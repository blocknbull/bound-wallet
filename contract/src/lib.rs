//! Bound Wallet: a policy-enforced smart wallet for AI agents on NEAR.
//!
//! The contract *is* the wallet. The human owner deploys it to a sub-account,
//! funds it, and registers agents. Each agent gets a NEAR function-call access
//! key that can only call `execute` on this contract. Every action the agent
//! requests is evaluated against the owner's policy before anything moves.
//!
//! Agents are identified by the public key that signed the transaction
//! (`env::signer_account_pk`), so no agent ever holds a full-access key and
//! the owner never shares their own key.

pub mod events;
pub mod policy;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PromiseOrValue, PublicKey,
};

pub use policy::{Action, ActiveHours, CallRule, Charge, Policy, ReceiverRule, TokenRule, Tripwire, Usage};

const DEFAULT_CALL_GAS: Gas = Gas::from_tgas(30);
const CALLBACK_GAS: Gas = Gas::from_tgas(10);
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(15);
/// Gas allowance granted to each agent key. This is NEAR's native guard on
/// *gas*, not money. Money is governed by `Policy`. NEAR checks the allowance
/// against the *prepaid* gas of each call (200 TGas is about 0.02 NEAR on
/// mainnet), so 1 NEAR is roughly 50 calls before the owner must re-add the
/// key. It bounds how much of the wallet's balance an agent can burn as gas.
const DEFAULT_KEY_ALLOWANCE: NearToken = NearToken::from_near(1);
/// How many decisions the wallet remembers on chain. Older ones are still in
/// the transaction logs; this ring buffer exists so a dashboard needs no indexer.
const HISTORY_CAP: u64 = 100;
/// Balance kept back so callbacks and state writes never starve.
const BALANCE_RESERVE: NearToken = NearToken::from_millinear(50);
const PRICE_FETCH_GAS: Gas = Gas::from_tgas(15);
const PRICE_CALLBACK_GAS: Gas = Gas::from_tgas(10);
const EXECUTE_AFTER_REFRESH_GAS: Gas = Gas::from_tgas(110);
/// A price older than this is not used. Owner-tunable.
const DEFAULT_PRICE_MAX_AGE_SECS: u64 = 600;
/// Sanity bounds for any price we accept, in cents per NEAR.
const PRICE_MIN_CENTS: u64 = 1;
const PRICE_MAX_CENTS: u64 = 100_000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Agents,
    Pending,
    History,
}

/// Lifetime counters per agent. These are the raw material for reputation.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stats {
    pub executed: u32,
    pub denied: u32,
    pub queued: u32,
    pub approved: u32,
    pub rejected: u32,
    pub failed: u32,
    pub added_at: U64,
    pub last_active: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRecord {
    pub label: String,
    pub public_key: PublicKey,
    pub policy: Policy,
    pub native_usage: Usage,
    /// Per-token usage. Small vector; policies rarely list more than a few tokens.
    pub token_usage: Vec<(AccountId, Usage)>,
    pub stats: Stats,
    /// Set by the tripwire or the owner. Every action is denied until the
    /// owner calls `unsuspend`.
    pub suspended: bool,
    /// Denials in the current tripwire window.
    pub denial_window_start: U64,
    pub denials_in_window: u32,
    /// Receivers the owner has approved at least once (for `approve_new_receivers`).
    pub known_receivers: Vec<AccountId>,
}

impl AgentRecord {
    /// Count a denial against the tripwire. Returns true if it just tripped.
    fn note_denial(&mut self, now: u64) -> bool {
        let Some(t) = &self.policy.tripwire else { return false };
        if now.saturating_sub(self.denial_window_start.0) >= t.window_secs.saturating_mul(policy::NS_PER_SEC) {
            self.denial_window_start = U64(now);
            self.denials_in_window = 0;
        }
        self.denials_in_window = self.denials_in_window.saturating_add(1);
        if self.denials_in_window >= t.max_denials && !self.suspended {
            self.suspended = true;
            return true;
        }
        false
    }

    fn token_usage(&self, token: &AccountId) -> Option<&Usage> {
        self.token_usage.iter().find(|(t, _)| t == token).map(|(_, u)| u)
    }

    fn token_usage_mut(&mut self, token: &AccountId) -> &mut Usage {
        if let Some(i) = self.token_usage.iter().position(|(t, _)| t == token) {
            return &mut self.token_usage[i].1;
        }
        self.token_usage.push((token.clone(), Usage::default()));
        &mut self.token_usage.last_mut().unwrap().1
    }

    /// Debit budgets for a charge that is about to be dispatched.
    fn debit(&mut self, charge: &Charge, now: u64) {
        let w = self.policy.window_secs;
        self.native_usage.roll(now, w);
        self.native_usage.spent =
            U128(self.native_usage.spent.0.saturating_add(charge.native.as_yoctonear()));
        self.native_usage.count = self.native_usage.count.saturating_add(1);
        self.native_usage.spent_usd_cents = self.native_usage.spent_usd_cents.saturating_add(charge.usd_cents);
        if let Some((token, amount)) = &charge.token {
            let tu = self.token_usage_mut(token);
            tu.roll(now, w);
            tu.spent = U128(tu.spent.0.saturating_add(*amount));
            tu.count = tu.count.saturating_add(1);
        }
        self.stats.last_active = U64(now);
    }

    /// Credit budgets back when a dispatched action failed on-chain.
    fn refund(&mut self, native: NearToken, usd_cents: u64, token: Option<(AccountId, u128)>) {
        self.native_usage.spent =
            U128(self.native_usage.spent.0.saturating_sub(native.as_yoctonear()));
        self.native_usage.count = self.native_usage.count.saturating_sub(1);
        self.native_usage.spent_usd_cents = self.native_usage.spent_usd_cents.saturating_sub(usd_cents);
        if let Some((t, amount)) = token {
            let tu = self.token_usage_mut(&t);
            tu.spent = U128(tu.spent.0.saturating_sub(amount));
            tu.count = tu.count.saturating_sub(1);
        }
    }
}

/// An action that exceeded `approval_above` and is waiting for the owner.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingAction {
    pub id: u64,
    pub agent_key: String,
    pub action: Action,
    pub created_at: U64,
}

/// One remembered decision. Same shape as the NEP-297 event, plus when.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct HistoryEntry {
    pub seq: u64,
    pub event: String,
    pub agent_key: Option<String>,
    pub label: Option<String>,
    pub action: Option<Action>,
    pub reason: Option<String>,
    pub pending_id: Option<u64>,
    pub timestamp: U64,
    pub block_height: U64,
}

/// Where the wallet gets NEAR/USD from. Pyth dropped NEAR in 2026 and the
/// NEAR price oracle depends on feeders being live, so this is pluggable.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum PriceSource {
    /// Owner or a designated feeder pushes the price with `set_price`.
    Manual,
    /// Spot price from a Ref/Rhea simple pool holding wNEAR and a stablecoin.
    RefPool {
        contract: AccountId,
        pool_id: u64,
        stable_decimals: u8,
    },
    /// NEAR's `priceoracle` contract (`get_price_data`).
    Oracle { contract: AccountId, asset_id: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceQuote {
    pub cents_per_near: u64,
    pub updated_at: U64,
    pub source: String,
    pub fresh: bool,
    pub max_age_secs: u64,
}

/// Subset of Ref's `get_pool` view.
#[near(serializers = [json])]
pub struct RefPoolView {
    token_account_ids: Vec<AccountId>,
    amounts: Vec<U128>,
}

/// Subset of priceoracle's `get_price_data` view.
#[near(serializers = [json])]
pub struct OraclePrice {
    multiplier: U128,
    decimals: u8,
}
#[near(serializers = [json])]
pub struct OracleAssetPrice {
    price: Option<OraclePrice>,
}
#[near(serializers = [json])]
pub struct OraclePriceData {
    prices: Vec<OracleAssetPrice>,
}

/// What `execute` tells the agent.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub enum ExecResult {
    Executed,
    Failed { reason: String },
    Denied { reason: String },
    Queued { id: u64 },
}

/// Result of a dry-run `check`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub allowed: bool,
    pub needs_approval: bool,
    pub reason: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Remaining {
    /// Budget left in this agent's window.
    pub native: NearToken,
    /// What the wallet can actually send right now (balance minus storage lock).
    pub wallet_free: NearToken,
    /// USD budget left this window, if the policy has a USD cap.
    pub usd_cents: Option<u64>,
    pub tokens: Vec<(AccountId, U128)>,
    pub actions: Option<u32>,
    pub window_resets_at: U64,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct EventData<'a> {
    agent_key: Option<&'a str>,
    label: Option<&'a str>,
    action: Option<&'a Action>,
    reason: Option<&'a str>,
    pending_id: Option<u64>,
}

enum Outcome {
    Denied(String, bool), // (reason, tripped now)
    Queued,
    Exec(Charge),
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct BoundWallet {
    owner: AccountId,
    paused: bool,
    agents: IterableMap<String, AgentRecord>,
    pending: IterableMap<u64, PendingAction>,
    next_pending_id: u64,
    history: Vector<HistoryEntry>,
    history_seq: u64,
    price_source: PriceSource,
    price: Option<(u64, u64)>, // (cents_per_near, updated_at ns)
    price_max_age_secs: u64,
    price_feeder: Option<AccountId>,
}

/// The account money leaves to, for the new-receiver rule.
fn receiver_of(action: &Action) -> Option<&AccountId> {
    match action {
        Action::Transfer { receiver, .. } | Action::FtTransfer { receiver, .. } => Some(receiver),
        _ => None,
    }
}

/// Balance the wallet can actually send: total minus what the protocol locks
/// for storage, minus a small reserve. Without this check a transfer that
/// overdraws fails the whole call with a raw protocol error instead of a
/// clean, logged denial.
fn available_balance() -> NearToken {
    let locked = env::storage_byte_cost()
        .saturating_mul(env::storage_usage() as u128)
        .saturating_add(BALANCE_RESERVE);
    env::account_balance().saturating_sub(locked)
}

fn pk_to_string(pk: &PublicKey) -> String {
    // PublicKey serializes to its "ed25519:..." / "secp256k1:..." text form.
    near_sdk::serde_json::to_value(pk)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .expect("public key to string")
}

#[near]
impl BoundWallet {
    // ---------------------------------------------------------------- init

    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            paused: false,
            agents: IterableMap::new(StorageKey::Agents),
            pending: IterableMap::new(StorageKey::Pending),
            next_pending_id: 1,
            history: Vector::new(StorageKey::History),
            history_seq: 0,
            price_source: PriceSource::Manual,
            price: None,
            price_max_age_secs: DEFAULT_PRICE_MAX_AGE_SECS,
            price_feeder: None,
        }
    }

    // ---------------------------------------------------------------- owner

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can do this"
        );
    }

    /// Register an agent: store its policy and add a function-call key that can
    /// only call `execute` on this contract.
    pub fn add_agent(
        &mut self,
        public_key: PublicKey,
        label: String,
        policy: Policy,
        gas_allowance: Option<NearToken>,
    ) -> Promise {
        self.assert_owner();
        policy.validate();
        let key = pk_to_string(&public_key);
        require!(!self.agents.contains_key(&key), "agent key already registered");
        let now = env::block_timestamp();
        self.agents.insert(
            key.clone(),
            AgentRecord {
                label: label.clone(),
                public_key: public_key.clone(),
                policy,
                native_usage: Usage::default(),
                token_usage: vec![],
                stats: Stats {
                    added_at: U64(now),
                    ..Default::default()
                },
                suspended: false,
                denial_window_start: U64(now),
                denials_in_window: 0,
                known_receivers: vec![],
            },
        );
        self.log("agent_added", Some(&key), Some(&label), None, None, None);
        let allowance = Allowance::limited(gas_allowance.unwrap_or(DEFAULT_KEY_ALLOWANCE))
            .expect("allowance must be > 0");
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            allowance,
            env::current_account_id(),
            "execute".to_string(),
        )
    }

    /// Replace an agent's policy. Usage counters are kept.
    pub fn update_policy(&mut self, public_key: PublicKey, policy: Policy) {
        self.assert_owner();
        policy.validate();
        let key = pk_to_string(&public_key);
        let label = {
            let rec = self.agents.get_mut(&key).expect("unknown agent");
            rec.policy = policy;
            rec.label.clone()
        };
        self.log("policy_updated", Some(&key), Some(&label), None, None, None);
    }

    /// Remove an agent and delete its access key. Any pending actions from it
    /// are dropped.
    pub fn remove_agent(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        let key = pk_to_string(&public_key);
        let rec = self.agents.remove(&key).expect("unknown agent");
        let stale: Vec<u64> = self
            .pending
            .iter()
            .filter(|(_, p)| p.agent_key == key)
            .map(|(id, _)| *id)
            .collect();
        for id in stale {
            self.pending.remove(&id);
        }
        self.log("agent_removed", Some(&key), Some(&rec.label), None, None, None);
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    /// Kill switch. Agents can still *call* `execute` but every action is denied.
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        self.log("paused", None, None, None, None, None);
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        self.log("unpaused", None, None, None, None, None);
    }

    /// Manually suspend an agent. Its key stays; every action is denied.
    pub fn suspend(&mut self, public_key: PublicKey) {
        self.assert_owner();
        let key = pk_to_string(&public_key);
        let rec = self.agents.get_mut(&key).expect("unknown agent");
        rec.suspended = true;
        let label = rec.label.clone();
        self.log("agent_suspended", Some(&key), Some(&label), None, None, None);
    }

    /// Lift a suspension (tripwire or manual) and reset the denial counter.
    pub fn unsuspend(&mut self, public_key: PublicKey) {
        self.assert_owner();
        let key = pk_to_string(&public_key);
        let rec = self.agents.get_mut(&key).expect("unknown agent");
        rec.suspended = false;
        rec.denials_in_window = 0;
        rec.denial_window_start = U64(env::block_timestamp());
        let label = rec.label.clone();
        self.log("agent_unsuspended", Some(&key), Some(&label), None, None, None);
    }

    /// Replace an agent key's gas allowance. NEAR allowances only go down as
    /// gas is prepaid, so this is how an owner keeps a long-lived agent alive.
    pub fn top_up_gas(&mut self, public_key: PublicKey, allowance: NearToken) -> Promise {
        self.assert_owner();
        let key = pk_to_string(&public_key);
        require!(self.agents.contains_key(&key), "unknown agent");
        let allowance = Allowance::limited(allowance).expect("allowance must be > 0");
        Promise::new(env::current_account_id())
            .delete_key(public_key.clone())
            .add_access_key_allowance(public_key, allowance, env::current_account_id(), "execute".to_string())
    }

    /// Upgrade the wallet's own code. Lets a wallet with no full-access key
    /// evolve, and keeps the owner in charge of it. The new code's `migrate`
    /// runs in the same batch, so state is never left half-converted.
    pub fn upgrade(&mut self, #[serializer(borsh)] code: Vec<u8>) -> Promise {
        self.assert_owner();
        Promise::new(env::current_account_id())
            .deploy_contract(code)
            .function_call("migrate".to_string(), b"{}".to_vec(), NearToken::from_yoctonear(0), Gas::from_tgas(50))
    }

    /// State migration hook called by `upgrade`. Today the layout is
    /// unchanged, so it reads the state as-is. When a field is added, read
    /// the previous layout struct here and map it into `Self`.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        env::state_read().expect("no state to migrate")
    }

    /// Owner moves funds out. Not subject to any agent policy.
    pub fn withdraw(&mut self, receiver: AccountId, amount: NearToken) -> Promise {
        self.assert_owner();
        Promise::new(receiver).transfer(amount)
    }

    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.assert_owner();
        self.owner = new_owner;
    }

    /// Approve a queued action. It is re-evaluated, debited and dispatched now.
    pub fn approve(&mut self, id: u64) -> PromiseOrValue<ExecResult> {
        self.assert_owner();
        require!(!self.paused, "wallet is paused");
        let pending = self.pending.remove(&id).expect("unknown pending id");
        let now = env::block_timestamp();
        let price = self.fresh_price();
        let (outcome, label) = {
            let rec = self
                .agents
                .get_mut(&pending.agent_key)
                .expect("agent no longer registered");
            let label = rec.label.clone();
            let token_usage = match &pending.action {
                Action::FtTransfer { token, .. } => rec.token_usage(token).cloned(),
                Action::IntentsDeposit { token: Some(token), .. } => rec.token_usage(token).cloned(),
                _ => None,
            };
            // Re-evaluate: caps may have been consumed since it was queued.
            if rec.policy.uses_usd() && price.is_none() {
                env::panic_str("NEAR/USD price is stale; call refresh_price (or set_price) and approve again");
            }
            let outcome = match policy::evaluate(
                &rec.policy,
                &rec.native_usage,
                token_usage.as_ref(),
                &pending.action,
                now,
                price,
            ) {
                Err(reason) => {
                    rec.stats.denied += 1;
                    let tripped = rec.note_denial(now);
                    Outcome::Denied(reason, tripped)
                }
                Ok(charge) => {
                    require!(
                        charge.native <= available_balance(),
                        format!(
                            "wallet has only {} free; top it up and approve again",
                            available_balance()
                        )
                    );
                    rec.stats.approved += 1;
                    rec.debit(&charge, now);
                    if let Some(r) = receiver_of(&pending.action) {
                        if !rec.known_receivers.contains(r) && rec.known_receivers.len() < 256 {
                            rec.known_receivers.push(r.clone());
                        }
                    }
                    Outcome::Exec(charge)
                }
            };
            (outcome, label)
        };
        match outcome {
            Outcome::Denied(reason, tripped) => {
                self.log(
                    "action_denied",
                    Some(&pending.agent_key),
                    Some(&label),
                    Some(&pending.action),
                    Some(&reason),
                    Some(id),
                );
                if tripped {
                    self.log("agent_tripped", Some(&pending.agent_key), Some(&label), None, None, None);
                }
                PromiseOrValue::Value(ExecResult::Denied { reason })
            }
            Outcome::Exec(charge) => {
                self.log(
                    "action_approved",
                    Some(&pending.agent_key),
                    Some(&label),
                    Some(&pending.action),
                    None,
                    Some(id),
                );
                PromiseOrValue::Promise(self.dispatch(pending.agent_key, pending.action, charge))
            }
            Outcome::Queued => unreachable!(),
        }
    }

    pub fn reject(&mut self, id: u64) {
        self.assert_owner();
        let pending = self.pending.remove(&id).expect("unknown pending id");
        let label = match self.agents.get_mut(&pending.agent_key) {
            Some(rec) => {
                rec.stats.rejected += 1;
                Some(rec.label.clone())
            }
            None => None,
        };
        self.log(
            "action_rejected",
            Some(&pending.agent_key),
            label.as_deref(),
            Some(&pending.action),
            None,
            Some(id),
        );
    }

    // ---------------------------------------------------------------- agent

    /// The only method an agent key can call. Evaluates the action against the
    /// agent's policy and either executes it, queues it for approval, or
    /// records a denial. Denials return normally (no panic) so they are
    /// written to chain history.
    ///
    /// If the policy has USD caps and the cached price is stale, the wallet
    /// first refreshes the price from its on-chain source, then evaluates.
    pub fn execute(&mut self, action: Action) -> PromiseOrValue<ExecResult> {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "execute must be signed with an agent key on this wallet"
        );
        let key = pk_to_string(&env::signer_account_pk());
        let needs_price = self
            .agents
            .get(&key)
            .expect("unknown agent key")
            .policy
            .uses_usd();
        if needs_price && self.fresh_price().is_none() {
            if let Some(fetch) = self.price_fetch_promise() {
                return PromiseOrValue::Promise(fetch.then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(EXECUTE_AFTER_REFRESH_GAS)
                        .execute_after_refresh(key, action),
                ));
            }
        }
        self.run_action(key, action)
    }

    /// Second half of `execute` when a price refresh was needed first.
    /// The refresh callback has already stored the price (or not, if the
    /// source failed, in which case evaluation denies with a clear reason).
    #[private]
    pub fn execute_after_refresh(&mut self, agent_key: String, action: Action) -> PromiseOrValue<ExecResult> {
        self.run_action(agent_key, action)
    }

    fn run_action(&mut self, key: String, action: Action) -> PromiseOrValue<ExecResult> {
        let now = env::block_timestamp();
        let paused = self.paused;
        let price = self.fresh_price();
        let (outcome, label) = {
            let rec = self.agents.get_mut(&key).expect("unknown agent key");
            let label = rec.label.clone();
            rec.stats.last_active = U64(now);
            let outcome = if paused {
                rec.stats.denied += 1;
                Outcome::Denied("wallet is paused".to_string(), false)
            } else if rec.suspended {
                rec.stats.denied += 1;
                Outcome::Denied("agent is suspended; the owner must unsuspend it".to_string(), false)
            } else {
                let token_usage = match &action {
                    Action::FtTransfer { token, .. } => rec.token_usage(token).cloned(),
                    Action::IntentsDeposit { token: Some(token), .. } => rec.token_usage(token).cloned(),
                    _ => None,
                };
                match policy::evaluate(
                    &rec.policy,
                    &rec.native_usage,
                    token_usage.as_ref(),
                    &action,
                    now,
                    price,
                ) {
                    Err(reason) => {
                        rec.stats.denied += 1;
                        let tripped = rec.note_denial(now);
                        Outcome::Denied(reason, tripped)
                    }
                    Ok(charge) if charge.native > available_balance() => {
                        rec.stats.denied += 1;
                        Outcome::Denied(
                            format!(
                                "insufficient wallet balance: {} free, {} requested",
                                available_balance(),
                                charge.native
                            ),
                            false,
                        )
                    }
                    Ok(charge) if charge.needs_approval => {
                        rec.stats.queued += 1;
                        Outcome::Queued
                    }
                    Ok(_)
                        if rec.policy.approve_new_receivers
                            && receiver_of(&action).map_or(false, |r| !rec.known_receivers.contains(r)) =>
                    {
                        rec.stats.queued += 1;
                        Outcome::Queued
                    }
                    Ok(charge) => {
                        rec.debit(&charge, now);
                        Outcome::Exec(charge)
                    }
                }
            };
            (outcome, label)
        };
        match outcome {
            Outcome::Denied(reason, tripped) => {
                self.log("action_denied", Some(&key), Some(&label), Some(&action), Some(&reason), None);
                if tripped {
                    self.log("agent_tripped", Some(&key), Some(&label), None, None, None);
                }
                PromiseOrValue::Value(ExecResult::Denied { reason })
            }
            Outcome::Queued => {
                let id = self.next_pending_id;
                self.next_pending_id += 1;
                self.log("action_queued", Some(&key), Some(&label), Some(&action), None, Some(id));
                self.pending.insert(
                    id,
                    PendingAction {
                        id,
                        agent_key: key,
                        action,
                        created_at: U64(now),
                    },
                );
                PromiseOrValue::Value(ExecResult::Queued { id })
            }
            Outcome::Exec(charge) => {
                self.log("action_executed", Some(&key), Some(&label), Some(&action), None, None);
                PromiseOrValue::Promise(self.dispatch(key, action, charge))
            }
        }
    }

    // ---------------------------------------------------------------- price

    /// Cached price if it is younger than `price_max_age_secs`.
    fn fresh_price(&self) -> Option<u64> {
        let (cents, at) = self.price?;
        let age = env::block_timestamp().saturating_sub(at) / policy::NS_PER_SEC;
        (age <= self.price_max_age_secs).then_some(cents)
    }

    fn store_price(&mut self, cents: u64) -> bool {
        if !(PRICE_MIN_CENTS..=PRICE_MAX_CENTS).contains(&cents) {
            env::log_str(&format!("price {cents} cents rejected: outside sanity bounds"));
            return false;
        }
        self.price = Some((cents, env::block_timestamp()));
        events::emit("price_updated", &near_sdk::serde_json::json!({ "cents_per_near": cents }));
        true
    }

    /// Owner or feeder pushes a price. Always allowed, so a stuck on-chain
    /// source never locks USD-capped agents out.
    pub fn set_price(&mut self, cents_per_near: u64) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner || Some(&caller) == self.price_feeder.as_ref(),
            "only the owner or the price feeder can set the price"
        );
        require!(self.store_price(cents_per_near), "price outside sanity bounds");
    }

    pub fn set_price_source(&mut self, source: PriceSource, max_age_secs: u64, feeder: Option<AccountId>) {
        self.assert_owner();
        require!(max_age_secs >= 30, "max_age_secs must be at least 30");
        self.price_source = source;
        self.price_max_age_secs = max_age_secs;
        self.price_feeder = feeder;
    }

    /// Pull a fresh price from the configured on-chain source. Anyone may
    /// call this; it only costs gas. Returns false when the source is Manual.
    pub fn refresh_price(&mut self) -> PromiseOrValue<bool> {
        match self.price_fetch_promise() {
            Some(p) => PromiseOrValue::Promise(p),
            None => PromiseOrValue::Value(false),
        }
    }

    /// Promise that fetches from the source and stores the result. None for Manual.
    fn price_fetch_promise(&self) -> Option<Promise> {
        let me = env::current_account_id();
        match &self.price_source {
            PriceSource::Manual => None,
            PriceSource::RefPool {
                contract,
                pool_id,
                stable_decimals,
            } => {
                let args = near_sdk::serde_json::json!({ "pool_id": pool_id }).to_string().into_bytes();
                Some(
                    Promise::new(contract.clone())
                        .function_call("get_pool".to_string(), args, NearToken::from_yoctonear(0), PRICE_FETCH_GAS)
                        .then(
                            Self::ext(me)
                                .with_static_gas(PRICE_CALLBACK_GAS)
                                .on_ref_pool(*stable_decimals),
                        ),
                )
            }
            PriceSource::Oracle { contract, asset_id } => {
                let args = near_sdk::serde_json::json!({ "asset_ids": [asset_id] }).to_string().into_bytes();
                Some(
                    Promise::new(contract.clone())
                        .function_call("get_price_data".to_string(), args, NearToken::from_yoctonear(0), PRICE_FETCH_GAS)
                        .then(Self::ext(me).with_static_gas(PRICE_CALLBACK_GAS).on_oracle_price()),
                )
            }
        }
    }

    #[private]
    pub fn on_ref_pool(
        &mut self,
        stable_decimals: u8,
        #[callback_result] pool: Result<RefPoolView, PromiseError>,
    ) -> bool {
        let Ok(pool) = pool else {
            env::log_str("price refresh failed: pool view errored");
            return false;
        };
        if pool.token_account_ids.len() != 2 || pool.amounts.len() != 2 {
            env::log_str("price refresh failed: not a two-token pool");
            return false;
        }
        // wNEAR is the 24-decimal side. The other side is the stablecoin.
        let wnear_idx = match pool
            .token_account_ids
            .iter()
            .position(|t| t.as_str().starts_with("wrap."))
        {
            Some(i) => i,
            None => {
                env::log_str("price refresh failed: no wrap.* token in pool");
                return false;
            }
        };
        let near_amt = pool.amounts[wnear_idx].0;
        let stable_amt = pool.amounts[1 - wnear_idx].0;
        if near_amt == 0 {
            return false;
        }
        // cents = stable / 10^sd * 100 / (near / 10^24)
        //       = stable * 100 * 10^24 / (10^sd * near)
        // Reduce first so the product stays inside u128: near / 1e18 = micro-NEAR.
        let micro_near = near_amt / 1_000_000_000_000_000_000u128;
        if micro_near == 0 {
            return false;
        }
        let denom = micro_near.saturating_mul(10u128.pow(stable_decimals as u32));
        let cents = stable_amt.saturating_mul(100).saturating_mul(1_000_000) / denom;
        self.store_price(cents.min(u64::MAX as u128) as u64)
    }

    #[private]
    pub fn on_oracle_price(&mut self, #[callback_result] data: Result<OraclePriceData, PromiseError>) -> bool {
        let price = match data {
            Ok(d) => d.prices.into_iter().next().and_then(|p| p.price),
            Err(_) => None,
        };
        let Some(p) = price else {
            env::log_str("price refresh failed: oracle has no fresh price");
            return false;
        };
        // price = multiplier / 10^(decimals - 24) USD per NEAR.
        let cents = if p.decimals >= 24 {
            p.multiplier.0.saturating_mul(100) / 10u128.pow((p.decimals - 24) as u32)
        } else {
            p.multiplier.0.saturating_mul(100).saturating_mul(10u128.pow((24 - p.decimals) as u32))
        };
        self.store_price(cents.min(u64::MAX as u128) as u64)
    }

    pub fn get_price(&self) -> Option<PriceQuote> {
        let (cents, at) = self.price?;
        Some(PriceQuote {
            cents_per_near: cents,
            updated_at: U64(at),
            source: match &self.price_source {
                PriceSource::Manual => "manual".to_string(),
                PriceSource::RefPool { contract, pool_id, .. } => format!("{contract} pool {pool_id}"),
                PriceSource::Oracle { contract, asset_id } => format!("{contract} {asset_id}"),
            },
            fresh: self.fresh_price().is_some(),
            max_age_secs: self.price_max_age_secs,
        })
    }

    pub fn get_price_source(&self) -> PriceSource {
        self.price_source.clone()
    }

    /// Dry run. Same evaluation as `execute`, no state change, callable by anyone.
    pub fn check(&self, public_key: PublicKey, action: Action) -> Verdict {
        let deny = |reason: String| Verdict {
            allowed: false,
            needs_approval: false,
            reason: Some(reason),
        };
        let key = pk_to_string(&public_key);
        let rec = match self.agents.get(&key) {
            Some(r) => r,
            None => return deny("unknown agent key".into()),
        };
        if self.paused {
            return deny("wallet is paused".into());
        }
        if rec.suspended {
            return deny("agent is suspended".into());
        }
        let token_usage = match &action {
            Action::FtTransfer { token, .. } => rec.token_usage(token),
            Action::IntentsDeposit { token: Some(token), .. } => rec.token_usage(token),
            _ => None,
        };
        match policy::evaluate(
            &rec.policy,
            &rec.native_usage,
            token_usage,
            &action,
            env::block_timestamp(),
            self.fresh_price(),
        ) {
            Ok(c) if c.native > available_balance() => deny(format!(
                "insufficient wallet balance: {} free",
                available_balance()
            )),
            Ok(c) => Verdict {
                allowed: true,
                needs_approval: c.needs_approval
                    || (rec.policy.approve_new_receivers
                        && receiver_of(&action).map_or(false, |r| !rec.known_receivers.contains(r))),
                reason: None,
            },
            Err(reason) => deny(reason),
        }
    }

    // ---------------------------------------------------------------- views

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn get_agent(&self, public_key: PublicKey) -> Option<AgentRecord> {
        self.agents.get(&pk_to_string(&public_key)).cloned()
    }

    pub fn list_agents(&self) -> Vec<AgentRecord> {
        self.agents.values().cloned().collect()
    }

    pub fn get_pending(&self) -> Vec<PendingAction> {
        self.pending.values().cloned().collect()
    }

    /// Most recent decisions first. `limit` defaults to 50, max 100.
    pub fn get_history(&self, limit: Option<u32>) -> Vec<HistoryEntry> {
        let limit = limit.unwrap_or(50).min(HISTORY_CAP as u32) as u64;
        let len = self.history.len() as u64;
        let mut out = Vec::new();
        let mut seq = self.history_seq;
        while seq > 0 && (out.len() as u64) < limit && self.history_seq - seq < len {
            seq -= 1;
            if let Some(e) = self.history.get((seq % HISTORY_CAP) as u32) {
                out.push(e.clone());
            }
        }
        out
    }

    /// Remaining budget for an agent right now, after rolling the window.
    pub fn get_remaining(&self, public_key: PublicKey) -> Option<Remaining> {
        let rec = self.agents.get(&pk_to_string(&public_key))?;
        let now = env::block_timestamp();
        let mut nu = rec.native_usage.clone();
        nu.roll(now, rec.policy.window_secs);
        let native = rec
            .policy
            .window_cap
            .as_yoctonear()
            .saturating_sub(nu.spent.0);
        let tokens = rec
            .policy
            .tokens
            .iter()
            .map(|t| {
                let mut tu = rec.token_usage(&t.token).cloned().unwrap_or_default();
                tu.roll(now, rec.policy.window_secs);
                (t.token.clone(), U128(t.window_cap.0.saturating_sub(tu.spent.0)))
            })
            .collect();
        let actions = if rec.policy.max_tx_per_window == 0 {
            None
        } else {
            Some(rec.policy.max_tx_per_window.saturating_sub(nu.count))
        };
        let usd_cents = rec
            .policy
            .window_cap_usd_cents
            .map(|cap| cap.saturating_sub(nu.spent_usd_cents));
        Some(Remaining {
            native: NearToken::from_yoctonear(native),
            wallet_free: available_balance(),
            usd_cents,
            tokens,
            actions,
            window_resets_at: U64(
                nu.window_start
                    .0
                    .saturating_add(rec.policy.window_secs * policy::NS_PER_SEC),
            ),
        })
    }

    // ------------------------------------------------------------ internals

    /// Emit the NEP-297 event and remember it in the on-chain ring buffer.
    fn log(
        &mut self,
        event: &str,
        agent_key: Option<&str>,
        label: Option<&str>,
        action: Option<&Action>,
        reason: Option<&str>,
        pending_id: Option<u64>,
    ) {
        events::emit(
            event,
            &EventData {
                agent_key,
                label,
                action,
                reason,
                pending_id,
            },
        );
        let entry = HistoryEntry {
            seq: self.history_seq,
            event: event.to_string(),
            agent_key: agent_key.map(str::to_string),
            label: label.map(str::to_string),
            action: action.cloned(),
            reason: reason.map(str::to_string),
            pending_id,
            timestamp: U64(env::block_timestamp()),
            block_height: U64(env::block_height()),
        };
        let idx = (self.history_seq % HISTORY_CAP) as u32;
        if (self.history.len() as u64) < HISTORY_CAP {
            self.history.push(entry);
        } else {
            self.history.replace(idx, entry);
        }
        self.history_seq += 1;
    }

    fn dispatch(&mut self, agent_key: String, action: Action, charge: Charge) -> Promise {
        let promise = match &action {
            Action::Transfer { receiver, amount } => Promise::new(receiver.clone()).transfer(*amount),
            Action::FtTransfer {
                token,
                receiver,
                amount,
                memo,
            } => {
                let args = near_sdk::serde_json::json!({
                    "receiver_id": receiver,
                    "amount": amount,
                    "memo": memo,
                });
                Promise::new(token.clone()).function_call(
                    "ft_transfer".to_string(),
                    args.to_string().into_bytes(),
                    NearToken::from_yoctonear(1),
                    FT_TRANSFER_GAS,
                )
            }
            Action::IntentsDeposit {
                deposit_address,
                amount,
                token,
                ..
            } => match token {
                None => Promise::new(deposit_address.clone()).transfer(NearToken::from_yoctonear(amount.0)),
                Some(t) => {
                    let args = near_sdk::serde_json::json!({
                        "receiver_id": deposit_address,
                        "amount": amount,
                        "memo": "near-intents deposit",
                    });
                    Promise::new(t.clone()).function_call(
                        "ft_transfer".to_string(),
                        args.to_string().into_bytes(),
                        NearToken::from_yoctonear(1),
                        FT_TRANSFER_GAS,
                    )
                }
            },
            Action::FunctionCall {
                contract,
                method,
                args,
                deposit,
                gas_tgas,
            } => Promise::new(contract.clone()).function_call(
                method.clone(),
                args.clone().into_bytes(),
                *deposit,
                gas_tgas
                    .map(|g| Gas::from_tgas(g as u64))
                    .unwrap_or(DEFAULT_CALL_GAS),
            ),
        };
        let (token, token_amount) = match &charge.token {
            Some((t, a)) => (Some(t.clone()), U128(*a)),
            None => (None, U128(0)),
        };
        promise.then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_action_done(agent_key, action, charge.native, charge.usd_cents, token, token_amount),
        )
    }

    #[private]
    pub fn on_action_done(
        &mut self,
        agent_key: String,
        action: Action,
        native: NearToken,
        usd_cents: u64,
        token: Option<AccountId>,
        token_amount: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> ExecResult {
        let label = match self.agents.get_mut(&agent_key) {
            Some(rec) => match result {
                Ok(()) => {
                    rec.stats.executed += 1;
                    return ExecResult::Executed;
                }
                Err(_) => {
                    // The protocol refunds the deposit/transfer on failure, so give
                    // the budget back too.
                    rec.refund(native, usd_cents, token.map(|t| (t, token_amount.0)));
                    rec.stats.failed += 1;
                    rec.label.clone()
                }
            },
            None => return ExecResult::Executed,
        };
        let reason = "on-chain action failed".to_string();
        self.log(
            "action_failed",
            Some(&agent_key),
            Some(&label),
            Some(&action),
            Some(&reason),
            None,
        );
        ExecResult::Failed { reason }
    }
}
