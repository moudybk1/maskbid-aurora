"use client";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert, Badge, ConnectPrompt, TxLink } from "@/components/ui";
import { publicClient, readEligible, readParticipant } from "@/lib/client";
import { COPY } from "@/lib/copy";
import { useChainData } from "@/lib/data";
import { fmtTime } from "@/lib/format";
import { useWallet } from "@/lib/wallet";

function Verify() {
  const { address } = useWallet();
  const ret = useSearchParams().get("return");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ txHash?: string; error?: string }>();
  const { data, refresh } = useChainData(async () => {
    const sim = await fetch("/api/identity/simulate").then((r) => r.json()).catch(() => ({ enabled: false }));
    if (!address) return { sim };
    const [eligible, p] = await Promise.all([readEligible(address), readParticipant(address)]);
    return { sim, eligible, uniquenessId: p[0], verifiedUntil: p[1], assurance: p[2], revoked: p[3] };
  }, [address], 5000);

  const simulate = async () => {
    setBusy(true); setResult(undefined);
    try {
      const r = await fetch("/api/identity/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: address }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail ?? "Simulation refused");
      await publicClient.waitForTransactionReceipt({ hash: j.txHash });
      setResult({ txHash: j.txHash });
      refresh();
    } catch (e) { setResult({ error: (e as Error).message }); } finally { setBusy(false); }
  };
  const safeReturn = ret && ret.startsWith("/") && !ret.startsWith("//") ? ret : undefined;

  return (
    <div className="reading stack">
      <h1>Participant verification</h1>
      <p className="muted">Proof of personhood binds one identity to one wallet so each auction gets one bid per person. This is not legal KYC. Exits (refunds, claims) never require it.</p>
      {!address && <ConnectPrompt>Verification is bound to the wallet you connect.</ConnectPrompt>}
      {data && address && (
        <div className="panel stack">
          <div className="row"><strong>Status</strong>{data.eligible ? <Badge tone="success">Verified participant</Badge> : data.uniquenessId && data.uniquenessId !== "0x0000000000000000000000000000000000000000000000000000000000000000" ? <Badge tone="warning">{data.revoked ? "Revoked" : "Expired"}</Badge> : <Badge tone="neutral">Not registered</Badge>}
            {data.assurance === 2 && <Badge tone="warning">Simulated</Badge>}{data.assurance === 1 && <Badge tone="info">Real provider</Badge>}</div>
          {data.verifiedUntil ? <p className="small">Valid until {fmtTime(data.verifiedUntil)}</p> : null}
          {data.assurance === 2 && <p className="small muted">{COPY.simulator}</p>}
          {data.eligible && <div className="row">{safeReturn ? <a className="btn" href={safeReturn}>Continue where you left off</a> : <a className="btn" href="/#lots">Browse live lots</a>}<a className="btn btn-secondary" href="/sell">Sell an asset</a></div>}
        </div>
      )}
      {data?.sim?.enabled && address && !data.eligible && (
        <div className="panel stack">
          <h3>Simulated verification (demo environment)</h3>
          <p className="small">This deployment accepts a simulator assurance level. The server derives an opaque uniqueness ID from your wallet and registers it with the restricted registrar key. No World ID proof is involved; the badge will say &ldquo;Simulated&rdquo;.</p>
          <button type="button" className="btn" onClick={simulate} disabled={busy}>{busy ? "Registering…" : "Register simulated identity"}</button>
          {result?.txHash && <Alert tone="success" title="Registered">Receipt: <TxLink hash={result.txHash} /></Alert>}
          {result?.error && <Alert tone="error" title="Not registered">{result.error}</Alert>}
        </div>
      )}
      {data && !data.sim?.enabled && address && !data.eligible && <Alert tone="warning" title="Real identity provider not configured">World ID verification is a gate (G-05) that this deployment has not passed. No bypass exists.</Alert>}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<p className="muted">Loading…</p>}><Verify /></Suspense>;
}
