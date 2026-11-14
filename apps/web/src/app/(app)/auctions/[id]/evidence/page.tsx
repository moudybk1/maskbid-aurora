"use client";
import { useParams } from "next/navigation";
import { formatMoney } from "@maskbid/protocol";
import { AddressLink, Alert, Badge, HashRow, PhaseBadge, SyncLine } from "@/components/ui";
import { readConfig, readKeyById } from "@/lib/client";
import { loadAuction, loadBids, useChainData } from "@/lib/data";
import { fmtTime } from "@/lib/format";

const ZERO = `0x${"00".repeat(32)}`;

export default function EvidencePage() {
  const id = BigInt(useParams<{ id: string }>().id);
  const { data, error, syncedAt, refresh } = useChainData(async () => {
    const view = await loadAuction(id);
    const [bids, cfg, key] = await Promise.all([loadBids(id), readConfig(), readKeyById(view.a.keyId)]);
    return { view, bids, cfg, key };
  }, [id], 10000);
  if (error) return <Alert tone="error" title="Evidence unavailable">{error}</Alert>;
  if (!data) return <p aria-busy="true" className="muted">Loading evidence from chain…</p>;
  const { view, bids, cfg, key } = data;
  const a = view.a;
  const requested = a.activeRequestId !== ZERO;
  const accepted = a.outputSha256 !== undefined;
  const recomputed = bids.at(-1)?.digestAfter;

  return (
    <div className="stack reading" style={{ gap: 24 }}>
      <div>
        <p className="caption"><a href={`/auctions/${id}`}>← Lot {id.toString()}</a></p>
        <h1>Evidence</h1>
        <p className="muted">Every row names its source. &ldquo;Result accepted&rdquo; is not &ldquo;attestation checked&rdquo;. Losing bid amounts are never shown.</p>
        <SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} />
      </div>

      <section className="panel">
        <h2>1 · Accepted on-chain outcome</h2>
        <div className="row"><PhaseBadge phase={view.phase} /></div>
        <HashRow label="Auction state" source="contract"><span>{view.state}{view.cancelReason !== "None" ? ` · ${view.cancelReason}` : ""}</span></HashRow>
        {accepted ? (
          <>
            <HashRow label="Outcome" source="contract"><span>{a.winner ? "WINNER" : "NO_SALE"}</span></HashRow>
            {a.winner && <><HashRow label="Winner" source="contract"><AddressLink address={a.winner} /></HashRow><HashRow label="Winning amount" source="contract"><span className="num">{formatMoney(a.winningAmountUnits)}</span></HashRow></>}
            <HashRow label="Output hash (SHA-256 of the solver's raw result)" value={a.outputSha256} source="contract" />
          </>
        ) : <p className="small muted">No result accepted yet.</p>}
      </section>

      <section className="panel">
        <h2>2 · Included bid set</h2>
        <p className="small muted">The contract keeps every sealed envelope and builds the solver&apos;s input from them itself, so nobody can hand the solver a different set.</p>
        <HashRow label="Bid count" source="contract"><span className="num">{a.bidCount}</span></HashRow>
        <HashRow label="Ordered digest" value={a.bidDigest} source="contract" />
        {recomputed && <HashRow label="Digest recomputed from the stored commitments" source="this browser"><Badge tone={recomputed === a.bidDigest ? "success" : "danger"}>{recomputed === a.bidDigest ? "matches" : "DOES NOT MATCH"}</Badge></HashRow>}
        {bids.map((b) => <HashRow key={b.index} label={`Bid ${b.index} · ${b.bidder} · deposit ${b.depositStatus}`} value={b.commitment} source="contract" />)}
      </section>

      <section className="panel">
        <h2>3 · Settlement request</h2>
        {!requested && <p className="small muted">Not requested yet.</p>}
        {requested && (
          <>
            <div className="row"><strong>Attempt {a.activeAttempt} of {Number(cfg.maxAttempts)}</strong>{accepted ? <Badge tone="success">accepted</Badge> : a.attemptFailed ? <Badge tone="danger">no result</Badge> : <Badge tone="info">running</Badge>}</div>
            <HashRow label="Request ID (binds digest, count, attempt and config)" value={a.activeRequestId} source="contract" />
            <HashRow label="Requested at · deadline" source="contract"><span className="num">{fmtTime(a.attemptStartedAt)} · {fmtTime(a.settlementDeadline)}</span></HashRow>
            {a.lastError && <HashRow label="Last failed run" source="contract"><span className="small">{a.lastError}</span></HashRow>}
            <p className="small muted">The contract accepts a result only as the answer to this exact request, from the solver it called itself, and only if every binding (request, digest, count, key, code hash, config) equals its own state.</p>
          </>
        )}
      </section>

      <section className="panel">
        <h2>4 · Code and key identity</h2>
        <HashRow label="Solver code hash (the only build OutLayer may run)" value={cfg.solverCodeHash} source="contract" />
        <HashRow label="Config hash" value={cfg.configHash} source="contract" />
        <HashRow label="Key ID (SHA-256 of SPKI)" value={a.keyId} source="contract" />
        {key && <HashRow label="Sealed key blob hash" value={key.sealedBlobHash} source="contract" />}
        <HashRow label="Contract (the solver's only allowed caller)" source="config"><AddressLink address={cfg.contract} /></HashRow>
        <HashRow label="Protocol address of the contract" value={cfg.contractAddress} source="contract" />
        <HashRow label="TEE runtime" source="config"><AddressLink address={cfg.outlayer} /></HashRow>
        <HashRow label="Attestation" source="viewer"><Badge tone="neutral">not checked</Badge> <span className="small muted">This viewer does not verify vendor attestation.</span></HashRow>
      </section>

      <section className="panel">
        <h2>5 · Deposits</h2>
        {bids.length === 0 && <p className="small muted">No deposits were locked.</p>}
        {bids.map((b) => <HashRow key={b.index} label={`Bid ${b.index} · ${b.bidder}`} source="contract"><Badge tone={b.depositStatus === "Locked" ? "info" : b.depositStatus === "Refunded" ? "success" : b.depositStatus === "Consumed" ? "accent" : "danger"}>{b.depositStatus}</Badge> <span className="small muted">{formatMoney(a.depositUnits)}</span></HashRow>)}
        {view.state === "Cancelled" && <HashRow label="Asset" source="contract"><span>{a.returnedAssetClaimed ? "Returned to the seller" : "Waiting for the seller to take it back"}</span></HashRow>}
      </section>
    </div>
  );
}
