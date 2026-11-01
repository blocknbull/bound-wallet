//! End-to-end tests on a local NEAR sandbox: deploy the wallet, register an
//! agent key, and drive it through allow / deny / queue / approve / pause /
//! remove flows.

use near_sdk::json_types::U128;
use near_sdk::NearToken;
use near_workspaces::types::{Gas, KeyType, SecretKey};

const EXEC_GAS: Gas = Gas::from_tgas(100);
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};

const WASM: &[u8] = include_bytes!("../target/near/bound_wallet.wasm");

async fn setup() -> anyhow::Result<(
    Worker<near_workspaces::network::Sandbox>,
    Account,
    Contract,
    Account,
    SecretKey,
)> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let vendor = worker.dev_create_account().await?;

    // Wallet is a sub-account of the owner, like the CLI does it.
    let wallet_acc = owner
        .create_subaccount("agent")
        .initial_balance(NearToken::from_near(20))
        .transact()
        .await?
        .into_result()?;
    let wallet = wallet_acc.deploy(WASM).await?.into_result()?;
    owner
        .call(wallet.id(), "new")
        .args_json(json!({ "owner": owner.id() }))
        .transact()
        .await?
        .into_result()?;

    let agent_sk = SecretKey::from_random(KeyType::ED25519);
    let policy = json!({
        "max_per_tx": NearToken::from_near(1),
        "window_cap": NearToken::from_near(3),
        "window_secs": 86400,
        "max_tx_per_window": 10,
        "receivers": { "Allowlist": [vendor.id()] },
        "calls": [],
        "tokens": [],
        "active_hours_utc": null,
        "expires_at": null,
        "approval_above": NearToken::from_millinear(500),
    });
    owner
        .call(wallet.id(), "add_agent")
        .args_json(json!({
            "public_key": agent_sk.public_key(),
            "label": "buyer",
            "policy": policy,
            "gas_allowance": NearToken::from_near(10),
        }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    Ok((worker, owner, wallet, vendor, agent_sk))
}

/// An `Account` handle that signs as the wallet using the agent's key.
fn as_agent(
    worker: &Worker<near_workspaces::network::Sandbox>,
    wallet: &Contract,
    sk: &SecretKey,
) -> anyhow::Result<Account> {
    Ok(Account::from_secret_key(wallet.id().clone(), sk.clone(), worker))
}

#[tokio::test]
async fn allowed_transfer_executes_and_debits() -> anyhow::Result<()> {
    let (worker, _owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    let before = vendor.view_account().await?.balance;

    let res = agent
        .call(wallet.id(), "execute")
        .args_json(json!({ "action": { "Transfer": { "receiver": vendor.id(), "amount": NearToken::from_millinear(250) } } }))
        .gas(EXEC_GAS)
        .transact()
        .await?
        .into_result()?;
    let out: Value = res.json()?;
    assert_eq!(out, json!("Executed"));
    assert!(res.logs().iter().any(|l| l.contains("action_executed")));

    let after = vendor.view_account().await?.balance;
    assert_eq!(after.as_yoctonear() - before.as_yoctonear(), NearToken::from_millinear(250).as_yoctonear());

    let rem: Value = wallet
        .view("get_remaining")
        .args_json(json!({ "public_key": sk.public_key() }))
        .await?
        .json()?;
    assert_eq!(rem["native"], json!(NearToken::from_millinear(2750)));
    assert_eq!(rem["actions"], json!(9));
    Ok(())
}

#[tokio::test]
async fn unknown_receiver_is_denied_not_panicked() -> anyhow::Result<()> {
    let (worker, _owner, wallet, _vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    let stranger = worker.dev_create_account().await?;
    let res = agent
        .call(wallet.id(), "execute")
        .args_json(json!({ "action": { "Transfer": { "receiver": stranger.id(), "amount": NearToken::from_millinear(1) } } }))
        .gas(EXEC_GAS)
        .transact()
        .await?
        .into_result()?;
    let out: Value = res.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("allowlist"));
    assert!(res.logs().iter().any(|l| l.contains("action_denied")));

    let rec: Value = wallet
        .view("get_agent")
        .args_json(json!({ "public_key": sk.public_key() }))
        .await?
        .json()?;
    assert_eq!(rec["stats"]["denied"], json!(1));
    Ok(())
}

#[tokio::test]
async fn large_transfer_is_queued_then_approved() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    let before = vendor.view_account().await?.balance;

    let res = agent
        .call(wallet.id(), "execute")
        .args_json(json!({ "action": { "Transfer": { "receiver": vendor.id(), "amount": NearToken::from_millinear(900) } } }))
        .gas(EXEC_GAS)
        .transact()
        .await?
        .into_result()?;
    let out: Value = res.json()?;
    assert_eq!(out["Queued"]["id"], json!(1));
    assert_eq!(vendor.view_account().await?.balance, before, "nothing moved yet");

    let pending: Value = wallet.view("get_pending").await?.json()?;
    assert_eq!(pending.as_array().unwrap().len(), 1);

    let res = owner
        .call(wallet.id(), "approve")
        .args_json(json!({ "id": 1 }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let out: Value = res.json()?;
    assert_eq!(out, json!("Executed"));
    let after = vendor.view_account().await?.balance;
    assert_eq!(after.as_yoctonear() - before.as_yoctonear(), NearToken::from_millinear(900).as_yoctonear());

    let pending: Value = wallet.view("get_pending").await?.json()?;
    assert!(pending.as_array().unwrap().is_empty());

    // The wallet remembers its own decisions, newest first.
    let history: Value = wallet
        .view("get_history")
        .args_json(json!({ "limit": 10 }))
        .await?
        .json()?;
    let events: Vec<&str> = history
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(events, vec!["action_approved", "action_queued", "agent_added"]);
    assert_eq!(history[0]["pending_id"], json!(1));
    Ok(())
}

#[tokio::test]
async fn window_cap_blocks_fourth_near() -> anyhow::Result<()> {
    let (worker, _owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    let send = |amount: NearToken| {
        agent
            .call(wallet.id(), "execute")
            .args_json(json!({ "action": { "Transfer": { "receiver": vendor.id(), "amount": amount } } }))
            .gas(EXEC_GAS)
            .transact()
    };
    // 0.5 x 6 = 3 NEAR = cap. Each is <= approval_above so executes directly.
    for _ in 0..6 {
        let r = send(NearToken::from_millinear(500)).await?.into_result()?;
        assert_eq!(r.json::<Value>()?, json!("Executed"));
    }
    let r = send(NearToken::from_millinear(500)).await?.into_result()?;
    let out: Value = r.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("window cap"));
    Ok(())
}

#[tokio::test]
async fn pause_denies_everything() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    owner.call(wallet.id(), "pause").transact().await?.into_result()?;
    let r = agent
        .call(wallet.id(), "execute")
        .args_json(json!({ "action": { "Transfer": { "receiver": vendor.id(), "amount": NearToken::from_millinear(1) } } }))
        .gas(EXEC_GAS)
        .transact()
        .await?
        .into_result()?;
    let out: Value = r.json()?;
    assert_eq!(out["Denied"]["reason"], json!("wallet is paused"));
    Ok(())
}

#[tokio::test]
async fn owner_only_methods_reject_agent() -> anyhow::Result<()> {
    let (worker, _owner, wallet, _vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    // The function-call key is scoped to `execute`; calling `pause` fails at the
    // protocol level before the contract even runs.
    let r = agent.call(wallet.id(), "pause").transact().await;
    assert!(r.is_err() || r.unwrap().is_failure());
    Ok(())
}

#[tokio::test]
async fn remove_agent_deletes_key() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    owner
        .call(wallet.id(), "remove_agent")
        .args_json(json!({ "public_key": sk.public_key() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let r = agent
        .call(wallet.id(), "execute")
        .args_json(json!({ "action": { "Transfer": { "receiver": vendor.id(), "amount": NearToken::from_millinear(1) } } }))
        .gas(EXEC_GAS)
        .transact()
        .await;
    assert!(r.is_err() || r.unwrap().is_failure(), "deleted key must not sign");
    Ok(())
}

#[tokio::test]
async fn overdraw_is_a_clean_denial() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    // Loosen the policy so only the wallet balance can stop this.
    let policy = json!({
        "max_per_tx": NearToken::from_near(100),
        "window_cap": NearToken::from_near(100),
        "window_secs": 86400,
        "max_tx_per_window": 0,
        "receivers": "Any",
        "calls": [],
        "tokens": [],
        "active_hours_utc": null,
        "expires_at": null,
        "approval_above": null,
    });
    owner
        .call(wallet.id(), "update_policy")
        .args_json(json!({ "public_key": sk.public_key(), "policy": policy }))
        .transact()
        .await?
        .into_result()?;
    let r = agent
        .call(wallet.id(), "execute")
        .args_json(json!({ "action": { "Transfer": { "receiver": vendor.id(), "amount": NearToken::from_near(50) } } }))
        .gas(EXEC_GAS)
        .transact()
        .await?
        .into_result()?;
    let out: Value = r.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("insufficient wallet balance"));
    Ok(())
}

#[tokio::test]
async fn usd_caps_use_the_wallet_price() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    // $10 per action, $15 per day, no NEAR-denominated limit to speak of.
    let policy = json!({
        "max_per_tx": NearToken::from_near(100),
        "window_cap": NearToken::from_near(100),
        "window_secs": 86400,
        "max_tx_per_window": 0,
        "receivers": "Any",
        "calls": [],
        "tokens": [],
        "active_hours_utc": null,
        "expires_at": null,
        "approval_above": null,
        "max_per_tx_usd_cents": 1000,
        "window_cap_usd_cents": 1500,
    });
    owner
        .call(wallet.id(), "update_policy")
        .args_json(json!({ "public_key": sk.public_key(), "policy": policy }))
        .transact()
        .await?
        .into_result()?;
    let send = |amount: NearToken| {
        agent
            .call(wallet.id(), "execute")
            .args_json(json!({ "action": { "Transfer": { "receiver": vendor.id(), "amount": amount } } }))
            .gas(EXEC_GAS)
            .transact()
    };

    // No price yet (Manual source): denied with a clear reason, not a panic.
    let out: Value = send(NearToken::from_near(1)).await?.into_result()?.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("price unavailable"));

    // Owner pushes $4.00 per NEAR.
    owner
        .call(wallet.id(), "set_price")
        .args_json(json!({ "cents_per_near": 400 }))
        .transact()
        .await?
        .into_result()?;
    let q: Value = wallet.view("get_price").await?.json()?;
    assert_eq!(q["cents_per_near"], json!(400));
    assert_eq!(q["fresh"], json!(true));

    // 2 NEAR = $8 ok. 3 NEAR = $12 over the per-action cap. Another 2 NEAR = $16 total over the window.
    assert_eq!(send(NearToken::from_near(2)).await?.into_result()?.json::<Value>()?, json!("Executed"));
    let out: Value = send(NearToken::from_near(3)).await?.into_result()?.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("max_per_tx $10.00"));
    let out: Value = send(NearToken::from_near(2)).await?.into_result()?.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("USD window cap"));

    let rem: Value = wallet
        .view("get_remaining")
        .args_json(json!({ "public_key": sk.public_key() }))
        .await?
        .json()?;
    assert_eq!(rem["usd_cents"], json!(700));

    // Strangers cannot set the price.
    let r = vendor
        .call(wallet.id(), "set_price")
        .args_json(json!({ "cents_per_near": 1 }))
        .transact()
        .await?;
    assert!(r.is_failure());
    Ok(())
}

#[tokio::test]
async fn intents_deposit_is_policy_gated_and_recorded() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    // A per-quote deposit address is just some account the allowlist has never heard of.
    let deposit_addr = worker.dev_create_account().await?;
    let before = deposit_addr.view_account().await?.balance;
    let action = json!({ "IntentsDeposit": {
        "deposit_address": deposit_addr.id(),
        "amount": NearToken::from_millinear(300).as_yoctonear().to_string(),
        "token": null,
        "destination_asset": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
        "recipient": "0x000000000000000000000000000000000000dEaD",
        "quote_ref": "corr-123",
    }});
    let send = || agent.call(wallet.id(), "execute").args_json(json!({ "action": action })).gas(EXEC_GAS).transact();

    // Default policy: swaps are off.
    let out: Value = send().await?.into_result()?.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("NEAR Intents"));

    // Owner turns swaps on; the allowlist still only knows `vendor`, but the
    // swap deposit is governed by caps, not by the allowlist.
    let mut policy: Value = wallet
        .view("get_agent")
        .args_json(json!({ "public_key": sk.public_key() }))
        .await?
        .json::<Value>()?["policy"]
        .clone();
    policy["allow_intents"] = json!(true);
    owner
        .call(wallet.id(), "update_policy")
        .args_json(json!({ "public_key": sk.public_key(), "policy": policy }))
        .transact()
        .await?
        .into_result()?;
    let out: Value = send().await?.into_result()?.json()?;
    assert_eq!(out, json!("Executed"));
    let after = deposit_addr.view_account().await?.balance;
    assert_eq!(after.as_yoctonear() - before.as_yoctonear(), NearToken::from_millinear(300).as_yoctonear());

    // Caps still bite: 1.5 NEAR is over max_per_tx.
    let big = json!({ "IntentsDeposit": {
        "deposit_address": deposit_addr.id(),
        "amount": NearToken::from_millinear(1500).as_yoctonear().to_string(),
        "token": null, "destination_asset": "x", "recipient": "y", "quote_ref": "z",
    }});
    let out: Value = agent.call(wallet.id(), "execute").args_json(json!({ "action": big })).gas(EXEC_GAS).transact().await?.into_result()?.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("max_per_tx"));

    // The audit trail keeps the destination, not just the deposit address.
    let history: Value = wallet.view("get_history").args_json(json!({ "limit": 3 })).await?.json()?;
    let executed = history.as_array().unwrap().iter().find(|e| e["event"] == "action_executed").unwrap();
    assert_eq!(executed["action"]["IntentsDeposit"]["recipient"], json!("0x000000000000000000000000000000000000dEaD"));
    assert_eq!(executed["action"]["IntentsDeposit"]["quote_ref"], json!("corr-123"));
    let _ = vendor;
    Ok(())
}

#[tokio::test]
async fn tripwire_suspends_a_probing_agent() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    let stranger = worker.dev_create_account().await?;
    let mut policy: Value = wallet
        .view("get_agent")
        .args_json(json!({ "public_key": sk.public_key() }))
        .await?
        .json::<Value>()?["policy"]
        .clone();
    policy["tripwire"] = json!({ "max_denials": 2, "window_secs": 3600 });
    owner
        .call(wallet.id(), "update_policy")
        .args_json(json!({ "public_key": sk.public_key(), "policy": policy }))
        .transact()
        .await?
        .into_result()?;
    let send = |to: &near_workspaces::AccountId| {
        agent
            .call(wallet.id(), "execute")
            .args_json(json!({ "action": { "Transfer": { "receiver": to, "amount": NearToken::from_millinear(10) } } }))
            .gas(EXEC_GAS)
            .transact()
    };
    // Two denials trip the wire...
    for _ in 0..2 {
        let r = send(stranger.id()).await?.into_result()?;
        assert!(r.json::<Value>()?["Denied"].is_object());
    }
    let rec: Value = wallet.view("get_agent").args_json(json!({ "public_key": sk.public_key() })).await?.json()?;
    assert_eq!(rec["suspended"], json!(true));
    // ...so even an allowed action is now denied.
    let out: Value = send(vendor.id()).await?.into_result()?.json()?;
    assert!(out["Denied"]["reason"].as_str().unwrap().contains("suspended"));
    let history: Value = wallet.view("get_history").args_json(json!({ "limit": 5 })).await?.json()?;
    assert!(history.as_array().unwrap().iter().any(|e| e["event"] == "agent_tripped"));
    // Owner lifts it.
    owner
        .call(wallet.id(), "unsuspend")
        .args_json(json!({ "public_key": sk.public_key() }))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(send(vendor.id()).await?.into_result()?.json::<Value>()?, json!("Executed"));
    Ok(())
}

#[tokio::test]
async fn owner_can_top_up_gas_and_upgrade_code() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    // Allowance starts at 10 NEAR (setup); raise it to 20.
    owner
        .call(wallet.id(), "top_up_gas")
        .args_json(json!({ "public_key": sk.public_key(), "allowance": NearToken::from_near(20) }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let key = worker.view_access_key(wallet.id(), &sk.public_key()).await?;
    match key.permission {
        near_workspaces::types::AccessKeyPermission::FunctionCall(p) => {
            assert_eq!(p.allowance, Some(NearToken::from_near(20)));
            assert_eq!(p.method_names, vec!["execute".to_string()]);
        }
        _ => panic!("expected a function-call key"),
    }

    // Upgrade to the same code through the contract; state survives migrate().
    owner
        .call(wallet.id(), "upgrade")
        .args_borsh(WASM.to_vec())
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let agents: Value = wallet.view("list_agents").await?.json()?;
    assert_eq!(agents.as_array().unwrap().len(), 1);
    let agent = as_agent(&worker, &wallet, &sk)?;
    let out: Value = agent
        .call(wallet.id(), "execute")
        .args_json(json!({ "action": { "Transfer": { "receiver": vendor.id(), "amount": NearToken::from_millinear(10) } } }))
        .gas(EXEC_GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(out, json!("Executed"));

    // Strangers cannot upgrade.
    let stranger = worker.dev_create_account().await?;
    let r = stranger.call(wallet.id(), "upgrade").args_borsh(WASM.to_vec()).max_gas().transact().await?;
    assert!(r.is_failure());
    Ok(())
}

#[tokio::test]
async fn first_payment_to_a_new_receiver_needs_approval() -> anyhow::Result<()> {
    let (worker, owner, wallet, vendor, sk) = setup().await?;
    let agent = as_agent(&worker, &wallet, &sk)?;
    let newcomer = worker.dev_create_account().await?;
    let mut policy: Value = wallet
        .view("get_agent")
        .args_json(json!({ "public_key": sk.public_key() }))
        .await?
        .json::<Value>()?["policy"]
        .clone();
    policy["receivers"] = json!("Any");
    policy["approve_new_receivers"] = json!(true);
    owner
        .call(wallet.id(), "update_policy")
        .args_json(json!({ "public_key": sk.public_key(), "policy": policy }))
        .transact()
        .await?
        .into_result()?;
    let send = |to: &near_workspaces::AccountId| {
        agent
            .call(wallet.id(), "execute")
            .args_json(json!({ "action": { "Transfer": { "receiver": to, "amount": NearToken::from_millinear(10) } } }))
            .gas(EXEC_GAS)
            .transact()
    };
    // Tiny, inside every cap, but the receiver is new: queued.
    let out: Value = send(newcomer.id()).await?.into_result()?.json()?;
    assert_eq!(out["Queued"]["id"], json!(1));
    let v: Value = wallet
        .view("check")
        .args_json(json!({ "public_key": sk.public_key(), "action": { "Transfer": { "receiver": newcomer.id(), "amount": NearToken::from_millinear(10) } } }))
        .await?
        .json()?;
    assert_eq!(v["needs_approval"], json!(true));
    // Owner approves once; from then on the receiver is known.
    let out: Value = owner.call(wallet.id(), "approve").args_json(json!({ "id": 1 })).max_gas().transact().await?.into_result()?.json()?;
    assert_eq!(out, json!("Executed"));
    assert_eq!(send(newcomer.id()).await?.into_result()?.json::<Value>()?, json!("Executed"));
    let _ = vendor;
    Ok(())
}

#[tokio::test]
async fn check_is_a_faithful_dry_run() -> anyhow::Result<()> {
    let (_worker, _owner, wallet, vendor, sk) = setup().await?;
    let v: Value = wallet
        .view("check")
        .args_json(json!({
            "public_key": sk.public_key(),
            "action": { "Transfer": { "receiver": vendor.id(), "amount": NearToken::from_millinear(900) } }
        }))
        .await?
        .json()?;
    assert_eq!(v["allowed"], json!(true));
    assert_eq!(v["needs_approval"], json!(true));
    let v: Value = wallet
        .view("check")
        .args_json(json!({
            "public_key": sk.public_key(),
            "action": { "Transfer": { "receiver": vendor.id(), "amount": NearToken::from_near(2) } }
        }))
        .await?
        .json()?;
    assert_eq!(v["allowed"], json!(false));
    let _ = U128(0);
    Ok(())
}
