"use client";
import { useRef, useState } from "react";
import { formatUnits6, type DisplayPhase } from "@maskbid/protocol";
import { AuctionCard } from "@/components/AuctionCard";
import { AssetArt } from "@/components/Dots";
import { FlowStory } from "@/components/FlowStory";
import { GetStarted } from "@/components/GetStarted";
import { Arrow, Hero } from "@/components/Hero";
import { PartsAccordion } from "@/components/PartsAccordion";
import { SealDemo } from "@/components/SealDemo";
import { Stipple } from "@/components/Stipple";
import { Alert, Reveal, SyncLine } from "@/components/ui";
import { readConfig } from "@/lib/client";
import { deployment } from "@/lib/config";
import { loadAuctions, useChainData } from "@/lib/data";

const PHASES: ("All" | DisplayPhase)[] = ["All", "Live", "Scheduled", "Closed", "Resolving", "Claim", "Completed", "Cancelled"];
const label = (p: (typeof PHASES)[number]) => (p === "Claim" ? "Pending payment" : p);

const icon = (d: string) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

const TRUST = [
  ["Encrypted before it leaves your device", "AES-256-GCM for the amount, RSA-OAEP-2048 for the key, bound to one auction.", icon("M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z")],
  ["Never the same twice", "Fresh key, IV and nonce on every seal, so equal bids look unrelated.", icon("M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4")],
  ["Checked against your receipt", "The commitment on chain must equal the one computed here.", icon("M20 6L9 17l-5-5")],
] as const;

const STACK = ["Aurora", "NEAR", "OutLayer", "AES-256-GCM", "RSA-OAEP-2048", "keccak-256", "ERC-1155", "Foundry"];
const SEALED = [["Every losing bid amount", "forever"], ["Your amount before the close", "until settlement"], ["Bid plaintext", "only inside the solver"], ["Who offered how much", "only the winner is tied to a number"]];
const PUBLIC = [["Wallet addresses and deposits", "at bid time"], ["Ordered bid digest", "updated per bid"], ["Winner and winning amount", "after settlement"], ["Execution and output hashes", "on the evidence page"]];

export default function Home() {
  const [phase, setPhase] = useState<(typeof PHASES)[number]>("All");
  const [sort, setSort] = useState<"closing" | "recent">("closing");
  const [cur, setCur] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const { data, error, syncedAt, refresh, loading } = useChainData(loadAuctions, [], 8000);
  const { data: cfg } = useChainData(readConfig, [], 60000);
  const maxBids = Number(cfg?.maxBids ?? 32);
  const all = data ?? [];
  const count = (p: (typeof PHASES)[number]) => (p === "All" ? all.length : all.filter((v) => v.phase === p).length);
  const list = all
    .filter((v) => phase === "All" || v.phase === phase)
    .sort((x, y) => (sort === "closing" ? Number(x.a.endTime - y.a.endTime) : Number(y.id - x.id)));
  const settled = all.filter((v) => v.phase === "Completed").reduce((s, v) => s + v.a.winningAmountUnits, 0n);
  const stat = (n: number | string) => (data ? n : "—");
  const step = () => (track.current?.querySelector<HTMLElement>(".lot-card")?.offsetWidth ?? 0) + 24;
  const show = (i: number) => {
    const t = track.current;
    if (!t) return;
    const left = i * step(), from = t.scrollLeft;
    setCur(i);
    t.scrollTo({ left, behavior: "smooth" });
    // some embedded browsers never run smooth scrolling; land on the card anyway
    setTimeout(() => { if (t.scrollLeft === from && from !== left) t.scrollTo({ left }); }, 450);
  };
  const pick = (p: (typeof PHASES)[number]) => { setPhase(p); setCur(0); track.current?.scrollTo({ left: 0 }); };
  const at = Math.min(cur, Math.max(0, list.length - 1));

  return (
    <div className="home">
      <Hero />

      <section id="lots" className="sec lots" aria-labelledby="lots-title">
        <div className="container">
          <Reveal className="sec-head">
            <h2 id="lots-title">Lots on Aurora</h2>
            <p>Every lot is one verified token. Bids stay encrypted until the auction closes, and only the winning amount is ever made public.</p>
          </Reveal>
          {!deployment && <Alert tone="error" title="No deployment configured">Writes are disabled. Run the local deployment or add a deployments file for this chain.</Alert>}
          <div className="toolbar">
            <div className="seg" role="group" aria-label="Filter by phase">
              {PHASES.filter((p) => p === "All" || p === "Live" || p === phase || count(p) > 0).map((p) => (
                <button key={p} type="button" aria-pressed={phase === p} onClick={() => pick(p)}>{label(p)}<small>{count(p)}</small></button>
              ))}
            </div>
            <select aria-label="Sort lots" value={sort} onChange={(e) => { setSort(e.target.value as "closing" | "recent"); setCur(0); track.current?.scrollTo({ left: 0 }); }}>
              <option value="closing">Closing soon</option><option value="recent">Recently listed</option>
            </select>
          </div>
          {loading && <p aria-busy="true" className="muted center">Reading lots from the chain…</p>}
          {!loading && list.length === 0 && (
            <div className="lot-empty card">
              <div className="lot-art"><AssetArt seed={deployment?.auction ?? "0x9802a651"} /></div>
              <div>
                <h3>{all.length ? `No ${label(phase).toLowerCase()} lots right now` : "No lots yet"}</h3>
                <p className="muted">{all.length ? "Other phases have lots. Switch the filter to see them." : "Register an asset, have a verifier approve it, and it becomes the first lot here."}</p>
                {all.length ? <button type="button" className="btn btn-secondary" onClick={() => pick("All")}>Show all lots</button> : <a className="btn" href="/sell">List the first asset <Arrow /></a>}
              </div>
            </div>
          )}
        </div>
        {list.length > 0 && (
          <div className="lot-rail">
            <div className="lot-track" ref={track} tabIndex={0} aria-label="Lots, scroll sideways"
              onScroll={(e) => { const s = step(); if (s > 24) setCur(Math.round(e.currentTarget.scrollLeft / s)); }}>
              {list.map((v) => <AuctionCard key={v.id.toString()} v={v} maxBids={maxBids} />)}
            </div>
            {list.length > 1 && <>
              <button type="button" className="rail-btn prev" aria-label="Previous lot" disabled={at === 0} onClick={() => show(at - 1)}><Arrow /></button>
              <button type="button" className="rail-btn next" aria-label="Next lot" disabled={at === list.length - 1} onClick={() => show(at + 1)}><Arrow /></button>
              <div className="rail-dots">{list.map((v, i) => <button key={v.id.toString()} type="button" aria-label={`Show lot ${v.id}`} aria-current={i === at || undefined} onClick={() => show(i)} />)}</div>
            </>}
          </div>
        )}
        <div className="container lots-sync"><SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} /></div>
      </section>

      {deployment && <section id="start" className="container start-sec" aria-label="Get started"><GetStarted /></section>}

      <FlowStory />

      <section className="sec container" aria-labelledby="parts-title">
        <Reveal className="sec-head">
          <p className="eyebrow">The stack</p>
          <h2 id="parts-title">Built from open, checkable parts</h2>
          <p>Nothing here asks you to trust a black box. Each stage runs on a public standard you can read and test.</p>
        </Reveal>
        <PartsAccordion />
      </section>

      <section className="sec trust" aria-labelledby="seal-title">
        <Reveal className="container trust-head">
          <p className="eyebrow">Sealed in your browser</p>
          <h2 id="seal-title">Your bid becomes 490 bytes nobody can read</h2>
          <p className="tag-pill">Runs in this tab</p>
        </Reveal>
        <div className="trust-band">
          <div className="trust-demo">
            <Stipple kind="cloud" seed={61} className="cloud t1" />
            <Stipple kind="cloud" seed={67} className="cloud t2" />
            <SealDemo />
          </div>
          <ul className="trust-rows">
            {TRUST.map(([title, text, ic]) => <li key={title}><i>{ic}</i><div><h3>{title}</h3><p>{text}</p></div></li>)}
          </ul>
        </div>
      </section>

      <section className="navy" aria-labelledby="privacy-title">
        <div className="container">
          <Reveal className="sec-head">
            <p className="eyebrow">On chain</p>
            <h2 id="privacy-title">Sealed where it matters, public where it counts</h2>
            <p>Anyone can read what Aurora records. These totals come straight from this deployment.</p>
          </Reveal>
        </div>
        <div className="marquee">
          <div className="marquee-track">
            {STACK.map((s) => <span key={s}>{s}</span>)}
            {STACK.map((s) => <span key={`${s}-again`} aria-hidden="true">{s}</span>)}
          </div>
        </div>
        <div className="container">
          <Reveal className="figures">
            <Stipple kind="cloud" seed={71} className="cloud g1" />
            <Stipple kind="cloud" seed={73} className="cloud g2" />
            <Stipple kind="flight" seed={79} className="g3" />
            <div className="figure-main"><b>{stat(formatUnits6(settled))}</b><span>mUSDC settled</span></div>
            <div className="figure-side">
              <p>Read from the chain right now</p>
              <div className="figure-tiles">
                <div><b>{stat(all.length)}</b><span>Lots listed</span></div>
                <div><b>{stat(count("Live"))}</b><span>Live right now</span></div>
                <div><b>{stat(all.reduce((s, v) => s + v.a.bidCount, 0))}</b><span>Sealed bids placed</span></div>
              </div>
            </div>
          </Reveal>
          <div className="ledger">
            <Reveal className="ledger-col">
              <h3>Stays sealed</h3>
              <ul>{SEALED.map(([what, when]) => <li key={what}>{what}<span className="chip peach">{when}</span></li>)}</ul>
            </Reveal>
            <Reveal className="ledger-col">
              <h3>Public on Aurora</h3>
              <ul>{PUBLIC.map(([what, when]) => <li key={what}>{what}<span className="chip mint">{when}</span></li>)}</ul>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="sec container cta" aria-labelledby="cta-title">
        <Reveal className="cta-in">
          <h2 id="cta-title">Have something worth a sealed bid?</h2>
          <p>Register it, have a verifier approve it, then list it. Bidders compete on price without ever seeing each other&apos;s numbers.</p>
          <div className="row"><a className="btn" href="/sell">List an asset <Arrow /></a><a className="btn btn-secondary" href="/verify">Verify identity</a></div>
        </Reveal>
      </section>
    </div>
  );
}
