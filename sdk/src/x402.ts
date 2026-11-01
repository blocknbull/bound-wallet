/**
 * x402-style pay-per-request, settled through a Bound wallet.
 *
 * The flow follows the x402 shape (402 -> pay -> retry with X-PAYMENT), with
 * one difference that is the point: the payment is not a signed delegate from
 * a key that could sign anything. It is an `execute` call on the agent's Bound
 * wallet, so the price is checked against the policy like any other spend:
 * capped per action and per window, denied over the limit, queued above the
 * approval threshold, and recorded on chain.
 *
 * Scheme "near-native": the server names a NEAR account and a price in yocto;
 * the proof is the hash of the execute transaction whose receipt paid it.
 */
import type { BoundAgent, ExecResult } from "./index.js";

export interface PaymentRequirements {
  scheme: "near-native";
  /** "near-mainnet" | "near-testnet" */
  network: string;
  /** NEAR account to pay. */
  payTo: string;
  /** Price in yoctoNEAR. */
  amountYocto: string;
  /** What is being bought, shown to the payer. */
  description?: string;
  /** The URL this price applies to. */
  resource?: string;
}

export interface PaymentRequiredBody {
  x402Version: 1;
  accepts: PaymentRequirements[];
  error?: string;
}

export interface PaymentProof {
  scheme: "near-native";
  wallet: string;
  txHash: string;
}

export const HEADER = "x-payment";

const NETWORK_SUFFIX: Record<string, string> = { "near-mainnet": ".near", "near-testnet": ".testnet" };

export function networkName(networkId: string): string {
  return networkId === "mainnet" ? "near-mainnet" : "near-testnet";
}

// ------------------------------------------------------------------ client

export interface PaidFetchResult {
  /** The final HTTP response (the paid retry when a payment happened). */
  res: Response;
  /** Set when a payment was made. */
  paid: { amountYocto: string; payTo: string; txHash: string } | null;
  /** Set when the wallet refused or deferred the payment. */
  wallet?: { denied?: string; queuedId?: number };
}

/**
 * Fetch a URL; on 402, pay the quoted price through the agent's wallet and
 * retry with the proof. `maxYocto` is a client-side ceiling on top of the
 * policy: a price above it is not even submitted to the wallet.
 */
export async function fetchWithPayment(
  agent: BoundAgent,
  url: string,
  init?: RequestInit,
  opts?: { maxYocto?: string }
): Promise<PaidFetchResult> {
  const first = await fetch(url, init);
  if (first.status !== 402) return { res: first, paid: null };

  let body: PaymentRequiredBody;
  try {
    // Clone so the caller can still read the 402 body if payment is refused.
    body = (await first.clone().json()) as PaymentRequiredBody;
  } catch {
    throw new Error("402 response did not carry x402 payment requirements");
  }
  const network = networkName(agent.walletId.endsWith(".near") || /^[0-9a-f]{64}$/.test(agent.walletId) ? "mainnet" : "testnet");
  const req = body.accepts?.find((a) => a.scheme === "near-native" && a.network === network);
  if (!req) throw new Error(`no near-native payment option for ${network} in: ${JSON.stringify(body.accepts)}`);
  if (!/^\d+$/.test(req.amountYocto)) throw new Error(`bad price: ${req.amountYocto}`);
  if (opts?.maxYocto && BigInt(req.amountYocto) > BigInt(opts.maxYocto)) {
    return { res: first, paid: null, wallet: { denied: `price ${req.amountYocto} yocto exceeds the client ceiling ${opts.maxYocto}` } };
  }

  const r = await agent.execute({ Transfer: { receiver: req.payTo, amount: req.amountYocto } });
  const result: ExecResult = r.result;
  if (result !== "Executed") {
    if (typeof result === "object" && "Denied" in result) return { res: first, paid: null, wallet: { denied: result.Denied.reason } };
    if (typeof result === "object" && "Queued" in result) return { res: first, paid: null, wallet: { queuedId: result.Queued.id } };
    throw new Error(`payment failed: ${JSON.stringify(result)}`);
  }

  const proof: PaymentProof = { scheme: "near-native", wallet: agent.walletId, txHash: r.txHash };
  const headers = new Headers(init?.headers);
  headers.set(HEADER, Buffer.from(JSON.stringify(proof)).toString("base64"));
  const second = await fetch(url, { ...init, headers });
  return { res: second, paid: { amountYocto: req.amountYocto, payTo: req.payTo, txHash: r.txHash } };
}

// ------------------------------------------------------------------ server

/** Body + status a server returns to ask for payment. */
export function paymentRequired(req: PaymentRequirements): { status: 402; body: PaymentRequiredBody } {
  return { status: 402, body: { x402Version: 1, accepts: [req] } };
}

export interface VerifyOptions {
  rpcUrl: string;
  /** Replay protection: a store of tx hashes already accepted. */
  seen: { has(h: string): boolean; add(h: string): void };
}

/**
 * Verify a proof: the transaction exists, succeeded, was signed by the wallet
 * named in the proof, contains a transfer receipt of at least the price to
 * `payTo`, and has not been used before. On success the hash is consumed.
 */
export async function verifyPayment(
  proofB64: string | null,
  req: PaymentRequirements,
  opts: VerifyOptions
): Promise<{ ok: boolean; wallet?: string; reason?: string }> {
  if (!proofB64) return { ok: false, reason: "missing X-PAYMENT header" };
  let proof: PaymentProof;
  try {
    proof = JSON.parse(Buffer.from(proofB64, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "X-PAYMENT is not base64 JSON" };
  }
  if (proof.scheme !== "near-native" || !proof.txHash || !proof.wallet) return { ok: false, reason: "malformed proof" };
  if (opts.seen.has(proof.txHash)) return { ok: false, reason: "payment already used" };

  const suffix = NETWORK_SUFFIX[req.network];
  if (suffix && !proof.wallet.endsWith(suffix) && !/^[0-9a-f]{64}$/.test(proof.wallet)) {
    return { ok: false, reason: `wallet ${proof.wallet} is not on ${req.network}` };
  }

  const rpc = await fetch(opts.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: [proof.txHash, proof.wallet] }),
  });
  const data = (await rpc.json()) as any;
  if (data.error) return { ok: false, reason: `tx lookup failed: ${data.error.data ?? data.error.message}` };
  const result = data.result;
  const signer = result?.transaction?.signer_id ?? result?.transaction?.signer_account_id;
  if (signer !== proof.wallet) return { ok: false, reason: "tx not signed by the claimed wallet" };
  if (!("SuccessValue" in (result?.status ?? {}))) return { ok: false, reason: "tx did not succeed" };

  const want = BigInt(req.amountYocto);
  const paid = (result?.receipts ?? []).some(
    (r: any) =>
      r.receiver_id === req.payTo &&
      (r.receipt?.Action?.actions ?? []).some((a: any) => a.Transfer && BigInt(a.Transfer.deposit) >= want)
  );
  if (!paid) return { ok: false, reason: `no transfer of ${req.amountYocto} yocto to ${req.payTo} in that tx` };

  opts.seen.add(proof.txHash);
  return { ok: true, wallet: proof.wallet };
}
