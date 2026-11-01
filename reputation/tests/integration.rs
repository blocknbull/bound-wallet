//! Registry against a real Bound wallet in the sandbox: register, verify,
//! sync, score, and sync again without double counting.

use near_sdk::NearToken;
use near_workspaces::types::{Gas, KeyType, SecretKey};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const WALLET_WASM: &[u8] = include_bytes!("../../contract/target/near/bound_wallet.wasm");
const REGISTRY_WASM: &[u8] = include_bytes!("../../contract/target/near/bound_reputation.wasm");
const EXEC_GAS: Gas = Gas::from_tgas(100);

struct World {
    worker: Worker<near_workspaces::network::Sandbox>,
    owner: Account,
    wallet: Contract,
    registry: Contract,
    vendor: Account,
    agent_sk: SecretKey,
}

async fn setup() -> anyhow::Result<World> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let vendor = worker.dev_create_account().await?;

    let wallet = owner
        .create_subaccount("agent")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?
        .deploy(WALLET_WASM)
        .await?
        .into_result()?;
    owner.call(wallet.id(), "new").args_json(json!({ "owner": owner.id() })).transact().await?.into_result()?;

    let registry = worker.dev_deploy(REGISTRY_WASM).await?;
    owner.call(registry.id(), "new").args_json(json!({ "owner": owner.id() })).transact().await?.into_result()?;

    let agent_sk = SecretKey::from_random(KeyType::ED25519);
    let policy = json!({
        "max_per_tx": NearToken::from_near(1),
        "window_cap": NearToken::from_near(10),
        "window_secs": 86400,
        "max_tx_per_window": 0,
        "receivers": { "Allowlist": [vendor.id()] },
        "calls": [], "tokens": [],
        "active_hours_utc": null, "expires_at": null, "approval_above": null,
    });
    owner
        .call(wallet.id(), "add_agent")
        .args_json(json!({ "public_key": agent_sk.public_key(), "label": "buyer", "policy": policy, "gas_allowance": NearToken::from_near(10) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    Ok(World { worker, owner, wallet, registry, vendor, agent_sk })
}

async fn act(w: &World, receiver: &near_workspaces::AccountId, amount: NearToken) -> anyhow::Result<Value> {
    let agent = Account::from_secret_key(w.wallet.id().clone(), w.agent_sk.clone(), &w.worker);
    Ok(agent
        .call(w.wallet.id(), "execute")
        .args_json(json!({ "action": { "Transfer": { "receiver": receiver, "amount": amount } } }))
        .gas(EXEC_GAS)
        .transact()
        .await?
        .into_result()?
        .json()?)
}

#[tokio::test]
async fn history_becomes_a_score() -> anyhow::Result<()> {
    let w = setup().await?;
    let stranger = w.worker.dev_create_account().await?;
    let pk = serde_json::to_value(w.agent_sk.public_key())?.as_str().unwrap().to_string();

    // 3 executed, 2 denied.
    for _ in 0..3 {
        assert_eq!(act(&w, w.vendor.id(), NearToken::from_millinear(100)).await?, json!("Executed"));
    }
    for _ in 0..2 {
        assert!(act(&w, stranger.id(), NearToken::from_millinear(100)).await?["Denied"].is_object());
    }

    // Anyone registers the wallet; the registry learns its owner.
    stranger
        .call(w.registry.id(), "register")
        .args_json(json!({ "wallet": w.wallet.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let info: Value = w.registry.view("get_wallet").args_json(json!({ "wallet": w.wallet.id() })).await?.json()?;
    assert_eq!(info["owner"], json!(w.owner.id()));
    assert_eq!(info["verified"], json!(false));

    // Unverified sync: events land in the unverified bucket and do not score.
    let n: Value = stranger
        .call(w.registry.id(), "sync")
        .args_json(json!({ "wallet": w.wallet.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(n, json!(5)); // 3 executed + 2 denied (agent_added has no counter)
    let s: Value = w.registry.view("get_score").args_json(json!({ "public_key": pk })).await?.json()?;
    assert_eq!(s["unverified"]["executed"], json!(3));
    assert_eq!(s["unverified"]["denied"], json!(2));
    assert_eq!(s["scored_events"], json!(0));
    assert_eq!(s["tier"], json!("new"));

    // Owner verifies; new activity is scored from here on.
    w.owner
        .call(w.registry.id(), "verify")
        .args_json(json!({ "wallet": w.wallet.id(), "verified": true }))
        .transact()
        .await?
        .into_result()?;
    for _ in 0..6 {
        assert_eq!(act(&w, w.vendor.id(), NearToken::from_millinear(100)).await?, json!("Executed"));
    }
    assert!(act(&w, stranger.id(), NearToken::from_millinear(100)).await?["Denied"].is_object());
    let n: Value = stranger
        .call(w.registry.id(), "sync")
        .args_json(json!({ "wallet": w.wallet.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(n, json!(7));

    let s: Value = w.registry.view("get_score").args_json(json!({ "public_key": pk })).await?.json()?;
    assert_eq!(s["verified"]["executed"], json!(6));
    assert_eq!(s["verified"]["denied"], json!(1));
    assert_eq!(s["scored_events"], json!(7));
    // good 6, bad 2: 100 * 7 / 10 = 70 -> caution
    assert_eq!(s["score"], json!(70));
    assert_eq!(s["tier"], json!("caution"));
    assert_eq!(s["labels"], json!(["buyer"]));
    assert_eq!(s["wallets"], json!([w.wallet.id()]));

    // Syncing again with nothing new counts nothing.
    let n: Value = stranger
        .call(w.registry.id(), "sync")
        .args_json(json!({ "wallet": w.wallet.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(n, json!(0));
    let s2: Value = w.registry.view("get_score").args_json(json!({ "public_key": pk })).await?.json()?;
    assert_eq!(s2["verified"], s["verified"]);

    // The wallet owner can give the agent a handle; strangers cannot.
    let r = stranger
        .call(w.registry.id(), "claim_handle")
        .args_json(json!({ "handle": "acme-buyer", "wallet": w.wallet.id(), "public_key": pk }))
        .transact()
        .await?;
    assert!(r.is_failure());
    w.owner
        .call(w.registry.id(), "claim_handle")
        .args_json(json!({ "handle": "acme-buyer", "wallet": w.wallet.id(), "public_key": pk }))
        .transact()
        .await?
        .into_result()?;
    let by_handle: Value = w.registry.view("resolve_handle").args_json(json!({ "handle": "acme-buyer" })).await?.json()?;
    assert_eq!(by_handle["public_key"], json!(pk));
    assert_eq!(by_handle["handle"], json!("acme-buyer"));
    let r = w.owner
        .call(w.registry.id(), "claim_handle")
        .args_json(json!({ "handle": "acme-buyer", "wallet": w.wallet.id(), "public_key": pk }))
        .transact()
        .await?;
    assert!(r.is_failure(), "handles are first come first served");

    // Only the registry owner can verify.
    let r = stranger
        .call(w.registry.id(), "verify")
        .args_json(json!({ "wallet": w.wallet.id(), "verified": false }))
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}
