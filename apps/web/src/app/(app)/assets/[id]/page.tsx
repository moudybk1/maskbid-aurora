"use client";
import { useParams } from "next/navigation";
import { AddressLink, Alert, Badge, HashRow, SyncLine, TxStatus, UriLink } from "@/components/ui";
import { fetchMetadata, listAuctions, readAsset } from "@/lib/client";
import { COPY } from "@/lib/copy";
import { useChainData } from "@/lib/data";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

const STATUS = ["Pending review", "Verified", "Rejected"] as const;

export default function AssetPage() {
  const tokenId = BigInt(useParams<{ id: string }>().id);
  const { address } = useWallet();
  const { state: tx, run } = useTx();
  const { data, error, syncedAt, refresh } = useChainData(async () => {
    const a = await readAsset(tokenId);
    const [meta, lots] = await Promise.all([fetchMetadata(a.metadataURI, a.metadataHash), listAuctions()]);
    return { a, meta, balance: address && a.owner === address ? 1n : 0n, listed: lots.filter((l) => l.a.tokenId === tokenId).map((l) => ({ id: Number(l.id) })) };
  }, [tokenId, address, tx.status], 8000);
  if (error) return <Alert tone="error" title="Asset unavailable">{error}</Alert>;
  if (!data) return <p className="muted" aria-busy="true">Loading…</p>;
  const { a, meta, balance, listed } = data;
  const redeem = () => run("Redeem token", { method: "redeem", args: { token_id: tokenId.toString() } }).then(refresh).catch(() => {});

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
        {a.reviewer && <HashRow label={a.status === 2 ? "Rejected by" : "Reviewed by"} source="contract"><AddressLink address={a.reviewer} /></HashRow>}
        {a.status === 1 && <HashRow label="Review digest" value={a.reviewDigest} source="contract" />}
        <HashRow label="Holder" source="contract">{a.redeemed ? <span>Redeemed (burned)</span> : a.inEscrow ? <span>In the auction contract&apos;s escrow</span> : a.owner ? <AddressLink address={a.owner} /> : <span>Not minted</span>}</HashRow>
        {listed.map((l) => <HashRow key={l.id} label={`Listed in auction ${l.id}`} source="contract"><a href={`/auctions/${l.id}`}>Open lot {l.id}</a></HashRow>)}
      </section>
      {address && balance === 1n && !a.redeemed && (
        <section className="panel">
          <h2>Redeem</h2>
          <p className="small">{COPY.redeem}</p>
          <button type="button" className="btn btn-danger" onClick={() => { if (confirm(COPY.redeem)) redeem(); }}>Burn this token</button>
        </section>
      )}
      {address && balance === 0n && a.minted && !a.redeemed && <p className="small muted">This account does not hold the unit (it may be escrowed in an auction or owned by someone else).</p>}
      <TxStatus state={tx} />
    </div>
  );
}
