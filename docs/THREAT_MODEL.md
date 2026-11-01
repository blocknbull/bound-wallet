# Threat model

What Bound protects, against whom, and what it deliberately does not promise.

## Assets

- The wallet's balance (NEAR, NEP-141 tokens).
- The owner's control: only the owner changes policy, approves, pauses, withdraws, upgrades.
- The integrity of the decision history and the reputation built on it.

## Actors

| Actor | Holds | Can |
|---|---|---|
| Owner | full key on their own account | everything, via owner-only methods |
| Agent | one function-call key on the wallet, scoped to `execute` | ask the wallet to act, nothing else |
| Harness (Claude Code, OpenClaw, ...) | the agent's key, in config | anything the agent can |
| Anyone | nothing | read state, `refresh_price`, register/sync in the registry |

## What the contract enforces, and against what

| Threat | Control | Enforced on chain |
|---|---|---|
| Compromised harness drains the wallet | per-action cap, window cap (NEAR or USD), rate limit | yes |
| Agent pays an attacker | receiver allowlist; contract/method allowlist; token allowlist | yes |
| Agent spends a lot in a short burst | rate limit; `approval_above` queues big actions for the owner | yes |
| Agent keeps probing limits looking for a gap | tripwire suspends it after N denials in a window | yes |
| Agent calls owner methods | its key is scoped to `execute` at the protocol level; owner methods check `predecessor == owner` | yes, twice |
| Agent burns the balance as gas | key allowance bounds prepaid gas; owner tops it up deliberately | yes |
| Owner loses the wallet's full-access key | wallet can be created with none; owner upgrades through `upgrade` | yes |
| Attacker fakes history to earn reputation | registry scores only `verify`d wallets; unverified events are bucketed separately | yes |
| Stale or manipulated price makes dollar caps wrong | price has a max age; out-of-range prices rejected; owner can override | partly: Ref spot is manipulable within a block, so dollar caps are a budget guard, not a settlement oracle |
| Cross-chain swap sends funds to a fake deposit address | `allow_intents` is opt-in; caps and approval threshold bound the loss; destination recorded | partly: the chain cannot verify a 1Click deposit address |

## What Bound does not protect against

- A malicious or compromised **owner**. The owner is the root of trust by design.
- Loss **inside the policy**. If the policy allows $50 a day to anyone, a compromised agent can lose $50 a day. Write tight policies; use `approval_above`.
- **Off-chain misuse of a quote**. A 1Click quote's deposit address cannot be verified on chain. The MCP server's recipient allowlist is a convenience, not a guarantee.
- **Price manipulation** of the Ref pool within a block, if dollar caps are used with that source. Use the oracle source when it is fed, or owner-pushed prices for high-value wallets.
- **Harness-level attacks** that do not touch the wallet (data exfiltration, prompt injection that changes what the agent asks for). Bound bounds the money; it does not police the model.

## Known gaps and planned work

- `migrate()` is a no-op today. The next layout change must read the previous struct explicitly.
- History is a 100-entry ring. Older decisions survive only in transaction logs. Indexers can read the NEP-297 events.
- The registry's `verify` is manual. A code-hash allowlist checked on chain would need a host function NEAR does not expose; a `global contract` deployment (NEP-591) is the likely path.
- No reentrancy concerns today: the wallet never calls untrusted code before updating state, and callbacks only credit refunds.
- Storage: only the owner can create state (agents, pending). Agents cannot grow storage except via history entries, which are bounded.
