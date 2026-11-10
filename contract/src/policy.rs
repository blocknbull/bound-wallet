//! Pure policy evaluation. No chain state, no promises: given a policy, the
//! agent's usage so far, an action and the current time, decide what happens.
//! Keeping this pure makes it unit-testable and lets `check` (view) and
//! `execute` (change) share one code path.

use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId, NearToken};

/// Nanoseconds in one second (NEAR block timestamps are in ns).
pub const NS_PER_SEC: u64 = 1_000_000_000;

/// Who the agent may send native NEAR or tokens to.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ReceiverRule {
    /// Any account. Caps still apply.
    Any,
    /// Only these accounts.
    Allowlist(Vec<AccountId>),
}

/// A contract the agent may call, and which methods. Empty `methods` = any method.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CallRule {
    pub contract: AccountId,
    pub methods: Vec<String>,
}

/// Per-token (NEP-141) spending limits, in the token's smallest unit.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenRule {
    pub token: AccountId,
    pub max_per_tx: U128,
    pub window_cap: U128,
}

/// Inclusive UTC hour window during which the agent may act.
/// `start` may be greater than `end` to wrap midnight (e.g. 22 -> 6).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ActiveHours {
    pub start_hour: u8,
    pub end_hour: u8,
}

/// Auto-suspend an agent that keeps getting denied. Probing the limits is
/// the signature of a compromised or misbehaving agent.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Tripwire {
    /// Denials that trip the wire...
    pub max_denials: u32,
    /// ...within this many seconds.
    pub window_secs: u64,
}

/// The rules the human sets once. The agent can never exceed them.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    /// Max native NEAR a single action may move (transfer or attached deposit).
    pub max_per_tx: NearToken,
    /// Max native NEAR across all actions in one rolling window.
    pub window_cap: NearToken,
    /// Window length in seconds. 86400 = daily cap.
    pub window_secs: u64,
    /// Max number of executed actions per window. 0 = unlimited.
    pub max_tx_per_window: u32,
    /// Who can receive native NEAR / tokens.
    pub receivers: ReceiverRule,
    /// Which contracts and methods the agent may call. Empty = no calls allowed.
    pub calls: Vec<CallRule>,
    /// Which NEP-141 tokens the agent may move, and their caps. Empty = no tokens.
    pub tokens: Vec<TokenRule>,
    /// Optional time-of-day restriction.
    pub active_hours_utc: Option<ActiveHours>,
    /// Optional hard expiry (ns since epoch). After this the key is dead weight.
    pub expires_at: Option<U64>,
    /// Native amounts strictly above this are queued for human approval
    /// instead of executed. None = never queue.
    pub approval_above: Option<NearToken>,
    /// Max USD value (in cents) one action may move. Needs a fresh NEAR/USD
    /// price; see `BoundWallet::refresh_price`.
    #[serde(default)]
    pub max_per_tx_usd_cents: Option<u64>,
    /// Max USD value (in cents) across the rolling window.
    #[serde(default)]
    pub window_cap_usd_cents: Option<u64>,
    /// Allow cross-chain swaps through NEAR Intents (1Click). The deposit goes
    /// to a per-quote address, so the receiver allowlist cannot apply; the
    /// amount caps, rate limit and approval threshold still do, and the
    /// destination is written to history.
    #[serde(default)]
    pub allow_intents: bool,
    /// Suspend the agent after too many denials in a window. None = never.
    #[serde(default)]
    pub tripwire: Option<Tripwire>,
    /// The first payment to a receiver this agent has never paid before is
    /// queued for the owner, however small. After one approval the receiver
    /// is known and later payments are autonomous. Only meaningful with
    /// `receivers: Any`; with an allowlist every receiver is already vetted.
    #[serde(default)]
    pub approve_new_receivers: bool,
}

/// Dollars-and-cents value of a native amount at `cents_per_near`.
pub fn yocto_to_cents(amount: NearToken, cents_per_near: u64) -> u64 {
    // yocto / 1e18 = micro-NEAR, so the product stays far inside u128.
    let micro = amount.as_yoctonear() / 1_000_000_000_000_000_000u128;
    (micro.saturating_mul(cents_per_near as u128) / 1_000_000u128).min(u64::MAX as u128) as u64
}

impl Policy {
    pub fn uses_usd(&self) -> bool {
        self.max_per_tx_usd_cents.is_some() || self.window_cap_usd_cents.is_some()
    }

    pub fn validate(&self) {
        assert!(self.window_secs > 0, "window_secs must be > 0");
        assert!(
            self.max_per_tx <= self.window_cap,
            "max_per_tx cannot exceed window_cap"
        );
        if let Some(h) = &self.active_hours_utc {
            assert!(h.start_hour < 24 && h.end_hour < 24, "hours must be 0-23");
        }
        if let Some(t) = &self.tripwire {
            assert!(t.max_denials > 0 && t.window_secs > 0, "tripwire needs max_denials > 0 and window_secs > 0");
        }
        if let (Some(per_tx), Some(cap)) = (self.max_per_tx_usd_cents, self.window_cap_usd_cents) {
            assert!(per_tx <= cap, "max_per_tx_usd_cents cannot exceed window_cap_usd_cents");
        }
        for t in &self.tokens {
            assert!(
                t.max_per_tx.0 <= t.window_cap.0,
                "token max_per_tx cannot exceed window_cap"
            );
        }
        for c in &self.calls {
            for m in &c.methods {
                assert!(!m.is_empty(), "method name cannot be empty");
            }
        }
    }

    fn token_rule(&self, token: &AccountId) -> Option<&TokenRule> {
        self.tokens.iter().find(|t| &t.token == token)
    }

    fn receiver_ok(&self, receiver: &AccountId) -> bool {
        match &self.receivers {
            ReceiverRule::Any => true,
            ReceiverRule::Allowlist(list) => list.contains(receiver),
        }
    }

    fn call_ok(&self, contract: &AccountId, method: &str) -> bool {
        self.calls.iter().any(|c| {
            &c.contract == contract && (c.methods.is_empty() || c.methods.iter().any(|m| m == method))
        })
    }
}

/// Rolling-window spend tracker.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Usage {
    pub window_start: U64,
    pub spent: U128,
    pub count: u32,
    #[serde(default)]
    pub spent_usd_cents: u64,
}

impl Usage {
    /// Reset the window if it has elapsed.
    pub fn roll(&mut self, now: u64, window_secs: u64) {
        if now.saturating_sub(self.window_start.0) >= window_secs.saturating_mul(NS_PER_SEC) {
            self.window_start = U64(now);
            self.spent = U128(0);
            self.count = 0;
            self.spent_usd_cents = 0;
        }
    }
}

/// What an agent asks the wallet to do.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Send native NEAR.
    Transfer { receiver: AccountId, amount: NearToken },
    /// Send a NEP-141 token via `ft_transfer`.
    FtTransfer {
        token: AccountId,
        receiver: AccountId,
        amount: U128,
        memo: Option<String>,
    },
    /// Fund a NEAR Intents (1Click) swap: send `amount` of native NEAR (or
    /// `token`) to the quote's deposit address. The rest of the fields are
    /// what the agent was quoted, kept for the audit trail.
    IntentsDeposit {
        deposit_address: AccountId,
        amount: U128,
        /// None = native NEAR, Some = NEP-141 token contract.
        token: Option<AccountId>,
        destination_asset: String,
        recipient: String,
        /// 1Click correlationId or quote hash.
        quote_ref: String,
    },
    /// Call any contract method with JSON args and an attached deposit.
    FunctionCall {
        contract: AccountId,
        method: String,
        /// JSON-encoded arguments.
        args: String,
        deposit: NearToken,
        /// Gas to attach, in TGas. Defaults to 30.
        gas_tgas: Option<u16>,
    },
}

/// What evaluation decided to charge against the agent's budgets.
#[derive(Clone, Debug, PartialEq)]
pub struct Charge {
    pub native: NearToken,
    /// USD value of `native` at the price used for evaluation (0 when the
    /// policy has no USD caps).
    pub usd_cents: u64,
    pub token: Option<(AccountId, u128)>,
    pub needs_approval: bool,
}

/// Evaluate an action against policy and current usage.
/// Does not mutate `usage`; the caller debits after the action is dispatched.
/// `cents_per_near` is the current NEAR/USD price if one is fresh enough to
/// use. It is only required when the policy has USD caps.
pub fn evaluate(
    policy: &Policy,
    native_usage: &Usage,
    token_usage: Option<&Usage>,
    action: &Action,
    now: u64,
    cents_per_near: Option<u64>,
) -> Result<Charge, String> {
    // 1. Hard gates that apply to every action.
    if let Some(exp) = policy.expires_at {
        if now >= exp.0 {
            return Err("policy expired".into());
        }
    }
    if let Some(h) = &policy.active_hours_utc {
        let hour = ((now / NS_PER_SEC) % 86_400 / 3_600) as u8;
        let inside = if h.start_hour <= h.end_hour {
            hour >= h.start_hour && hour <= h.end_hour
        } else {
            hour >= h.start_hour || hour <= h.end_hour
        };
        if !inside {
            return Err(format!(
                "outside active hours (now {:02}:00 UTC, allowed {:02}-{:02})",
                hour, h.start_hour, h.end_hour
            ));
        }
    }

    // 2. Rate limit (count is shared across all action kinds).
    let mut nu = native_usage.clone();
    nu.roll(now, policy.window_secs);
    if policy.max_tx_per_window > 0 && nu.count >= policy.max_tx_per_window {
        return Err(format!(
            "rate limit: {} actions already in this window",
            nu.count
        ));
    }

    // 3. Action-specific checks.
    let (native, token) = match action {
        Action::Transfer { receiver, amount } => {
            if !policy.receiver_ok(receiver) {
                return Err(format!("receiver {receiver} not in allowlist"));
            }
            if amount.is_zero() {
                return Err("amount must be > 0".into());
            }
            (*amount, None)
        }
        Action::FtTransfer {
            token,
            receiver,
            amount,
            ..
        } => {
            if !policy.receiver_ok(receiver) {
                return Err(format!("receiver {receiver} not in allowlist"));
            }
            let rule = policy
                .token_rule(token)
                .ok_or_else(|| format!("token {token} not allowed"))?;
            if amount.0 == 0 {
                return Err("amount must be > 0".into());
            }
            if amount.0 > rule.max_per_tx.0 {
                return Err(format!(
                    "token amount {} exceeds max_per_tx {}",
                    amount.0, rule.max_per_tx.0
                ));
            }
            let mut tu = token_usage.cloned().unwrap_or_default();
            tu.roll(now, policy.window_secs);
            let projected = tu.spent.0.saturating_add(amount.0);
            if projected > rule.window_cap.0 {
                return Err(format!(
                    "token window cap: {} spent + {} requested > cap {}",
                    tu.spent.0, amount.0, rule.window_cap.0
                ));
            }
            (NearToken::from_yoctonear(0), Some((token.clone(), amount.0)))
        }
        Action::FunctionCall {
            contract,
            method,
            deposit,
            ..
        } => {
            if !policy.call_ok(contract, method) {
                return Err(format!("call {contract}.{method} not allowed"));
            }
            (*deposit, None)
        }
        Action::IntentsDeposit { amount, token, .. } => {
            if !policy.allow_intents {
                return Err("cross-chain swaps (NEAR Intents) not allowed by policy".into());
            }
            if amount.0 == 0 {
                return Err("amount must be > 0".into());
            }
            match token {
                None => (NearToken::from_yoctonear(amount.0), None),
                Some(t) => {
                    let rule = policy
                        .token_rule(t)
                        .ok_or_else(|| format!("token {t} not allowed"))?;
                    if amount.0 > rule.max_per_tx.0 {
                        return Err(format!(
                            "token amount {} exceeds max_per_tx {}",
                            amount.0, rule.max_per_tx.0
                        ));
                    }
                    let mut tu = token_usage.cloned().unwrap_or_default();
                    tu.roll(now, policy.window_secs);
                    if tu.spent.0.saturating_add(amount.0) > rule.window_cap.0 {
                        return Err(format!(
                            "token window cap: {} spent + {} requested > cap {}",
                            tu.spent.0, amount.0, rule.window_cap.0
                        ));
                    }
                    (NearToken::from_yoctonear(0), Some((t.clone(), amount.0)))
                }
            }
        }
    };

    // 4. Native caps (apply to transfers and attached deposits).
    if native > policy.max_per_tx {
        return Err(format!(
            "amount {} exceeds max_per_tx {}",
            native, policy.max_per_tx
        ));
    }
    let projected = nu.spent.0.saturating_add(native.as_yoctonear());
    if projected > policy.window_cap.as_yoctonear() {
        return Err(format!(
            "window cap: {} spent + {} requested > cap {}",
            NearToken::from_yoctonear(nu.spent.0),
            native,
            policy.window_cap
        ));
    }

    // 5. USD caps, if the policy has them.
    let mut usd_cents = 0u64;
    if policy.uses_usd() && !native.is_zero() {
        let price = cents_per_near
            .ok_or_else(|| "NEAR/USD price unavailable or stale; call refresh_price".to_string())?;
        usd_cents = yocto_to_cents(native, price);
        if let Some(max) = policy.max_per_tx_usd_cents {
            if usd_cents > max {
                return Err(format!(
                    "amount ${}.{:02} exceeds max_per_tx ${}.{:02}",
                    usd_cents / 100,
                    usd_cents % 100,
                    max / 100,
                    max % 100
                ));
            }
        }
        if let Some(cap) = policy.window_cap_usd_cents {
            let projected = nu.spent_usd_cents.saturating_add(usd_cents);
            if projected > cap {
                return Err(format!(
                    "USD window cap: ${}.{:02} spent + ${}.{:02} requested > cap ${}.{:02}",
                    nu.spent_usd_cents / 100,
                    nu.spent_usd_cents % 100,
                    usd_cents / 100,
                    usd_cents % 100,
                    cap / 100,
                    cap % 100
                ));
            }
        }
    }

    // 6. Human-in-the-loop threshold.
    let needs_approval = match policy.approval_above {
        Some(t) => native > t,
        None => false,
    };

    Ok(Charge {
        native,
        usd_cents,
        token,
        needs_approval,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn base_policy() -> Policy {
        Policy {
            max_per_tx: NearToken::from_near(1),
            window_cap: NearToken::from_near(5),
            window_secs: 86_400,
            max_tx_per_window: 10,
            receivers: ReceiverRule::Allowlist(vec![acc("vendor.near")]),
            calls: vec![CallRule {
                contract: acc("dex.near"),
                methods: vec!["swap".into()],
            }],
            tokens: vec![TokenRule {
                token: acc("usdc.near"),
                max_per_tx: U128(100_000_000),
                window_cap: U128(500_000_000),
            }],
            active_hours_utc: None,
            expires_at: None,
            approval_above: Some(NearToken::from_millinear(500)),
            max_per_tx_usd_cents: None,
            window_cap_usd_cents: None,
            allow_intents: false,
            tripwire: None,
            approve_new_receivers: false,
        }
    }

    #[test]
    fn intents_deposits_are_gated_by_policy_not_allowlist() {
        let mut p = base_policy();
        let a = Action::IntentsDeposit {
            deposit_address: acc("7f3a9b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"),
            amount: U128(NearToken::from_millinear(200).as_yoctonear()),
            token: None,
            destination_asset: "nep141:base-usdc.omft.near".into(),
            recipient: "0xabc".into(),
            quote_ref: "corr-1".into(),
        };
        let e = evaluate(&p, &Usage::default(), None, &a, 0, None).unwrap_err();
        assert!(e.contains("not allowed by policy"));
        p.allow_intents = true;
        let c = evaluate(&p, &Usage::default(), None, &a, 0, None).unwrap();
        assert_eq!(c.native, NearToken::from_millinear(200));
        // Caps still apply: 2 NEAR is over max_per_tx (1 NEAR).
        let big = Action::IntentsDeposit {
            deposit_address: acc("dep.near"),
            amount: U128(NearToken::from_near(2).as_yoctonear()),
            token: None,
            destination_asset: "x".into(),
            recipient: "y".into(),
            quote_ref: "z".into(),
        };
        assert!(evaluate(&p, &Usage::default(), None, &big, 0, None).is_err());
    }

    #[test]
    fn transfer_within_limits_passes() {
        let p = base_policy();
        let a = Action::Transfer {
            receiver: acc("vendor.near"),
            amount: NearToken::from_millinear(100),
        };
        let c = evaluate(&p, &Usage::default(), None, &a, 0, None).unwrap();
        assert_eq!(c.native, NearToken::from_millinear(100));
        assert!(!c.needs_approval);
    }

    #[test]
    fn transfer_above_approval_threshold_is_queued() {
        let p = base_policy();
        let a = Action::Transfer {
            receiver: acc("vendor.near"),
            amount: NearToken::from_millinear(800),
        };
        let c = evaluate(&p, &Usage::default(), None, &a, 0, None).unwrap();
        assert!(c.needs_approval);
    }

    #[test]
    fn transfer_to_unknown_receiver_denied() {
        let p = base_policy();
        let a = Action::Transfer {
            receiver: acc("attacker.near"),
            amount: NearToken::from_millinear(1),
        };
        let e = evaluate(&p, &Usage::default(), None, &a, 0, None).unwrap_err();
        assert!(e.contains("allowlist"));
    }

    #[test]
    fn per_tx_cap_enforced() {
        let p = base_policy();
        let a = Action::Transfer {
            receiver: acc("vendor.near"),
            amount: NearToken::from_near(2),
        };
        assert!(evaluate(&p, &Usage::default(), None, &a, 0, None).is_err());
    }

    #[test]
    fn window_cap_enforced_and_rolls() {
        let p = base_policy();
        let a = Action::Transfer {
            receiver: acc("vendor.near"),
            amount: NearToken::from_near(1),
        };
        let used = Usage {
            window_start: U64(0),
            spent: U128(NearToken::from_near(4).as_yoctonear() + 1),
            count: 1,
            spent_usd_cents: 0,
        };
        assert!(evaluate(&p, &used, None, &a, 1, None).is_err());
        // Next day the window has rolled.
        let next_day = 86_401 * NS_PER_SEC;
        assert!(evaluate(&p, &used, None, &a, next_day, None).is_ok());
    }

    #[test]
    fn rate_limit_enforced() {
        let p = base_policy();
        let a = Action::Transfer {
            receiver: acc("vendor.near"),
            amount: NearToken::from_millinear(1),
        };
        let used = Usage {
            window_start: U64(0),
            spent: U128(0),
            count: 10,
            spent_usd_cents: 0,
        };
        assert!(evaluate(&p, &used, None, &a, 1, None).unwrap_err().contains("rate limit"));
    }

    #[test]
    fn function_call_allowlist() {
        let p = base_policy();
        let ok = Action::FunctionCall {
            contract: acc("dex.near"),
            method: "swap".into(),
            args: "{}".into(),
            deposit: NearToken::from_yoctonear(1),
            gas_tgas: None,
        };
        assert!(evaluate(&p, &Usage::default(), None, &ok, 0, None).is_ok());
        let bad = Action::FunctionCall {
            contract: acc("dex.near"),
            method: "withdraw_all".into(),
            args: "{}".into(),
            deposit: NearToken::from_yoctonear(0),
            gas_tgas: None,
        };
        assert!(evaluate(&p, &Usage::default(), None, &bad, 0, None).is_err());
    }

    #[test]
    fn token_caps() {
        let p = base_policy();
        let a = Action::FtTransfer {
            token: acc("usdc.near"),
            receiver: acc("vendor.near"),
            amount: U128(100_000_000),
            memo: None,
        };
        let c = evaluate(&p, &Usage::default(), None, &a, 0, None).unwrap();
        assert_eq!(c.token, Some((acc("usdc.near"), 100_000_000)));
        let tu = Usage {
            window_start: U64(0),
            spent: U128(450_000_000),
            count: 0,
            spent_usd_cents: 0,
        };
        assert!(evaluate(&p, &Usage::default(), Some(&tu), &a, 1, None).is_err());
        let unknown = Action::FtTransfer {
            token: acc("scam.near"),
            receiver: acc("vendor.near"),
            amount: U128(1),
            memo: None,
        };
        assert!(evaluate(&p, &Usage::default(), None, &unknown, 0, None).is_err());
    }

    #[test]
    fn active_hours_wrap_midnight() {
        let mut p = base_policy();
        p.active_hours_utc = Some(ActiveHours {
            start_hour: 22,
            end_hour: 6,
        });
        let a = Action::Transfer {
            receiver: acc("vendor.near"),
            amount: NearToken::from_millinear(1),
        };
        let at = |h: u64| h * 3_600 * NS_PER_SEC;
        assert!(evaluate(&p, &Usage::default(), None, &a, at(23), None).is_ok());
        assert!(evaluate(&p, &Usage::default(), None, &a, at(3), None).is_ok());
        assert!(evaluate(&p, &Usage::default(), None, &a, at(12), None).is_err());
    }

    #[test]
    fn usd_caps_need_a_price_and_enforce_limits() {
        let mut p = base_policy();
        p.max_per_tx = NearToken::from_near(100);
        p.window_cap = NearToken::from_near(100);
        p.approval_above = None;
        p.max_per_tx_usd_cents = Some(2_000); // $20
        p.window_cap_usd_cents = Some(5_000); // $50
        let a = |n: u128| Action::Transfer {
            receiver: acc("vendor.near"),
            amount: NearToken::from_near(n),
        };
        // No price: denied, with a clear reason.
        let e = evaluate(&p, &Usage::default(), None, &a(1), 0, None).unwrap_err();
        assert!(e.contains("price unavailable"));
        // $5/NEAR: 3 NEAR = $15 ok, 5 NEAR = $25 too much per action.
        let c = evaluate(&p, &Usage::default(), None, &a(3), 0, Some(500)).unwrap();
        assert_eq!(c.usd_cents, 1_500);
        assert!(evaluate(&p, &Usage::default(), None, &a(5), 0, Some(500)).unwrap_err().contains("max_per_tx"));
        // Window: $40 spent + $15 > $50.
        let used = Usage {
            window_start: U64(0),
            spent: U128(0),
            count: 1,
            spent_usd_cents: 4_000,
        };
        assert!(evaluate(&p, &used, None, &a(3), 1, Some(500)).unwrap_err().contains("USD window cap"));
    }

    #[test]
    fn yocto_to_cents_math() {
        assert_eq!(yocto_to_cents(NearToken::from_near(1), 477), 477);
        assert_eq!(yocto_to_cents(NearToken::from_millinear(250), 400), 100);
        assert_eq!(yocto_to_cents(NearToken::from_yoctonear(1), 400), 0);
    }

    #[test]
    fn expiry() {
        let mut p = base_policy();
        p.expires_at = Some(U64(100));
        let a = Action::Transfer {
            receiver: acc("vendor.near"),
            amount: NearToken::from_millinear(1),
        };
        assert!(evaluate(&p, &Usage::default(), None, &a, 99, None).is_ok());
        assert!(evaluate(&p, &Usage::default(), None, &a, 100, None).is_err());
    }
}

/// Property tests for the policy engine.
///
/// The hand-written tests above check the cases we thought of. These check the
/// invariants that must hold for every input: that a denial is always a
/// returned `Err` and never a panic, that nothing comes back `Ok` above a cap,
/// that an allowlist cannot be stepped around, and that spending more never
/// unlocks what spending less forbade.
///
/// Two families of generator, on purpose. `any_policy` is deliberately hostile
/// and is used only for the no-panic property. Everything else uses `case`,
/// which draws the action from the policy that will judge it: sizes around the
/// caps, receivers from the allowlist plus one outsider. Generating the two
/// independently makes nearly every case a denial on size alone, and a
/// property that only ever sees denials passes without proving anything.
/// `generators_are_not_vacuous` keeps that honest.
#[cfg(test)]
mod props {
    use super::*;
    use proptest::prelude::*;

    const ONE_NEAR: u128 = 10u128.pow(24);

    fn account() -> impl Strategy<Value = AccountId> {
        prop_oneof![
            Just("alice.near"),
            Just("bob.near"),
            Just("vendor.near"),
            Just("attacker.near"),
            Just("usdc.near"),
            Just("dex.near"),
        ]
        .prop_map(|s| s.parse().unwrap())
    }

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    /// Zero, one, realistic sizes, and the top of the range, where anything
    /// that is not saturating arithmetic overflows.
    fn wild_amount() -> impl Strategy<Value = u128> {
        prop_oneof![
            Just(0u128),
            Just(1u128),
            1u128..10u128.pow(27),
            (u128::MAX - 1_000)..=u128::MAX,
        ]
    }

    fn wild_near() -> impl Strategy<Value = NearToken> {
        wild_amount().prop_map(NearToken::from_yoctonear)
    }

    fn wild_usage() -> impl Strategy<Value = Usage> {
        (any::<u64>(), wild_amount(), any::<u32>(), any::<u64>()).prop_map(
            |(window_start, spent, count, spent_usd_cents)| Usage {
                window_start: U64(window_start),
                spent: U128(spent),
                count,
                spent_usd_cents,
            },
        )
    }

    fn wild_action() -> impl Strategy<Value = Action> {
        prop_oneof![
            (account(), wild_near())
                .prop_map(|(receiver, amount)| Action::Transfer { receiver, amount }),
            (account(), account(), wild_amount()).prop_map(|(token, receiver, a)| {
                Action::FtTransfer { token, receiver, amount: U128(a), memo: None }
            }),
            (account(), wild_amount(), prop::option::of(account())).prop_map(
                |(deposit_address, a, token)| Action::IntentsDeposit {
                    deposit_address,
                    amount: U128(a),
                    token,
                    destination_asset: "nep141:base-0x833.omft.near".into(),
                    recipient: "0xabc".into(),
                    quote_ref: "q1".into(),
                }
            ),
            (account(), "[a-z_]{1,8}", wild_near()).prop_map(|(contract, method, deposit)| {
                Action::FunctionCall {
                    contract,
                    method,
                    args: "{}".into(),
                    deposit,
                    gas_tgas: None,
                }
            }),
        ]
    }

    prop_compose! {
        /// Anything at all, including policies `validate` would reject. An
        /// upgraded wallet can still hold one written by an older version of
        /// the struct, so `evaluate` has to survive it.
        fn any_policy()(
            max_per_tx in wild_near(), window_cap in wild_near(), window_secs in any::<u64>(),
            max_tx_per_window in any::<u32>(),
            allow in prop::collection::vec(account(), 0..3),
            use_allowlist in any::<bool>(),
            calls in prop::collection::vec(
                (account(), prop::collection::vec("[a-z_]{1,8}", 0..3))
                    .prop_map(|(contract, methods)| CallRule { contract, methods }), 0..3),
            tokens in prop::collection::vec(
                (account(), wild_amount(), wild_amount()).prop_map(|(token, a, b)| TokenRule {
                    token, max_per_tx: U128(a), window_cap: U128(b),
                }), 0..3),
            hours in prop::option::of((any::<u8>(), any::<u8>())),
            expires_at in prop::option::of(any::<u64>()),
            approval_above in prop::option::of(wild_near()),
            per_tx_usd in prop::option::of(any::<u64>()),
            window_usd in prop::option::of(any::<u64>()),
            allow_intents in any::<bool>(),
            approve_new_receivers in any::<bool>(),
        ) -> Policy {
            Policy {
                max_per_tx, window_cap, window_secs, max_tx_per_window,
                receivers: if use_allowlist { ReceiverRule::Allowlist(allow) } else { ReceiverRule::Any },
                calls, tokens,
                active_hours_utc: hours.map(|(start_hour, end_hour)| ActiveHours { start_hour, end_hour }),
                expires_at: expires_at.map(U64),
                approval_above,
                max_per_tx_usd_cents: per_tx_usd,
                window_cap_usd_cents: window_usd,
                allow_intents,
                tripwire: None,
                approve_new_receivers,
            }
        }
    }

    prop_compose! {
        /// A policy an owner could plausibly store: every assertion in
        /// `validate` holds, and the caps are in a range an action can
        /// realistically sit either side of.
        ///
        /// `expires_at` and `active_hours_utc` are left unset here. They are
        /// gates that reject before any cap is consulted, so switching them on
        /// would push most cases back into blanket denial and hollow out the
        /// properties below. Both are covered by the unit tests above and by
        /// `never_panics`.
        fn sane_policy()(
            per_tx in 1u128..=50, window_mult in 1u128..=20,
            window_secs in 60u64..=86_400, max_tx_per_window in 0u32..8,
            allow in prop::collection::vec(account(), 1..4),
            use_allowlist in any::<bool>(),
            token_a in account(), token_cap in 1_000u128..=1_000_000_000,
            call_target in account(), method in "[a-z_]{1,8}",
            usd in prop::option::of((100u64..=5_000, 1u128..=20)),
            allow_intents in any::<bool>(),
            approval in prop::option::of(1u128..=50),
            approve_new_receivers in any::<bool>(),
        ) -> Policy {
            let max_per_tx = per_tx * ONE_NEAR;
            let window_cap = max_per_tx * window_mult;
            let (per_tx_usd, window_usd) = match usd {
                Some((cents, mult)) => (Some(cents), Some(cents.saturating_mul(mult as u64))),
                None => (None, None),
            };
            Policy {
                max_per_tx: NearToken::from_yoctonear(max_per_tx),
                window_cap: NearToken::from_yoctonear(window_cap),
                window_secs,
                max_tx_per_window,
                receivers: if use_allowlist { ReceiverRule::Allowlist(allow) } else { ReceiverRule::Any },
                calls: vec![CallRule { contract: call_target, methods: vec![method] }],
                tokens: vec![TokenRule {
                    token: token_a,
                    max_per_tx: U128(token_cap),
                    window_cap: U128(token_cap.saturating_mul(10)),
                }],
                active_hours_utc: None,
                expires_at: None,
                approval_above: approval.map(|n| NearToken::from_yoctonear(n * ONE_NEAR)),
                max_per_tx_usd_cents: per_tx_usd,
                window_cap_usd_cents: window_usd,
                allow_intents,
                tripwire: None,
                approve_new_receivers,
            }
        }
    }

    type Case = (Policy, Usage, Option<Usage>, Action, u64, Option<u64>);

    /// A policy together with an action drawn to suit it, so a useful share of
    /// cases land near a limit instead of a thousand NEAR past it.
    fn case() -> impl Strategy<Value = Case> {
        sane_policy().prop_flat_map(|p| {
            let per_tx = p.max_per_tx.as_yoctonear().max(1);
            let window = p.window_cap.as_yoctonear().max(1);

            // Allowed receivers plus one outsider, so both sides of the
            // allowlist check are exercised rather than only the happy path.
            let mut pool = match &p.receivers {
                ReceiverRule::Any => vec![acc("alice.near"), acc("bob.near"), acc("vendor.near")],
                ReceiverRule::Allowlist(l) => l.clone(),
            };
            pool.push(acc("attacker.near"));

            let rule = p.tokens[0].clone();
            let tok_cap = rule.max_per_tx.0.max(1);
            let call = p.calls[0].clone();
            let allowed_method = call.methods[0].clone();

            let action = prop_oneof![
                3 => (prop::sample::select(pool.clone()), 0u128..=per_tx.saturating_mul(2))
                        .prop_map(|(receiver, a)| Action::Transfer {
                            receiver, amount: NearToken::from_yoctonear(a),
                        }),
                2 => (
                        prop::sample::select(pool.clone()),
                        prop_oneof![Just(rule.token.clone()), Just(acc("dex.near"))],
                        0u128..=tok_cap.saturating_mul(2),
                     ).prop_map(|(receiver, token, a)| Action::FtTransfer {
                            token, receiver, amount: U128(a), memo: None,
                        }),
                2 => (prop::sample::select(pool.clone()), 0u128..=per_tx.saturating_mul(2),
                      prop::option::of(Just(rule.token.clone())))
                        .prop_map(|(deposit_address, a, token)| Action::IntentsDeposit {
                            deposit_address,
                            amount: U128(a),
                            token,
                            destination_asset: "nep141:base-0x833.omft.near".into(),
                            recipient: "0xabc".into(),
                            quote_ref: "q1".into(),
                        }),
                2 => (
                        prop_oneof![Just(call.contract.clone()), Just(acc("attacker.near"))],
                        prop_oneof![Just(allowed_method.clone()), Just("drain".to_string())],
                        0u128..=per_tx.saturating_mul(2),
                     ).prop_map(|(contract, method, d)| Action::FunctionCall {
                            contract, method, args: "{}".into(),
                            deposit: NearToken::from_yoctonear(d),
                            gas_tgas: None,
                        }),
            ];

            // Usage sits inside the window and below the caps, which is the
            // state a live agent is actually in.
            let max_count = p.max_tx_per_window.max(1);
            let usage = (0u128..=window, 0u32..=max_count, 0u64..=5_000).prop_map(
                move |(spent, count, usd)| Usage {
                    window_start: U64(1_000 * NS_PER_SEC),
                    spent: U128(spent),
                    count,
                    spent_usd_cents: usd,
                },
            );
            let token_usage = prop::option::of(
                (0u128..=rule.window_cap.0.max(1)).prop_map(|spent| Usage {
                    window_start: U64(1_000 * NS_PER_SEC),
                    spent: U128(spent),
                    count: 0,
                    spent_usd_cents: 0,
                }),
            );
            // Inside the window that usage started, so nothing rolls by accident.
            let now = (1_000u64..=1_060).prop_map(|s| s * NS_PER_SEC);
            // A plausible NEAR/USD price, so USD caps are actually evaluated
            // instead of short-circuiting on a missing price.
            let price = prop::option::of(100u64..=1_000);

            (Just(p), usage, token_usage, action, now, price)
        })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        /// The audit trail depends on a denial being a returned `Err`: the
        /// caller writes it to history and emits the event. A panic reverts
        /// the transaction instead, so the denial leaves no record and the
        /// tripwire never counts it. `evaluate` must never panic, on any
        /// input, valid policy or not.
        #[test]
        fn never_panics(
            p in any_policy(), u in wild_usage(), tu in prop::option::of(wild_usage()),
            a in wild_action(), now in any::<u64>(), price in prop::option::of(any::<u64>()),
        ) {
            let _ = evaluate(&p, &u, tu.as_ref(), &a, now, price);
        }

        /// Nothing comes back `Ok` that breaks a cap. This is the promise the
        /// whole product makes, checked against the same rolled usage the
        /// evaluator judged against.
        #[test]
        fn allowed_actions_stay_inside_every_cap((p, u, tu, a, now, price) in case()) {
            let charge = match evaluate(&p, &u, tu.as_ref(), &a, now, price) {
                Ok(c) => c,
                Err(_) => return Ok(()),
            };

            let mut nu = u.clone();
            nu.roll(now, p.window_secs);

            prop_assert!(charge.native <= p.max_per_tx, "native above max_per_tx");
            prop_assert!(
                nu.spent.0.saturating_add(charge.native.as_yoctonear())
                    <= p.window_cap.as_yoctonear(),
                "native window cap exceeded"
            );
            if p.max_tx_per_window > 0 {
                prop_assert!(nu.count < p.max_tx_per_window, "rate limit exceeded");
            }
            if let Some(max) = p.max_per_tx_usd_cents {
                prop_assert!(charge.usd_cents <= max, "usd per-action cap exceeded");
            }
            if let Some(cap) = p.window_cap_usd_cents {
                prop_assert!(
                    nu.spent_usd_cents.saturating_add(charge.usd_cents) <= cap,
                    "usd window cap exceeded"
                );
            }
            if let Some((token, amt)) = &charge.token {
                let rule = match p.token_rule(token) {
                    Some(r) => r,
                    None => return Err(TestCaseError::fail("charged a token with no rule")),
                };
                prop_assert!(*amt <= rule.max_per_tx.0, "token per-action cap exceeded");
                let mut t = tu.clone().unwrap_or_default();
                t.roll(now, p.window_secs);
                prop_assert!(
                    t.spent.0.saturating_add(*amt) <= rule.window_cap.0,
                    "token window cap exceeded"
                );
            }
        }

        /// The allowlist is what stops a compromised agent paying an address
        /// the owner never approved, so it has to hold for every input, not
        /// only the one in the attack demo. `IntentsDeposit` is deliberately
        /// out of scope: its destination is a per-quote address nobody can
        /// know in advance, which is why the amount caps carry that case.
        #[test]
        fn an_allowlist_is_never_bypassed((p, u, tu, a, now, price) in case()) {
            if evaluate(&p, &u, tu.as_ref(), &a, now, price).is_err() {
                return Ok(());
            }
            if let ReceiverRule::Allowlist(list) = &p.receivers {
                match &a {
                    Action::Transfer { receiver, .. } | Action::FtTransfer { receiver, .. } => {
                        prop_assert!(
                            list.contains(receiver),
                            "paid a receiver outside the allowlist"
                        );
                    }
                    _ => {}
                }
            }
        }

        /// Spending more can never unlock what spending less forbade. Both
        /// evaluations are pinned inside one window so neither rolls, leaving
        /// how much has been spent as the only difference between them.
        #[test]
        fn more_usage_never_permits_more(
            (p, base, _tu, a, now, price) in case(),
            extra_spent in 0u128..(50 * ONE_NEAR), extra_count in 0u32..8,
            extra_usd in 0u64..5_000,
        ) {
            let mut more = base.clone();
            more.spent = U128(base.spent.0.saturating_add(extra_spent));
            more.count = base.count.saturating_add(extra_count);
            more.spent_usd_cents = base.spent_usd_cents.saturating_add(extra_usd);

            if evaluate(&p, &base, None, &a, now, price).is_err() {
                prop_assert!(
                    evaluate(&p, &more, None, &a, now, price).is_err(),
                    "denied on less usage, allowed on more"
                );
            }
        }
    }

    /// A property that only ever sees denials passes while proving nothing,
    /// and nothing in the test output would say so. This fails if the
    /// generators drift back to that state: it samples `case()` and insists a
    /// real share of cases are allowed, that token charges happen, and that
    /// the allowlist check is actually reached with both insiders and
    /// outsiders. The first version of these tests allowed 8 cases in 512 and
    /// reached the allowlist zero times.
    #[test]
    fn generators_are_not_vacuous() {
        use proptest::strategy::ValueTree;
        use proptest::test_runner::TestRunner;

        let mut runner = TestRunner::deterministic();
        let (mut allowed, mut token_charges, mut inside, mut outside) = (0, 0, 0, 0);
        const N: usize = 1_000;

        for _ in 0..N {
            let (p, u, tu, a, now, price) =
                case().new_tree(&mut runner).unwrap().current();
            let listed = match (&p.receivers, &a) {
                (
                    ReceiverRule::Allowlist(l),
                    Action::Transfer { receiver, .. } | Action::FtTransfer { receiver, .. },
                ) => Some(l.contains(receiver)),
                _ => None,
            };
            match evaluate(&p, &u, tu.as_ref(), &a, now, price) {
                Ok(c) => {
                    allowed += 1;
                    if c.token.is_some() {
                        token_charges += 1;
                    }
                    if listed == Some(true) {
                        inside += 1;
                    }
                }
                Err(_) => {
                    if listed == Some(false) {
                        outside += 1;
                    }
                }
            }
        }

        println!(
            "case() coverage over {N}: {allowed} allowed, {token_charges} token charges, \
             allowlist reached {} times ({inside} inside, {outside} outside)",
            inside + outside
        );
        assert!(
            allowed >= N / 10,
            "only {allowed}/{N} cases were allowed; the cap properties are nearly vacuous"
        );
        assert!(token_charges >= 10, "only {token_charges}/{N} token charges");
        assert!(inside >= 10, "allowlist allowed only {inside}/{N} times");
        assert!(outside >= 10, "allowlist denied only {outside}/{N} times");
    }
}
