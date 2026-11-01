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
  max_per_tx: string;
  window_cap: string;
  window_secs: number;
  max_tx_per_window: number;
  receivers: ReceiverRule;
  calls: CallRule[];
  tokens: TokenRule[];
  active_hours_utc: { start_hour: number; end_hour: number } | null;
  expires_at: string | null;
  approval_above: string | null;
  max_per_tx_usd_cents?: number | null;
  window_cap_usd_cents?: number | null;
  allow_intents?: boolean;
  tripwire?: { max_denials: number; window_secs: number } | null;
  approve_new_receivers?: boolean;
}

export interface PriceQuote {
  cents_per_near: number;
  updated_at: string;
  source: string;
  fresh: boolean;
  max_age_secs: number;
}

export type Action =
  | { Transfer: { receiver: string; amount: string } }
  | { FtTransfer: { token: string; receiver: string; amount: string; memo?: string | null } }
  | { FunctionCall: { contract: string; method: string; args: string; deposit: string; gas_tgas?: number | null } }
  | { IntentsDeposit: { deposit_address: string; amount: string; token: string | null; destination_asset: string; recipient: string; quote_ref: string } };

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

/** Known 1Click asset ids. Anything else falls back to the chain prefix. */
const ASSETS: Record<string, { symbol: string; chain: string }> = {
  "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near": { symbol: "USDC", chain: "Base" },
  "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": { symbol: "USDC", chain: "NEAR" },
  "nep141:eth.bridge.near": { symbol: "ETH", chain: "NEAR" },
  "nep141:wrap.near": { symbol: "wNEAR", chain: "NEAR" },
  "nep141:eth.omft.near": { symbol: "ETH", chain: "Ethereum" },
  "nep141:btc.omft.near": { symbol: "BTC", chain: "Bitcoin" },
  "nep141:sol.omft.near": { symbol: "SOL", chain: "Solana" },
};

export function describeAsset(assetId: string): { symbol: string; chain: string } {
  if (ASSETS[assetId]) return ASSETS[assetId];
  const bare = assetId.replace(/^nep141:/, "");
  const m = bare.match(/^([a-z]+)-0x[0-9a-f]+\.omft\.near$/);
  if (m) return { symbol: "token", chain: m[1][0].toUpperCase() + m[1].slice(1) };
  if (bare.endsWith(".omft.near")) return { symbol: bare.split(".")[0].toUpperCase(), chain: bare.split(".")[0] };
  return { symbol: bare.split(".")[0], chain: "NEAR" };
}

export function describeAction(a: Action): { title: string; subtitle: string; amountYocto: string | null } {
  if ("Transfer" in a) return { title: `Pay ${a.Transfer.receiver}`, subtitle: "NEAR transfer", amountYocto: a.Transfer.amount };
  if ("FtTransfer" in a)
    return {
      title: `Pay ${a.FtTransfer.receiver}`,
      subtitle: `${a.FtTransfer.amount} units of ${a.FtTransfer.token}`,
      amountYocto: null,
    };
  if ("IntentsDeposit" in a) {
    const d = a.IntentsDeposit;
    const { symbol, chain } = describeAsset(d.destination_asset);
    return {
      title: `Swap to ${symbol} on ${chain} → ${d.recipient.length > 14 ? d.recipient.slice(0, 10) + "…" : d.recipient}`,
      subtitle: `NEAR Intents · deposit ${d.deposit_address.slice(0, 12)}… · ${d.quote_ref.slice(0, 8)}`,
      amountYocto: d.token ? null : d.amount,
    };
  }
  return {
    title: `${a.FunctionCall.contract}.${a.FunctionCall.method}`,
    subtitle: "Contract call",
    amountYocto: a.FunctionCall.deposit,
  };
}

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
