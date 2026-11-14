"use client";
import { useRef, useState } from "react";
import type { DisplayPhase } from "@maskbid/protocol";
import { AuctionCard } from "@/components/AuctionCard";
import { AssetArt } from "@/components/Dots";
import { GetStarted } from "@/components/GetStarted";
import { Arrow } from "@/components/Hero";
import { SyncLine } from "@/components/ui";
import { readConfig } from "@/lib/client";
import { loadAuctions, useChainData } from "@/lib/data";

const PHASES: ("All" | DisplayPhase)[] = ["All", "Live", "Scheduled", "Closed", "Resolving", "Claim", "Completed", "Cancelled"];
const label = (p: (typeof PHASES)[number]) => (p === "Claim" ? "Pending payment" : p);
const rank = (v: { phase: DisplayPhase }) => (v.phase === "Live" ? 0 : v.phase === "Scheduled" ? 1 : 2);

/** The app's home: every lot on the contract, then the first-run checklist. */
export default function Auctions() {
  const [phase, setPhase] = useState<(typeof PHASES)[number]>("All");
  const [sort, setSort] = useState<"closing" | "recent">("closing");
  const [cur, setCur] = useState(0);
  const track = useRef<HTMLDivElement>(null);
  const { data, error, syncedAt, refresh, loading } = useChainData(loadAuctions, [], 8000);
  const { data: cfg } = useChainData(readConfig, [], 60000);
  const maxBids = Number(cfg?.maxBids ?? 32);
  const all = data?.list ?? [];
  const count = (p: (typeof PHASES)[number]) => (p === "All" ? all.length : all.filter((v) => v.phase === p).length);
  const list = all
    .filter((v) => phase === "All" || v.phase === phase)
    // "Closing soon" means open lots first (soonest close), then everything already closed, most recent first.
    .sort((x, y) => (sort === "closing" ? rank(x) - rank(y) || (rank(x) < 2 ? Number(x.a.endTime - y.a.endTime) : Number(y.a.endTime - x.a.endTime)) : Number(y.id - x.id)));
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
    <div className="market">
      <section id="lots" className="lots" aria-labelledby="lots-title">
        <div className="container">
          <div className="sec-head">
            <h1 id="lots-title">Lots on NEAR</h1>
            <p>Every lot is one verified token. Bids stay encrypted until the auction closes, and only the winning amount is ever made public.</p>
          </div>
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
              <div className="lot-art"><AssetArt seed="0x34894179" /></div>
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
        <div className="container lots-sync"><SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} via="chain" /></div>
      </section>

      <section id="start" className="container start-sec" aria-label="Get started"><GetStarted /></section>
    </div>
  );
}
