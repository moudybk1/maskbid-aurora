"use client";
import { GetStarted } from "@/components/GetStarted";
import { Badge, SyncLine } from "@/components/ui";
import { fetchMetadata, listAssets, readEligible } from "@/lib/client";
import { useChainData } from "@/lib/data";
import { useWallet } from "@/lib/wallet";

const STATUS = ["Pending review", "Verified", "Rejected"] as const;

export default function Sell() {
  const { address } = useWallet();
  const { data, error, syncedAt, refresh, loading } = useChainData(async () => {
    if (!address) return undefined;
    const [eligible, all] = await Promise.all([readEligible(address), listAssets()]);
    const assets = await Promise.all(all.filter(({ a }) => a.issuer === address).map(async ({ tokenId, a }) => ({ tokenId, a, balance: a.owner === address ? 1n : 0n, title: (await fetchMetadata(a.metadataURI, a.metadataHash)).data?.title })));
    return { eligible, assets };
  }, [address], 8000);

  if (!address) return <div className="stack" style={{ gap: 24 }}><div><h1>Sell</h1><p className="muted">Turn a verified asset into a sealed-bid auction. Bidders compete on price without seeing each other&apos;s numbers.</p></div><GetStarted fixed="sell" /></div>;
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="row between">
        <div><h1>Sell</h1><p className="muted">Turn a verified asset into a sealed-bid auction. Bidders compete on price without seeing each other&apos;s numbers.</p></div>
        <a className="btn" href="/assets/new" aria-disabled={data?.eligible === false}>Register asset</a>
      </div>
      <GetStarted fixed="sell" />
      <div className="row between"><h2 style={{ margin: 0 }}>Your assets</h2><SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} /></div>
      {loading && <p className="muted" aria-busy="true">Loading your assets…</p>}
      {data && data.assets.length === 0 && <p className="muted">Assets you register appear here with their review status and the next thing to do.</p>}
      {data && data.assets.length > 0 && (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Token</th><th>Title</th><th>Status</th><th>Held</th><th>Next step</th></tr></thead>
          <tbody>
            {data.assets.map(({ tokenId, a, balance, title }) => (
              <tr key={tokenId.toString()}>
                <td className="num">#{tokenId.toString()}</td>
                <td><a href={`/assets/${tokenId}`}>{title ?? "(metadata unavailable)"}</a></td>
                <td><Badge tone={a.status === 1 ? "success" : a.status === 2 ? "danger" : "warning"}>{a.redeemed ? "Redeemed" : STATUS[a.status]}</Badge></td>
                <td>{balance === 1n ? "in your account" : a.minted ? "escrowed / transferred" : "not minted"}</td>
                <td>{a.status === 1 && balance === 1n && !a.redeemed ? <a className="btn btn-sm" href={`/auctions/new?asset=${tokenId}`}>Create auction</a>
                  : a.status === 0 ? <span className="small muted">Waiting for a verifier</span>
                  : a.status === 2 ? <a className="small" href="/assets/new">Register a new draft</a>
                  : a.minted && balance === 0n && !a.redeemed ? <a className="small" href={`/assets/${tokenId}`}>In an auction or transferred</a> : <span className="small muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </div>
  );
}
