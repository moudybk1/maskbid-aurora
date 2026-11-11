"use client";
import { useParams } from "next/navigation";
import type { Hex } from "viem";
import { formatMoney } from "@maskbid/protocol";
import { AddressLink, Alert, Badge, HashRow, PhaseBadge, SyncLine, TxLink } from "@/components/ui";
import { auctionEvents, readConfig, readKeyById } from "@/lib/client";
import { COPY } from "@/lib/copy";
import { loadAuction, loadBids, useChainData } from "@/lib/data";
import { fmtTime } from "@/lib/format";

interface Evidence { status: "available_unchecked" | "not_available"; executionId?: string; outputSha256?: Hex; manifestSha256?: Hex; wasmSha256?: Hex; adapter?: string; note?: string; fatal?: { code: string }; executedAt?: string }

async function fetchEvidence(requestId: Hex): Promise<Evidence> {
  const r = await fetch(`/api/evidence/${requestId}`, { cache: "no-store" });
  if (!r.ok) return { status: "not_available" };
  const j = await r.json();
  return { status: "available_unchecked", ...j };
}

export default function EvidencePage() {
  const id = BigInt(useParams<{ id: string }>().id);
  const { data, error, syncedAt, refresh } = useChainData(async () => {
    const view = await loadAuction(id);
    const [bids, cfg, key, requested, accepted, claimed, refunded, cancelled, defaulted, returned] = await Promise.all([
      loadBids(id), readConfig(), readKeyById(view.a.keyId),
      auctionEvents("SettlementRequested", { auctionId: id }), auctionEvents("SettlementAccepted", { auctionId: id }), auctionEvents("WinClaimed", { auctionId: id }),
      auctionEvents("DepositRefunded", { auctionId: id }), auctionEvents("AuctionCancelled", { auctionId: id }), auctionEvents("WinnerDefaulted", { auctionId: id }), auctionEvents("ReturnedAssetClaimed", { auctionId: id }),
    ]);
    const evidence = Object.fromEntries(await Promise.all(requested.map(async (r) => [r.args.requestId as Hex, await fetchEvidence(r.args.requestId as Hex)])));
    return { view, bids, cfg, key, requested, accepted, claimed, refunded, cancelled, defaulted, returned, evidence };
  }, [id], 10000);
  if (error) return <Alert tone="error" title="Evidence unavailable">{error}</Alert>;
  if (!data) return <p aria-busy="true" className="muted">Loading evidence from chain…</p>;
  const { view, bids, cfg, key, requested, accepted, evidence } = data;
  const a = view.a;
  const acceptedEv = accepted[0];
  const local = cfg.nearAdapterAccount === "local-mock-adapter";

  return (
    <div className="stack reading" style={{ gap: 24 }}>
      <div>
        <p className="caption"><a href={`/auctions/${id}`}>← Lot {id.toString()}</a></p>
        <h1>Evidence</h1>
        <p className="muted">Every row names its source. &ldquo;Receipt available&rdquo; is not &ldquo;attestation checked&rdquo;. Losing bid amounts are never shown.</p>
        <SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} />
      </div>
      {local && <Alert tone="warning" title="Local mock adapter">{COPY.localAdapter}</Alert>}

      <section className="panel">
        <h2>1 · Accepted on-chain outcome</h2>
        <div className="row"><PhaseBadge phase={view.phase} /></div>
        <HashRow label="Auction state" source="contract"><span>{view.state}{view.cancelReason !== "None" ? ` · ${view.cancelReason}` : ""}</span></HashRow>
        {acceptedEv ? (
          <>
            <HashRow label="Outcome" source="SettlementAccepted event"><span>{acceptedEv.args.outcome === 0 ? "WINNER" : "NO_SALE"}</span></HashRow>
            {acceptedEv.args.outcome === 0 && <><HashRow label="Winner" source="event"><AddressLink address={acceptedEv.args.winner as string} /></HashRow><HashRow label="Winning amount" source="event"><span className="num">{formatMoney(acceptedEv.args.winningAmountUnits as bigint)}</span></HashRow></>}
            <HashRow label="Result transaction" source="chain"><TxLink hash={acceptedEv.transactionHash} /></HashRow>
            <HashRow label="Execution ID hash" value={acceptedEv.args.executionIdHash as string} source="event" />
            <HashRow label="Output hash (SHA-256 of raw result)" value={acceptedEv.args.outputHash as string} source="event" />
          </>
        ) : <p className="small muted">No result accepted yet.</p>}
      </section>

      <section className="panel">
        <h2>2 · Included bid set</h2>
        <HashRow label="Bid count" source="contract"><span className="num">{a.bidCount}</span></HashRow>
        <HashRow label="Ordered digest" value={a.bidDigest} source="contract" />
        {bids.map((b) => <HashRow key={b.index} label={`Bid ${b.index} · ${b.bidder.slice(0, 10)}… · deposit ${b.depositStatus}`} value={b.commitment} source="BidPlaced event" />)}
      </section>

      <section className="panel">
        <h2>3 · Settlement requests</h2>
        {requested.length === 0 && <p className="small muted">Not requested yet.</p>}
        {requested.map((r) => {
          const rid = r.args.requestId as Hex;
          const ev = evidence[rid] as Evidence | undefined;
          const isActive = rid === a.activeRequestId;
          return (
            <div key={rid} style={{ marginBottom: 16 }}>
              <div className="row"><strong>Attempt {String(r.args.attempt)}</strong>{isActive && <Badge tone="info">active request</Badge>}{acceptedEv?.args.requestId === rid && <Badge tone="success">accepted</Badge>}</div>
              <HashRow label="Request ID" value={rid} source="SettlementRequested event" />
              <HashRow label="Digest · count · deadline" source="event"><span className="mono">{(r.args.bidDigest as string).slice(0, 14)}… · {String(r.args.bidCount)} · {fmtTime(r.args.deadline as bigint)}</span></HashRow>
              <HashRow label="Request transaction" source="chain"><TxLink hash={r.transactionHash} /></HashRow>
              <HashRow label="Execution evidence" source={ev?.adapter ?? "adapter"}>
                {ev?.status === "available_unchecked" && !ev.fatal ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <Badge tone="warning">available · unchecked</Badge>
                    <span className="small">{COPY.evidenceUnchecked}</span>
                    {ev.executionId && <span className="mono">execution {ev.executionId}</span>}
                    {ev.outputSha256 && <span className="mono">output sha256 {ev.outputSha256}</span>}
                    <span className="mono">manifest sha256 {ev.manifestSha256}</span>
                    {ev.wasmSha256 && <span className="mono">code {ev.wasmSha256}</span>}
                    {acceptedEv?.args.requestId === rid && (ev.outputSha256
                      ? <span className="small">Output hash {ev.outputSha256.toLowerCase() === (acceptedEv.args.outputHash as string).toLowerCase() ? "matches" : "DOES NOT MATCH"} the accepted on-chain result.</span>
                      : <span className="small">Adapter output hash not recorded in this file; compare the on-chain output hash with the adapter record (get_request).</span>)}
                  </div>
                ) : ev?.fatal ? <Badge tone="danger">failed · {ev.fatal.code}</Badge> : <Badge tone="neutral">not available</Badge>}
              </HashRow>
            </div>
          );
        })}
      </section>

      <section className="panel">
        <h2>4 · Code and key identity</h2>
        <HashRow label="Solver code hash (pinned at creation)" value={a.solverCodeHash} source="contract" />
        <HashRow label="Config hash" value={a.configHash} source="contract" />
        <HashRow label="Key ID (SHA-256 of SPKI)" value={a.keyId} source="contract" />
        <HashRow label="Sealed key blob hash" value={key.sealedBlobHash} source="KeyPrepared callback" />
        <HashRow label="Adapter" source="config"><span className="mono">{cfg.nearAdapterAccount}</span></HashRow>
        <HashRow label="Callback sender" source="config"><AddressLink address={cfg.callbackSender} /></HashRow>
        <HashRow label="Attestation" source="viewer"><Badge tone="neutral">not checked</Badge> <span className="small muted">{local ? "No TEE attestation exists for the local adapter." : "This viewer does not verify vendor attestation."}</span></HashRow>
      </section>

      <section className="panel">
        <h2>5 · Settlement, claim and refund transactions</h2>
        {data.claimed.map((e) => <HashRow key={e.transactionHash} label={`Win claimed · paid ${formatMoney(e.args.totalPaid as bigint)}`} source="WinClaimed event"><TxLink hash={e.transactionHash} /></HashRow>)}
        {data.refunded.map((e, i) => <HashRow key={`${e.transactionHash}-${i}`} label={`Deposit refunded · ${(e.args.bidder as string).slice(0, 10)}… · ${formatMoney(e.args.amount as bigint)}`} source="DepositRefunded event"><TxLink hash={e.transactionHash} /></HashRow>)}
        {data.defaulted.map((e) => <HashRow key={e.transactionHash} label={`Winner defaulted · penalty ${formatMoney(e.args.penalty as bigint)} credited to seller`} source="WinnerDefaulted event"><TxLink hash={e.transactionHash} /></HashRow>)}
        {data.cancelled.map((e) => <HashRow key={e.transactionHash} label="Auction cancelled" source="AuctionCancelled event"><TxLink hash={e.transactionHash} /></HashRow>)}
        {data.returned.map((e) => <HashRow key={e.transactionHash} label="Returned asset claimed by seller" source="ReturnedAssetClaimed event"><TxLink hash={e.transactionHash} /></HashRow>)}
        {data.claimed.length + data.refunded.length + data.defaulted.length + data.cancelled.length + data.returned.length === 0 && <p className="small muted">No settlement transactions yet.</p>}
      </section>
    </div>
  );
}
