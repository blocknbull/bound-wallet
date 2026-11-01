#!/usr/bin/env node
/**
 * BoundWallet MCP server. Gives any MCP-capable agent (Claude, Codex, OpenClaw,
 * IronClaw, Cursor...) a wallet it cannot abuse. The agent sees four tools;
 * the owner's policy decides what actually happens.
 *
 * Env: BOUND_WALLET, BOUND_AGENT_KEY, NEAR_NETWORK (default testnet)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BoundAgent, BoundReputation, NEAR, fromYocto, type Action } from "./index.js";
import { DESTINATIONS, swapStatus } from "./oneclick.js";

const walletId = process.env.BOUND_WALLET;
const secretKey = process.env.BOUND_AGENT_KEY;
const network = process.env.NEAR_NETWORK ?? "testnet";
if (!walletId || !secretKey) {
  console.error("BOUND_WALLET and BOUND_AGENT_KEY must be set");
  process.exit(1);
}

const agentP = BoundAgent.load(network, walletId, secretKey);

const ActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("transfer"),
    receiver: z.string().describe("NEAR account to pay"),
    amount_near: z.string().describe("Amount in NEAR, e.g. '0.25'"),
  }),
  z.object({
    type: z.literal("ft_transfer"),
    token: z.string().describe("NEP-141 token contract, e.g. usdc.fakes.testnet"),
    receiver: z.string(),
    amount: z.string().describe("Amount in the token's smallest unit"),
    memo: z.string().optional(),
  }),
  z.object({
    type: z.literal("call"),
    contract: z.string(),
    method: z.string(),
    args: z.record(z.any()).default({}).describe("JSON arguments"),
    deposit_near: z.string().default("0"),
    gas_tgas: z.number().int().min(1).max(250).optional(),
  }),
]);

function toAction(a: z.infer<typeof ActionSchema>): Action {
  switch (a.type) {
    case "transfer":
      return { Transfer: { receiver: a.receiver, amount: NEAR(a.amount_near) } };
    case "ft_transfer":
      return { FtTransfer: { token: a.token, receiver: a.receiver, amount: a.amount, memo: a.memo ?? null } };
    case "call":
      return {
        FunctionCall: {
          contract: a.contract,
          method: a.method,
          args: JSON.stringify(a.args),
          deposit: NEAR(a.deposit_near),
          gas_tgas: a.gas_tgas ?? null,
        },
      };
  }
}

const text = (x: unknown) => ({ content: [{ type: "text" as const, text: typeof x === "string" ? x : JSON.stringify(x, null, 2) }] });

const server = new McpServer({ name: "bound-wallet", version: "0.1.0" });

server.tool(
  "bound_status",
  "Show this agent's wallet, policy, remaining budget and reputation counters. Call this first so you know what you are allowed to spend.",
  {},
  async () => {
    const agent = await agentP;
    const [me, remaining, balance] = await Promise.all([agent.me(), agent.remaining(), agent.balance()]);
    if (!me) return text({ error: "this key is not registered on the wallet" });
    return text({
      wallet: agent.walletId,
      wallet_balance_near: balance,
      policy: {
        max_per_tx_near: fromYocto(me.policy.max_per_tx),
        window_cap_near: fromYocto(me.policy.window_cap),
        window_secs: me.policy.window_secs,
        max_tx_per_window: me.policy.max_tx_per_window,
        receivers: me.policy.receivers,
        calls: me.policy.calls,
        tokens: me.policy.tokens,
        active_hours_utc: me.policy.active_hours_utc,
        approval_above_near: me.policy.approval_above ? fromYocto(me.policy.approval_above) : null,
        max_per_tx_usd: me.policy.max_per_tx_usd_cents != null ? me.policy.max_per_tx_usd_cents / 100 : null,
        window_cap_usd: me.policy.window_cap_usd_cents != null ? me.policy.window_cap_usd_cents / 100 : null,
      },
      remaining: remaining && {
        native_near: fromYocto(remaining.native),
        usd: remaining.usd_cents != null ? remaining.usd_cents / 100 : null,
        wallet_free_near: fromYocto(remaining.wallet_free),
        tokens: remaining.tokens,
        actions: remaining.actions,
        window_resets_at_ns: remaining.window_resets_at,
      },
      stats: me.stats,
    });
  }
);

server.tool(
  "bound_check",
  "Dry-run an action against the wallet policy without executing it. Returns allowed / needs_approval / reason.",
  { action: ActionSchema },
  async ({ action }) => text(await (await agentP).check(toAction(action)))
);

server.tool(
  "bound_execute",
  "Execute an action through the policy wallet. The result is Executed, Denied {reason}, Queued {id} (waiting for the human owner) or Failed. Denials are recorded on-chain; do not retry a denied action with different parameters to get around the policy.",
  { action: ActionSchema },
  async ({ action }) => {
    const r = await (await agentP).execute(toAction(action));
    return text(r);
  }
);

server.tool(
  "bound_explain_denial",
  "Given a denial reason from bound_execute, explain what the policy allows instead.",
  { reason: z.string() },
  async ({ reason }) => {
    const agent = await agentP;
    const me = await agent.me();
    const rem = await agent.remaining();
    if (!me) return text("Key not registered.");
    const lines = [`Denied because: ${reason}`];
    if (/allowlist/.test(reason) && typeof me.policy.receivers === "object")
      lines.push(`Allowed receivers: ${me.policy.receivers.Allowlist.join(", ")}`);
    if (/max_per_tx/.test(reason)) lines.push(`Max per action: ${fromYocto(me.policy.max_per_tx)} NEAR`);
    if (/window cap/.test(reason) && rem) lines.push(`Remaining this window: ${fromYocto(rem.native)} NEAR`);
    if (/rate limit/.test(reason)) lines.push(`Max actions per window: ${me.policy.max_tx_per_window}`);
    if (/not allowed/.test(reason) && /call/.test(reason))
      lines.push(`Allowed calls: ${me.policy.calls.map((c) => `${c.contract}.${c.methods.join("|") || "*"}`).join(", ") || "none"}`);
    if (/token/.test(reason)) lines.push(`Allowed tokens: ${me.policy.tokens.map((t) => t.token).join(", ") || "none"}`);
    if (/paused/.test(reason)) lines.push("The owner paused the wallet. Wait for them to unpause.");
    if (/suspended/.test(reason)) lines.push("You tripped the wire: too many denied actions in a short time. Stop retrying. Only the owner can lift the suspension.");
    if (/USD window cap|exceeds max_per_tx \$/.test(reason) && rem?.usd_cents != null) lines.push(`Remaining USD this window: $${(rem.usd_cents / 100).toFixed(2)}`);
    if (/price unavailable/.test(reason)) lines.push("The wallet could not get a fresh NEAR/USD price. Ask the owner to set or refresh it.");
    if (/active hours/.test(reason) && me.policy.active_hours_utc)
      lines.push(`Active hours UTC: ${me.policy.active_hours_utc.start_hour}-${me.policy.active_hours_utc.end_hour}`);
    lines.push("If you need more, ask the owner to change the policy. Do not try to work around it.");
    return text(lines.join("\n"));
  }
);

if (network === "mainnet") {
  const recipients = (process.env.BOUND_SWAP_RECIPIENTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const recipientOk = (r: string) => recipients.length === 0 || recipients.includes(r.toLowerCase());
  const Dest = z.string().describe("Destination: a shorthand like usdc:base, usdc:near, eth:near, or a 1Click assetId");

  server.tool(
    "bound_swap_quote",
    "Dry-run a cross-chain swap via NEAR Intents: how much of the destination asset would N NEAR buy, delivered to `recipient` on the destination chain. No funds move.",
    { amount_near: z.string(), destination: Dest, recipient: z.string() },
    async ({ amount_near, destination, recipient }) => {
      const agent = await agentP;
      const r = await agent.swap({ amountNear: amount_near, destinationAsset: DESTINATIONS[destination] ?? destination, recipient, dry: true });
      return text({ amount_in: r.quote.quote.amountInFormatted, amount_in_usd: r.quote.quote.amountInUsd, amount_out: r.quote.quote.amountOutFormatted, amount_out_usd: r.quote.quote.amountOutUsd, eta_seconds: r.quote.quote.timeEstimate });
    }
  );
  server.tool(
    "bound_swap",
    "Execute a cross-chain swap via NEAR Intents, funded by this wallet under its policy. The policy must allow intents, and the amount counts against the agent's caps and approval threshold like any payment. Returns the wallet's decision and the deposit address to track the swap.",
    { amount_near: z.string(), destination: Dest, recipient: z.string(), confidential: z.boolean().optional().describe("Route via Confidential Intents so counterparties and amounts are hidden on NEAR") },
    async ({ amount_near, destination, recipient, confidential }) => {
      if (!recipientOk(recipient)) return text({ Denied: { reason: `recipient ${recipient} is not in BOUND_SWAP_RECIPIENTS (off-chain guard)` } });
      const agent = await agentP;
      const r = await agent.swap({ amountNear: amount_near, destinationAsset: DESTINATIONS[destination] ?? destination, recipient, confidential });
      return text({ result: r.result, tx_hash: r.txHash, deposit_address: r.quote.quote.depositAddress, correlation_id: r.quote.correlationId, amount_out: r.quote.quote.amountOutFormatted, eta_seconds: r.quote.quote.timeEstimate });
    }
  );
  server.tool("bound_swap_status", "Check a NEAR Intents swap by its deposit address.", { deposit_address: z.string() }, async ({ deposit_address }) => text(await swapStatus(deposit_address)));
}

const registryId = process.env.BOUND_REGISTRY;
if (registryId) {
  server.tool(
    "bound_my_reputation",
    "Read this agent's reputation score (0-100) and tier from the Bound Reputation registry. Denials and failures lower it; it is public, so other agents and marketplaces can see it too.",
    {},
    async () => {
      const agent = await agentP;
      const rep = await BoundReputation.load(network, registryId);
      const sc = await rep.getScore(agent.publicKey);
      return text(sc ?? { note: "not scored yet; the wallet may not be registered or synced" });
    }
  );
  server.tool(
    "bound_check_reputation",
    "Look up another agent's reputation before trusting or hiring it, by its Agent ID handle (e.g. acme-buyer) or its public key.",
    { agent: z.string().describe("Agent ID handle or ed25519 public key") },
    async ({ agent: who }) => {
      const rep = await BoundReputation.load(network, registryId);
      return text((await rep.lookup(who)) ?? { note: "unknown agent" });
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
