/**
 * Policy editor. Amounts are entered in NEAR and stored as yoctoNEAR strings.
 * Presets cover the common shapes so an owner rarely touches every field.
 */
import { useState } from "react";
import { nearToYocto, yoctoToNear } from "./rpc";
import { Field, Segmented, Switch } from "./ui";
import type { Policy } from "./types";

/** u128::MAX in yocto: the NEAR caps step aside when the policy is in dollars. */
export const UNLIMITED = "340282366920938463463374607431768211455";
export const isUnlimited = (y: string) => y === UNLIMITED;

export const PRESETS: Record<string, { label: string; blurb: string; policy: Policy }> = {
  buyer: {
    label: "Buyer",
    blurb: "Pays a few known vendors. Small per-action cap, daily budget, asks you above 0.25 N.",
    policy: {
      max_per_tx: nearToYocto("0.5"),
      window_cap: nearToYocto("2"),
      window_secs: 86400,
      max_tx_per_window: 20,
      receivers: { Allowlist: [] },
      calls: [],
      tokens: [],
      active_hours_utc: null,
      expires_at: null,
      approval_above: nearToYocto("0.25"),
      max_per_tx_usd_cents: null,
      window_cap_usd_cents: null,
      allow_intents: false,
      tripwire: { max_denials: 5, window_secs: 3600 },
    },
  },
  trader: {
    label: "Trader",
    blurb: "Calls one DEX contract. No transfers to accounts. Higher budget, rate limited.",
    policy: {
      max_per_tx: nearToYocto("5"),
      window_cap: nearToYocto("20"),
      window_secs: 86400,
      max_tx_per_window: 100,
      receivers: { Allowlist: [] },
      calls: [{ contract: "", methods: [] }],
      tokens: [],
      active_hours_utc: null,
      expires_at: null,
      approval_above: null,
      max_per_tx_usd_cents: null,
      window_cap_usd_cents: null,
      allow_intents: false,
      tripwire: { max_denials: 10, window_secs: 3600 },
    },
  },
  intern: {
    label: "Intern",
    blurb: "Everything above 0.05 N needs your approval. Office hours only.",
    policy: {
      max_per_tx: nearToYocto("1"),
      window_cap: nearToYocto("1"),
      window_secs: 86400,
      max_tx_per_window: 10,
      receivers: "Any",
      calls: [],
      tokens: [],
      active_hours_utc: { start_hour: 9, end_hour: 18 },
      expires_at: null,
      approval_above: nearToYocto("0.05"),
      max_per_tx_usd_cents: null,
      window_cap_usd_cents: null,
      allow_intents: false,
      tripwire: { max_denials: 3, window_secs: 3600 },
      approve_new_receivers: true,
    },
  },
  dollars: {
    label: "Dollar budget",
    blurb: "$20 per action, $50 a day, priced from the wallet's NEAR/USD feed. Asks you above $25.",
    policy: {
      max_per_tx: UNLIMITED,
      window_cap: UNLIMITED,
      window_secs: 86400,
      max_tx_per_window: 50,
      receivers: "Any",
      calls: [],
      tokens: [],
      active_hours_utc: null,
      expires_at: null,
      approval_above: null,
      max_per_tx_usd_cents: 2000,
      window_cap_usd_cents: 5000,
      allow_intents: true,
      tripwire: { max_denials: 5, window_secs: 3600 },
    },
  },
};

function Chips({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim().toLowerCase();
    if (v && !items.includes(v)) onChange([...items, v]);
    setDraft("");
  };
  return (
    <>
      <div className="input-row">
        <input
          className="input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn sm" onClick={add}>
          Add
        </button>
      </div>
      {items.length > 0 && (
        <div className="chips" style={{ marginTop: 8 }}>
          {items.map((it) => (
            <span className="chip" key={it}>
              {it}
              <button type="button" onClick={() => onChange(items.filter((x) => x !== it))} aria-label={`remove ${it}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function NearInput({ value, onChange, placeholder }: { value: string; onChange: (yocto: string) => void; placeholder?: string }) {
  const [text, setText] = useState(value ? yoctoToNear(value, 6) : "");
  return (
    <div className="suffix">
      <input
        className="input num"
        inputMode="decimal"
        placeholder={placeholder ?? "0"}
        value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9.]/g, "");
          setText(t);
          if (t && /^\d*\.?\d*$/.test(t) && t !== ".") onChange(nearToYocto(t));
        }}
      />
      <span>NEAR</span>
    </div>
  );
}

function UsdInput({ cents, onChange }: { cents: number | null | undefined; onChange: (cents: number | null) => void }) {
  const [text, setText] = useState(cents != null ? (cents / 100).toString() : "");
  return (
    <div className="suffix">
      <input
        className="input num"
        inputMode="decimal"
        placeholder="0"
        value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9.]/g, "");
          setText(t);
          if (t === "" || t === ".") onChange(null);
          else onChange(Math.round(Number(t) * 100));
        }}
      />
      <span>USD</span>
    </div>
  );
}

export function PolicyForm({ value, onChange }: { value: Policy; onChange: (p: Policy) => void }) {
  const set = (patch: Partial<Policy>) => onChange({ ...value, ...patch });
  const usdMode = value.max_per_tx_usd_cents != null || value.window_cap_usd_cents != null;
  const receiversMode: "any" | "list" = value.receivers === "Any" ? "any" : "list";
  const windowMode = value.window_secs === 3600 ? "hour" : value.window_secs === 604800 ? "week" : "day";
  const approval = value.approval_above !== null;

  return (
    <div>
      <Field label="Budget window">
        <Segmented
          value={windowMode}
          options={[
            { value: "hour", label: "Hourly" },
            { value: "day", label: "Daily" },
            { value: "week", label: "Weekly" },
          ]}
          onChange={(v) => set({ window_secs: v === "hour" ? 3600 : v === "week" ? 604800 : 86400 })}
        />
      </Field>

      <Field label="Budget in" hint={usdMode ? "Dollar budgets use the wallet's NEAR/USD price. The wallet refreshes it before each action." : undefined}>
        <Segmented
          value={usdMode ? "usd" : "near"}
          options={[
            { value: "near", label: "NEAR" },
            { value: "usd", label: "US dollars" },
          ]}
          onChange={(v) =>
            v === "usd"
              ? set({ max_per_tx: UNLIMITED, window_cap: UNLIMITED, max_per_tx_usd_cents: 2000, window_cap_usd_cents: 5000 })
              : set({ max_per_tx: nearToYocto("0.5"), window_cap: nearToYocto("2"), max_per_tx_usd_cents: null, window_cap_usd_cents: null })
          }
        />
      </Field>

      {usdMode ? (
        <div className="input-row">
          <Field label="Budget per window">
            <UsdInput cents={value.window_cap_usd_cents} onChange={(c) => set({ window_cap_usd_cents: c ?? 0 })} />
          </Field>
          <Field label="Max per action">
            <UsdInput cents={value.max_per_tx_usd_cents} onChange={(c) => set({ max_per_tx_usd_cents: c ?? 0 })} />
          </Field>
        </div>
      ) : (
        <div className="input-row">
          <Field label="Budget per window">
            <NearInput value={value.window_cap} onChange={(y) => set({ window_cap: y })} />
          </Field>
          <Field label="Max per action">
            <NearInput value={value.max_per_tx} onChange={(y) => set({ max_per_tx: y })} />
          </Field>
        </div>
      )}

      <Field label="Ask me above" hint={approval ? "Actions above this amount wait for your approval." : "Off: the agent never asks, it is only capped."}>
        <div className="input-row">
          <div style={{ flex: 1 }}>
            {approval ? (
              <NearInput value={value.approval_above ?? "0"} onChange={(y) => set({ approval_above: y })} />
            ) : (
              <input className="input" disabled value="Never" />
            )}
          </div>
          <button type="button" className="btn sm" onClick={() => set({ approval_above: approval ? null : nearToYocto("0.25") })}>
            {approval ? "Turn off" : "Turn on"}
          </button>
        </div>
      </Field>

      <Field label="Who can be paid">
        <Segmented
          value={receiversMode}
          options={[
            { value: "list", label: "Only these accounts" },
            { value: "any", label: "Anyone" },
          ]}
          onChange={(v) => set({ receivers: v === "any" ? "Any" : { Allowlist: [] } })}
        />
        {receiversMode === "list" && (
          <div style={{ marginTop: 8 }}>
            <Chips
              items={value.receivers === "Any" ? [] : value.receivers.Allowlist}
              onChange={(list) => set({ receivers: { Allowlist: list } })}
              placeholder="vendor.testnet"
            />
          </div>
        )}
        {receiversMode === "any" && (
          <div className="row between" style={{ marginTop: 10 }}>
            <span className="subtitle" style={{ whiteSpace: "normal" }}>Ask me the first time it pays someone new</span>
            <Switch on={!!value.approve_new_receivers} onChange={(v) => set({ approve_new_receivers: v })} />
          </div>
        )}
      </Field>

      <Field label="Contracts it may call" hint="Format contract.testnet or contract.testnet:method1,method2. Leave empty to block all calls.">
        <Chips
          items={value.calls.map((c) => (c.methods.length ? `${c.contract}:${c.methods.join(",")}` : c.contract))}
          onChange={(list) =>
            set({
              calls: list.map((s) => {
                const [contract, m] = s.split(":");
                return { contract, methods: m ? m.split(",").filter(Boolean) : [] };
              }),
            })
          }
          placeholder="dex.testnet:swap"
        />
      </Field>

      <Field label="Cross-chain swaps via NEAR Intents" hint="Lets the agent fund 1Click swap deposits. The per-quote deposit address bypasses the receiver list; caps, rate limit and the approval threshold still apply, and the destination is recorded.">
        <div className="row between">
          <span className="subtitle" style={{ whiteSpace: "normal" }}>{value.allow_intents ? "Allowed, within the caps above" : "Not allowed"}</span>
          <Switch on={!!value.allow_intents} onChange={(v) => set({ allow_intents: v })} />
        </div>
      </Field>

      <Field label="Tripwire" hint={value.tripwire ? "Suspend the agent after this many denials within the window. You lift it from the agent page." : "Off. A probing agent keeps probing until you notice."}>
        <div className="input-row">
          <div className="suffix" style={{ flex: 1 }}>
            <input
              className="input num"
              inputMode="numeric"
              placeholder="5"
              value={value.tripwire?.max_denials ?? ""}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                set({ tripwire: v === "" ? null : { max_denials: Number(v), window_secs: value.tripwire?.window_secs ?? 3600 } });
              }}
            />
            <span>denials</span>
          </div>
          <div className="suffix" style={{ flex: 1 }}>
            <input
              className="input num"
              inputMode="numeric"
              placeholder="60"
              value={value.tripwire ? Math.round(value.tripwire.window_secs / 60) : ""}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                if (value.tripwire) set({ tripwire: { ...value.tripwire, window_secs: Math.max(1, Number(v || 0)) * 60 } });
              }}
              disabled={!value.tripwire}
            />
            <span>minutes</span>
          </div>
        </div>
      </Field>

      <div className="input-row">
        <Field label="Max actions per window" hint="0 = unlimited">
          <input
            className="input num"
            inputMode="numeric"
            value={value.max_tx_per_window}
            onChange={(e) => set({ max_tx_per_window: Number(e.target.value.replace(/\D/g, "") || 0) })}
          />
        </Field>
        <Field label="Active hours (UTC)" hint="Leave blank for always">
          <div className="input-row">
            <input
              className="input num"
              placeholder="9"
              inputMode="numeric"
              value={value.active_hours_utc?.start_hour ?? ""}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                set({ active_hours_utc: v === "" ? null : { start_hour: Math.min(23, Number(v)), end_hour: value.active_hours_utc?.end_hour ?? 18 } });
              }}
            />
            <input
              className="input num"
              placeholder="18"
              inputMode="numeric"
              value={value.active_hours_utc?.end_hour ?? ""}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                set({ active_hours_utc: v === "" ? null : { start_hour: value.active_hours_utc?.start_hour ?? 9, end_hour: Math.min(23, Number(v)) } });
              }}
            />
          </div>
        </Field>
      </div>
    </div>
  );
}

export function validatePolicy(p: Policy): string | null {
  const usd = p.max_per_tx_usd_cents != null || p.window_cap_usd_cents != null;
  if (usd) {
    if (!p.window_cap_usd_cents) return "Budget per window must be more than $0";
    if ((p.max_per_tx_usd_cents ?? 0) > p.window_cap_usd_cents) return "Max per action cannot exceed the window budget";
  }
  if (BigInt(p.window_cap) === 0n) return "Budget per window must be more than 0";
  if (BigInt(p.max_per_tx) > BigInt(p.window_cap)) return "Max per action cannot exceed the window budget";
  if (p.calls.some((c) => !c.contract)) return "Every call rule needs a contract";
  return null;
}
