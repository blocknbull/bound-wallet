//! NEP-297 events. Every decision the wallet makes is logged so indexers,
//! dashboards and reputation systems can replay an agent's history.

use near_sdk::serde::Serialize;
use near_sdk::{env, serde_json};

pub const STANDARD: &str = "bound-wallet";
pub const VERSION: &str = "1.0.0";

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Envelope<'a, T: Serialize> {
    standard: &'a str,
    version: &'a str,
    event: &'a str,
    data: [&'a T; 1],
}

pub fn emit<T: Serialize>(event: &str, data: &T) {
    let e = Envelope {
        standard: STANDARD,
        version: VERSION,
        event,
        data: [data],
    };
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::to_string(&e).expect("event serialize")
    ));
}
