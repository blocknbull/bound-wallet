/**
 * BoundWallet SDK: typed client for the policy-enforced agent wallet contract.
 *
 * Two roles:
 *  - BoundOwner: the human. Deploys the wallet, registers agents, sets policy,
 *    approves queued actions, pauses, withdraws.
 *  - BoundAgent: the AI. Holds only a function-call key scoped to `execute`.
 */
import { connect, keyStores, KeyPair, Account, Near, utils } from "near-api-js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ------------------------------------------------------------------ types

export type ReceiverRule = "Any" | { Allowlist: string[] };

export interface CallRule {
  contract: string;
  methods: string[];
}

export interface TokenRule {
  token: string;
  max_per_tx: string;
  window_cap: string;
}

export interface Policy {
  max_per_tx: string; // yoctoNEAR
  window_cap: string; // yoctoNEAR
  window_secs: number;
  max_tx_per_window: number;
  receivers: ReceiverRule;
  calls: CallRule[];
  tokens: TokenRule[];
  active_hours_utc: { start_hour: number; end_hour: number } | null;
  expires_at: string | null; // ns since epoch
  approval_above: string | null; // yoctoNEAR
  max_per_tx_usd_cents?: number | null;
  window_cap_usd_cents?: number | null;
  allow_intents?: boolean;
  tripwire?: { max_denials: number; window_secs: number } | null;
  /** First payment to a never-before-paid receiver is queued for the owner. */
  approve_new_receivers?: boolean;
}

export type PriceSource =
  | "Manual"
  | { RefPool: { contract: string; pool_id: number; stable_decimals: number } }
  | { Oracle: { contract: string; asset_id: string } };

export interface PriceQuote {
  cents_per_near: number;
  updated_at: string;
  source: string;
  fresh: boolean;
  max_age_secs: number;
}

export type Action =
  | { Transfer: { receiver: string; amount: string } }
  | {
      FtTransfer: {
        token: string;
        receiver: string;
        amount: string;
        memo?: string | null;
      };
    }
  | {
      IntentsDeposit: {
        deposit_address: string;
        amount: string;
        token: string | null;
        destination_asset: string;
        recipient: string;
        quote_ref: string;
      };
    }
  | {
      FunctionCall: {
        contract: string;
        method: string;
        args: string;
        deposit: string;
        gas_tgas?: number | null;
      };
    };

export type ExecResult =
  | "Executed"
  | { Failed: { reason: string } }
  | { Denied: { reason: string } }
  | { Queued: { id: number } };

export interface Verdict {
  allowed: boolean;
  needs_approval: boolean;
  reason: string | null;
}

export interface Usage {
  window_start: string;
  spent: string;
  count: number;
  spent_usd_cents?: number;
}

export interface Stats {
  executed: number;
  denied: number;
  queued: number;
  approved: number;
  rejected: number;
  failed: number;
  added_at: string;
  last_active: string;
}

export interface AgentRecord {
  label: string;
  public_key: string;
  policy: Policy;
  native_usage: Usage;
  token_usage: [string, Usage][];
  stats: Stats;
  suspended?: boolean;
  denials_in_window?: number;
  known_receivers?: string[];
}

export interface PendingAction {
  id: number;
  agent_key: string;
  action: Action;
  created_at: string;
}

export interface HistoryEntry {
  seq: number;
  event: string;
  agent_key: string | null;
  label: string | null;
  action: Action | null;
  reason: string | null;
  pending_id: number | null;
  timestamp: string;
  block_height: string;
}

export interface Remaining {
  native: string;
  wallet_free: string;
  usd_cents: number | null;
  tokens: [string, string][];
  actions: number | null;
  window_resets_at: string;
}

// ---------------------------------------------------------------- helpers

export const NEAR = (n: string | number): string =>
  utils.format.parseNearAmount(String(n)) ?? "0";

export const fromYocto = (y: string): string =>
  utils.format.formatNearAmount(y, 4);

export function rpcUrl(networkId: string): string {
  if (process.env.NEAR_RPC_URL) return process.env.NEAR_RPC_URL;
  // FastNEAR public endpoints; the legacy rpc.*.near.org hosts rate-limit hard.
  return networkId === "mainnet"
    ? "https://free.rpc.fastnear.com"
    : "https://test.rpc.fastnear.com";
}

/** Connect with the keys in ~/.near-credentials (what near-cli writes). */
export async function connectWithCredentials(networkId: string): Promise<Near> {
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(
    join(homedir(), ".near-credentials")
  );
  return connect({ networkId, nodeUrl: rpcUrl(networkId), keyStore });
}

/** Connect with one in-memory key bound to `accountId`. */
export async function connectWithKey(
  networkId: string,
  accountId: string,
  secretKey: string
): Promise<Near> {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey(networkId, accountId, KeyPair.fromString(secretKey as any));
  return connect({ networkId, nodeUrl: rpcUrl(networkId), keyStore });
}

/** Read-only connection. */
export async function connectView(networkId: string): Promise<Near> {
  return connect({
    networkId,
    nodeUrl: rpcUrl(networkId),
    keyStore: new keyStores.InMemoryKeyStore(),
  });
}

const GAS_100 = BigInt("100000000000000");
const GAS_200 = BigInt("200000000000000");

async function view<T>(account: Account, contractId: string, methodName: string, args: object): Promise<T> {
  return account.viewFunction({ contractId, methodName, args }) as Promise<T>;
}

/** Pull the typed return value out of a FinalExecutionOutcome. */
export function parseResult<T>(outcome: any): T | undefined {
  const status = outcome?.status;
  const b64 = status?.SuccessValue;
  if (typeof b64 !== "string" || b64.length === 0) return undefined;
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as T;
}

/** Collect NEP-297 events emitted by the wallet in an outcome. */
export function parseEvents(outcome: any): { event: string; data: any }[] {
  const logs: string[] = [];
  for (const r of outcome?.receipts_outcome ?? []) logs.push(...(r.outcome?.logs ?? []));
  logs.push(...(outcome?.transaction_outcome?.outcome?.logs ?? []));
  return logs
    .filter((l) => l.startsWith("EVENT_JSON:"))
    .map((l) => JSON.parse(l.slice("EVENT_JSON:".length)))
    .filter((e) => e.standard === "bound-wallet")
    .map((e) => ({ event: e.event, data: e.data?.[0] }));
}

// ------------------------------------------------------------------ owner

export class BoundOwner {
  constructor(
    public readonly near: Near,
    public readonly owner: Account,
    public readonly walletId: string
  ) {}

  static async load(networkId: string, ownerId: string, walletId: string): Promise<BoundOwner> {
    const near = await connectWithCredentials(networkId);
    return new BoundOwner(near, await near.account(ownerId), walletId);
  }

  /**
   * Create `walletId` as a sub-account of the owner, deploy the contract and
   * initialise it. The owner's own public key is added as a full-access key
   * for recovery and upgrades; pass `recoveryKey: null` to leave the wallet
   * with no full-access key at all (only agent keys and contract logic).
   */
  static async deploy(opts: {
    networkId: string;
    ownerId: string;
    walletId: string;
    wasmPath: string;
    initialBalanceNear: string;
    recoveryKey?: string | null;
  }): Promise<BoundOwner> {
    const near = await connectWithCredentials(opts.networkId);
    const owner = await near.account(opts.ownerId);
    const wasm = readFileSync(opts.wasmPath);
    const key =
      opts.recoveryKey === undefined
        ? (await near.connection.signer.getPublicKey(opts.ownerId, opts.networkId)).toString()
        : opts.recoveryKey;
    const amount = BigInt(NEAR(opts.initialBalanceNear));
    if (key) {
      await owner.createAndDeployContract(opts.walletId, key, wasm, amount);
    } else {
      // No full-access key: create with a throwaway key, deploy, then delete it.
      const tmp = KeyPair.fromRandom("ed25519");
      await owner.createAndDeployContract(opts.walletId, tmp.getPublicKey(), wasm, amount);
      const ks = near.connection.signer as any;
      await ks.keyStore.setKey(opts.networkId, opts.walletId, tmp);
      const w = await near.account(opts.walletId);
      await w.functionCall({
        contractId: opts.walletId,
        methodName: "new",
        args: { owner: opts.ownerId },
        gas: GAS_100,
      });
      await w.deleteKey(tmp.getPublicKey());
      return new BoundOwner(near, owner, opts.walletId);
    }
    await owner.functionCall({
      contractId: opts.walletId,
      methodName: "new",
      args: { owner: opts.ownerId },
      gas: GAS_100,
    });
    return new BoundOwner(near, owner, opts.walletId);
  }

  async addAgent(publicKey: string, label: string, policy: Policy, gasAllowanceYocto?: string) {
    return this.owner.functionCall({
      contractId: this.walletId,
      methodName: "add_agent",
      args: { public_key: publicKey, label, policy, gas_allowance: gasAllowanceYocto ?? null },
      gas: GAS_100,
    });
  }

  async updatePolicy(publicKey: string, policy: Policy) {
    return this.owner.functionCall({
      contractId: this.walletId,
      methodName: "update_policy",
      args: { public_key: publicKey, policy },
      gas: GAS_100,
    });
  }

  async removeAgent(publicKey: string) {
    return this.owner.functionCall({
      contractId: this.walletId,
      methodName: "remove_agent",
      args: { public_key: publicKey },
      gas: GAS_100,
    });
  }

  async suspend(publicKey: string) {
    return this.owner.functionCall({ contractId: this.walletId, methodName: "suspend", args: { public_key: publicKey }, gas: GAS_100 });
  }

  async unsuspend(publicKey: string) {
    return this.owner.functionCall({ contractId: this.walletId, methodName: "unsuspend", args: { public_key: publicKey }, gas: GAS_100 });
  }

  async topUpGas(publicKey: string, allowanceYocto: string) {
    return this.owner.functionCall({ contractId: this.walletId, methodName: "top_up_gas", args: { public_key: publicKey, allowance: allowanceYocto }, gas: GAS_100 });
  }

  /** Upgrade the wallet's code through the contract itself (owner only). */
  async upgrade(wasm: Uint8Array) {
    return this.owner.functionCall({
      contractId: this.walletId,
      methodName: "upgrade",
      args: wasm,
      gas: GAS_200,
      stringify: (x: any) => x,
    });
  }

  async pause() {
    return this.owner.functionCall({ contractId: this.walletId, methodName: "pause", args: {}, gas: GAS_100 });
  }

  async unpause() {
    return this.owner.functionCall({ contractId: this.walletId, methodName: "unpause", args: {}, gas: GAS_100 });
  }

  async approve(id: number): Promise<ExecResult | undefined> {
    const out = await this.owner.functionCall({
      contractId: this.walletId,
      methodName: "approve",
      args: { id },
      gas: GAS_200,
    });
    return parseResult<ExecResult>(out);
  }

  async reject(id: number) {
    return this.owner.functionCall({ contractId: this.walletId, methodName: "reject", args: { id }, gas: GAS_100 });
  }

  async withdraw(receiver: string, amountYocto: string) {
    return this.owner.functionCall({
      contractId: this.walletId,
      methodName: "withdraw",
      args: { receiver, amount: amountYocto },
      gas: GAS_100,
    });
  }

  listAgents() {
    return view<AgentRecord[]>(this.owner, this.walletId, "list_agents", {});
  }
  getPending() {
    return view<PendingAction[]>(this.owner, this.walletId, "get_pending", {});
  }
  getAgent(publicKey: string) {
    return view<AgentRecord | null>(this.owner, this.walletId, "get_agent", { public_key: publicKey });
  }
  getRemaining(publicKey: string) {
    return view<Remaining | null>(this.owner, this.walletId, "get_remaining", { public_key: publicKey });
  }
  getHistory(limit = 50) {
    return view<HistoryEntry[]>(this.owner, this.walletId, "get_history", { limit });
  }
  getPrice() {
    return view<PriceQuote | null>(this.owner, this.walletId, "get_price", {});
  }

  /** Owner or feeder pushes a NEAR/USD price in cents (Manual source). */
  async setPrice(centsPerNear: number) {
    return this.owner.functionCall({ contractId: this.walletId, methodName: "set_price", args: { cents_per_near: centsPerNear }, gas: GAS_100 });
  }

  async setPriceSource(source: PriceSource, maxAgeSecs: number, feeder: string | null) {
    return this.owner.functionCall({
      contractId: this.walletId,
      methodName: "set_price_source",
      args: { source, max_age_secs: maxAgeSecs, feeder },
      gas: GAS_100,
    });
  }

  /** Pull a fresh price from the configured on-chain source. Anyone can call this. */
  async refreshPrice() {
    const out = await this.owner.functionCall({ contractId: this.walletId, methodName: "refresh_price", args: {}, gas: GAS_100 });
    return parseResult<boolean>(out);
  }
}

// ------------------------------------------------------------------ agent

export class BoundAgent {
  constructor(
    public readonly near: Near,
    public readonly wallet: Account,
    public readonly walletId: string,
    public readonly publicKey: string
  ) {}

  /** `secretKey` is the agent's function-call key, e.g. "ed25519:...". */
  static async load(networkId: string, walletId: string, secretKey: string): Promise<BoundAgent> {
    const near = await connectWithKey(networkId, walletId, secretKey);
    const pk = KeyPair.fromString(secretKey as any).getPublicKey().toString();
    return new BoundAgent(near, await near.account(walletId), walletId, pk);
  }

  /** Ask the wallet to perform an action. Never throws on policy denial. */
  async execute(action: Action): Promise<{ result: ExecResult; events: { event: string; data: any }[]; txHash: string }> {
    const out = await this.wallet.functionCall({
      contractId: this.walletId,
      methodName: "execute",
      args: { action },
      gas: GAS_200,
    });
    return {
      result: parseResult<ExecResult>(out) ?? "Executed",
      events: parseEvents(out),
      txHash: out.transaction?.hash,
    };
  }

  /** Dry run: would this action pass right now? */
  check(action: Action) {
    return view<Verdict>(this.wallet, this.walletId, "check", { public_key: this.publicKey, action });
  }

  me() {
    return view<AgentRecord | null>(this.wallet, this.walletId, "get_agent", { public_key: this.publicKey });
  }

  remaining() {
    return view<Remaining | null>(this.wallet, this.walletId, "get_remaining", { public_key: this.publicKey });
  }

  async balance() {
    const b = await this.wallet.getAccountBalance();
    return { total: fromYocto(b.total), available: fromYocto(b.available) };
  }

  /**
   * Cross-chain swap through NEAR Intents (1Click), funded under policy.
   * Gets a quote, asks the wallet to send native NEAR to the quote's deposit
   * address as an `IntentsDeposit`, reports the tx hash to 1Click, and
   * returns everything needed to track it. Mainnet only.
   */
  async swap(opts: { amountNear: string; destinationAsset: string; recipient: string; slippageBps?: number; dry?: boolean; confidential?: boolean }) {
    const oc = await import("./oneclick.js");
    const onMainnet = this.walletId.endsWith(".near") || /^[0-9a-f]{64}$/.test(this.walletId);
    if (!opts.dry && !onMainnet) throw new Error("NEAR Intents has no testnet; live swaps need a mainnet wallet (dry quotes work anywhere)");
    const quote = await oc.requestQuote({
      originAsset: oc.WNEAR,
      destinationAsset: opts.destinationAsset,
      amount: NEAR(opts.amountNear),
      recipient: opts.recipient,
      // 1Click validates refundTo as an existing mainnet account even for dry
      // quotes (and rejects the wNEAR contract itself), so testnet wallets
      // borrow a placeholder for dry runs.
      refundTo: onMainnet ? this.walletId : process.env.BOUND_DRY_REFUND ?? "bound.near",
      slippageBps: opts.slippageBps,
      dry: opts.dry,
      confidential: opts.confidential,
    });
    if (opts.dry || !quote.quote.depositAddress) return { quote, result: null as ExecResult | null, txHash: null as string | null };
    const action: Action = {
      IntentsDeposit: {
        deposit_address: quote.quote.depositAddress,
        amount: quote.quote.amountIn,
        token: null,
        destination_asset: opts.destinationAsset,
        recipient: opts.recipient,
        quote_ref: quote.correlationId,
      },
    };
    const r = await this.execute(action);
    if (r.result === "Executed" && r.txHash) {
      await oc.submitDeposit(quote.quote.depositAddress, r.txHash).catch(() => undefined);
    }
    return { quote, result: r.result, txHash: r.txHash };
  }
}

// ------------------------------------------------------------ reputation

export interface Counters {
  executed: number;
  denied: number;
  failed: number;
  approved: number;
  rejected: number;
  queued: number;
}

export interface Score {
  public_key: string;
  handle: string | null;
  score: number;
  tier: "new" | "trusted" | "caution" | "risky";
  scored_events: number;
  verified: Counters;
  unverified: Counters;
  wallets: string[];
  labels: string[];
  first_seen: string;
  last_seen: string;
  last_denied: string | null;
}

export interface RegistryWallet {
  wallet: string;
  owner: string | null;
  verified: boolean;
  registered_by: string;
  registered_at: string;
  next_seq: number;
  synced_at: string;
  events: number;
}

/** Client for the Bound Reputation registry. Reads need no key. */
export class BoundReputation {
  constructor(
    public readonly account: Account,
    public readonly registryId: string
  ) {}

  static async load(networkId: string, registryId: string, signerId?: string): Promise<BoundReputation> {
    const near = signerId ? await connectWithCredentials(networkId) : await connectView(networkId);
    return new BoundReputation(await near.account(signerId ?? registryId), registryId);
  }

  getScore(publicKey: string) {
    return view<Score | null>(this.account, this.registryId, "get_score", { public_key: publicKey });
  }
  /** Look up by Agent ID handle or public key. */
  lookup(handleOrKey: string) {
    return handleOrKey.includes(":") ? this.getScore(handleOrKey) : view<Score | null>(this.account, this.registryId, "resolve_handle", { handle: handleOrKey });
  }
  /** Wallet owner gives an agent a human-readable Agent ID. */
  claimHandle(handle: string, wallet: string, publicKey: string) {
    return this.account.functionCall({ contractId: this.registryId, methodName: "claim_handle", args: { handle, wallet, public_key: publicKey }, gas: GAS_100 });
  }
  listScores(from = 0, limit = 50) {
    return view<Score[]>(this.account, this.registryId, "list_scores", { from, limit });
  }
  getWallet(wallet: string) {
    return view<RegistryWallet | null>(this.account, this.registryId, "get_wallet", { wallet });
  }
  listWallets() {
    return view<RegistryWallet[]>(this.account, this.registryId, "list_wallets", {});
  }
  register(wallet: string) {
    return this.account.functionCall({ contractId: this.registryId, methodName: "register", args: { wallet }, gas: GAS_100 });
  }
  verify(wallet: string, verified = true) {
    return this.account.functionCall({ contractId: this.registryId, methodName: "verify", args: { wallet, verified }, gas: GAS_100 });
  }
  async sync(wallet: string): Promise<number> {
    const out = await this.account.functionCall({ contractId: this.registryId, methodName: "sync", args: { wallet }, gas: GAS_100 });
    return parseResult<number>(out) ?? 0;
  }
}

// -------------------------------------------------------------- policies

/** A sensible starter policy: small daily budget, allowlisted receivers only. */
export function starterPolicy(opts: {
  maxPerTxNear?: string;
  dailyCapNear?: string;
  receivers?: string[];
  approvalAboveNear?: string;
  calls?: CallRule[];
  tokens?: TokenRule[];
  maxTxPerDay?: number;
}): Policy {
  return {
    max_per_tx: NEAR(opts.maxPerTxNear ?? "0.5"),
    window_cap: NEAR(opts.dailyCapNear ?? "2"),
    window_secs: 86400,
    max_tx_per_window: opts.maxTxPerDay ?? 50,
    receivers: opts.receivers ? { Allowlist: opts.receivers } : "Any",
    calls: opts.calls ?? [],
    tokens: opts.tokens ?? [],
    active_hours_utc: null,
    expires_at: null,
    approval_above: opts.approvalAboveNear ? NEAR(opts.approvalAboveNear) : null,
    max_per_tx_usd_cents: null,
    window_cap_usd_cents: null,
    allow_intents: false,
    tripwire: { max_denials: 5, window_secs: 3600 },
    approve_new_receivers: !opts.receivers,
  };
}

export function loadPolicyFile(path: string): Policy {
  if (!existsSync(path)) throw new Error(`policy file not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as Policy;
}
