"use client";
import { useState } from "react";
import { bytesToHex, hexToBytes } from "viem";
import { encryptBid, formatMoney, InvalidAmount, parseUnits6 } from "@maskbid/protocol";
import { addressOf, readAuction, readBid, readBidIndex, readConfig, readKeyById } from "@/lib/client";
import { COPY } from "@/lib/copy";
import type { AuctionView } from "@/lib/data";
import { fmtDuration } from "@/lib/format";
import { describeError } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { bidCall, write } from "@/lib/write";
import { Alert, AmountInput, Modal, Money, TxLink } from "./ui";

type Step = "amount" | "confirm" | "progress" | "done";
type Stage = "encrypt" | "bid-sign" | "bid-confirm" | "recorded";
const STAGES: [Stage, string][] = [
  ["encrypt", "Sealing the bid in this browser"], ["bid-sign", "Signing the deposit transfer"], ["bid-confirm", "Bid confirming"], ["recorded", "Recorded on chain"],
];

export function BidDialog({ view, claimWindow, onClose, onRecorded }: { view: AuctionView; claimWindow: bigint; onClose: () => void; onRecorded: () => void }) {
  const { client, address } = useWallet();
  const [step, setStep] = useState<Step>("amount");
  const [input, setInput] = useState("");
  const [amount, setAmount] = useState<bigint>();
  const [error, setError] = useState<string>();
  const [ack, setAck] = useState(false);
  const [stage, setStage] = useState<Stage>("encrypt");
  const [stageState, setStageState] = useState<Record<string, "done" | "active" | "error">>({});
  const [hashes, setHashes] = useState<{ bid?: string }>({});
  const [integrity, setIntegrity] = useState<"ok" | "mismatch">();
  const { a } = view;

  const validate = () => {
    try {
      const v = parseUnits6(input);
      if (v < a.reserveUnits) { setError(`Bid must be at least the reserve of ${formatMoney(a.reserveUnits)}.`); return; }
      setAmount(v); setError(undefined); setStep("confirm");
    } catch (e) {
      setError(e instanceof InvalidAmount ? e.message : String(e));
    }
  };

  const submit = async () => {
    if (!client || !address || amount === undefined) return;
    setStep("progress"); setError(undefined);
    const mark = (s: Stage, st: "done" | "active" | "error") => { setStage(s); setStageState((p) => ({ ...p, [s]: st })); };
    try {
      mark("encrypt", "active");
      const [fresh, cfg, bidder] = await Promise.all([readAuction(view.id), readConfig(), addressOf(address)]); // never bid on stale state
      const key = await readKeyById(fresh.keyId);
      if (!key || key.status < 2 || key.keyId !== fresh.keyId) throw new Error(COPY.keyError);
      // Inside the envelope the contract and the bidder are their 20-byte protocol addresses.
      const domain = { chainId: cfg.chainId, auctionContract: cfg.contractAddress, auctionId: view.id };
      const { envelope, commitment } = await encryptBid({ spki: hexToBytes(key.publicKeySpki), domain, bidder, amountUnits: amount, expectedKeyId: fresh.keyId });
      mark("encrypt", "done");

      // One transfer locks the deposit and carries the envelope; if the contract refuses the bid, the token returns the deposit.
      mark("bid-sign", "active");
      await write(client, bidCall(view.id, fresh.depositUnits, bytesToHex(envelope)), (h) => { setHashes({ bid: h }); mark("bid-sign", "done"); mark("bid-confirm", "active"); });
      const index = await readBidIndex(view.id, address);
      const onchain = index > 0n ? (await readBid(view.id, index - 1n)).commitment : undefined;
      setIntegrity(onchain?.toLowerCase() === commitment.toLowerCase() ? "ok" : "mismatch");
      mark("bid-confirm", "done"); mark("recorded", "done");
      setStep("done");
      onRecorded();
    } catch (e) {
      setStageState((p) => ({ ...p, [stage]: "error" }));
      setError(describeError(e));
    }
  };

  const remainder = amount !== undefined ? amount - a.depositUnits : 0n;

  return (
    <Modal title="Place sealed bid" onClose={onClose} closable={step !== "progress"}>
      {step === "amount" && (
        <form onSubmit={(e) => { e.preventDefault(); validate(); }}>
          <p className="muted small">{COPY.privacy}</p>
          <AmountInput id="bid-amount" label="Your bid" value={input} onChange={setInput} error={error}
            help={`Reserve ${formatMoney(a.reserveUnits)} · fixed deposit ${formatMoney(a.depositUnits)} · up to 6 decimals`} />
          <button className="btn btn-block" type="submit">Review bid</button>
        </form>
      )}

      {step === "confirm" && amount !== undefined && (
        <div className="stack">
          <dl className="kv">
            <dt>Your sealed bid</dt><dd><Money units={amount} strong /></dd>
            <dt>Deposit locked now</dt><dd><Money units={a.depositUnits} /></dd>
            <dt>Remaining payment if you win</dt><dd><Money units={remainder} /></dd>
            <dt>Payment window after result</dt><dd>{fmtDuration(claimWindow)}</dd>
            <dt>Who can see the amount</dt><dd>Nobody until the auction closes; only the winning amount becomes public. Your account, deposit and transaction time are public.</dd>
          </dl>
          <p className="small">{COPY.firstPrice}</p>
          <p className="small">{COPY.defaultRule} Bids cannot be edited or withdrawn once recorded.</p>
          <label className="checkbox"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /><span>I understand my {formatMoney(a.depositUnits)} deposit is forfeited to the seller if I win and miss the payment deadline.</span></label>
          <div className="row">
            <button type="button" className="btn btn-secondary" onClick={() => setStep("amount")}>Back</button>
            <button type="button" className="btn" disabled={!ack} onClick={submit}>Encrypt and sign</button>
          </div>
        </div>
      )}

      {(step === "progress" || step === "done") && (
        <div className="stack">
          <ol className="steps" aria-live="polite">
            {STAGES.map(([s, label]) => (
              <li key={s} data-state={stageState[s]}>{label}{s === "bid-confirm" && hashes.bid && <> · <TxLink hash={hashes.bid} /></>}</li>
            ))}
          </ol>
          {error && (
            <>
              <Alert tone="error" title="No bid was recorded">{error}</Alert>
              <div className="row"><button type="button" className="btn btn-secondary" onClick={() => { setStageState({}); setStep("confirm"); setError(undefined); }}>Review and try again</button><button type="button" className="btn btn-text" onClick={onClose}>Close</button></div>
            </>
          )}
          {step === "done" && (
            <>
              <Alert tone="success" title="Bid recorded">{COPY.bidRecorded} Receipt: {hashes.bid && <TxLink hash={hashes.bid} />}</Alert>
              {integrity === "mismatch" && <Alert tone="error" title="Integrity check failed">The commitment the contract stored differs from the one computed in this browser. Do not bid again; inspect the transaction.</Alert>}
              {integrity === "ok" && <p className="small muted">The commitment stored by the contract matches the one computed locally.</p>}
              <p className="small">Your entered bid: <Money units={amount!} /> — kept only in this page&apos;s memory, not sent to any server.</p>
              <button type="button" className="btn btn-block" onClick={onClose}>Done</button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
