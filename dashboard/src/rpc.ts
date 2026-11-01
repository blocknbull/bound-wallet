/**
 * Thin JSON-RPC layer. No SDK needed for reads: view calls and account state
 * are two RPC methods. Keeping this dependency-free keeps the bundle small and
 * the dashboard honest about what it reads from chain.
 */
export type Network = "testnet" | "mainnet";

// FastNEAR endpoints send CORS headers; the legacy rpc.*.near.org hosts do not
// reliably, and they are rate limited for browsers.
export const RPC: Record<Network, string> = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
};

/** Default Bound Reputation registry per network. Override in localStorage key `bound.registry`. */
export const REGISTRY: Record<Network, string | null> = {
  testnet: "reputation.reins.testnet",
  mainnet: null,
};

export function registryId(network: Network): string | null {
  try {
    return localStorage.getItem("bound.registry") || REGISTRY[network];
  } catch {
    return REGISTRY[network];
  }
}

export const EXPLORER: Record<Network, string> = {
  testnet: "https://testnet.nearblocks.io",
  mainnet: "https://nearblocks.io",
};

let id = 0;
export async function rpc<T>(network: Network, method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC[network], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.data?.toString() ?? json.error.message);
  return json.result as T;
}

const enc = (o: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const dec = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes));

export async function view<T>(network: Network, contract: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result: number[]; error?: string }>(network, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: enc(args),
  });
  if (r.error) throw new Error(r.error);
  return JSON.parse(dec(r.result)) as T;
}

export interface AccountView {
  amount: string;
  locked: string;
  storage_usage: number;
  code_hash: string;
}

export function viewAccount(network: Network, accountId: string) {
  return rpc<AccountView>(network, "query", {
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
}

// ---------------------------------------------------------------- amounts

const YOCTO = 10n ** 24n;

export function yoctoToNear(y: string | bigint, digits = 2): string {
  const v = BigInt(y);
  const whole = v / YOCTO;
  const frac = v % YOCTO;
  const fracStr = frac.toString().padStart(24, "0").slice(0, digits);
  const s = digits > 0 ? `${whole}.${fracStr}` : `${whole}`;
  return s.replace(/\.?0+$/, "") || "0";
}

export function nearToYocto(n: string): string {
  const [w, f = ""] = n.trim().split(".");
  const frac = (f + "0".repeat(24)).slice(0, 24);
  return (BigInt(w || "0") * YOCTO + BigInt(frac)).toString();
}

export function pct(part: string | bigint, total: string | bigint): number {
  const t = BigInt(total);
  if (t === 0n) return 0;
  return Number((BigInt(part) * 1000n) / t) / 10;
}

export function timeAgo(ns: string): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
