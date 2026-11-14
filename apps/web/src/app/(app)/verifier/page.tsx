"use client";
import { useState } from "react";
import { sha256, stringToBytes, type Hex } from "viem";
import { reviewDigest } from "@maskbid/protocol";
import { AddressLink, Alert, Badge, Empty, HashRow, SyncLine, TxStatus, UriLink } from "@/components/ui";
import { addressOf, fetchMetadata, listAssets, readConfig, type AssetStruct } from "@/lib/client";
import { useChainData } from "@/lib/data";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

export default function VerifierQueue() {
  const { address } = useWallet();
  const { state: tx, run } = useTx();
  const [open, setOpen] = useState<bigint>();
  const [reason, setReason] = useState("Metadata complete; images consistent with description; demo declaration present.");
  const { data, error, syncedAt, refresh, loading } = useChainData(async () => {
    if (!address) return undefined;
    const [cfg, assets, reviewer] = await Promise.all([readConfig(), listAssets(), addressOf(address)]);
    const pending = assets.filter(({ a }) => a.status === 0).reverse();
    const items: { tokenId: bigint; a: AssetStruct; meta: Awaited<ReturnType<typeof fetchMetadata>> }[] = await Promise.all(pending.map(async ({ tokenId, a }) => ({ tokenId, a, meta: await fetchMetadata(a.metadataURI, a.metadataHash) })));
    return { isVerifier: cfg.verifier === address, items, cfg, reviewer };
  }, [address, tx.status], 8000);

  const decide = (tokenId: bigint, metadataHash: Hex, decision: 1 | 2) => {
    if (!address || !data) return;
    // The digest binds the decision to this deployment, the token, the reviewer and the frozen metadata.
    const digest = reviewDigest({ chainId: data.cfg.chainId, assetContract: data.cfg.contractAddress, tokenId, reviewer: data.reviewer, metadataHash, decision, reason });
    const token_id = tokenId.toString();
    const call = decision === 1 ? { label: "Verify and mint", method: "verify_and_mint", args: { token_id, review_digest: digest } } : { label: "Reject asset", method: "reject_asset", args: { token_id, reason_hash: sha256(stringToBytes(reason.normalize("NFC"))) } };
    run(call.label, call).then(() => { setOpen(undefined); refresh(); }).catch(() => {});
  };

  if (!address) return <div className="reading"><h1>Verifier queue</h1><Alert tone="info" title="Connect the verifier account">Review decisions are signed on chain by the account that holds the verifier role.</Alert></div>;
  if (data && !data.isVerifier) return <div className="reading"><h1>Verifier queue</h1><Alert tone="warning" title="Not a verifier">This account is not the verifier of this deployment.</Alert></div>;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div><h1>Verifier queue</h1><p className="muted">Approve mints exactly one unit to the issuer and pins your review digest. You cannot review your own registrations.</p></div>
      <SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} />
      <TxStatus state={tx} />
      {loading && <p className="muted" aria-busy="true">Loading queue…</p>}
      {data && data.items.length === 0 && <Empty title="Nothing awaiting review" />}
      {data?.items.map(({ tokenId, a, meta }) => {
        const self = a.issuer === address;
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
                <HashRow label="Frozen metadata" source="URI fetch"><UriLink uri={a.metadataURI} /></HashRow>
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
