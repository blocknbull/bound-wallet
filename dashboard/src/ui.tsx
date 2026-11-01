import { useEffect, type ReactNode } from "react";

export function Card({ children, onClick, className = "" }: { children: ReactNode; onClick?: () => void; className?: string }) {
  return (
    <div className={`card ${onClick ? "clickable" : ""} ${className}`} onClick={onClick}>
      {children}
    </div>
  );
}

export function Section({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="section">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

export function Pill({ tone = "", children }: { tone?: "" | "green" | "red" | "amber" | "accent"; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Meter({ used, total }: { used: bigint; total: bigint }) {
  const p = total === 0n ? 0 : Math.min(100, Number((used * 1000n) / total) / 10);
  const cls = p >= 100 ? "full" : p >= 75 ? "warn" : "";
  return (
    <div className={`meter ${cls}`}>
      <div style={{ width: `${p}%` }} />
    </div>
  );
}

const PALETTE = ["#ab9ff2", "#3ddc97", "#ffc857", "#6cc3ff", "#ff8fa3", "#c9f279"];
export function Avatar({ name }: { name: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const bg = PALETTE[h % PALETTE.length];
  return (
    <div className="avatar" style={{ background: bg }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function Sheet({ open, onClose, title, lead, children }: { open: boolean; onClose: () => void; title: string; lead?: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="grip" />
        <h3>{title}</h3>
        {lead && <p className="lead">{lead}</p>}
        {children}
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? "active" : ""} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} aria-pressed={on} />;
}

export function Toast({ msg, tone }: { msg: string | null; tone: "error" | "success" }) {
  if (!msg) return null;
  return <div className={`toast ${tone}`}>{msg}</div>;
}

export function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      {text}
    </div>
  );
}

export function Stat({ v, k }: { v: number | string; k: string }) {
  return (
    <div className="stat">
      <div className="v num">{v}</div>
      <div className="k">{k}</div>
    </div>
  );
}

export function short(s: string, head = 10, tail = 6) {
  return s.length > head + tail + 3 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}
