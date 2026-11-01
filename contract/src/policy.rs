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
