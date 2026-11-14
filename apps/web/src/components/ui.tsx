"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatUnits6, TOKEN_SYMBOL, type DisplayPhase } from "@maskbid/protocol";
import { addressUrl, txUrl } from "@/lib/config";
import { short } from "@/lib/format";
import type { TxState } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

export function Badge({ tone, children }: { tone: "neutral" | "success" | "warning" | "danger" | "info" | "accent"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const PHASE_TONE: Record<DisplayPhase, "neutral" | "success" | "warning" | "danger" | "info" | "accent"> = {
  Scheduled: "neutral", Live: "success", Closed: "warning", Resolving: "info", Claim: "accent", Completed: "neutral", Cancelled: "danger",
};
export const PhaseBadge = ({ phase }: { phase: DisplayPhase }) => <Badge tone={PHASE_TONE[phase]}>{phase === "Claim" ? "Pending payment" : phase}</Badge>;

// The auction lifecycle in the words a bidder uses. Closed and Resolving are one step to a bidder: "waiting for the result".
const TRACK: [string, DisplayPhase[]][] = [["Opens", ["Scheduled"]], ["Bidding", ["Live"]], ["Result", ["Closed", "Resolving"]], ["Payment", ["Claim"]], ["Settled", ["Completed"]]];
export function PhaseTrack({ phase }: { phase: DisplayPhase }) {
  const at = TRACK.findIndex(([, ps]) => ps.includes(phase));
  if (at < 0) return null; // cancelled lots leave the track
  return (
    <ol className="phase-track" aria-label="Auction progress">
      {TRACK.map(([label], i) => <li key={label} data-state={i < at ? "done" : i === at ? "current" : undefined} aria-current={i === at ? "step" : undefined}>{label}</li>)}
    </ol>
  );
}

/** Stands in for any screen that needs a wallet: one button, not a dead-end notice. */
export function ConnectPrompt({ title = "Connect an account", children }: { title?: string; children: ReactNode }) {
  const { setConnectOpen } = useWallet();
  return (
    <div className="connect-prompt panel">
      <div><h3>{title}</h3><p className="muted">{children}</p></div>
      <button type="button" className="btn" onClick={() => setConnectOpen(true)}>Connect account</button>
    </div>
  );
}

export function Alert({ tone, title, children }: { tone: "info" | "warning" | "error" | "success"; title?: string; children?: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {title && <strong>{title}</strong>}
      {children}
    </div>
  );
}

export function Money({ units, strong }: { units: bigint; strong?: boolean }) {
  return (
    <span className="money" style={strong ? { fontSize: 20 } : undefined}>
      {formatUnits6(units)}<span className="unit">{TOKEN_SYMBOL}</span>
    </span>
  );
}

export function AddressLink({ address, label }: { address: string; label?: string }) {
  const url = addressUrl(address);
  const text = label ?? (address.length <= 34 ? address : short(address, 16, 10)); // NEAR account names read better whole
  return (
    <span className="mono" title={address}>
      {url ? <a href={url} target="_blank" rel="noreferrer">{text}</a> : text}
      <CopyButton value={address} />
    </span>
  );
}

export function TxLink({ hash }: { hash: string }) {
  const url = txUrl(hash);
  return <span className="mono" title={hash}>{url ? <a href={url} target="_blank" rel="noreferrer">{short(hash, 8, 6)}</a> : short(hash, 8, 6)}<CopyButton value={hash} /></span>;
}

/** A data: URI is the metadata itself (the seeded demo lots use one); a link to it would only open a blank tab. */
export function UriLink({ uri }: { uri: string }) {
  return uri.startsWith("data:") ? <span>Stored inline in the token record (data URI)</span> : <a href={uri} target="_blank" rel="noreferrer" className="mono">{uri}</a>;
}

export function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn-text btn-sm" style={{ minHeight: 28, marginLeft: 4 }} aria-label={`Copy ${short(value)}`}
      onClick={() => { navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? "copied" : "copy"}
    </button>
  );
}

export function HashRow({ label, value, children, source }: { label: string; value?: string; children?: ReactNode; source?: string }) {
  const [full, setFull] = useState(false);
  return (
    <div className="hash-row">
      <div>
        <div className="small muted">{label}{source && <span className="caption"> · source: {source}</span>}</div>
        {value ? <div className="mono">{full ? value : short(value, 10, 8)}<CopyButton value={value} /></div> : children}
      </div>
      {value && value.length > 24 && <button type="button" className="btn btn-text btn-sm" onClick={() => setFull(!full)} aria-expanded={full}>{full ? "hide" : "reveal"}</button>}
    </div>
  );
}

export function Field({ label, help, error, children, id }: { label: string; help?: string; error?: string; children: ReactNode; id: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help && !error && <div className="help" id={`${id}-help`}>{help}</div>}
      {error && <div className="error" id={`${id}-error`} role="alert">{error}</div>}
    </div>
  );
}

export function AmountInput({ id, value, onChange, error, help, label, disabled }: { id: string; value: string; onChange: (v: string) => void; error?: string; help?: string; label: string; disabled?: boolean }) {
  return (
    <Field id={id} label={label} help={help} error={error}>
      <div className="input-unit">
        <input id={id} className="input" inputMode="decimal" autoComplete="off" value={value} disabled={disabled} placeholder="0.000000"
          aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined} aria-invalid={Boolean(error)} onChange={(e) => onChange(e.target.value)} />
        <span className="unit">{TOKEN_SYMBOL}</span>
      </div>
    </Field>
  );
}

export function Modal({ title, onClose, children, closable = true, wide }: { title: string; onClose: () => void; children: ReactNode; closable?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>("input,select,textarea") ?? ref.current?.querySelector<HTMLElement>("button:not([aria-label='Close dialog'])"))?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && closable) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [onClose, closable]);
  // Portal: an ancestor with a transform (the header's entrance animation) would otherwise trap position: fixed.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && closable) onClose(); }}>
      <div className={wide ? "modal modal-wide" : "modal"} role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={ref}>
        <div className="row between"><h2 id="modal-title">{title}</h2>{closable && <button type="button" className="btn btn-text" onClick={onClose} aria-label="Close dialog">Close</button>}</div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Persistent receipt card: a toast alone is not enough for a financial action (spec 10 §10). */
export function TxStatus({ state }: { state: TxState }) {
  if (state.status === "idle") return null;
  if (state.status === "error") return <Alert tone="error" title={`${state.label ?? "Transaction"} failed`}>{state.error}</Alert>;
  if (state.status === "success") return <Alert tone="success" title={`${state.label ?? "Transaction"} confirmed`}>Receipt: {state.hash && <TxLink hash={state.hash} />}</Alert>;
  return (
    <Alert tone="info" title={state.status === "signing" ? `Signing: ${state.label}` : `Confirming: ${state.label}`}>
      {state.hash ? <>Broadcast: <TxLink hash={state.hash} /> — closing this page does not cancel the transaction.</> : "Signing with this account's key in the browser."}
    </Alert>
  );
}

/** Children rise in once when the block scrolls into view. Server HTML stays visible; only below-the-fold blocks are hidden, after mount. */
export function Reveal({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || el.getBoundingClientRect().top < window.innerHeight) return;
    el.dataset.reveal = "hidden";
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.dataset.reveal = "shown"; io.disconnect(); } }, { rootMargin: "0px 0px -12% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={className} data-reveal="shown">{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty card"><h3>{title}</h3>{children}</div>;
}

export function SyncLine({ syncedAt, error, onRefresh, via = "chain" }: { syncedAt?: number; error?: string; onRefresh: () => void; via?: string }) {
  return (
    <div className="row small muted" aria-live="polite">
      {error ? <span style={{ color: "var(--color-danger)" }}>Chain read failed: {error}</span> : syncedAt ? <span>Last synced {new Date(syncedAt).toLocaleTimeString()} from {via}</span> : <span>Syncing…</span>}
      <button type="button" className="btn btn-text btn-sm" onClick={onRefresh}>Refresh</button>
    </div>
  );
}
