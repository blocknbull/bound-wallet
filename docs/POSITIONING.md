# Positioning

How Bound gets sold after the hackathon.

## The one line

**A wallet you can hand an AI agent.** The owner sets the limits once, the contract enforces them every time, and every decision is public.

## The problem with selling it as a wallet

Nobody is shopping for a policy-enforced smart wallet. It is a category that does not exist in anyone's head yet, so leading with it means explaining before selling, and you lose.

What people do have is one of two feelings:

1. **A chore they want gone.** Something they buy again every month and resent handling.
2. **A fear blocking something they already want.** They would let an agent pay, but not with real money.

Bound sells into both, and the pitch is different for each. The chore pitch is about forgetting. The fear pitch is about the limit being somewhere the agent cannot reach.

The line that fuses them: **let your agent buy, set the limit once, and it cannot break it.**

## The metaphor

A prepaid card with a merchant lock and a monthly cap, except the limits are not a setting the cardholder can phone up and change. They are in a contract, and the agent has no way to reach them.

Everyone understands a card limit. Nobody needs a crypto explanation to get there. Use the card metaphor with retail and never say "access key" in the first minute.

## The retail story

Told in the first person, which is how it lands:

> Every month I spend about three hundred dollars on groceries, same two shops. I told my agent once: three hundred a month, those two shops, nothing over eighty in one go, ask me above that. Now it buys and I have stopped thinking about it. If it ever tried a third shop, it would not get a warning. It would get refused. Not because the agent decided to behave. Because the contract said no.

The sellable line in there is **"not because the agent decided to behave."** That is the whole product in nine words.

**Be honest about what this is.** Groceries are the mental model, not a shipped integration. A supermarket does not take NEAR today. Say "the shape of this is your grocery budget" and then show a payment that is actually real. Overclaiming to judges who verify reproducibility is the one mistake that costs us the hackathon, and overclaiming to users is how a wallet gets a reputation it cannot shake.

## What agents actually pay for today

These are real on crypto rails right now and should carry every demo:

- Inference and API credits, which is what x402 was built for and what we already support on both sides
- Compute and storage top-ups
- Paying other agents, which is where Agent Market and swarm bidding are heading
- Subscriptions and recurring service top-ups
- Creator tips and recurring donations
- Domain renewals and ad budgets

The bridge to the grocery story is NEAR Intents. The wallet holds NEAR and pays a vendor in USDC on Base, inside the caps, which we have already done on mainnet. Every merchant that takes USDC is reachable from a Bound wallet today. That is the honest version of "your agent buys your groceries", and it gets more true every quarter without us writing new code.

## Swarms: lead wallets and sub-wallets

This needs no contract changes. It already works and it is running on testnet (`scripts/swarm-setup.sh` and `scripts/swarm-demo.sh`), which is worth saying plainly because every competitor will have to build it.

`assert_owner` checks the predecessor account, and `Action::FunctionCall` dispatches from the wallet account itself. So a Bound wallet can be the owner of another Bound wallet, and a lead agent can drive its sub-wallets within its own `calls` allowlist.

Two patterns, and the recommended one is the simpler one:

**Budget cascade (recommended).** The human owns every wallet. The lead wallet's only job is moving money down to sub-wallet accounts, with those accounts on its receiver allowlist. One deposit into the lead wallet is the swarm's total ceiling, and the lead's window cap is the rate it can fund anyone. Each sub-wallet's own caps bound one member. The human keeps the kill switch on every wallet, and no agent anywhere can change a policy.

**Delegated policy (advanced).** The lead wallet is set as owner of the sub-wallets, so the lead agent can set policies and pause its workers. More autonomous and genuinely useful for a large swarm, but the human's kill switch becomes indirect: pausing the lead stops funding, while budgets already pushed down keep running. Only offer this when someone asks for it, and allow `pause` without `add_agent` so the lead can stop a worker but never arm a new one.

The thing to sell here is **blast radius**. In a swarm, one compromised member normally means the treasury. With sub-wallets it means that member's cap, and the money stops at a boundary nobody has to notice in time.

Hooks for this: "One budget. Many agents. No blast radius." And "Compromise one agent, lose one agent's budget."

## Hooks

Keep the brand line. It is the best one we have and it is already on the site, the cards and the profile.

> Your agent can spend. It cannot overspend.

Supporting hooks, by audience:

- Retail: "A card for your AI, with a limit it cannot raise."
- Retail, chore framing: "Set the budget once. It buys from then on."
- Developer: "Never put a key in an `.env` again."
- Developer, sharper: "The limit is not in the prompt. It is in the contract."
- Security: "It probed three times. It is suspended. Nobody was watching."
- Swarm: "One budget. Many agents. No blast radius."
- Treasury and business: "Give the agent a budget, not the keys."

The filter stays what it already is: lead with the sharpest claim, cut every word that does not sell, no adjective the reader cannot verify.

## Objections

**"Can't I just prompt it not to overspend?"** You can, and it works until the prompt is attacked, confused, or updated. The limit either lives somewhere the agent can reach or it does not. This is also the honest framing of the whole category, so use it rather than dodging it.

**"Why not a multisig?"** A multisig asks a human every time, which means the agent is not autonomous. Bound is autonomous below the threshold and asks above it, and the threshold is yours. A DAO or multisig can be the owner, so this is an and, not an or.

**"What if the agent's key leaks?"** The holder gets the agent's policy and nothing else. The key can call one method on one contract. That is the sentence to lead with for developers, because it is the one they check.

**"Why NEAR?"** Function-call keys mean the restriction is enforced by the chain and not by our contract alone, so an agent key here cannot sign an arbitrary transfer at all. On other chains the equivalent payer is a smart account whose signature check is a view function, which cannot decrement a budget because it cannot write state. Caps that actually hold are structurally easier here.

## Why this becomes the default

The wedge is not competing with wallets. It is competing with the absence of limits, which is the current default everywhere: a key in an environment variable and hope.

Four distribution paths, in the order they pay off:

1. **MCP.** One config line makes Bound the wallet for Claude Code, Codex, Cursor and anything else that speaks MCP. This is already shipped and is the cheapest adoption we have.
2. **Swarm frameworks.** Lead and sub-wallets are demoable now, and a framework that adopts them gets bounded blast radius for free.
3. **x402 on both sides.** We are the payer SDK and the vendor verifier. Every vendor we help charge is a vendor whose payers want a Bound wallet.
4. **The registry.** Public scores per agent key are the only part that compounds. Once agents have records, hiring and marketplace platforms read ours, and that is the moat rather than the policy engine, which anyone can copy.

The near-term goal is not users. It is being the wallet named in other people's docs.
