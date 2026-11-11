"use client";
import { useState } from "react";
import { keccak256, sha256, stringToBytes, type Hex } from "viem";
import { reviewDigest } from "@maskbid/protocol";
import { AddressLink, Alert, Badge, Empty, HashRow, SyncLine, TxStatus } from "@/components/ui";
import { assetEvents, contracts, fetchMetadata, publicClient, readAsset } from "@/lib/client";
import { CHAIN_ID } from "@/lib/config";
import { useChainData } from "@/lib/data";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { write } from "@/lib/write";

export default function VerifierQueue() {
  const { address } = useWallet();
  const { state: tx, run } = useTx();
  const [open, setOpen] = useState<bigint>();
  const [reason, setReason] = useState("Metadata complete; images consistent with description; demo declaration present.");
  const { data, error, syncedAt, refresh, loading } = useChainData(async () => {
    if (!address) return undefined;
    const { asset } = contracts();
    const isVerifier = await publicClient.readContract({ ...asset, functionName: "hasRole", args: [keccak256(stringToBytes("VERIFIER_ROLE")), address] });
    const logs = await assetEvents("AssetRegistered");
    const items = (await Promise.all(logs.map(async (l) => {
      const tokenId = l.args.tokenId as bigint;
      const a = await readAsset(tokenId);
      if (a.status !== 0) return undefined;
      return { tokenId, a, meta: await fetchMetadata(a.metadataURI, a.metadataHash), block: l.blockNumber };
    }))).filter(Boolean) as { tokenId: bigint; a: Awaited<ReturnType<typeof readAsset>>; meta: Awaited<ReturnType<typeof fetchMetadata>>; block: bigint }[];
    return { isVerifier, items };
  }, [address, tx.status], 8000);

  const decide = (tokenId: bigint, metadataHash: Hex, decision: 1 | 2) => {
    if (!address) return;
    const digest = reviewDigest({ chainId: BigInt(CHAIN_ID), assetContract: contracts().asset.address, tokenId, reviewer: address, metadataHash, decision, reason });
    const call = decision === 1 ? ["Verify and mint", "verifyAndMint", [tokenId, digest]] as const : ["Reject asset", "rejectAsset", [tokenId, sha256(stringToBytes(reason.normalize("NFC")))]] as const;
    run(call[0], (c) => write(c, contracts().asset, call[1], [...call[2]])).then(() => { setOpen(undefined); refresh(); }).catch(() => {});
  };

  if (!address) return <div className="reading"><h1>Verifier queue</h1><Alert tone="info" title="Connect the verifier wallet">Review decisions are signed on chain by a wallet holding VERIFIER_ROLE.</Alert></div>;
  if (data && !data.isVerifier) return <div className="reading"><h1>Verifier queue</h1><Alert tone="warning" title="Not a verifier">This wallet does not hold VERIFIER_ROLE on the asset contract.</Alert></div>;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div><h1>Verifier queue</h1><p className="muted">Approve mints exactly one unit to the issuer and pins your review digest. You cannot review your own registrations.</p></div>
      <SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} />
      <TxStatus state={tx} />
      {loading && <p className="muted" aria-busy="true">Loading queue…</p>}
      {data && data.items.length === 0 && <Empty title="Nothing awaiting review" />}
      {data?.items.map(({ tokenId, a, meta }) => {
        const self = a.issuer.toLowerCase() === address.toLowerCase();
        const blocked = self || meta.integrity !== "verified";
        return (
          <section className="panel" key={tokenId.toString()}>
            <div className="row between">
              <div className="row"><strong>Token #{tokenId.toString()}</strong><span>{meta.data?.title ?? "(metadata unavailable)"}</span><Badge tone={meta.integrity === "verified" ? "success" : "danger"}>metadata {meta.integrity}</Badge>{meta.data?.isDemo && <Badge tone="neutral">demo</Badge>}</div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(open === tokenId ? undefined : tokenId)} aria-expanded={open === tokenId}>{open === tokenId ? "Close" : "Review"}</button>
            </div>
            {open === tokenId && (
              <div className="stack" style={{ marginTop: 12 }}>
                <HashRow label="Issuer" source="contract"><AddressLink address={a.issuer} /></HashRow>
                <HashRow label="Metadata hash" value={a.metadataHash} source="contract" />
                <HashRow label="Frozen metadata" source="URI fetch"><a href={a.metadataURI} target="_blank" rel="noreferrer" className="mono">{a.metadataURI}</a></HashRow>
                {meta.data && <dl className="kv"><dt>Category</dt><dd>{meta.data.category}</dd><dt>Condition</dt><dd>{meta.data.condition}</dd><dt>Description</dt><dd>{meta.data.description}</dd><dt>Images</dt><dd>{meta.data.images?.length ? meta.data.images.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" style={{ display: "block" }}>{u}</a>) : "none"}</dd></dl>}
                {meta.integrity === "mismatch" && <Alert tone="error" title="Integrity error">The fetched metadata does not hash to the on-chain value. Do not approve.</Alert>}
                {self && <Alert tone="warning" title="Self-review blocked">You registered this asset; the contract rejects issuer = reviewer.</Alert>}
                <label className="field"><span style={{ fontWeight: 500 }}>Review reason (private; only its hash goes on chain)</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                <div className="row">
                  <button type="button" className="btn" disabled={blocked || !reason.trim()} onClick={() => decide(tokenId, a.metadataHash, 1)}>Approve and mint</button>
                  <button type="button" className="btn btn-danger" disabled={self || !reason.trim()} onClick={() => decide(tokenId, a.metadataHash, 2)}>Reject</button>
                </div>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
