/**
 * Minimal client for the NEAR Intents 1Click swap API. No SDK dependency: it
 * is three HTTP calls. Mainnet only; NEAR Intents has no testnet.
 *
 * Flow: quote -> the wallet funds the quote's deposit address under policy
 * (an `IntentsDeposit` action) -> optionally tell 1Click the tx hash ->
 * poll status until SUCCESS / REFUNDED / FAILED.
 */

export const ONECLICK_URL = "https://1click.chaindefuser.com/v0";

export interface OneClickToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price?: number;
  contractAddress?: string;
}

export interface QuoteParams {
  /** Origin asset id, e.g. "nep141:wrap.near". */
  originAsset: string;
  /** Destination asset id, e.g. "nep141:base-0x8335...omft.near" (USDC on Base). */
  destinationAsset: string;
  /** Amount in the origin asset's smallest unit. */
  amount: string;
  /** Destination address on the destination chain. */
  recipient: string;
  /** NEAR account refunds go back to (the wallet). */
  refundTo: string;
  slippageBps?: number;
  deadlineMinutes?: number;
  dry?: boolean;
  referral?: string;
  /** Route through Confidential Intents: counterparties and amounts are hidden on the NEAR side. */
  confidential?: boolean;
}

export interface Quote {
  correlationId: string;
  timestamp: string;
  signature: string;
  quote: {
    depositAddress?: string;
    depositMemo?: string;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    deadline?: string;
    timeEstimate: number;
  };
  quoteRequest: Record<string, unknown>;
}

export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

const headers = (): Record<string, string> => {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    // 1Click's edge rejects library default user agents.
    "user-agent": "bound-wallet/0.1 (+https://github.com/bound-wallet)",
  };
  const key = process.env.ONECLICK_API_KEY;
  if (key) h["x-api-key"] = key;
  return h;
};

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ONECLICK_URL}${path}`, { ...init, headers: { ...headers(), ...(init?.headers as any) } });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text };
  }
  if (!res.ok) throw new Error(`1Click ${path} ${res.status}: ${body?.message ?? text}`);
  return body as T;
}

export function listTokens(): Promise<OneClickToken[]> {
  return call<OneClickToken[]>("/tokens");
}

export async function findToken(symbol: string, blockchain: string): Promise<OneClickToken | undefined> {
  const all = await listTokens();
  return all.find((t) => t.symbol.toLowerCase() === symbol.toLowerCase() && t.blockchain.toLowerCase() === blockchain.toLowerCase());
}

export function requestQuote(p: QuoteParams): Promise<Quote> {
  const deadline = new Date(Date.now() + (p.deadlineMinutes ?? 15) * 60_000).toISOString();
  return call<Quote>("/quote", {
    method: "POST",
    body: JSON.stringify({
      dry: p.dry ?? false,
      swapType: "EXACT_INPUT",
      slippageTolerance: p.slippageBps ?? 100,
      originAsset: p.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: p.destinationAsset,
      amount: p.amount,
      refundTo: p.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: p.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline,
      referral: p.referral ?? "bound-wallet",
      confidentiality: p.confidential ? "basic" : "public",
    }),
  });
}

export function submitDeposit(depositAddress: string, txHash: string): Promise<unknown> {
  return call("/deposit/submit", { method: "POST", body: JSON.stringify({ depositAddress, txHash }) });
}

export function swapStatus(depositAddress: string): Promise<{ status: SwapStatus; [k: string]: unknown }> {
  return call(`/status?depositAddress=${encodeURIComponent(depositAddress)}`);
}

/** Known destination shorthands so agents can say "USDC on base". */
export const DESTINATIONS: Record<string, string> = {
  "usdc:base": "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  "usdc:near": "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "eth:near": "nep141:eth.bridge.near",
};

export const WNEAR = "nep141:wrap.near";
