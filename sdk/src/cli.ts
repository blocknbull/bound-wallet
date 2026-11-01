#!/usr/bin/env node
/**
 * bound CLI. Owner commands use keys from ~/.near-credentials; agent
 * commands use --agent-key (or BOUND_AGENT_KEY).
 */
import { KeyPair } from "near-api-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BoundAgent,
  BoundOwner,
  BoundReputation,
  NEAR,
  fromYocto,
  loadPolicyFile,
  starterPolicy,
  type Action,
} from "./index.js";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): { cmd: string; args: Args } {
  const [cmd = "help", ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) args[k] = true;
      else {
        args[k] = next;
        i++;
      }
    }
  }
  return { cmd, args };
}

function need(args: Args, k: string, env?: string): string {
  const v = (args[k] as string) ?? (env ? process.env[env] : undefined);
  if (!v || v === "true") throw new Error(`missing --${k}${env ? ` (or $${env})` : ""}`);
  return v;
}

const HELP = `bound - policy-enforced wallet for AI agents on NEAR

Owner commands (sign with ~/.near-credentials):
  deploy       --owner <acct> --name <sub> --wasm <path> [--balance 5] [--no-recovery-key]
  add-agent    --owner <acct> --wallet <id> --label <name> [--policy <file>] [--generate-key | --public-key <pk>]
  policy       --owner <acct> --wallet <id> --public-key <pk> --policy <file>
  remove-agent --owner <acct> --wallet <id> --public-key <pk>
  pause|unpause --owner <acct> --wallet <id>
  suspend|unsuspend --owner <acct> --wallet <id> --public-key <pk>
  top-up-gas   --owner <acct> --wallet <id> --public-key <pk> --allowance <near>
  upgrade      --owner <acct> --wallet <id> --wasm <path>       owner-driven code upgrade + migrate
  approve|reject --owner <acct> --wallet <id> --id <n>
  withdraw     --owner <acct> --wallet <id> --to <acct> --amount <near>
  agents       --owner <acct> --wallet <id>
  pending      --owner <acct> --wallet <id>
  history      --owner <acct> --wallet <id> [--limit 50]
  price        --owner <acct> --wallet <id>                       show cached NEAR/USD price
  set-price    --owner <acct> --wallet <id> --usd <4.77>          push a price (Manual source)
  refresh-price --owner <acct> --wallet <id>                      pull from the on-chain source
  price-source --owner <acct> --wallet <id> --source manual|ref:<pool_id>|oracle:<asset> [--max-age 600] [--feeder <acct>]

Reputation registry (--registry <acct>, or $BOUND_REGISTRY):
  rep-register --owner <acct> --registry <id> --wallet <id>     register a wallet (anyone)
  rep-verify   --owner <acct> --registry <id> --wallet <id> [--no]   registry owner marks it genuine
  rep-sync     --owner <acct> --registry <id> --wallet <id>     pull new history into the registry
  rep-score    --registry <id> --public-key <pk|handle>         read an agent's score (no key needed)
  rep-claim    --owner <acct> --registry <id> --wallet <id> --public-key <pk> --handle <name>   give the agent an Agent ID
  rep-list     --registry <id>                                  all scored agents

Agent commands (sign with the agent's function-call key):
  exec   --wallet <id> --agent-key <ed25519:..> --action '<json>'
  check  --wallet <id> --agent-key <ed25519:..> --action '<json>'
  me     --wallet <id> --agent-key <ed25519:..>
  fetch  --wallet <id> --agent-key <k> --url <u> [--max <near>]   pay a 402 through the wallet (x402)

Swaps via NEAR Intents (mainnet only; agent key):
  swap-quote --wallet <id> --agent-key <k> --amount <near> --to usdc:base|<assetId> --recipient <addr>   dry quote
  swap       --wallet <id> --agent-key <k> --amount <near> --to usdc:base|<assetId> --recipient <addr> [--confidential]
  swap-status --deposit <depositAddress>

Shortcuts for --action:
  --transfer <acct> --amount <near>
  --ft <token> --to <acct> --amount <units>
  --call <contract> --method <m> [--args '{}'] [--deposit <near>] [--gas <tgas>]

Env: NEAR_NETWORK (testnet|mainnet, default testnet), NEAR_RPC_URL, BOUND_AGENT_KEY, BOUND_WALLET
`;

function actionFromArgs(args: Args): Action {
  if (args.action) return JSON.parse(args.action as string);
  if (args.transfer)
    return { Transfer: { receiver: args.transfer as string, amount: NEAR(need(args, "amount")) } };
  if (args.ft)
    return {
      FtTransfer: {
        token: args.ft as string,
        receiver: need(args, "to"),
        amount: need(args, "amount"),
        memo: (args.memo as string) ?? null,
      },
    };
  if (args.call)
    return {
      FunctionCall: {
        contract: args.call as string,
        method: need(args, "method"),
        args: (args.args as string) ?? "{}",
        deposit: args.deposit ? NEAR(args.deposit as string) : "0",
        gas_tgas: args.gas ? Number(args.gas) : null,
      },
    };
  throw new Error("no action given (use --action, --transfer, --ft or --call)");
}

function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const network = (args.network as string) ?? process.env.NEAR_NETWORK ?? "testnet";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  // ----------------------------------------------------------- agent side
  if (cmd === "swap-status") {
    const oc = await import("./oneclick.js");
    print(await oc.swapStatus(need(args, "deposit")));
    return;
  }
  if (cmd === "swap-quote" || cmd === "swap") {
    const oc = await import("./oneclick.js");
    const walletId = need(args, "wallet", "BOUND_WALLET");
    const key = need(args, "agent-key", "BOUND_AGENT_KEY");
    const agent = await BoundAgent.load(network, walletId, key);
    const to = need(args, "to");
    const destinationAsset = oc.DESTINATIONS[to] ?? to;
    const r = await agent.swap({ amountNear: need(args, "amount"), destinationAsset, recipient: need(args, "recipient"), dry: cmd === "swap-quote", confidential: !!args.confidential });
    const q = r.quote.quote;
    console.log(`${q.amountInFormatted} NEAR ($${q.amountInUsd}) -> ${q.amountOutFormatted} ($${q.amountOutUsd}) to ${need(args, "recipient")}, ~${q.timeEstimate}s`);
    if (cmd === "swap") print({ result: r.result, txHash: r.txHash, depositAddress: q.depositAddress, correlationId: r.quote.correlationId });
    return;
  }

  if (cmd === "fetch") {
    const x402 = await import("./x402.js");
    const walletId = need(args, "wallet", "BOUND_WALLET");
    const key = need(args, "agent-key", "BOUND_AGENT_KEY");
    const agent = await BoundAgent.load(network, walletId, key);
    const r = await x402.fetchWithPayment(agent, need(args, "url"), undefined, {
      maxYocto: args.max ? NEAR(args.max as string) : undefined,
    });
    if (r.paid) console.log(`paid ${fromYocto(r.paid.amountYocto)} NEAR to ${r.paid.payTo}  (tx ${r.paid.txHash})`);
    if (r.wallet?.denied) console.log(`payment denied: ${r.wallet.denied}`);
    if (r.wallet?.queuedId != null) console.log(`payment queued for owner approval (id ${r.wallet.queuedId})`);
    console.log(`HTTP ${r.res.status}`);
    console.log(await r.res.text());
    return;
  }

  if (cmd === "exec" || cmd === "check" || cmd === "me") {
    const walletId = need(args, "wallet", "BOUND_WALLET");
    const key = need(args, "agent-key", "BOUND_AGENT_KEY");
    const agent = await BoundAgent.load(network, walletId, key);
    if (cmd === "me") {
      print({ agent: await agent.me(), remaining: await agent.remaining(), wallet: await agent.balance() });
      return;
    }
    const action = actionFromArgs(args);
    if (cmd === "check") {
      print(await agent.check(action));
      return;
    }
    const r = await agent.execute(action);
    print(r);
    return;
  }

  // ------------------------------------------------------------ registry
  if (cmd.startsWith("rep-")) {
    const registryId = need(args, "registry", "BOUND_REGISTRY");
    const signer = (args.owner as string) || undefined;
    const rep = await BoundReputation.load(network, registryId, signer);
    switch (cmd) {
      case "rep-register":
        await rep.register(need(args, "wallet"));
        console.log("registered");
        return;
      case "rep-verify":
        await rep.verify(need(args, "wallet"), !args.no);
        console.log(args.no ? "unverified" : "verified");
        return;
      case "rep-sync":
        console.log(`${await rep.sync(need(args, "wallet"))} new events`);
        return;
      case "rep-claim":
        await rep.claimHandle(need(args, "handle"), need(args, "wallet"), need(args, "public-key"));
        console.log(`Agent ID "${need(args, "handle")}" claimed`);
        return;
      case "rep-score": {
        const sc = await rep.lookup(need(args, "public-key"));
        if (!sc) console.log("unknown agent");
        else print(sc);
        return;
      }
      case "rep-list": {
        const all = await rep.listScores();
        for (const sc of all) console.log(`${String(sc.score).padStart(3)}  ${sc.tier.padEnd(8)} ${(sc.handle ?? sc.labels[0] ?? "").padEnd(14)} ${sc.public_key}  (${sc.scored_events} scored)`);
        if (all.length === 0) console.log("(no agents yet)");
        return;
      }
      default:
        throw new Error(`unknown command ${cmd}`);
    }
  }

  // ----------------------------------------------------------- owner side
  const ownerId = need(args, "owner");

  if (cmd === "deploy") {
    const name = need(args, "name");
    const walletId = `${name}.${ownerId}`;
    const b = await BoundOwner.deploy({
      networkId: network,
      ownerId,
      walletId,
      wasmPath: resolve(need(args, "wasm")),
      initialBalanceNear: (args.balance as string) ?? "5",
      recoveryKey: args["no-recovery-key"] ? null : undefined,
    });
    console.log(`deployed wallet ${b.walletId} owned by ${ownerId}`);
    return;
  }

  const walletId = need(args, "wallet", "BOUND_WALLET");
  const owner = await BoundOwner.load(network, ownerId, walletId);

  switch (cmd) {
    case "add-agent": {
      const label = need(args, "label");
      const policy = args.policy ? loadPolicyFile(args.policy as string) : starterPolicy({});
      let pk: string = (args["public-key"] as string) ?? "";
      let secret: string | undefined;
      if (!pk || args["generate-key"]) {
        const kp = KeyPair.fromRandom("ed25519");
        pk = kp.getPublicKey().toString();
        secret = kp.toString();
      }
      await owner.addAgent(pk, label, policy, args["gas-allowance"] ? NEAR(args["gas-allowance"] as string) : undefined);
      console.log(`agent "${label}" registered on ${walletId}`);
      console.log(`public key:  ${pk}`);
      if (secret) {
        const dir = join(process.cwd(), ".bound");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${label}.${walletId}.json`);
        writeFileSync(file, JSON.stringify({ wallet: walletId, label, public_key: pk, secret_key: secret, network }, null, 2));
        console.log(`agent key saved to ${file}`);
        console.log(`give the agent:  BOUND_WALLET=${walletId} BOUND_AGENT_KEY=${secret}`);
      }
      return;
    }
    case "policy":
      await owner.updatePolicy(need(args, "public-key"), loadPolicyFile(need(args, "policy")));
      console.log("policy updated");
      return;
    case "remove-agent":
      await owner.removeAgent(need(args, "public-key"));
      console.log("agent removed and key deleted");
      return;
    case "suspend":
      await owner.suspend(need(args, "public-key"));
      console.log("agent suspended");
      return;
    case "unsuspend":
      await owner.unsuspend(need(args, "public-key"));
      console.log("agent unsuspended");
      return;
    case "top-up-gas":
      await owner.topUpGas(need(args, "public-key"), NEAR(need(args, "allowance")));
      console.log("gas allowance replaced");
      return;
    case "upgrade": {
      const { readFileSync } = await import("node:fs");
      await owner.upgrade(new Uint8Array(readFileSync(need(args, "wasm"))));
      console.log("upgraded and migrated");
      return;
    }
    case "pause":
      await owner.pause();
      console.log("wallet paused");
      return;
    case "unpause":
      await owner.unpause();
      console.log("wallet unpaused");
      return;
    case "approve":
      print(await owner.approve(Number(need(args, "id"))));
      return;
    case "reject":
      await owner.reject(Number(need(args, "id")));
      console.log("rejected");
      return;
    case "withdraw":
      await owner.withdraw(need(args, "to"), NEAR(need(args, "amount")));
      console.log("withdrawn");
      return;
    case "agents": {
      const agents = await owner.listAgents();
      for (const a of agents) {
        const rem = await owner.getRemaining(a.public_key);
        console.log(`- ${a.label}  ${a.public_key}${a.suspended ? "  [SUSPENDED]" : ""}`);
        console.log(`    per-tx ${fromYocto(a.policy.max_per_tx)} N, window ${fromYocto(a.policy.window_cap)} N / ${a.policy.window_secs}s, remaining ${rem ? fromYocto(rem.native) : "?"} N`);
        console.log(`    executed ${a.stats.executed} denied ${a.stats.denied} queued ${a.stats.queued} approved ${a.stats.approved} rejected ${a.stats.rejected} failed ${a.stats.failed}`);
      }
      if (agents.length === 0) console.log("(no agents)");
      return;
    }
    case "pending":
      print(await owner.getPending());
      return;
    case "price": {
      const q = await owner.getPrice();
      if (!q) console.log("no price yet");
      else console.log(`1 NEAR = $${(q.cents_per_near / 100).toFixed(2)}  (${q.source}, ${q.fresh ? "fresh" : "STALE"}, max age ${q.max_age_secs}s)`);
      return;
    }
    case "set-price": {
      const cents = Math.round(Number(need(args, "usd")) * 100);
      await owner.setPrice(cents);
      console.log(`price set: 1 NEAR = $${(cents / 100).toFixed(2)}`);
      return;
    }
    case "refresh-price":
      print(await owner.refreshPrice());
      return;
    case "price-source": {
      const spec = need(args, "source");
      let source: import("./index.js").PriceSource;
      if (spec === "manual") source = "Manual";
      else if (spec.startsWith("ref:"))
        source = { RefPool: { contract: network === "mainnet" ? "v2.ref-finance.near" : "ref-finance-101.testnet", pool_id: Number(spec.slice(4)), stable_decimals: 6 } };
      else if (spec.startsWith("oracle:"))
        source = { Oracle: { contract: network === "mainnet" ? "priceoracle.near" : "priceoracle.testnet", asset_id: spec.slice(7) } };
      else throw new Error("source must be manual, ref:<pool_id> or oracle:<asset_id>");
      await owner.setPriceSource(source, Number(args["max-age"] ?? 600), (args.feeder as string) ?? null);
      console.log("price source updated");
      return;
    }
    case "history": {
      const h = await owner.getHistory(Number(args.limit ?? 50));
      for (const e of h) {
        const when = new Date(Number(BigInt(e.timestamp) / 1000000n)).toISOString();
        const what = e.action ? JSON.stringify(e.action) : "";
        console.log(`${when}  ${e.event.padEnd(16)} ${(e.label ?? "").padEnd(10)} ${what}${e.reason ? "  [" + e.reason + "]" : ""}`);
      }
      if (h.length === 0) console.log("(no history)");
      return;
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
