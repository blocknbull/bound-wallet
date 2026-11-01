# Bound vs the Binance Agentic Wallet

Binance shipped Agent OS and the Agentic Wallet in August 2026 and Agent IDs (.ai names) in October. It is the most complete "wallet for agents" from a centralized player, so it is the right yardstick. What they have, what we have, and what we took from them.

| Binance Agentic Wallet | Bound | Notes |
|---|---|---|
| Daily limit, set in the app | Per-action and rolling-window caps, in NEAR or dollars | Ours are per agent, not per wallet, and on chain. Binance enforces at their API. |
| Tradable token scope | Token allowlist with per-token caps; contract + method allowlist | Same idea, wider: we also scope which contracts an agent may call. |
| High-risk handling: auto-reject or app confirmation | `approval_above` queues big actions; policy denies the rest | Same two outcomes. Ours are rules in a contract, not a toggle in an app. |
| Transfers only to addressbook entries | Receiver allowlist, or `approve_new_receivers` (first payment to anyone new asks you) | Taken from Binance. Added 29 Oct. |
| Agent ID (.ai names) | Agent ID handles in the reputation registry, claimed by the wallet owner, resolvable to a scored key | Taken from Binance. Added 29 Oct. Ours carries a reputation score with it. |
| Sign out revokes the agent | `remove_agent` deletes the key; `suspend` keeps the key but denies everything | Plus the tripwire does it automatically. |
| MPC keyless; agent never holds a key | Agent holds one function-call key scoped to a single method; owner never shares theirs | Different mechanism, same property: the agent cannot move funds outside the rules. |
| All operations logged and auditable | Last 100 decisions on chain in the wallet, NEP-297 events for all, registry builds reputation from them | Ours are public and verifiable by anyone, not a dashboard inside Binance. |
| x402 micropayments, capped per day | Not yet. Planned for hackathon week 1: pay-per-request under policy using USDC on NEAR | Their cap is $20/day; ours would be whatever the policy says. |
| Market and limit orders, prediction markets | Cross-chain swaps via NEAR Intents under policy | Different product scope. We bound money; we do not run a trading venue. |
| MCP endpoint, works with Claude Code, Cursor, Codex | MCP server, works with Claude Code, Claude Desktop, Codex, Cursor, OpenClaw, IronClaw | Parity. |
| Chains: BNB, Ethereum, Base, Solana | NEAR, with cross-chain delivery to 35+ chains via Intents | |
| Custodial (Binance) | Self-custodial, owner is any NEAR account including a DAO | The fundamental difference. |

## Settings vocabulary we adopted

Binance calls them "daily limit", "tradable token scope", "high-risk transaction handling" and "addressbook". The dashboard now speaks the same language where it maps: "Budget per window", "Who can be paid", "Ask me above", "Ask me the first time it pays someone new".

## What we deliberately do not copy

- A per-wallet ceiling set by the operator. Bound has no operator. The owner's policy is the only ceiling.
- Prediction markets and order books. Out of scope; the wallet governs spend, venues are other people's contracts.
- MPC. On NEAR, protocol-level function-call keys give the same guarantee with less machinery.
