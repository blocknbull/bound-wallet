//! Bound Reputation: a registry that turns Bound Wallet decision history into
//! a score per agent key.
//!
//! Every Bound wallet remembers its last 100 decisions on chain
//! (`get_history`). This contract pulls that history from registered wallets,
//! folds it into per-agent counters, and exposes a score anyone can read
//! before trusting an agent: an Agent Market requester, another agent, or a
//! wallet owner deciding how long a leash to give.
//!
//! Trust model: anyone can register a wallet, but only events from wallets the
//! registry owner has `verify`d (after checking the deployed code hash
//! off-chain) count toward the score. Unverified events are kept separately so
//! nothing is lost, and nothing is faked into a score.

use near_sdk::json_types::U64;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, PanicOnDefault, Promise, PromiseError, PromiseOrValue};

const SYNC_GAS: Gas = Gas::from_tgas(20);
const CALLBACK_GAS: Gas = Gas::from_tgas(20);
const HISTORY_LIMIT: u32 = 100;
/// Below this many scored events an agent is "new", whatever the ratio says.
const NEW_THRESHOLD: u64 = 5;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Wallets,
    Agents,
    Handles,
}

/// Handles are lowercase, 3 to 32 chars, letters, digits and hyphens.
fn valid_handle(h: &str) -> bool {
    let len = h.len();
    (3..=32).contains(&len)
        && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !h.starts_with('-')
        && !h.ends_with('-')
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Counters {
    pub executed: u64,
    pub denied: u64,
    pub failed: u64,
    pub approved: u64,
    pub rejected: u64,
    pub queued: u64,
}

impl Counters {
    fn total(&self) -> u64 {
        self.executed + self.denied + self.failed + self.approved + self.rejected
    }

    fn apply(&mut self, event: &str) -> bool {
        match event {
            "action_executed" => self.executed += 1,
            "action_denied" => self.denied += 1,
            "action_failed" => self.failed += 1,
            "action_approved" => self.approved += 1,
            "action_rejected" => self.rejected += 1,
            "action_queued" => self.queued += 1,
            _ => return false,
        }
        true
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct WalletInfo {
    pub wallet: AccountId,
    pub owner: Option<AccountId>,
    pub verified: bool,
    pub registered_by: AccountId,
    pub registered_at: U64,
    /// Next history `seq` to process. Everything below it is already counted.
    pub next_seq: u64,
    pub synced_at: U64,
    pub events: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRep {
    pub public_key: String,
    /// Human-readable Agent ID claimed by the wallet owner, e.g. "acme-buyer".
    pub handle: Option<String>,
    pub labels: Vec<String>,
    pub wallets: Vec<AccountId>,
    pub verified: Counters,
    pub unverified: Counters,
    pub first_seen: U64,
    pub last_seen: U64,
    pub last_denied: Option<U64>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Score {
    pub public_key: String,
    pub handle: Option<String>,
    /// 0 to 100. Only verified wallets count.
    pub score: u8,
    /// "new", "trusted", "caution" or "risky".
    pub tier: String,
    pub scored_events: u64,
    pub verified: Counters,
    pub unverified: Counters,
    pub wallets: Vec<AccountId>,
    pub labels: Vec<String>,
    pub first_seen: U64,
    pub last_seen: U64,
    pub last_denied: Option<U64>,
}

/// The fields of a Bound wallet `HistoryEntry` this registry reads. Unknown
/// fields (the action body) are ignored on deserialization.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct HistoryEntry {
    pub seq: u64,
    pub event: String,
    pub agent_key: Option<String>,
    pub label: Option<String>,
    pub timestamp: U64,
}

/// Pure scoring so it is unit-testable and the formula is in one place.
/// good = executed + approved - failed (a failed action was logged as executed first)
/// bad  = 2 * denied + 3 * failed + rejected
/// score = 100 * (good + 1) / (good + bad + 2), Laplace-smoothed.
pub fn score_of(c: &Counters) -> (u8, &'static str) {
    let good = (c.executed + c.approved).saturating_sub(c.failed);
    let bad = 2 * c.denied + 3 * c.failed + c.rejected;
    let score = (100 * (good + 1)) / (good + bad + 2);
    let score = score.min(100) as u8;
    let tier = if c.total() < NEW_THRESHOLD {
        "new"
    } else if score >= 90 {
        "trusted"
    } else if score >= 70 {
        "caution"
    } else {
        "risky"
    };
    (score, tier)
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    wallets: IterableMap<AccountId, WalletInfo>,
    agents: IterableMap<String, AgentRep>,
    /// handle -> agent public key
    handles: IterableMap<String, String>,
}

#[near]
impl Registry {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            wallets: IterableMap::new(StorageKey::Wallets),
            agents: IterableMap::new(StorageKey::Agents),
            handles: IterableMap::new(StorageKey::Handles),
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the registry owner can do this");
    }

    // ------------------------------------------------------------ wallets

    /// Register a Bound wallet. Anyone can. The wallet's owner is looked up
    /// so consumers can see who stands behind the history.
    pub fn register(&mut self, wallet: AccountId) -> Promise {
        require!(!self.wallets.contains_key(&wallet), "wallet already registered");
        self.wallets.insert(
            wallet.clone(),
            WalletInfo {
                wallet: wallet.clone(),
                owner: None,
                verified: false,
                registered_by: env::predecessor_account_id(),
                registered_at: U64(env::block_timestamp()),
                next_seq: 0,
                synced_at: U64(0),
                events: 0,
            },
        );
        Promise::new(wallet.clone())
            .function_call("get_owner".to_string(), b"{}".to_vec(), near_sdk::NearToken::from_yoctonear(0), SYNC_GAS)
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_owner(wallet))
    }

    #[private]
    pub fn on_owner(&mut self, wallet: AccountId, #[callback_result] owner: Result<AccountId, PromiseError>) {
        if let (Ok(owner), Some(info)) = (owner, self.wallets.get_mut(&wallet)) {
            info.owner = Some(owner);
        }
    }

    /// Registry owner marks a wallet as a genuine Bound wallet (code hash
    /// checked off-chain). Only verified wallets feed the score.
    pub fn verify(&mut self, wallet: AccountId, verified: bool) {
        self.assert_owner();
        let info = self.wallets.get_mut(&wallet).expect("wallet not registered");
        info.verified = verified;
    }

    /// Pull new history from a wallet and fold it in. Anyone can call; it
    /// only costs gas. Idempotent: entries below `next_seq` are skipped.
    pub fn sync(&mut self, wallet: AccountId) -> PromiseOrValue<u64> {
        require!(self.wallets.contains_key(&wallet), "wallet not registered");
        let args = near_sdk::serde_json::json!({ "limit": HISTORY_LIMIT }).to_string().into_bytes();
        PromiseOrValue::Promise(
            Promise::new(wallet.clone())
                .function_call("get_history".to_string(), args, near_sdk::NearToken::from_yoctonear(0), SYNC_GAS)
                .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_history(wallet)),
        )
    }

    /// Returns how many new events were counted.
    #[private]
    pub fn on_history(&mut self, wallet: AccountId, #[callback_result] history: Result<Vec<HistoryEntry>, PromiseError>) -> u64 {
        let Ok(mut history) = history else {
            env::log_str("sync failed: wallet did not return history");
            return 0;
        };
        let (next_seq, verified) = match self.wallets.get(&wallet) {
            Some(i) => (i.next_seq, i.verified),
            None => return 0,
        };
        history.sort_by_key(|e| e.seq);
        let mut counted = 0u64;
        let mut max_seq = next_seq;
        for e in history.into_iter().filter(|e| e.seq >= next_seq) {
            max_seq = max_seq.max(e.seq + 1);
            let Some(key) = e.agent_key.clone() else { continue };
            let rec = self.agents.entry(key.clone()).or_insert_with(|| AgentRep {
                public_key: key.clone(),
                handle: None,
                labels: vec![],
                wallets: vec![],
                verified: Counters::default(),
                unverified: Counters::default(),
                first_seen: e.timestamp,
                last_seen: e.timestamp,
                last_denied: None,
            });
            let counters = if verified { &mut rec.verified } else { &mut rec.unverified };
            if !counters.apply(&e.event) {
                continue;
            }
            counted += 1;
            if let Some(l) = e.label {
                if !rec.labels.contains(&l) {
                    rec.labels.push(l);
                }
            }
            if !rec.wallets.contains(&wallet) {
                rec.wallets.push(wallet.clone());
            }
            if e.timestamp.0 < rec.first_seen.0 {
                rec.first_seen = e.timestamp;
            }
            if e.timestamp.0 > rec.last_seen.0 {
                rec.last_seen = e.timestamp;
            }
            if e.event == "action_denied" || e.event == "action_rejected" {
                rec.last_denied = Some(e.timestamp);
            }
        }
        if let Some(info) = self.wallets.get_mut(&wallet) {
            info.next_seq = max_seq;
            info.synced_at = U64(env::block_timestamp());
            info.events += counted;
        }
        env::log_str(&format!("synced {wallet}: {counted} new events"));
        counted
    }

    // ------------------------------------------------------------ handles

    /// Give an agent a human-readable Agent ID. Only the owner of a wallet
    /// the agent has acted through may claim it, so a handle always points at
    /// a key somebody is accountable for. First come, first served.
    pub fn claim_handle(&mut self, handle: String, wallet: AccountId, public_key: String) {
        require!(valid_handle(&handle), "handle: 3-32 chars, a-z 0-9 and hyphens");
        require!(!self.handles.contains_key(&handle), "handle already taken");
        let info = self.wallets.get(&wallet).expect("wallet not registered");
        require!(info.owner.as_ref() == Some(&env::predecessor_account_id()), "only the wallet owner can claim a handle for its agent");
        let rec = self.agents.get_mut(&public_key).expect("agent not seen yet; sync the wallet first");
        require!(rec.wallets.contains(&wallet), "agent has not acted through that wallet");
        if let Some(old) = rec.handle.take() {
            self.handles.remove(&old);
        }
        rec.handle = Some(handle.clone());
        self.handles.insert(handle, public_key);
    }

    pub fn resolve_handle(&self, handle: String) -> Option<Score> {
        let key = self.handles.get(&handle)?.clone();
        self.get_score(key)
    }

    // -------------------------------------------------------------- views

    pub fn get_score(&self, public_key: String) -> Option<Score> {
        let rec = self.agents.get(&public_key)?;
        let (score, tier) = score_of(&rec.verified);
        Some(Score {
            public_key: rec.public_key.clone(),
            handle: rec.handle.clone(),
            score,
            tier: tier.to_string(),
            scored_events: rec.verified.total(),
            verified: rec.verified.clone(),
            unverified: rec.unverified.clone(),
            wallets: rec.wallets.clone(),
            labels: rec.labels.clone(),
            first_seen: rec.first_seen,
            last_seen: rec.last_seen,
            last_denied: rec.last_denied,
        })
    }

    pub fn get_agent(&self, public_key: String) -> Option<AgentRep> {
        self.agents.get(&public_key).cloned()
    }

    pub fn get_wallet(&self, wallet: AccountId) -> Option<WalletInfo> {
        self.wallets.get(&wallet).cloned()
    }

    pub fn list_wallets(&self) -> Vec<WalletInfo> {
        self.wallets.values().cloned().collect()
    }

    pub fn list_scores(&self, from: Option<u32>, limit: Option<u32>) -> Vec<Score> {
        let from = from.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50) as usize;
        self.agents
            .keys()
            .skip(from)
            .take(limit)
            .filter_map(|k| self.get_score(k.clone()))
            .collect()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(executed: u64, denied: u64, failed: u64, approved: u64, rejected: u64) -> Counters {
        Counters {
            executed,
            denied,
            failed,
            approved,
            rejected,
            queued: 0,
        }
    }

    #[test]
    fn fresh_agent_is_new_and_neutral() {
        assert_eq!(score_of(&c(0, 0, 0, 0, 0)), (50, "new"));
        assert_eq!(score_of(&c(2, 0, 0, 0, 0)), (75, "new"));
    }

    #[test]
    fn clean_record_is_trusted() {
        let (s, t) = score_of(&c(20, 0, 0, 2, 0));
        assert!(s >= 95, "{s}");
        assert_eq!(t, "trusted");
    }

    #[test]
    fn denials_drag_the_score_down() {
        let (s, t) = score_of(&c(10, 5, 0, 0, 0)); // 10 good, 10 bad
        assert_eq!(s, 50);
        assert_eq!(t, "risky");
        let (s, t) = score_of(&c(20, 2, 0, 0, 0)); // 20 good, 4 bad
        assert_eq!(s, 80);
        assert_eq!(t, "caution");
    }

    #[test]
    fn failures_hurt_most() {
        let (s, _) = score_of(&c(5, 0, 2, 0, 0)); // 3 good, 6 bad
        assert_eq!(s as u64, (100 * 4) / 11);
    }
}
