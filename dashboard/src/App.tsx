import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import type { Network } from "./rpc";
import { useWallet } from "./store";
import { DevKeySigner, WalletSigner, publicKeyOf, type Signer } from "./signer";
import { Activity, AddAgent, AgentDetail, Agents, Approvals, Home, type Actions, type Tab } from "./screens";
import { Card, Field, Segmented, Sheet, Toast } from "./ui";
import type { AgentRecord } from "./types";

const LS = {
  wallet: "bound.wallet",
  network: "bound.network",
  devkey: "bound.devkey",
};

export default function App() {
  const [network, setNetwork] = useState<Network>(() => (localStorage.getItem(LS.network) as Network) || "testnet");
  const [walletId, setWalletId] = useState<string | null>(() => localStorage.getItem(LS.wallet));
  const [tab, setTab] = useState<Tab>("home");
  const [openAgent, setOpenAgent] = useState<AgentRecord | null>(null);
  const [adding, setAdding] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [signer, setSigner] = useState<Signer | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: "error" | "success" } | null>(null);
  const selectorRef = useRef<WalletSelector | null>(null);
  const modalRef = useRef<WalletSelectorModal | null>(null);

  const { state, error, loading, refresh } = useWallet(network, walletId);

  const say = useCallback((msg: string, tone: "error" | "success" = "success") => {
    setToast({ msg, tone });
    window.setTimeout(() => setToast(null), tone === "error" ? 6000 : 3000);
  }, []);

  // Restore a dev key session.
  useEffect(() => {
    const raw = localStorage.getItem(LS.devkey);
    if (raw && !signer) {
      try {
        const { accountId, secretKey, network: n } = JSON.parse(raw);
        if (n === network) setSigner(new DevKeySigner(network, accountId, secretKey));
      } catch {
        localStorage.removeItem(LS.devkey);
      }
    }
  }, [network, signer]);

  // Wallet selector: set up once per wallet id, restore an existing session.
  useEffect(() => {
    if (!walletId) return;
    let cancelled = false;
    (async () => {
      const selector = await setupWalletSelector({ network, modules: [setupMyNearWallet(), setupMeteorWallet()] });
      if (cancelled) return;
      selectorRef.current = selector;
      modalRef.current = setupModal(selector, { contractId: walletId, methodNames: ["add_agent", "update_policy", "remove_agent", "pause", "unpause", "approve", "reject", "withdraw"] });
      const sub = selector.store.observable.subscribe((s) => {
        const active = s.accounts.find((a) => a.active) ?? s.accounts[0];
        if (active) setSigner(new WalletSigner(selector, active.accountId));
        else setSigner((cur) => (cur?.kind === "wallet" ? null : cur));
      });
      return () => sub.unsubscribe();
    })();
    return () => {
      cancelled = true;
    };
  }, [network, walletId]);

  const isOwner = !!state && !!signer && signer.accountId === state.owner;
  const canAct = isOwner;

  const run = useCallback(
    async (label: string, fn: () => Promise<any>) => {
      if (!signer) return;
      setBusy(true);
      try {
        await fn();
        say(label);
        await refresh();
      } catch (e: any) {
        const m: string = e?.message ?? String(e);
        say(m.length > 180 ? m.slice(0, 180) + "…" : m, "error");
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [signer, refresh, say]
  );

  const actions: Actions = useMemo(
    () => ({
      addAgent: (public_key, label, policy) => run(`Agent "${label}" added`, () => signer!.call(walletId!, "add_agent", { public_key, label, policy, gas_allowance: null })),
      updatePolicy: (public_key, policy) => run("Policy saved", () => signer!.call(walletId!, "update_policy", { public_key, policy })),
      removeAgent: (public_key) => run("Agent removed", () => signer!.call(walletId!, "remove_agent", { public_key })),
      setPaused: (paused) => run(paused ? "Paused. Every action is denied." : "Resumed", () => signer!.call(walletId!, paused ? "pause" : "unpause", {})),
      approve: (id) => run("Approved and executed", () => signer!.call(walletId!, "approve", { id }, 200)),
      reject: (id) => run("Rejected", () => signer!.call(walletId!, "reject", { id })),
      withdraw: (receiver, amount) => run("Withdrawn", () => signer!.call(walletId!, "withdraw", { receiver, amount })),
      setPrice: (cents_per_near) => run("Price set", () => signer!.call(walletId!, "set_price", { cents_per_near })),
      refreshPrice: () => run("Price refreshed", () => signer!.call(walletId!, "refresh_price", {})),
      suspend: (public_key) => run("Agent suspended", () => signer!.call(walletId!, "suspend", { public_key })),
      unsuspend: (public_key) => run("Suspension lifted", () => signer!.call(walletId!, "unsuspend", { public_key })),
    }),
    [run, signer, walletId]
  );

  const connectWallet = (id: string, n: Network) => {
    localStorage.setItem(LS.wallet, id);
    localStorage.setItem(LS.network, n);
    setNetwork(n);
    setWalletId(id);
    setTab("home");
  };

  const disconnect = async () => {
    await signer?.signOut().catch(() => {});
    setSigner(null);
  };

  const forget = () => {
    localStorage.removeItem(LS.wallet);
    setWalletId(null);
    setSigner(null);
    setOpenAgent(null);
  };

  if (!walletId) return <Connect onConnect={connectWallet} initialNetwork={network} />;

  const common = state ? { network, walletId, state, canAct, actions, busy } : null;

  return (
    <div className="frame">
      <div className="topbar">
        <div className="brand">
          <img src="/icon.png" alt="" width={28} height={28} style={{ borderRadius: 9 }} />
          <span>Bound</span>
          <span className="pill" style={{ marginLeft: 2 }}>{network}</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn icon" title="Refresh" onClick={refresh} disabled={loading}>
            {loading ? <span className="spin" /> : "↻"}
          </button>
          {signer ? (
            <button className="btn sm" onClick={() => setConnectOpen(true)} title={signer.accountId}>
              {isOwner ? "● " : "○ "}
              {signer.accountId.length > 18 ? signer.accountId.slice(0, 16) + "…" : signer.accountId}
            </button>
          ) : (
            <button className="btn sm primary" onClick={() => setConnectOpen(true)}>
              Connect owner
            </button>
          )}
        </div>
      </div>

      {error && (
        <Card>
          <div className="title" style={{ color: "var(--red)" }}>
            Could not load {walletId}
          </div>
          <div className="subtitle" style={{ whiteSpace: "normal" }}>{error}</div>
          <button className="btn sm" style={{ marginTop: 12 }} onClick={forget}>
            Open another wallet
          </button>
        </Card>
      )}

      {!state && !error && (
        <Card className="hero">
          <span className="spin" />
        </Card>
      )}

      {signer && state && !isOwner && (
        <Card>
          <div className="title">Read only</div>
          <div className="subtitle" style={{ whiteSpace: "normal" }}>
            {signer.accountId} is not the owner of this wallet. The owner is {state.owner}.
          </div>
        </Card>
      )}

      {common && openAgent && <AgentDetail {...common} a={state!.agents.find((x) => x.public_key === openAgent.public_key) ?? openAgent} onBack={() => setOpenAgent(null)} />}
      {common && !openAgent && tab === "home" && <Home {...common} go={setTab} onAdd={() => setAdding(true)} />}
      {common && !openAgent && tab === "agents" && <Agents {...common} onAdd={() => setAdding(true)} onOpen={setOpenAgent} />}
      {common && !openAgent && tab === "approvals" && <Approvals {...common} />}
      {common && !openAgent && tab === "activity" && <Activity {...common} />}

      {common && <AddAgent open={adding} onClose={() => setAdding(false)} network={network} walletId={walletId} actions={actions} busy={busy} />}

      <nav className="tabs">
        {(
          [
            ["home", "Home"],
            ["agents", "Agents"],
            ["approvals", "Approvals"],
            ["activity", "Activity"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button
            key={t}
            className={tab === t && !openAgent ? "active" : ""}
            onClick={() => {
              setOpenAgent(null);
              setTab(t);
            }}
          >
            {label}
            {t === "approvals" && state && state.pending.length > 0 && <span className="badge">{state.pending.length}</span>}
          </button>
        ))}
      </nav>

      <ConnectSheet
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        network={network}
        walletId={walletId}
        signer={signer}
        owner={state?.owner ?? null}
        onWallet={() => {
          setConnectOpen(false);
          modalRef.current?.show();
        }}
        onDevKey={(accountId, secretKey) => {
          localStorage.setItem(LS.devkey, JSON.stringify({ accountId, secretKey, network }));
          setSigner(new DevKeySigner(network, accountId, secretKey));
          setConnectOpen(false);
          say(`Signing as ${accountId}`);
        }}
        onDisconnect={async () => {
          await disconnect();
          setConnectOpen(false);
        }}
        onForget={() => {
          setConnectOpen(false);
          forget();
        }}
      />

      <Toast msg={toast?.msg ?? null} tone={toast?.tone ?? "success"} />
    </div>
  );
}

// ------------------------------------------------------------------ Connect

function Connect({ onConnect, initialNetwork }: { onConnect: (walletId: string, network: Network) => void; initialNetwork: Network }) {
  const [id, setId] = useState("");
  const [network, setNetwork] = useState<Network>(initialNetwork);
  const ok = /^[a-z0-9._-]+\.(testnet|near)$/.test(id.trim());
  return (
    <div className="frame" style={{ justifyContent: "center", paddingBottom: 24 }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <img src="/icon.png" alt="" width={72} height={72} style={{ borderRadius: 22, display: "block", margin: "0 auto 16px", boxShadow: "0 20px 60px rgba(139,124,246,.25)" }} />
        <h1 style={{ margin: 0, fontSize: 28, letterSpacing: "-0.03em" }}>Bound</h1>
        <p style={{ color: "var(--muted)", margin: "6px 0 0" }}>Hold the reins on your AI agents.</p>
      </div>
      <Card>
        <Field label="Network">
          <Segmented
            value={network}
            options={[
              { value: "testnet", label: "Testnet" },
              { value: "mainnet", label: "Mainnet" },
            ]}
            onChange={setNetwork}
          />
        </Field>
        <Field label="Wallet account" hint="The sub-account your Bound wallet contract is deployed to.">
          <input className="input" autoFocus placeholder={network === "testnet" ? "buyer.you.testnet" : "agents.you.near"} value={id} onChange={(e) => setId(e.target.value.toLowerCase())} onKeyDown={(e) => e.key === "Enter" && ok && onConnect(id.trim(), network)} />
        </Field>
        <button className="btn primary" disabled={!ok} onClick={() => onConnect(id.trim(), network)}>
          Open wallet
        </button>
      </Card>
      <p style={{ textAlign: "center", color: "var(--faint)", fontSize: 13 }}>
        No wallet yet? Deploy one with <span className="mono">bound deploy</span> from the SDK.
      </p>
    </div>
  );
}

function ConnectSheet({ open, onClose, network, walletId, signer, owner, onWallet, onDevKey, onDisconnect, onForget }: { open: boolean; onClose: () => void; network: Network; walletId: string; signer: Signer | null; owner: string | null; onWallet: () => void; onDevKey: (accountId: string, secretKey: string) => void; onDisconnect: () => void; onForget: () => void }) {
  const [mode, setMode] = useState<"pick" | "devkey">("pick");
  const [acct, setAcct] = useState(owner ?? "");
  const [sk, setSk] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (owner && !acct) setAcct(owner);
  }, [owner, acct]);

  return (
    <Sheet open={open} onClose={onClose} title={signer ? "Owner session" : "Connect as owner"} lead={signer ? `Signing as ${signer.accountId} via ${signer.kind === "wallet" ? "your wallet" : "a local key"}.` : `Owner actions on ${walletId} are signed by ${owner ?? "the owner account"}.`}>
      {signer ? (
        <div className="list">
          <button className="btn" onClick={onDisconnect}>
            Disconnect
          </button>
          <button className="btn ghost" onClick={onForget}>
            Open another wallet
          </button>
        </div>
      ) : mode === "pick" ? (
        <div className="list">
          <button className="btn primary" onClick={onWallet}>
            Connect a NEAR wallet
          </button>
          {network === "testnet" && (
            <button className="btn" onClick={() => setMode("devkey")}>
              Use a private key (testnet)
            </button>
          )}
          <button className="btn ghost" onClick={onForget}>
            Open another wallet
          </button>
        </div>
      ) : (
        <>
          <Field label="Owner account">
            <input className="input" value={acct} onChange={(e) => setAcct(e.target.value)} />
          </Field>
          <Field label="Private key" hint="Stored only in this browser. Testnet only.">
            <input className="input mono" placeholder="ed25519:…" value={sk} onChange={(e) => setSk(e.target.value.trim())} />
          </Field>
          {err && <div className="hint" style={{ color: "var(--red)", marginBottom: 10 }}>{err}</div>}
          <div className="btn-row">
            <button className="btn" onClick={() => setMode("pick")}>
              Back
            </button>
            <button
              className="btn primary"
              disabled={!acct || !sk}
              onClick={() => {
                try {
                  publicKeyOf(sk);
                  setErr(null);
                  onDevKey(acct.trim(), sk);
                } catch {
                  setErr("That does not look like a valid ed25519 secret key.");
                }
              }}
            >
              Sign in
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
