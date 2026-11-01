import { useEffect, useMemo, useState } from "react";
import { EXPLORER, nearToYocto, registryId, timeAgo, view, yoctoToNear, type Network } from "./rpc";
import { PRESETS, PolicyForm, isUnlimited, validatePolicy } from "./PolicyForm";
import { generateAgentKey } from "./signer";
import type { WalletState } from "./store";
import { describeAction, type AgentRecord, type HistoryEntry, type PendingAction, type Policy, type Score } from "./types";
import { Avatar, Card, Empty, Field, Meter, Pill, Section, Sheet, Stat, Switch, short } from "./ui";

export interface Actions {
  addAgent(publicKey: string, label: string, policy: Policy): Promise<void>;
  updatePolicy(publicKey: string, policy: Policy): Promise<void>;
  removeAgent(publicKey: string): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  approve(id: number): Promise<void>;
  reject(id: number): Promise<void>;
  withdraw(receiver: string, amountYocto: string): Promise<void>;
  setPrice(centsPerNear: number): Promise<void>;
  refreshPrice(): Promise<void>;
  suspend(publicKey: string): Promise<void>;
  unsuspend(publicKey: string): Promise<void>;
}

export const usd = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Budget line for an agent: dollars when the policy is in dollars, NEAR otherwise. */
function budgetLine(state: WalletState, a: AgentRecord): { left: string; cap: string; used: bigint; total: bigint } {
  const r = state.remaining[a.public_key];
  if (a.policy.window_cap_usd_cents != null) {
    const cap = a.policy.window_cap_usd_cents;
    const left = r?.usd_cents ?? cap;
    return { left: usd(left), cap: usd(cap), used: BigInt(cap - left), total: BigInt(cap) };
  }
  const cap = BigInt(a.policy.window_cap);
  const left = r ? BigInt(r.native) : cap;
  return { left: `${yoctoToNear(left, 2)}`, cap: `${yoctoToNear(cap, 2)} NEAR`, used: cap - left, total: cap };
}

interface Common {
  network: Network;
  walletId: string;
  state: WalletState;
  canAct: boolean;
  actions: Actions;
  busy: boolean;
}

// ------------------------------------------------------------------ helpers

function agentLabel(state: WalletState, key: string) {
  return state.agents.find((a) => a.public_key === key)?.label ?? short(key, 12, 4);
}

function windowName(secs: number) {
  return secs === 3600 ? "hour" : secs === 604800 ? "week" : secs === 86400 ? "day" : `${secs}s`;
}

// ------------------------------------------------------------------ Home

export function Home({ state, walletId, network, canAct, actions, busy, go, onAdd }: Common & { go: (tab: Tab) => void; onAdd: () => void }) {
  const free = BigInt(state.balance) - BigInt(state.storageLocked);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [wTo, setWTo] = useState(state.owner);
  const [wAmt, setWAmt] = useState("");
  const [priceOpen, setPriceOpen] = useState(false);
  const [priceText, setPriceText] = useState(state.price ? (state.price.cents_per_near / 100).toFixed(2) : "");
  const anyUsd = state.agents.some((a) => a.policy.window_cap_usd_cents != null || a.policy.max_per_tx_usd_cents != null);
  const q = state.price;
  return (
    <>
      <Card className="hero">
        <div className="label">Available to agents</div>
        <div className="amount num">
          {yoctoToNear(free > 0n ? free : 0n, 2)}
          <small>NEAR</small>
        </div>
        <div className="sub num">
          {yoctoToNear(state.balance, 2)} total · {yoctoToNear(state.storageLocked, 2)} locked for storage
        </div>
        <div style={{ marginTop: 14 }}>
          <a href={`${EXPLORER[network]}/address/${walletId}`} target="_blank" rel="noreferrer" className="pill accent">
            {walletId} ↗
          </a>
        </div>
      </Card>

      <Card>
        <div className="row between">
          <div className="stack">
            <div className="title">{state.paused ? "Paused" : "Agents are active"}</div>
            <div className="subtitle">{state.paused ? "Every action is denied until you resume." : "Kill switch. Denies everything instantly."}</div>
          </div>
          <Switch on={state.paused} onChange={(v) => canAct && !busy && actions.setPaused(v)} />
        </div>
      </Card>

      {(anyUsd || q) && (
        <Card onClick={() => canAct && setPriceOpen(true)}>
          <div className="row between">
            <div className="stack">
              <div className="title num">{q ? `1 NEAR = ${usd(q.cents_per_near)}` : "No NEAR/USD price yet"}</div>
              <div className="subtitle">
                {q ? `${q.source} · ${timeAgo(q.updated_at)}` : "Dollar budgets need a price."}
                {q && !q.fresh ? " · stale" : ""}
              </div>
            </div>
            {q ? <Pill tone={q.fresh ? "green" : "amber"}>{q.fresh ? "fresh" : "stale"}</Pill> : <Pill tone="amber">missing</Pill>}
          </div>
        </Card>
      )}

      {state.pending.length > 0 && (
        <Card onClick={() => go("approvals")}>
          <div className="row between">
            <div className="row">
              <Pill tone="amber">
                <span className="dot" /> {state.pending.length}
              </Pill>
              <div className="stack">
                <div className="title">Waiting for your approval</div>
                <div className="subtitle">Agents asked for more than their threshold.</div>
              </div>
            </div>
            <span style={{ color: "var(--muted)" }}>›</span>
          </div>
        </Card>
      )}

      <Section title="Agents" action={<button className="link" onClick={() => go("agents")}>See all</button>} />
      {state.agents.length === 0 ? (
        <Card>
          <Empty icon="○" text="No agents yet. Add one and hand it the key." />
        </Card>
      ) : (
        <div className="list">
          {state.agents.slice(0, 3).map((a) => (
            <AgentRow key={a.public_key} a={a} state={state} onClick={() => go("agents")} />
          ))}
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={!canAct || busy} onClick={onAdd}>
          Add agent
        </button>
        <button className="btn" disabled={!canAct || busy} onClick={() => setWithdrawOpen(true)}>
          Withdraw
        </button>
      </div>

      <Sheet open={priceOpen} onClose={() => setPriceOpen(false)} title="NEAR/USD price" lead={q ? `The wallet is using ${q.source}. ${q.fresh ? "The price is fresh." : "The price is stale, so dollar-capped actions are denied until it is refreshed."}` : "Dollar-capped agents are denied until the wallet has a price."}>
        <button className="btn" disabled={busy} onClick={() => actions.refreshPrice()} style={{ marginBottom: 14 }}>
          Refresh from on-chain source
        </button>
        <Field label="Or set it yourself" hint="Owner override. Use this on testnet, or if the on-chain source is down.">
          <div className="suffix">
            <input className="input num" inputMode="decimal" value={priceText} onChange={(e) => setPriceText(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="4.77" />
            <span>USD per NEAR</span>
          </div>
        </Field>
        <button
          className="btn primary"
          disabled={busy || !priceText || Number(priceText) <= 0}
          onClick={async () => {
            await actions.setPrice(Math.round(Number(priceText) * 100));
            setPriceOpen(false);
          }}
        >
          Set price
        </button>
      </Sheet>

      <Sheet open={withdrawOpen} onClose={() => setWithdrawOpen(false)} title="Withdraw" lead="Move funds out of the wallet. Not subject to any agent policy.">
        <Field label="To">
          <input className="input" value={wTo} onChange={(e) => setWTo(e.target.value)} />
        </Field>
        <Field label="Amount">
          <div className="suffix">
            <input className="input num" inputMode="decimal" value={wAmt} onChange={(e) => setWAmt(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0" />
            <span>NEAR</span>
          </div>
        </Field>
        <button
          className="btn primary"
          disabled={busy || !wAmt || !wTo}
          onClick={async () => {
            await actions.withdraw(wTo.trim(), nearToYocto(wAmt));
            setWithdrawOpen(false);
            setWAmt("");
          }}
        >
          Withdraw {wAmt || ""} NEAR
        </button>
      </Sheet>
    </>
  );
}

function AgentRow({ a, state, onClick }: { a: AgentRecord; state: WalletState; onClick: () => void }) {
  const b = budgetLine(state, a);
  return (
    <Card onClick={onClick}>
      <div className="row between">
        <div className="row">
          <Avatar name={a.label} />
          <div className="stack">
            <div className="title">{a.label}</div>
            <div className="subtitle num">
              {b.left} of {b.cap} left this {windowName(a.policy.window_secs)}
            </div>
          </div>
        </div>
        {a.suspended ? <Pill tone="red">suspended</Pill> : a.stats.denied > 0 && <Pill tone="red">{a.stats.denied} denied</Pill>}
      </div>
      <Meter used={b.used} total={b.total} />
    </Card>
  );
}

// ------------------------------------------------------------------ Agents

export function Agents({ state, onAdd, canAct, busy, onOpen }: Common & { onAdd: () => void; onOpen: (a: AgentRecord) => void }) {
  return (
    <>
      <Section
        title={`${state.agents.length} agent${state.agents.length === 1 ? "" : "s"}`}
        action={
          <button className="link" disabled={!canAct || busy} onClick={onAdd}>
            + Add
          </button>
        }
      />
      {state.agents.length === 0 ? (
        <Card>
          <Empty icon="○" text="No agents yet." />
        </Card>
      ) : (
        <div className="list">
          {state.agents.map((a) => (
            <AgentRow key={a.public_key} a={a} state={state} onClick={() => onOpen(a)} />
          ))}
        </div>
      )}
    </>
  );
}

export function AgentDetail({ a, state, walletId, network, canAct, actions, busy, onBack }: Common & { a: AgentRecord; onBack: () => void }) {
  const b = budgetLine(state, a);
  const r = state.remaining[a.public_key];
  const inUsd = a.policy.window_cap_usd_cents != null;
  const [edit, setEdit] = useState(false);
  const [mcp, setMcp] = useState(false);
  const [draft, setDraft] = useState<Policy>(a.policy);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const p = a.policy;
  const err = validatePolicy(draft);

  return (
    <>
      <button className="back" onClick={onBack}>
        ‹ Agents
      </button>
      <Card className="hero" >
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
          <Avatar name={a.label} />
        </div>
        <div className="title" style={{ fontSize: 20 }}>
          {a.label}
        </div>
        <div className="amount num" style={{ fontSize: 36 }}>
          {b.left}
          <small>{inUsd ? "left" : "NEAR left"}</small>
        </div>
        <div className="sub num">
          of {b.cap} this {windowName(p.window_secs)}
          {r?.actions != null ? ` · ${r.actions} actions left` : ""}
        </div>
        <Meter used={b.used} total={b.total} />
      </Card>

      {a.suspended && (
        <Card>
          <div className="row between">
            <div className="stack">
              <div className="title" style={{ color: "var(--red)" }}>Suspended</div>
              <div className="subtitle" style={{ whiteSpace: "normal" }}>Every action is denied. The tripwire fired or you suspended it.</div>
            </div>
            {canAct && (
              <button className="btn sm success" disabled={busy} onClick={() => actions.unsuspend(a.public_key)}>
                Lift
              </button>
            )}
          </div>
        </Card>
      )}

      <div className="stats">
        <Stat v={a.stats.executed} k="executed" />
        <Stat v={a.stats.denied} k="denied" />
        <Stat v={a.stats.queued} k="asked you" />
      </div>

      <Section title="Policy" action={canAct ? <button className="link" onClick={() => { setDraft(a.policy); setEdit(true); }}>Edit</button> : undefined} />
      <Card>
        <dl className="kv">
          <dt>Max per action</dt>
          <dd className="num">{inUsd ? usd(p.max_per_tx_usd_cents ?? 0) : `${yoctoToNear(p.max_per_tx, 4)} NEAR`}</dd>
          <dt>Budget</dt>
          <dd className="num">
            {inUsd ? usd(p.window_cap_usd_cents ?? 0) : `${yoctoToNear(p.window_cap, 4)} NEAR`} / {windowName(p.window_secs)}
          </dd>
          {inUsd && !isUnlimited(p.window_cap) && (
            <>
              <dt>NEAR ceiling</dt>
              <dd className="num">{yoctoToNear(p.window_cap, 2)} NEAR / {windowName(p.window_secs)}</dd>
            </>
          )}
          <dt>Asks you above</dt>
          <dd className="num">{p.approval_above ? `${yoctoToNear(p.approval_above, 4)} NEAR` : "never"}</dd>
          <dt>Can pay</dt>
          <dd>{p.receivers === "Any" ? (p.approve_new_receivers ? "anyone, new receivers need my OK" : "anyone") : p.receivers.Allowlist.length ? p.receivers.Allowlist.join(", ") : "nobody"}</dd>
          <dt>Can call</dt>
          <dd>{p.calls.length ? p.calls.map((c) => `${c.contract}${c.methods.length ? ":" + c.methods.join(",") : ""}`).join(", ") : "nothing"}</dd>
          <dt>Cross-chain swaps</dt>
          <dd>{p.allow_intents ? "allowed via NEAR Intents" : "no"}</dd>
          <dt>Tripwire</dt>
          <dd>{p.tripwire ? `${p.tripwire.max_denials} denials / ${Math.round(p.tripwire.window_secs / 60)} min` : "off"}</dd>
          <dt>Rate limit</dt>
          <dd>{p.max_tx_per_window ? `${p.max_tx_per_window} / ${windowName(p.window_secs)}` : "none"}</dd>
          <dt>Active hours</dt>
          <dd>{p.active_hours_utc ? `${p.active_hours_utc.start_hour}:00 to ${p.active_hours_utc.end_hour}:00 UTC` : "always"}</dd>
        </dl>
      </Card>

      <Reputation network={network} publicKey={a.public_key} />

      <Section title="Key" />
      <Card>
        <div className="mono" style={{ wordBreak: "break-all", color: "var(--muted)" }}>
          {a.public_key}
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={() => setMcp(true)}>
            MCP config
          </button>
          <a className="btn sm" href={`${EXPLORER[network]}/address/${walletId}?tab=accesskeys`} target="_blank" rel="noreferrer">
            On explorer ↗
          </a>
        </div>
      </Card>

      {canAct && (
        <div className="btn-row" style={{ marginTop: 6 }}>
          {!a.suspended && (
            <button className="btn" disabled={busy} onClick={() => actions.suspend(a.public_key)}>
              Suspend
            </button>
          )}
          <button className="btn danger" disabled={busy} onClick={() => setConfirmRemove(true)}>
            Remove agent
          </button>
        </div>
      )}

      <Sheet open={edit} onClose={() => setEdit(false)} title="Edit policy" lead="Changes apply to the agent's next action. Usage so far is kept.">
        <PolicyForm value={draft} onChange={setDraft} />
        {err && <div className="hint" style={{ color: "var(--red)", marginBottom: 10 }}>{err}</div>}
        <button
          className="btn primary"
          disabled={busy || !!err}
          onClick={async () => {
            await actions.updatePolicy(a.public_key, draft);
            setEdit(false);
          }}
        >
          Save policy
        </button>
      </Sheet>

      <Sheet open={mcp} onClose={() => setMcp(false)} title="Give this agent its wallet" lead="Add to Claude Code, Claude Desktop, Codex, Cursor or any MCP client. Use the secret key you saved when the agent was created.">
        <McpSnippet network={network} walletId={walletId} secret="ed25519:<the agent's secret key>" />
      </Sheet>

      <Sheet open={confirmRemove} onClose={() => setConfirmRemove(false)} title={`Remove ${a.label}?`} lead="Its key is deleted from the wallet and any pending requests are dropped. This cannot be undone.">
        <div className="btn-row">
          <button className="btn" onClick={() => setConfirmRemove(false)}>
            Keep
          </button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              await actions.removeAgent(a.public_key);
              setConfirmRemove(false);
              onBack();
            }}
          >
            Remove
          </button>
        </div>
      </Sheet>
    </>
  );
}

const TIER_TONE: Record<Score["tier"], "green" | "amber" | "red" | "accent"> = { trusted: "green", caution: "amber", risky: "red", new: "accent" };

function Reputation({ network, publicKey }: { network: Network; publicKey: string }) {
  const reg = registryId(network);
  const [score, setScore] = useState<Score | null | undefined>(undefined);
  useEffect(() => {
    if (!reg) return;
    let alive = true;
    view<Score | null>(network, reg, "get_score", { public_key: publicKey })
      .then((s) => alive && setScore(s))
      .catch(() => alive && setScore(null));
    return () => {
      alive = false;
    };
  }, [network, reg, publicKey]);
  if (!reg) return null;
  return (
    <>
      <Section title="Reputation" action={<a href={`${EXPLORER[network]}/address/${reg}`} target="_blank" rel="noreferrer">{reg}</a>} />
      <Card>
        {score === undefined ? (
          <span className="spin" />
        ) : score === null ? (
          <div className="subtitle" style={{ whiteSpace: "normal" }}>
            Not scored yet. Register this wallet in the registry and sync it, and every decision here becomes public reputation.
          </div>
        ) : (
          <div className="row between">
            <div className="stack">
              <div className="row" style={{ gap: 8 }}>
                <span className="num" style={{ fontSize: 32, fontWeight: 700, letterSpacing: "-0.03em" }}>{score.score}</span>
                <Pill tone={TIER_TONE[score.tier]}>{score.tier}</Pill>
                {score.handle && <Pill tone="accent">@{score.handle}</Pill>}
              </div>
              <div className="subtitle" style={{ whiteSpace: "normal" }}>
                {score.scored_events} scored decisions across {score.wallets.length} wallet{score.wallets.length === 1 ? "" : "s"}
                {score.unverified.executed + score.unverified.denied > 0 ? ` · ${score.unverified.executed + score.unverified.denied} unverified` : ""}
              </div>
            </div>
            <div className="stack" style={{ alignItems: "flex-end", flex: "none" }}>
              <span className="subtitle num">{score.verified.executed + score.verified.approved} good</span>
              <span className="subtitle num" style={{ color: score.verified.denied ? "var(--red)" : undefined }}>{score.verified.denied} denied</span>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

export function McpSnippet({ network, walletId, secret }: { network: Network; walletId: string; secret: string }) {
  const cfg = {
    mcpServers: {
      "bound-wallet": {
        command: "node",
        args: ["/path/to/NearWallet/sdk/dist/mcp.js"],
        env: { NEAR_NETWORK: network, BOUND_WALLET: walletId, BOUND_AGENT_KEY: secret },
      },
    },
  };
  const text = JSON.stringify(cfg, null, 2);
  return (
    <>
      <pre className="code">{text}</pre>
      <button className="btn" style={{ marginTop: 10 }} onClick={() => navigator.clipboard.writeText(text)}>
        Copy
      </button>
    </>
  );
}

// ------------------------------------------------------------------ Add agent

export function AddAgent({ open, onClose, network, walletId, actions, busy }: { open: boolean; onClose: () => void; network: Network; walletId: string; actions: Actions; busy: boolean }) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [label, setLabel] = useState("");
  const [preset, setPreset] = useState<keyof typeof PRESETS>("buyer");
  const [policy, setPolicy] = useState<Policy>(PRESETS.buyer.policy);
  const [key, setKey] = useState<{ publicKey: string; secretKey: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const err = validatePolicy(policy);

  const reset = () => {
    setStep(1);
    setLabel("");
    setPreset("buyer");
    setPolicy(PRESETS.buyer.policy);
    setKey(null);
    setCopied(false);
  };
  const close = () => {
    if (step === 3 && !copied) return; // make them acknowledge the key
    reset();
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={step === 1 ? "New agent" : step === 2 ? "Set the reins" : "Hand over the key"}
      lead={
        step === 1
          ? "Name it and pick a starting shape. You can change everything later."
          : step === 2
            ? "The agent can never exceed these. Every check happens on chain."
            : "Shown once. The wallet only stores the public half."
      }
    >
      {step === 1 && (
        <>
          <Field label="Name">
            <input className="input" autoFocus placeholder="buyer" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <Field label="Preset">
            <div className="list">
              {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((k) => (
                <Card
                  key={k}
                  onClick={() => {
                    setPreset(k);
                    setPolicy(PRESETS[k].policy);
                  }}
                >
                  <div className="row between">
                    <div className="stack">
                      <div className="title">{PRESETS[k].label}</div>
                      <div className="subtitle" style={{ whiteSpace: "normal" }}>
                        {PRESETS[k].blurb}
                      </div>
                    </div>
                    <span style={{ color: preset === k ? "var(--accent)" : "var(--faint)", fontSize: 18 }}>{preset === k ? "●" : "○"}</span>
                  </div>
                </Card>
              ))}
            </div>
          </Field>
          <button className="btn primary" disabled={!label.trim()} onClick={() => setStep(2)}>
            Continue
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <PolicyForm value={policy} onChange={setPolicy} />
          {err && <div className="hint" style={{ color: "var(--red)", marginBottom: 10 }}>{err}</div>}
          <div className="btn-row">
            <button className="btn" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              className="btn primary"
              disabled={busy || !!err}
              onClick={async () => {
                const k = generateAgentKey();
                await actions.addAgent(k.publicKey, label.trim(), policy);
                setKey(k);
                setStep(3);
              }}
            >
              {busy ? <span className="spin" /> : "Create agent"}
            </button>
          </div>
        </>
      )}

      {step === 3 && key && (
        <>
          <Field label="Secret key">
            <div className="secret mono">{key.secretKey}</div>
          </Field>
          <button
            className={`btn ${copied ? "success" : "primary"}`}
            onClick={() => {
              navigator.clipboard.writeText(key.secretKey);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy secret key"}
          </button>
          <Section title="Or paste this MCP config" />
          <McpSnippet network={network} walletId={walletId} secret={key.secretKey} />
          <button className="btn ghost" style={{ marginTop: 10 }} disabled={!copied} onClick={close}>
            {copied ? "Done" : "Copy the key first"}
          </button>
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ Approvals

export function Approvals({ state, canAct, actions, busy }: Common) {
  if (state.pending.length === 0)
    return (
      <Card>
        <Empty icon="✓" text="Nothing waiting. Agents are inside their limits." />
      </Card>
    );
  const free = BigInt(state.balance) - BigInt(state.storageLocked);
  return (
    <div className="list">
      {state.pending.map((p: PendingAction) => {
        const d = describeAction(p.action);
        const amt = d.amountYocto ? BigInt(d.amountYocto) : 0n;
        const short = amt > free;
        return (
          <Card key={p.id}>
            <div className="row between">
              <div className="row">
                <Avatar name={agentLabel(state, p.agent_key)} />
                <div className="stack">
                  <div className="title">{d.title}</div>
                  <div className="subtitle">
                    {agentLabel(state, p.agent_key)} · {timeAgo(p.created_at)}
                  </div>
                </div>
              </div>
              {d.amountYocto && (
                <div className="num" style={{ fontWeight: 700, fontSize: 17 }}>
                  {yoctoToNear(d.amountYocto, 4)} N
                </div>
              )}
            </div>
            {short && (
              <div className="hint" style={{ color: "var(--amber)", marginTop: 10 }}>
                Wallet only has {yoctoToNear(free, 2)} NEAR free. Top up before approving.
              </div>
            )}
            {canAct && (
              <div className="btn-row" style={{ marginTop: 14 }}>
                <button className="btn danger" disabled={busy} onClick={() => actions.reject(p.id)}>
                  Reject
                </button>
                <button className="btn success" disabled={busy || short} onClick={() => actions.approve(p.id)}>
                  Approve
                </button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ Activity

const TONE: Record<string, { tone: "green" | "red" | "amber" | "accent" | ""; label: string }> = {
  action_executed: { tone: "green", label: "Executed" },
  action_denied: { tone: "red", label: "Denied" },
  action_queued: { tone: "amber", label: "Asked you" },
  action_approved: { tone: "green", label: "Approved" },
  action_rejected: { tone: "red", label: "Rejected" },
  action_failed: { tone: "red", label: "Failed" },
  agent_added: { tone: "accent", label: "Agent added" },
  agent_removed: { tone: "", label: "Agent removed" },
  policy_updated: { tone: "accent", label: "Policy updated" },
  paused: { tone: "red", label: "Paused" },
  unpaused: { tone: "green", label: "Resumed" },
  agent_tripped: { tone: "red", label: "Tripwire" },
  agent_suspended: { tone: "red", label: "Suspended" },
  agent_unsuspended: { tone: "green", label: "Lifted" },
  price_updated: { tone: "accent", label: "Price" },
};

const TITLE: Record<string, string> = {
  paused: "Wallet paused. Every action denied.",
  unpaused: "Wallet resumed.",
  agent_added: "New agent registered",
  agent_removed: "Agent removed, key deleted",
  policy_updated: "Policy changed",
  agent_tripped: "Too many denials. Agent suspended automatically.",
  agent_suspended: "Owner suspended the agent",
  agent_unsuspended: "Owner lifted the suspension",
};

export function Activity({ state, network }: Common) {
  const events = useMemo(() => state.events, [state.events]);
  if (events.length === 0)
    return (
      <Card>
        <Empty icon="·" text="No activity yet. Every decision the wallet makes shows up here." />
      </Card>
    );
  return (
    <div className="list">
      {events.map((e: HistoryEntry) => {
        const t = TONE[e.event] ?? { tone: "", label: e.event };
        const d = e.action ? describeAction(e.action) : null;
        return (
          <Card key={e.seq}>
            <div className="row between">
              <div className="stack">
                <div className="row" style={{ gap: 8 }}>
                  <Pill tone={t.tone}>{t.label}</Pill>
                  <span className="subtitle">{e.label ?? ""}</span>
                </div>
                <div className="title" style={{ marginTop: 6 }}>
                  {d ? d.title : TITLE[e.event] ?? e.event.replace(/_/g, " ")}
                </div>
                {e.reason && <div className="subtitle" style={{ whiteSpace: "normal", color: "var(--red)" }}>{e.reason}</div>}
              </div>
              <div className="stack" style={{ alignItems: "flex-end", flex: "none" }}>
                {d?.amountYocto && <div className="num" style={{ fontWeight: 700 }}>{yoctoToNear(d.amountYocto, 4)} N</div>}
                <a className="subtitle" href={`${EXPLORER[network]}/blocks/${e.block_height}`} target="_blank" rel="noreferrer">
                  {timeAgo(e.timestamp)} ↗
                </a>
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export type Tab = "home" | "agents" | "approvals" | "activity";
