# Recording session

One sitting, two videos, same lighting and framing. Screen capture is recorded separately afterwards and cut in.

- **Video A — the submission demo, 100 seconds.** What the judges watch. Proof-heavy. Goes in the `demoUrl` field.
- **Video B — the retail teaser, 50 seconds.** What grows the account. Story-heavy, no jargon, one analogy.

Record B first. It is shorter, it warms you up, and the delivery on A gets better for it.

## Before the camera turns on

Three things have to be true or two shots in Video A cannot be filmed:

1. **Telegram bot token from @BotFather.** The approvals shot is a phone buzzing and a tap. Without the token, shoot the dashboard Approve button instead and lose the phone shot. The token takes two minutes to get.
2. **Mainnet request #1 (0.4 N) still queued.** It has been held open since 3 Nov for exactly this. Do not approve it before filming.
3. **The attack demo re-run and green.** `./scripts/attack-demo.sh` on testnet. It leaves the agent suspended, so unsuspend afterwards.

Also: plain top, no logo. Phone on silent. Close Slack and mail so no notification lands in a screen capture.

## Video B — the retail teaser, 50 seconds

The one that sells. No contract vocabulary, no NEAR vocabulary until the last line.

**On camera, whole thing. No screen capture except one short cutaway.**

> I gave an AI agent my money. On purpose.
>
> Here is what nobody tells you about agents that can pay. The only thing stopping yours from sending everything is the prompt. And you can talk a prompt into anything.
>
> So I built a wallet where the limit is not in the prompt. It is in the contract.
>
> Think about your monthly groceries. Same two shops, about three hundred dollars. You set that once. Three hundred a month, those two shops, nothing over eighty in one go, ask me above that.
>
> Then the agent just buys. You stop thinking about it.
>
> And if it ever tries a third shop, it does not get a warning. It gets refused.

*[cutaway, 4 seconds: the dashboard denial line, red, reason visible]*

> That is a real payment on NEAR mainnet. Capped, checked, written down.
>
> Your agent can spend. It cannot overspend.

Delivery notes. "On purpose" gets a beat after it. "Talk a prompt into anything" is the line people repeat, so slow down on it. "It gets refused" is flat and final, not triumphant.

## Video A — the submission demo, 100 seconds

| Time | Shot | What you say |
|---|---|---|
| 0–10 | You, face to camera | "I gave an AI agent real money on NEAR mainnet two weeks ago. It is still running. It still cannot lose it." |
| 10–20 | Screen: a function-call key in an `.env` | "A NEAR key limits gas, not money. Scoped to a token transfer, it can send the whole balance in one call. That is how agents hold funds today." |
| 20–32 | Dashboard: the policy | "So the limits go in a contract instead. Ten dollars an action. Twenty-five a day. Two receivers. Above ten, ask me." |
| 32–46 | Claude Code via MCP, terminal | "The agent pays a vendor. Executed. It hits a paywall, pays it, retries, gets the data. Executed, under budget." |
| 46–58 | Terminal, then phone | "It asks for 0.4 NEAR. That is over the threshold, so it waits. My phone buzzes. I approve, and the contract re-checks the policy before it sends." |
| 58–75 | Terminal: attack demo | "Now the agent is compromised. It tries to pay an address I never allowed. Denied. It tries again. Denied. Third time the tripwire suspends it, and everything after that is refused. Nobody was watching. The contract was." |
| 75–88 | Explorer, then registry | "A real swap: one NEAR out, 4.21 USDC on Base, inside the caps. And the agent has a public record now. One executed, one denied, score on chain." |
| 88–100 | You, face to camera | "Live on mainnet. Open source. Built in two weeks at NEAR HACKATHON." |

Close on the repo and site URL held on screen for three seconds.

## The post that carries Video A

Hard requirements from the rules: tag `@NEARProtocol`, include `#NEARHackathon`, attach the video, say it was built at NEAR HACKATHON. The launch thread is missing the hashtag, so this post has to carry it.

> Built at NEAR HACKATHON: a wallet you can hand an AI agent.
>
> The owner sets the limits once. The contract enforces them every time. Every decision lands on chain.
>
> Live on @NEARProtocol mainnet. #NEARHackathon

## Practical

Shoot each spoken block as its own take and cut between them. Trying to land 100 seconds in one pass costs an hour and the twelfth take is always worse than the third.

Record a clean 10 seconds of silence before you start talking. It gives the editor a noise profile and removes room hum.

Frame slightly off-centre with the window to one side. Lens at eye height, not below.

For screen captures, set the terminal to 16pt or larger. Judges watch on laptops and phones; 12pt is unreadable at 720p.
