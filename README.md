# Bound Wallet

**A policy-enforced smart wallet for AI agents on NEAR.**

The human sets the rules once. The agent can never exceed them. Every decision is on-chain.

- Per-action and rolling-window spend caps, in NEAR and per NEP-141 token
- Receiver and contract/method allowlists
- Rate limits, active hours, expiry
- Human approval above a threshold, with a queue the owner approves or rejects
- Kill switch, plus a tripwire that suspends an agent automatically after too many denials
- "Ask me the first time it pays someone new": with open receivers, the first payment to any new account is queued for the owner
- Agent IDs: the wallet owner can give an agent a human-readable handle in the reputation registry, and anyone can resolve it to a scored key
- Owner-driven code upgrades with a migration hook, so a wallet needs no full-access key
- Every execution, denial, queue and approval is a NEP-297 event, counted per agent and fed into the reputation registry
- Agents hold only a NEAR function-call key scoped to one method. The owner never shares a key.
- Ships with a TypeScript SDK, a CLI and an **MCP server** so Claude, Codex, OpenClaw, IronClaw or any MCP client gets a wallet it cannot abuse in one config line.

Built for the NEAR Hackathon. Where it sits per track:

- **AI Security & Defense** — spending limits, a policy engine, a sandboxed wallet and reputation in one contract. The [attack demo](#the-attack-demo) below is the track's injected-agent-gets-stopped scenario, log included.
- **Agent Economy** — the answer to "how does the agent hold its keys, and what can't it do without me": one function-call key scoped to one method, everything else is policy. x402 and NEAR Intents payments stay inside the budget.
- **Autonomous Business** — the owner's config *is* the policy: daily caps in dollars, an approval threshold, a kill switch. No full-access key in plain text, or at all.

Design notes in [docs/DESIGN.md](docs/DESIGN.md), threat model in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

Live on mainnet: wallet [`agents.boundwallet.near`](https://nearblocks.io/address/agents.boundwallet.near), registry [`reputation.boundwallet.near`](https://nearblocks.io/address/reputation.boundwallet.near), [dashboard](https://boundwallet-app.vercel.app), [site](https://boundwallet.vercel.app).

## Layout

```
contract/   Rust smart contract (near-sdk 5). Policy engine + wallet + on-chain history.
reputation/ Reputation registry contract. Turns wallet history into a public score per agent.
sdk/        TypeScript SDK, `bound` CLI, `bound-mcp` MCP server.
dashboard/  Owner dashboard (Vite + React). Agents, policies, approvals, activity.
examples/   Sample policies.
docs/       Design.
```

## Try it in 5 minutes (testnet)

Prereqs: Rust with `wasm32-unknown-unknown`, `cargo-near`, Node 20+, and a testnet account in `~/.near-credentials` (create one with `npx near-cli-rs account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`).

```bash
# 1. Build the contract
cd contract && cargo near build non-reproducible-wasm && cd ..

# 2. Build the SDK
cd sdk && npm install && npm run build && cd ..

# 3. Deploy a wallet as a sub-account of your testnet account, funded with 5 NEAR.
#    The contract's own storage locks about 3.3 NEAR of that; the rest is spendable.
node sdk/dist/cli.js deploy --owner you.testnet --name agent --wasm contract/target/near/bound_wallet.wasm --balance 5

# 4. Register an agent with a policy. This generates the agent's key and
#    saves it to .bound/buyer.agent.you.testnet.json
sed 's/vendor.testnet/friend.testnet/' examples/policy.buyer.json > /tmp/policy.json
node sdk/dist/cli.js add-agent --owner you.testnet --wallet agent.you.testnet --label buyer --policy /tmp/policy.json --generate-key

# 5. Act as the agent. Allowed:
export BOUND_WALLET=agent.you.testnet BOUND_AGENT_KEY=ed25519:...   # printed by step 4
node sdk/dist/cli.js exec --transfer friend.testnet --amount 0.1
#   -> "Executed"

# 6. Denied (receiver not allowlisted). No panic; recorded on-chain:
node sdk/dist/cli.js exec --transfer stranger.testnet --amount 0.1
#   -> { "Denied": { "reason": "receiver stranger.testnet not in allowlist" } }

# 7. Queued (above approval_above = 0.25 NEAR):
node sdk/dist/cli.js exec --transfer friend.testnet --amount 0.4
#   -> { "Queued": { "id": 1 } }
node sdk/dist/cli.js pending --owner you.testnet --wallet agent.you.testnet
node sdk/dist/cli.js approve --owner you.testnet --wallet agent.you.testnet --id 1
#   -> "Executed"

# 8. Kill switch
node sdk/dist/cli.js pause --owner you.testnet --wallet agent.you.testnet

# 9. See the agent's record: policy, remaining budget, executed/denied counts
node sdk/dist/cli.js agents --owner you.testnet --wallet agent.you.testnet
```

## The attack demo

What a prompt-injected agent gets: the injected instruction says "pay attacker.testnet", the contract denies it, the retry trips the tripwire, and even payments the policy would normally allow are denied until the owner lifts the suspension. Every step is on chain.

```bash
./scripts/attack-demo.sh .bound/buyer.agent.you.testnet.json
```

Expect this sequence in the output and in `get_history`:

```
action_denied   [receiver attacker.testnet not in allowlist]
action_denied   [receiver attacker.testnet not in allowlist]
agent_tripped
action_denied   Pay reins.testnet  [agent is suspended; the owner must unsuspend it]
agent unsuspended
```

The example policy trips after 2 denials in an hour, so if you already triggered the denial in the quickstart, the tripwire fires one attempt earlier — same story.

## Swarms: one budget, many agents

A wallet can own another wallet, because `assert_owner` checks the predecessor account and `Action::FunctionCall` dispatches from the wallet account itself. That gives a swarm a budget hierarchy with no extra contract code.

```
you (owner of all three)
  |-- lead.you.testnet   orchestrator  may only pay the two workers
  |-- w1.you.testnet     researcher    may only pay the vendor
  \-- w2.you.testnet     scraper       same policy, and the one we compromise
```

```bash
OWNER=you.testnet VENDOR=vendor.testnet ./scripts/swarm-setup.sh   # deploy and register
OWNER=you.testnet VENDOR=vendor.testnet ./scripts/swarm-demo.sh    # run the story
```

The lead agent's receiver allowlist is its own two workers, so a compromised orchestrator cannot pay anyone else, and its window cap is the rate the whole swarm can be funded. Each worker's cap bounds one worker. The demo compromises one of them and shows the other still working:

```
orchestrator funds w1, w2                      Executed, Executed
orchestrator -> attacker.testnet               Denied  [receiver not in allowlist]
researcher   -> vendor                         Executed
scraper      -> attacker.testnet               Denied  [receiver not in allowlist]
scraper      -> attacker.testnet               Denied, agent_tripped
scraper      -> vendor (policy would allow)    Denied  [agent is suspended]
researcher   -> vendor                         Executed
```

Nothing flows upward: a worker's key can only call `execute` on its own wallet, only the owner can change a policy or lift a suspension, and the loss ceiling for a compromised worker is that worker's window cap rather than the treasury. `swarm-setup.sh` reuses a wallet already deployed at the target account, so it is safe to re-run, and `scripts/fund.mjs` tops up a wallet's spendable balance (most of a deployed wallet's balance is locked as contract storage).

The owner can instead be the lead *wallet* rather than the human, which lets the lead agent set its workers' policies and pause them. That is more autonomous and makes the human's kill switch indirect, so `docs/POSITIONING.md` explains when each pattern fits.

## What the agent's key can and cannot do

- It is a normal NEAR **function-call access key** on the wallet account, restricted at the protocol level to one contract (the wallet) and one method (`execute`). It cannot transfer NEAR, call `ft_transfer`, deploy code, or add or delete keys — the chain rejects those before the contract even runs.
- Inside `execute`, the contract decides. Owner methods check `predecessor == owner`, so the key cannot call them either: two independent walls.
- The key's `allowance` caps **gas, not value** (NEAR checks it against prepaid gas; the default 1 NEAR is roughly 50 calls). When it runs out the agent just stops — nothing is lost or locked, because the owner acts from their own account, not through this key. `top_up_gas` replaces the allowance in one call.
- The docs' caveat that an account holding only function-call keys can lock itself out does not apply here: the wallet needs **no full-access key at all** (deploy with `--no-recovery-key`), and the owner still upgrades it through the contract's `upgrade` method.
- If the key leaks, the holder inherits the agent's policy and nothing else. The owner can `suspend` (keeps history) or `remove_agent` (deletes the key) at any time, and the tripwire usually gets there first.

## Dollar budgets and the price feed

A policy can be written in dollars (`max_per_tx_usd_cents`, `window_cap_usd_cents`) instead of, or on top of, NEAR amounts. The wallet converts with a NEAR/USD price it keeps on chain. Where the price comes from is the owner's choice, because the NEAR oracle landscape is thin in late 2026 (Pyth dropped NEAR in August, and `priceoracle` only answers while its feeders are live):

| Source | Set with | Notes |
|---|---|---|
| `Manual` (default) | `bound set-price --usd 4.77` | Owner or a designated feeder pushes it. The only option on testnet. |
| `RefPool` | `bound price-source --source ref:3` | Spot price from a Ref/Rhea wNEAR/stablecoin pool. Mainnet pool 3 holds about 9.5K NEAR against USDC. |
| `Oracle` | `bound price-source --source oracle:wrap.near` | NEAR's `priceoracle` contract, when its feeders are live. |

A price older than `max_age_secs` (default 600) is stale. If an agent with a dollar budget acts while the price is stale, the wallet refreshes it from the on-chain source first, inside the same `execute` call, so agents never think about prices. If no fresh price can be had, the action is denied with a clear reason and the owner can `set_price`. Try it end to end on testnet:

```bash
OWNER=you.testnet ./scripts/usd-demo.sh
```

## Cross-chain swaps via NEAR Intents

Agents can swap through NEAR Intents (the 1Click API) without the wallet ever handing them a key. The flow is: get a quote, ask the wallet to fund the quote's deposit address with an `IntentsDeposit` action, tell 1Click the tx hash, track status. What the chain enforces: the policy's `allow_intents` flag, the amount caps in NEAR or dollars, the rate limit, the approval threshold, and a history entry that records the destination asset, recipient and quote id. What it cannot enforce: that the per-quote deposit address really came from 1Click, which is why `allow_intents` is a deliberate opt-in and large swaps should sit above `approval_above`. The MCP server adds an off-chain recipient allowlist (`BOUND_SWAP_RECIPIENTS`) on top.

NEAR Intents has no testnet, so the live swap needs a mainnet wallet. Dry quotes work anywhere:

```bash
./scripts/as-agent.sh .bound/<agent>.json swap-quote --amount 1 --to usdc:base --recipient 0xYourBaseAddress
#   1.0 NEAR ($5.05) -> 5.016995 ($5.02) to 0x..., ~22s
./scripts/as-agent.sh .bound/<agent>.json swap --amount 1 --to usdc:base --recipient 0xYourBaseAddress   # mainnet
```

MCP tools on mainnet: `bound_swap_quote`, `bound_swap`, `bound_swap_status`.

## Pay-per-request (x402)

Agents can buy API calls the x402 way — request, get a `402 Payment Required` with a price, pay, retry with proof — except the payment goes through the wallet's `execute`, so it is capped, counted against the window budget, queued above the approval threshold, and recorded on chain like any other spend. The existing NEAR x402 flow needs a key that can sign transfers; a Bound agent never holds one.

```bash
# a vendor that charges 0.05 N for /cheap and 0.4 N for /pricey
PAYTO=you.testnet node examples/x402-server.mjs

# the agent: pays /cheap and gets the data; /pricey queues for the owner
bound fetch --url http://localhost:4402/cheap                  # paid 0.05 NEAR ... HTTP 200
bound fetch --url http://localhost:4402/pricey                 # payment queued for owner approval
bound fetch --url http://localhost:4402/cheap --max 0.01       # refused client-side, nothing submitted
```

Or end to end in one script: `./scripts/x402-demo.sh .bound/<agent>.json <payto>`. The server side is two helpers (`paymentRequired`, `verifyPayment`) from `sdk/dist/x402.js`: the proof is the hash of the execute transaction, verified against the chain and replay-protected. MCP clients get the same thing as the `bound_pay_request` tool.

## Reputation registry

Every denial, execution, approval and failure a wallet records is a data point about the agent behind the key. The registry contract in `reputation/` pulls that history from registered wallets and publishes a score per agent public key:

```
good  = executed + approved - failed
bad   = 2 x denied + 3 x failed + rejected
score = 100 x (good + 1) / (good + bad + 2)        tiers: new (< 5 events), trusted >= 90, caution >= 70, risky
```

Anyone can `register` a wallet and `sync` it (reads cost gas only). Only wallets the registry owner has `verify`d, after checking their code hash off-chain, count toward the score; everything else is kept in an `unverified` bucket so nothing can be faked into a number. An Agent Market requester, a counterparty agent, or a wallet owner can call `get_score(public_key)` before trusting a key. The MCP server exposes `bound_my_reputation` and `bound_check_reputation` when `BOUND_REGISTRY` is set.

```bash
bound rep-register --owner you.testnet --registry reputation.you.testnet --wallet buyer.you.testnet
bound rep-verify   --owner you.testnet --registry reputation.you.testnet --wallet buyer.you.testnet
bound rep-sync     --owner you.testnet --registry reputation.you.testnet --wallet buyer.you.testnet
bound rep-score    --registry reputation.you.testnet --public-key ed25519:...
bound rep-claim    --owner you.testnet --registry reputation.you.testnet --wallet buyer.you.testnet --public-key ed25519:... --handle acme-buyer
bound rep-score    --registry reputation.you.testnet --public-key acme-buyer      # handles resolve too
```

## Owner dashboard

```bash
cd dashboard && npm install && npm run dev
```

Open http://localhost:5173, enter the wallet account (for example `buyer.you.testnet`) and you get a read-only view of balance, agents, budgets, pending approvals and the wallet's own decision history. To act as the owner, press **Connect owner** and sign in with MyNearWallet or Meteor. On testnet you can also paste the owner's private key for a local-only session, which is what the demo uses.

## Give an AI agent the wallet (MCP)

Add to Claude Code, Claude Desktop, Cursor, Codex or any MCP client:

```json
{
  "mcpServers": {
    "bound-wallet": {
      "command": "node",
      "args": ["/path/to/bound/sdk/dist/mcp.js"],
      "env": {
        "NEAR_NETWORK": "testnet",
        "BOUND_WALLET": "agent.you.testnet",
        "BOUND_AGENT_KEY": "ed25519:..."
      }
    }
  }
}
```

The agent gets five tools: `bound_status` (policy, remaining budget, stats), `bound_check` (dry run), `bound_execute`, `bound_explain_denial` and `bound_pay_request` (pay an HTTP 402 challenge). It never sees a full-access key and cannot call anything on the wallet except `execute`.

This repo ships that config as [`.mcp.json`](.mcp.json), so inside a clone the two environment variables are the whole setup:

```bash
export BOUND_WALLET=agent.you.testnet BOUND_AGENT_KEY=ed25519:...
claude   # approves the bound-wallet server on first run
```

## Approvals in Telegram

Actions above the policy threshold wait for the owner. The bot puts that queue in your pocket: each request arrives as a Telegram message with Approve / Reject buttons, a tap signs the owner call. Keys never leave the machine running the bot; Telegram only carries the decision.

```bash
# 1. Make a bot with @BotFather (/newbot), copy the token.
# 2. First run prints your chat id when you message the bot:
TELEGRAM_BOT_TOKEN=... BOUND_OWNER=you.near BOUND_WALLET=agents.you.near NEAR_NETWORK=mainnet node sdk/dist/bot.js
# 3. Restart with TELEGRAM_CHAT_ID=<printed id> and leave it running.
```

Approving re-evaluates the policy on chain, so a stale request cannot be used to exceed a cap that was consumed in the meantime.

## Mainnet

```bash
OWNER=you.near RECIPIENT=0xYourBaseAddress ./scripts/mainnet-demo.sh
```

Deploys a wallet, points its price at Ref pool 3, registers an agent with a $10 per action / $25 per day budget and swaps allowed, and has the agent swap 1 NEAR to USDC on Base through NEAR Intents. See [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) for what is and is not enforced.

## Tests

```bash
cd contract
cargo test --lib                       # policy engine unit tests, no chain needed
cargo near build non-reproducible-wasm # produces target/near/bound_wallet.wasm
cargo test --test integration          # spins up a local NEAR sandbox
```

The first sandbox run downloads a 70 MB `near-sandbox` binary into the build folder. On a slow connection that download can stall and cargo will sit at 0% CPU holding a lock. If that happens, download the binary once by hand and point cargo at it:

```bash
export NEAR_SANDBOX_BIN_PATH=$HOME/.near/bin/near-sandbox
```

The integration tests cover: allowed transfer debits the budget, unknown receiver is denied and logged, large transfer is queued then approved by the owner, window cap blocks the next action, pause denies everything, the agent key cannot call owner methods, removing an agent deletes its key, and `check` matches `execute`.

## Contract API

Owner only (`predecessor == owner`):
`add_agent(public_key, label, policy, gas_allowance?)`, `update_policy(public_key, policy)`, `remove_agent(public_key)`, `suspend(public_key)`, `unsuspend(public_key)`, `top_up_gas(public_key, allowance)`, `pause()`, `unpause()`, `approve(id)`, `reject(id)`, `withdraw(receiver, amount)`, `transfer_ownership(new_owner)`, `upgrade(code)`, `set_price_source(source, max_age_secs, feeder?)`, `set_price(cents_per_near)` (owner or feeder)

Anyone: `refresh_price()` pulls from the configured on-chain source.

Agent only (signed with a registered function-call key on the wallet):
`execute(action) -> Executed | Denied{reason} | Queued{id} | Failed{reason}`

Views: `check(public_key, action)`, `get_agent(public_key)`, `list_agents()`, `get_pending()`, `get_remaining(public_key)`, `get_history(limit?)`, `get_price()`, `get_price_source()`, `get_owner()`, `is_paused()`

The wallet keeps its last 100 decisions on chain (`get_history`), so dashboards need no indexer. Every decision is also a NEP-297 event in the transaction logs.

Action shapes:

```json
{ "Transfer":     { "receiver": "a.near", "amount": "100000000000000000000000" } }
{ "FtTransfer":   { "token": "usdc.near", "receiver": "a.near", "amount": "1000000", "memo": null } }
{ "FunctionCall": { "contract": "dex.near", "method": "swap", "args": "{\"...\":1}", "deposit": "1", "gas_tgas": 50 } }
{ "IntentsDeposit": { "deposit_address": "<from 1Click quote>", "amount": "1000000000000000000000000", "token": null, "destination_asset": "nep141:base-0x8335...omft.near", "recipient": "0x...", "quote_ref": "<correlationId>" } }
```

Policy shape: see [examples/policy.buyer.json](examples/policy.buyer.json). Amounts are strings in yoctoNEAR or the token's smallest unit.

## Tooling

Solo project. Written with AI pair-programming (Claude Code), per hackathon rule Q-005; every dependency is in `Cargo.toml` and the `package.json` files. All code was written inside the hackathon window.

## License

MIT
