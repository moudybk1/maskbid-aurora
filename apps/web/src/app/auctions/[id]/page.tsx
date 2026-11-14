"use client";
import { useParams } from "next/navigation";
import { ActionPanel } from "@/components/ActionPanel";
import { AssetArt, Dots } from "@/components/Dots";
import { AddressLink, Alert, Badge, HashRow, SyncLine, TxLink } from "@/components/ui";
import { COPY } from "@/lib/copy";
import { loadAuction, loadBids, useChainData } from "@/lib/data";
import { fmtTime, short } from "@/lib/format";

export default function AuctionDetail() {
  const id = BigInt(useParams<{ id: string }>().id);
  const { data: view, error, syncedAt, refresh } = useChainData(() => loadAuction(id), [id], 5000);
  const { data: bids, refresh: refreshBids } = useChainData(() => loadBids(id), [id, view?.a.bidCount], 10000);
  if (error) return <Alert tone="error" title="Auction unavailable">{error}</Alert>;
  if (!view) return <p aria-busy="true" className="muted">Loading auction from chain…</p>;
  const { a, asset, metadata } = view;
  const refreshAll = () => { refresh(); refreshBids(); };
  const title = metadata?.title ?? `Asset #${a.tokenId.toString()}`;

  return (
    <div className="stack" style={{ gap: 32 }}>
      <div>
        <p className="caption"><a href="/#lots">← All lots</a></p>
        <div className="row" style={{ margin: "12px 0 14px" }}>
          <span className="caption">Lot {id.toString()} · token #{a.tokenId.toString()}{metadata?.category ? ` · ${metadata.category.replace("_", " ")}` : ""}</span>
          <Badge tone={asset.status === 1 ? "success" : "warning"}>{asset.status === 1 ? "Verified asset" : "Unverified"}</Badge>
          {metadata?.isDemo && <Badge tone="neutral">Demo asset</Badge>}
          <Badge tone={view.integrity === "verified" ? "success" : view.integrity === "mismatch" ? "danger" : "warning"}>metadata {view.integrity}</Badge>
        </div>
        <h1 style={{ marginBottom: 8 }}>{title}</h1>
        <SyncLine syncedAt={syncedAt} error={error} onRefresh={refreshAll} />
      </div>

      <div className="detail">
        <div className="stack" style={{ gap: 32 }}>
          <figure className="lot-media" style={{ margin: 0 }}>
            {metadata?.images?.[0] ? <img src={metadata.images[0]} alt={title} /> : (
              <>
                <AssetArt seed={asset.metadataHash} category={metadata?.category} large />
                <figcaption>No pictures registered · drawn from its category and hash {short(asset.metadataHash)}</figcaption>
              </>
            )}
          </figure>

          <div>
            {metadata?.isDemo && <p className="small muted">{COPY.demoAsset}</p>}
            <p className="reading" style={{ fontSize: 17 }}>{metadata?.description ?? "Metadata could not be loaded from the registered URI."}</p>
            <dl className="facts" style={{ marginTop: 20 }}>
              {metadata?.condition && <div className="fact"><dt>Condition</dt><dd>{metadata.condition}</dd></div>}
              <div className="fact"><dt>Seller</dt><dd><AddressLink address={a.seller} /></dd></div>
              <div className="fact"><dt>Issuer</dt><dd><AddressLink address={asset.issuer} /></dd></div>
              <div className="fact"><dt>Reviewed by</dt><dd>{asset.reviewer === "0x0000000000000000000000000000000000000000" ? "—" : <AddressLink address={asset.reviewer} />}</dd></div>
              <div className="fact"><dt>Opens</dt><dd className="num">{fmtTime(a.startTime)}</dd></div>
              <div className="fact"><dt>Closes</dt><dd className="num">{fmtTime(a.endTime)}</dd></div>
              <div className="fact"><dt>Settlement deadline</dt><dd className="num">{fmtTime(a.settlementDeadline)}</dd></div>
            </dl>
            <p className="caption" style={{ marginTop: 12 }}>The reviewer approved metadata and evidence against the review checklist; that is not a guarantee of physical authenticity. <a href={`/assets/${a.tokenId}`}>Asset history and redemption</a></p>
          </div>

          <section className="panel">
            <div className="row between" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Sealed bids</h2><a className="btn btn-secondary btn-sm" href={`/auctions/${id}/evidence`}>Inspect evidence</a></div>
            <p className="small muted">{COPY.privacy} The ordered digest commits to every accepted bid; the solver must process exactly this set. Each row shows that bid&apos;s real 490-byte envelope as dots.</p>
            <HashRow label="Bid count" source="contract"><span className="num">{a.bidCount}</span></HashRow>
            <HashRow label="Ordered digest" value={a.bidDigest} source="contract" />
            <HashRow label="Encryption key ID" value={a.keyId} source="contract" />
            {bids && bids.length > 0 && (
              <div style={{ marginTop: 16 }}>
                {bids.map((b) => (
                  <div className="bid-row" key={b.index}>
                    <span className="num muted">#{b.index}</span>
                    <Dots hex={b.envelope} cols={35} glow label={`Sealed envelope of bid ${b.index}`} />
                    <div style={{ minWidth: 0 }}><AddressLink address={b.bidder} /><div className="caption">commitment {short(b.commitment, 8, 6)} · <TxLink hash={b.txHash} /></div></div>
                    <Badge tone={b.depositStatus === "Locked" ? "info" : b.depositStatus === "Refunded" ? "success" : b.depositStatus === "Consumed" ? "accent" : "danger"}>{b.depositStatus}</Badge>
                  </div>
                ))}
              </div>
            )}
            {bids && bids.length === 0 && <p className="small muted" style={{ marginTop: 12 }}>No bids recorded yet.</p>}
          </section>
        </div>
        <ActionPanel view={view} bids={bids ?? []} refresh={refreshAll} />
      </div>
    </div>
  );
}
