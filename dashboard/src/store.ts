/**
 * All chain state the dashboard shows, loaded in one pass and refreshed on
 * demand or every 20 s. Reads need no signer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { view, viewAccount, type Network } from "./rpc";
import type { HistoryEntry } from "./types";
import type { AgentRecord, PendingAction, PriceQuote, Remaining } from "./types";

export interface WalletState {
  owner: string;
  paused: boolean;
  balance: string;
  storageLocked: string;
  agents: AgentRecord[];
  remaining: Record<string, Remaining>;
  pending: PendingAction[];
  events: HistoryEntry[];
  price: PriceQuote | null;
  loadedAt: number;
}

const STORAGE_BYTE_COST = 10_000_000_000_000_000_000n; // 1e19 yocto per byte

export async function loadWallet(network: Network, walletId: string): Promise<WalletState> {
  const [owner, paused, agents, pending, account] = await Promise.all([
    view<string>(network, walletId, "get_owner"),
    view<boolean>(network, walletId, "is_paused"),
    view<AgentRecord[]>(network, walletId, "list_agents"),
    view<PendingAction[]>(network, walletId, "get_pending"),
    viewAccount(network, walletId),
  ]);
  const remainingList = await Promise.all(
    agents.map((a) => view<Remaining | null>(network, walletId, "get_remaining", { public_key: a.public_key }))
  );
  const remaining: Record<string, Remaining> = {};
  agents.forEach((a, i) => {
    if (remainingList[i]) remaining[a.public_key] = remainingList[i]!;
  });
  const [events, price] = await Promise.all([
    view<HistoryEntry[]>(network, walletId, "get_history", { limit: 100 }).catch(() => [] as HistoryEntry[]),
    view<PriceQuote | null>(network, walletId, "get_price", {}).catch(() => null),
  ]);
  return {
    owner,
    paused,
    balance: account.amount,
    storageLocked: (BigInt(account.storage_usage) * STORAGE_BYTE_COST).toString(),
    agents,
    remaining,
    pending,
    events,
    price,
    loadedAt: Date.now(),
  };
}

export function useWallet(network: Network, walletId: string | null) {
  const [state, setState] = useState<WalletState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!walletId) return;
    setLoading(true);
    try {
      setState(await loadWallet(network, walletId));
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [network, walletId]);

  useEffect(() => {
    setState(null);
    refresh();
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(refresh, 20_000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [refresh]);

  return { state, error, loading, refresh };
}
