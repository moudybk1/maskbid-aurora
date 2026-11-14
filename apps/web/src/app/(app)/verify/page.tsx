"use client";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Alert, Badge, ConnectPrompt, TxStatus } from "@/components/ui";
import { readConfig, readEligible, readParticipant } from "@/lib/client";
import { COPY } from "@/lib/copy";
import { useChainData } from "@/lib/data";
import { fmtTime } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";

function Verify() {
  const { address } = useWallet();
  const ret = useSearchParams().get("return");
  const { state: tx, run } = useTx();
  const { data, refresh } = useChainData(async () => {
    const sim = { enabled: (await readConfig()).allowSimulator };
    if (!address) return { sim };
    const [eligible, p] = await Promise.all([readEligible(address), readParticipant(address)]);
    return { sim, eligible, registered: p !== null, verifiedUntil: p?.verifiedUntil, assurance: p?.assurance, revoked: p?.revoked };
  }, [address], 5000);

  // The account registers itself; the contract allows it only on a deployment that accepts simulator assurance.
  const simulate = () => run("Register simulated identity", { method: "register_simulated" }).then(refresh).catch(() => {});
  const safeReturn = ret && ret.startsWith("/") && !ret.startsWith("//") ? ret : undefined;

  return (
    <div className="reading stack">
      <h1>Participant verification</h1>
      <p className="muted">Proof of personhood binds one identity to one account so each auction gets one bid per person. This is not legal KYC. Exits (refunds, claims) never require it.</p>
      {!address && <ConnectPrompt>Verification is bound to the account you connect.</ConnectPrompt>}
      {data && address && (
        <div className="panel stack">
          <div className="row"><strong>Status</strong>{data.eligible ? <Badge tone="success">Verified participant</Badge> : data.registered ? <Badge tone="warning">{data.revoked ? "Revoked" : "Expired"}</Badge> : <Badge tone="neutral">Not registered</Badge>}
            {data.assurance === 2 && <Badge tone="warning">Simulated</Badge>}{data.assurance === 1 && <Badge tone="info">Real provider</Badge>}</div>
          {data.verifiedUntil ? <p className="small">Valid until {fmtTime(data.verifiedUntil)}</p> : null}
          {data.assurance === 2 && <p className="small muted">{COPY.simulator}</p>}
          {data.eligible && <div className="row">{safeReturn ? <a className="btn" href={safeReturn}>Continue where you left off</a> : <a className="btn" href="/auctions">Browse live lots</a>}<a className="btn btn-secondary" href="/sell">Sell an asset</a></div>}
        </div>
      )}
      {data?.sim?.enabled && address && !data.eligible && (
        <div className="panel stack">
          <h3>Simulated verification (demo environment)</h3>
          <p className="small">This demo deployment accepts a simulator assurance level: your account registers itself for 30 days, with an identity derived from the account name. That is one bid per account, not per person, and the badge says &ldquo;Simulated&rdquo;. No World ID proof is involved.</p>
          <button type="button" className="btn" onClick={simulate} disabled={tx.status === "signing" || tx.status === "confirming"}>Register simulated identity</button>
          <TxStatus state={tx} />
        </div>
      )}
      {data && !data.sim?.enabled && address && !data.eligible && <Alert tone="warning" title="Real identity provider not configured">World ID verification is a gate (G-05) that this deployment has not passed. No bypass exists.</Alert>}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<p className="muted">Loading…</p>}><Verify /></Suspense>;
}
