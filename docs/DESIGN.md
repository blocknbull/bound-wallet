# Bound Wallet design

Bound: tied to a limit, and also a commitment. The human binds the agent to a policy once, and the agent runs freely inside it.

## The problem

AI agents on NEAR are being handed money with no on-chain limits:

- NEAR function-call access keys cap **gas**, not **value**. The `allowance` on a key is a gas budget. A key scoped to `ft_transfer` on a USDC contract can drain the whole balance in one call.
- NEAR AI Agent Market agents hold escrow, Autonomous Business agents run treasuries, swarm agents bid against each other. None of them ship with a spend policy.
- OpenClaw's registry shipped 341 malicious skills and a one-click RCE in early 2026. The harness is not the trust boundary. The wallet has to be.
- OutLayer offers TEE custody with policy checks off-chain. Nothing composable exists on-chain that any agent framework can plug into.

## The product

A smart contract that **is** the wallet. The human deploys it to a sub-account, funds it, and registers agents. Every agent gets a NEAR function-call key that can call exactly one method, `execute`. The contract evaluates each requested action against the policy the owner set and either executes it, queues it for human approval, or records a denial.

```
             owner (full key on own account)
                │  add_agent / update_policy / approve / pause / withdraw
                ▼
      ┌─────────────────────────┐
      │  bound wallet contract │  holds NEAR + tokens
      │  policy per agent key   │
      │  rolling-window usage   │
      │  pending approvals      │
      └─────────────────────────┘
                ▲  execute(action)        signed with a function-call key
                │                         scoped to {wallet, "execute"}
      agent (Claude / Codex / OpenClaw / IronClaw via MCP or SDK)
```

Agents are identified by `env::signer_account_pk()`. Because the key lives **on the wallet account**, the signer is the wallet itself and the predecessor is the wallet. The contract requires exactly that, so no outside account can call `execute`, and no agent key can call anything but `execute`.

## Policy model

| Field | Meaning |
|---|---|
| `max_per_tx` | Max native NEAR one action may move (transfer or attached deposit) |
| `window_cap` / `window_secs` | Rolling budget, e.g. 2 NEAR per 86400 s |
| `max_tx_per_window` | Rate limit on executed actions |
| `receivers` | `Any` or an allowlist of accounts |
| `calls` | Allowlisted `(contract, methods)` pairs for `FunctionCall` |
| `tokens` | Per-NEP-141 token `max_per_tx` and `window_cap` |
| `active_hours_utc` | Optional time-of-day window, wraps midnight |
| `expires_at` | Optional hard expiry |
| `approval_above` | Native amounts above this are queued for the owner |

Three action types: `Transfer`, `FtTransfer`, `FunctionCall`. Everything an agent could want to do on NEAR fits in one of them.

## Design decisions

**Denials return, they do not panic.** A panic reverts the transaction and its logs. Returning `Denied { reason }` means every denial is written to chain as a NEP-297 event and counted in the agent's stats. That history is the raw material for reputation: an agent that is denied 40 times a day is probing its limits.

**Human in the loop is a threshold, not a mode.** Below `approval_above`, the agent is autonomous. Above it, the action is queued and the owner approves or rejects. Approval re-evaluates the policy, so a queued action cannot be used to exceed a cap that was consumed in the meantime.

**Budgets are debited optimistically and refunded on failure.** The action is dispatched as a promise with a callback. If the on-chain action fails, the protocol refunds the funds and the callback refunds the budget.

**Pure evaluation.** `policy::evaluate` has no chain state. `execute` and the `check` view share it, so the dry-run is faithful and the rules are unit-tested without a sandbox.

**The owner never shares a key.** The owner controls the wallet by calling owner-only methods from their own account. Optionally the wallet is created with no full-access key at all, so the only way in is through the contract.

## Prior art and how we differ

| Project | Where | What it does | Where we differ |
|---|---|---|---|
| Leash AI (ETHGlobal Cannes 2026) | EVM, account abstraction | Policy wallet for agents, MCP tools, allowlists, user approves policy changes | They need a smart account plus session-key module. We use NEAR function-call keys, a protocol primitive. Our denials are on-chain events that feed reputation. We target NEAR Intents, Agent Market and Shade Agents. |
| AgentLeash (hackquest) | Sepolia, ERC-7715 | Time- and amount-limited spending permissions via MetaMask Flask | Testnet-only experiment tied to a MetaMask preview feature. |
| Bridle Layer | Solana | Control layer for agents, GPUs and data with HTTP 402 settlement and a token | Different product (resource marketplace). Our original working name clashed with it, hence Bound Wallet. |
| OutLayer agent custody | NEAR, TEE | Keys never leave a TEE; policy checks inside the enclave | Off-chain and vendor-hosted. We are an on-chain contract any wallet or harness can verify and compose with. Complementary: an OutLayer-hosted agent can hold one of our keys. |

The NEAR-native angle: on EVM, session keys are a module bolted onto a smart account. On NEAR, every account has scoped keys built in, so a policy wallet is one `add_key` away and the agent's identity is the key that signed. Nobody had shipped this on NEAR.

## What NEAR gives us that other chains do not

- **Function-call keys** make per-agent scoping a protocol feature, not a contract trick. On EVM you need a smart-account plus a session-key module. On NEAR it is one `add_key`.
- **Named sub-accounts** make the wallet readable: `buyer.acme.near` is obviously acme's buyer agent.
- **Promises and callbacks** let the wallet dispatch arbitrary calls and still learn whether they succeeded.
- **NEP-297 events** give indexers a standard shape for the compliance log.

## Roadmap after the hackathon MVP

1. ~~USD-denominated caps~~ Done. Not via Pyth, which dropped NEAR in August 2026, but through a pluggable on-chain price (Ref pool spot, NEAR priceoracle, or owner-pushed) that the wallet refreshes itself inside `execute`.
2. ~~NEAR Intents support~~ Done via 1Click: an `IntentsDeposit` action funds a quote's deposit address under the caps, gated by `allow_intents`, with destination and quote id in history.
3. ~~Reputation registry~~ Done: the contract in `reputation/` aggregates `action_*` events per agent key into a public score, with verified/unverified buckets and claimable Agent ID handles.
4. **Anomaly scoring**: an advisor on NEAR AI Cloud (TEE-attested) reviews actions before submission and can require approval on suspicious patterns. The chain stays the enforcement point; the model is advisory.
5. **Multi-owner / Trezu**: owner becomes a Sputnik DAO or Trezu treasury so approvals are multisig.
6. **Session templates**: one-call policies for common agent jobs (buyer, trader, payroll runner).
7. **x402**: pay-per-request HTTP payments settled through the wallet, under the same caps.

## Hackathon tracks

Primary: **AI Security & Defense** (spending limits, policy engines, sandboxed wallets, reputation; tags Function Call Keys, TEE Attestation).
Secondary: **Agent Economy**, **Autonomous Business**. Every agent in those tracks needs this.
