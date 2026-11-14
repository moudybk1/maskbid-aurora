"use client";
import { useParams } from "next/navigation";
import { AddressLink, Alert, Badge, HashRow, SyncLine, TxLink, TxStatus, UriLink } from "@/components/ui";
import { assetEvents, auctionEvents, contracts, fetchMetadata, readAsset, readAssetBalance } from "@/lib/client";
import { COPY } from "@/lib/copy";
import { useChainData } from "@/lib/data";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { write } from "@/lib/write";

const STATUS = ["Pending review", "Verified", "Rejected"] as const;

export default function AssetPage() {
  const tokenId = BigInt(useParams<{ id: string }>().id);
  const { address } = useWallet();
  const { state: tx, run } = useTx();
  const { data, error, syncedAt, refresh } = useChainData(async () => {
    const a = await readAsset(tokenId);
    const [meta, balance, registered, verified, rejected, redeemed, listed] = await Promise.all([
      fetchMetadata(a.metadataURI, a.metadataHash), address ? readAssetBalance(address, tokenId) : 0n,
      assetEvents("AssetRegistered", { tokenId }), assetEvents("AssetVerified", { tokenId }), assetEvents("AssetRejected", { tokenId }), assetEvents("AssetRedeemed", { tokenId }),
      auctionEvents("AuctionCreated", { tokenId }),
    ]);
    return { a, meta, balance, history: [...registered, ...verified, ...rejected, ...redeemed].sort((x, y) => Number(x.blockNumber - y.blockNumber)), listed };
  }, [tokenId, address, tx.status], 8000);
  if (error) return <Alert tone="error" title="Asset unavailable">{error}</Alert>;
  if (!data) return <p className="muted" aria-busy="true">Loading…</p>;
  const { a, meta, balance, history, listed } = data;
  const redeem = () => run("Redeem token", (c) => write(c, contracts().asset, "redeem", [tokenId])).then(refresh).catch(() => {});

  return (
    <div className="stack reading" style={{ gap: 24 }}>
      <div>
        <div className="row"><span className="caption">Token #{tokenId.toString()}</span><Badge tone={a.status === 1 ? "success" : a.status === 2 ? "danger" : "warning"}>{STATUS[a.status]}</Badge>{a.redeemed && <Badge tone="neutral">Redeemed</Badge>}{meta.data?.isDemo && <Badge tone="neutral">Demo asset</Badge>}</div>
        <h1>{meta.data?.title ?? "Metadata unavailable"}</h1>
        <SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} />
      </div>
      {meta.data?.images?.[0] && <div className="card"><div className="image"><img src={meta.data.images[0]} alt="" /></div></div>}
      <p>{meta.data?.description}</p>
      <section className="panel">
        <h2>Provenance</h2>
        <HashRow label="Issuer" source="contract"><AddressLink address={a.issuer} /></HashRow>
        <HashRow label="Metadata URI" source="contract"><UriLink uri={a.metadataURI} /></HashRow>
        <HashRow label="Metadata hash" value={a.metadataHash} source="contract" />
        <HashRow label="Metadata integrity" source="this browser"><Badge tone={meta.integrity === "verified" ? "success" : meta.integrity === "mismatch" ? "danger" : "warning"}>{meta.integrity}</Badge></HashRow>
        {a.status !== 0 && <HashRow label="Review digest" value={a.reviewDigest} source="contract" />}
        {history.map((e) => <HashRow key={e.transactionHash + e.eventName} label={e.eventName.replace("Asset", "")} source="event"><TxLink hash={e.transactionHash} /></HashRow>)}
        {listed.map((e) => <HashRow key={e.transactionHash} label={`Listed in auction ${String(e.args.auctionId)}`} source="AuctionCreated event"><a href={`/auctions/${String(e.args.auctionId)}`}>Open lot {String(e.args.auctionId)}</a></HashRow>)}
      </section>
      {address && balance === 1n && !a.redeemed && (
        <section className="panel">
          <h2>Redeem</h2>
          <p className="small">{COPY.redeem}</p>
          <button type="button" className="btn btn-danger" onClick={() => { if (confirm(COPY.redeem)) redeem(); }}>Burn this token</button>
        </section>
      )}
      {address && balance === 0n && a.minted && !a.redeemed && <p className="small muted">This wallet does not hold the unit (it may be escrowed in an auction or owned by someone else).</p>}
      <TxStatus state={tx} />
    </div>
  );
}
