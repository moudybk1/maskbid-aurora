"use client";
import { AddressLink, Alert, HashRow } from "@/components/ui";
import { readConfig } from "@/lib/client";
import { NETWORK, RPC_URL } from "@/lib/config";
import { useChainData } from "@/lib/data";
import { fmtDuration, formatNear } from "@/lib/format";

export default function ConfigPage() {
  const { data: cfg, error } = useChainData(readConfig, [], 60000);
  return (
    <div className="reading stack">
      <h1>Deployment</h1>
      {error && <Alert tone="error">{error}</Alert>}
      {cfg && (
        <section className="panel">
          <HashRow label="Network" source="env"><span className="mono">{NETWORK} · {RPC_URL}</span></HashRow>
          <HashRow label="Profile" source="contract"><span>{cfg.profile}</span></HashRow>
          <HashRow label="MaskBid contract (registry, assets, auctions)" source="contract"><AddressLink address={cfg.contract} /></HashRow>
          <HashRow label="Protocol address and domain number" source="contract"><span className="mono">{cfg.contractAddress} · {cfg.chainId.toString()}</span></HashRow>
          <HashRow label="Payment token (mUSDC, 6 decimals)" source="contract"><AddressLink address={cfg.token} /></HashRow>
          <HashRow label="Admin · registrar · verifier" source="contract"><span className="mono">{cfg.admin} · {cfg.registrar} · {cfg.verifier}</span></HashRow>
          <HashRow label="TEE runtime (OutLayer)" source="contract"><AddressLink address={cfg.outlayer} /></HashRow>
          <HashRow label="Solver code hash" value={cfg.solverCodeHash} source="contract" />
          <HashRow label="Solver module" source="contract"><a href={cfg.wasmUrl} target="_blank" rel="noreferrer" className="small">{cfg.wasmUrl}</a></HashRow>
          <HashRow label="Config hash" value={cfg.configHash} source="contract" />
          <HashRow label="Cost of one TEE run" source="contract"><span className="small">{formatNear(cfg.executionDeposit)} NEAR attached by the caller; the unused part is returned</span></HashRow>
          <HashRow label="Limits" source="contract"><span className="small">max {Number(cfg.maxBids)} bids · duration {fmtDuration(cfg.minDurationSeconds)}–{fmtDuration(cfg.maxDurationSeconds)} · claim window {fmtDuration(cfg.claimWindowSeconds)} · settlement grace {fmtDuration(cfg.settlementGraceSeconds)} · attempt timeout {fmtDuration(cfg.attemptTimeoutSeconds)} · {Number(cfg.maxAttempts)} attempts · envelope {Number(cfg.envelopeBytes)} bytes · protocol v{Number(cfg.protocolVersion)}</span></HashRow>
          <HashRow label="Read model" source="this app"><span className="small">None. Every page reads the contract directly.</span></HashRow>
        </section>
      )}
    </div>
  );
}
