"use client";
import { AddressLink, Alert, HashRow } from "@/components/ui";
import { readConfig } from "@/lib/client";
import { CHAIN_ID, deployment, RPC_URL } from "@/lib/config";
import { COPY } from "@/lib/copy";
import { useChainData } from "@/lib/data";
import { fmtDuration } from "@/lib/format";

export default function ConfigPage() {
  const { data: cfg, error } = useChainData(readConfig, [], 60000);
  if (!deployment) return <Alert tone="error" title="No deployment">No deployments file for chain {CHAIN_ID}.</Alert>;
  const local = deployment.nearAdapterAccount === "local-mock-adapter";
  return (
    <div className="reading stack">
      <h1>Deployment</h1>
      {local && <Alert tone="warning" title="Local mock adapter">{COPY.localAdapter}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <section className="panel">
        <HashRow label="Chain" source="env"><span className="mono">{CHAIN_ID} · {RPC_URL}</span></HashRow>
        <HashRow label="Profile" source="contract"><span>{cfg?.profile ?? deployment.profile}</span></HashRow>
        <HashRow label="Auction contract" source="deployments"><AddressLink address={deployment.auction} /></HashRow>
        <HashRow label="Asset contract" source="deployments"><AddressLink address={deployment.asset} /></HashRow>
        <HashRow label="Participant registry" source="deployments"><AddressLink address={deployment.registry} /></HashRow>
        <HashRow label="Payment token (mUSDC, 6 decimals)" source="deployments"><AddressLink address={deployment.token} /></HashRow>
        <HashRow label="Callback sender" source="deployments"><AddressLink address={deployment.callbackSender} /></HashRow>
        <HashRow label="NEAR adapter" source="deployments"><span className="mono">{deployment.nearAdapterAccount}</span></HashRow>
        <HashRow label="Solver code hash" value={deployment.solverCodeHash} source="deployments" />
        <HashRow label="Config hash" value={cfg?.configHash ?? deployment.configHash} source="contract" />
        <HashRow label="Deployment block" source="deployments"><span className="num">{deployment.deployBlock}</span></HashRow>
        {cfg && <HashRow label="Limits" source="contract"><span className="small">max {Number(cfg.maxBids)} bids · duration {fmtDuration(cfg.minDurationSeconds)}–{fmtDuration(cfg.maxDurationSeconds)} · claim window {fmtDuration(cfg.claimWindowSeconds)} · settlement grace {fmtDuration(cfg.settlementGraceSeconds)} · attempt timeout {fmtDuration(cfg.attemptTimeoutSeconds)} · {Number(cfg.maxAttempts)} attempts · envelope {Number(cfg.envelopeBytes)} bytes · protocol v{Number(cfg.protocolVersion)}</span></HashRow>}
        {cfg && deployment.configHash !== cfg.configHash && <Alert tone="error" title="Config hash mismatch">The deployments file does not match the contract. Writes should be treated as unsafe until regenerated.</Alert>}
      </section>
    </div>
  );
}
