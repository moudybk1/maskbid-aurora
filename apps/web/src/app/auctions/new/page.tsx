"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { decodeEventLog, keccak256, stringToBytes, type Hex } from "viem";
import { auctionAbi } from "@maskbid/contracts";
import { formatMoney, InvalidAmount, KEY_STATUSES, parseUnits6 } from "@maskbid/protocol";
import { Alert, AmountInput, ConnectPrompt, Field, Money, TxStatus } from "@/components/ui";
import { auctionEvents, chainNow, contracts, publicClient, readAsset, readAssetBalance, readConfig, readEligible, readKeyRecord } from "@/lib/client";
import { useChainData } from "@/lib/data";
import { fmtDuration, fmtTime } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { write } from "@/lib/write";

const DURATIONS = [180, 600, 1800, 3600, 21600, 86400, 604800];

function CreateAuction() {
  const router = useRouter();
  const tokenId = BigInt(useSearchParams().get("asset") ?? "0");
  const { address } = useWallet();
  const { state: tx, run } = useTx();
  const [reserve, setReserve] = useState("100");
  const [deposit, setDeposit] = useState("10");
  const [startMode, setStartMode] = useState<"now" | "at">("now");
  const [startAt, setStartAt] = useState("");
  const [duration, setDuration] = useState(180);
  const [keyId, setKeyId] = useState<Hex>();
  const [formError, setFormError] = useState<string>();
  const [step, setStep] = useState<"params" | "review">("params");

  const { data, refresh } = useChainData(async () => {
    if (!address) return undefined;
    const [cfg, asset, balance, eligible, now, keyLogs] = await Promise.all([readConfig(), readAsset(tokenId), readAssetBalance(address, tokenId), readEligible(address), chainNow(), auctionEvents("KeyRequested", { owner: address })]);
    const keys = (await Promise.all(keyLogs.map((l) => readKeyRecord(l.args.keyRequestId as Hex)))).filter((k) => k.status === 2);
    const approved = await publicClient.readContract({ ...contracts().asset, functionName: "isApprovedForAll", args: [address, contracts().auction.address] });
    return { cfg, asset, balance, eligible, now, keys, approved };
  }, [address, tokenId, tx.status], 4000);
  if (!address) return <div className="form stack"><h1>Create auction</h1><ConnectPrompt>Creating an auction needs the seller wallet that holds the verified token.</ConnectPrompt></div>;
  if (!data) return <p aria-busy="true" className="muted">Loading…</p>;
  const { cfg, asset, balance, eligible, now, keys, approved } = data;
  const allowedDurations = DURATIONS.filter((d) => BigInt(d) >= cfg.minDurationSeconds && BigInt(d) <= cfg.maxDurationSeconds);
  const effectiveDuration = allowedDurations.includes(duration) ? duration : allowedDurations[0];
  const selectedKey = keys.find((k) => k.keyId === keyId) ?? keys[0];
  const ready = asset.status === 1 && !asset.redeemed && balance === 1n && eligible;

  const prepareKey = () => run("Prepare auction key", (c) => write(c, contracts().auction, "prepareAuctionKey", [keccak256(stringToBytes(`${address}-${Date.now()}`))])).then(refresh).catch(() => {});

  const review = () => {
    try {
      const r = parseUnits6(reserve), d = parseUnits6(deposit);
      if (d === 0n || r < d) throw new InvalidAmount("Deposit must be greater than 0 and at most the reserve.");
      if (startMode === "at" && (!startAt || BigInt(Math.floor(new Date(startAt).getTime() / 1000)) < now)) throw new InvalidAmount("Start time must be in the future (chain time).");
      if (!selectedKey) throw new InvalidAmount("Prepare an auction key first.");
      setFormError(undefined); setStep("review");
    } catch (e) { setFormError((e as Error).message); }
  };

  const publish = async () => {
    const { asset: assetC, auction } = contracts();
    try {
      if (!approved) await run("Approve asset escrow", (c) => write(c, assetC, "setApprovalForAll", [auction.address, true]));
      const start = startMode === "now" ? 0n : BigInt(Math.floor(new Date(startAt).getTime() / 1000));
      // "start now": the contract starts at the mined block, so leave 60 s for signing + mining (capped at the maximum)
      const span = BigInt(effectiveDuration) + 60n;
      const end = start === 0n ? await chainNow() + (span < cfg.maxDurationSeconds ? span : cfg.maxDurationSeconds) : start + BigInt(effectiveDuration);
      const receipt = await run("Create auction", (c) => write(c, auction, "createAuction", [tokenId, parseUnits6(reserve), parseUnits6(deposit), start, end, selectedKey!.keyId]));
      const ev = receipt.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, data: l.data, topics: l.topics }); } catch { return undefined; } }).find((e) => e?.eventName === "AuctionCreated");
      const id = (ev?.args as { auctionId?: bigint } | undefined)?.auctionId;
      router.push(id !== undefined ? `/auctions/${id}` : "/");
    } catch {}
  };

  return (
    <div className="form stack" style={{ gap: 20 }}>
      <div><p className="caption"><a href="/sell">← Sell</a></p><h1>Create auction</h1><p className="muted">Token #{tokenId.toString()} is escrowed only when you publish. Parameters become immutable after that.</p></div>

      <section className="panel"><h3>1 · Asset</h3>
        {ready ? <Alert tone="success" title="Ready to list">Verified, unredeemed, and held by this wallet.</Alert> : <Alert tone="warning" title="Not ready">{!eligible ? "This wallet is not a verified participant. " : ""}{asset.status !== 1 ? "The asset is not verified. " : ""}{balance !== 1n ? "This wallet does not hold the token. " : ""}{asset.redeemed ? "The token was redeemed." : ""}</Alert>}
      </section>

      <section className="panel"><h3>2 · Private auction key</h3>
        <p className="small muted">A fresh RSA-2048 key pair is prepared per auction; the public key is pinned on chain before any bid. {cfg.nearAdapterAccount === "local-mock-adapter" ? "On this deployment the local mock adapter generates it (not a TEE)." : "Generated inside the solver TEE via the NEAR adapter."}</p>
        {keys.length > 0 ? (
          <Field id="key" label="Ready key"><select id="key" value={selectedKey?.keyId} onChange={(e) => setKeyId(e.target.value as Hex)}>{keys.map((k) => <option key={k.keyId} value={k.keyId}>{k.keyId.slice(0, 18)}… · {KEY_STATUSES[k.status]}</option>)}</select></Field>
        ) : <p className="small">No ready key for this wallet yet.</p>}
        <button type="button" className="btn btn-secondary" onClick={prepareKey} disabled={!eligible || tx.status === "signing" || tx.status === "confirming"}>Prepare new key</button>
        {tx.label === "Prepare auction key" && tx.status === "success" && keys.length === 0 && <p className="small muted" aria-live="polite">Key requested. Waiting for the adapter callback (status refreshes automatically)…</p>}
      </section>

      {step === "params" && (
        <section className="panel"><h3>3 · Terms and schedule</h3>
          <AmountInput id="reserve" label="Reserve price (public minimum)" value={reserve} onChange={setReserve} />
          <AmountInput id="deposit" label="Fixed deposit per bidder" value={deposit} onChange={setDeposit} help="Must be at most the reserve. The winner pays reserve-or-more minus this deposit." />
          <Field id="start" label="Start">
            <div className="row">
              <label className="checkbox"><input type="radio" name="start" checked={startMode === "now"} onChange={() => setStartMode("now")} /> Immediately</label>
              <label className="checkbox"><input type="radio" name="start" checked={startMode === "at"} onChange={() => setStartMode("at")} /> At</label>
              <input id="start" type="datetime-local" className="input" style={{ width: "auto" }} value={startAt} onChange={(e) => setStartAt(e.target.value)} disabled={startMode !== "at"} />
            </div>
          </Field>
          <Field id="duration" label="Duration" help={`Profile ${cfg.profile}: ${fmtDuration(cfg.minDurationSeconds)} to ${fmtDuration(cfg.maxDurationSeconds)}`}>
            <select id="duration" value={effectiveDuration} onChange={(e) => setDuration(Number(e.target.value))}>{allowedDurations.map((d) => <option key={d} value={d}>{fmtDuration(d)}</option>)}</select>
          </Field>
          {formError && <Alert tone="error">{formError}</Alert>}
          <button type="button" className="btn" onClick={review} disabled={!ready}>Review terms</button>
        </section>
      )}

      {step === "review" && (
        <section className="panel"><h3>4 · Review and publish</h3>
          <dl className="kv">
            <dt>Reserve</dt><dd><Money units={parseUnits6(reserve)} /></dd>
            <dt>Deposit</dt><dd><Money units={parseUnits6(deposit)} /></dd>
            <dt>Starts</dt><dd>{startMode === "now" ? "Immediately when published" : fmtTime(BigInt(Math.floor(new Date(startAt).getTime() / 1000)))}</dd>
            <dt>Duration</dt><dd>{fmtDuration(effectiveDuration)}</dd>
            <dt>Rules</dt><dd className="small">First price, highest valid bid ≥ reserve wins, ties to the earliest bid. Winner pays within {fmtDuration(cfg.claimWindowSeconds)} or forfeits the deposit to you. Delivery is the token only.</dd>
            <dt>Key</dt><dd className="mono">{selectedKey?.keyId.slice(0, 18)}…</dd>
          </dl>
          {!approved && <p className="small muted">You will first approve the auction contract as operator for your asset token (one transaction), then publish (second transaction).</p>}
          <div className="row"><button type="button" className="btn btn-secondary" onClick={() => setStep("params")}>Back</button><button type="button" className="btn" onClick={publish} disabled={tx.status === "signing" || tx.status === "confirming"}>{approved ? "Publish auction" : "Approve and publish"}</button></div>
          <p className="caption">Seller cancellation is possible only while no bid exists. Deposit {formatMoney(parseUnits6(deposit))} applies to every bidder.</p>
        </section>
      )}
      <TxStatus state={tx} />
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<p className="muted">Loading…</p>}><CreateAuction /></Suspense>;
}
