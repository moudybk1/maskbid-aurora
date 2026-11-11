"use client";
import { useState } from "react";
import { bytesToHex, decodeEventLog, hexToBytes, type Address, type Hex } from "viem";
import { auctionAbi } from "@maskbid/contracts";
import { encryptBid, formatMoney, InvalidAmount, parseUnits6 } from "@maskbid/protocol";
import { contracts, readAllowance, readAuction, readKeyById } from "@/lib/client";
import { COPY } from "@/lib/copy";
import type { AuctionView } from "@/lib/data";
import { fmtDuration } from "@/lib/format";
import { describeError } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { write } from "@/lib/write";
import { Alert, AmountInput, Modal, Money, TxLink } from "./ui";
import { CHAIN_ID } from "@/lib/config";

type Step = "amount" | "confirm" | "progress" | "done";
type Stage = "encrypt" | "approve-sign" | "approve-confirm" | "bid-sign" | "bid-confirm" | "recorded";
const STAGES: [Stage, string][] = [
  ["encrypt", "Preparing encryption"], ["approve-sign", "Awaiting approval signature"], ["approve-confirm", "Approval confirming"],
  ["bid-sign", "Awaiting bid signature"], ["bid-confirm", "Bid confirming"], ["recorded", "Recorded on chain"],
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
  const [needsApproval, setNeedsApproval] = useState(false);
  const [hashes, setHashes] = useState<{ approve?: Hex; bid?: Hex }>({});
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
      const fresh = await readAuction(view.id); // never bid on stale state
      const key = await readKeyById(fresh.keyId);
      if (key.status < 2 || key.keyId !== fresh.keyId) throw new Error(COPY.keyError);
      const domain = { chainId: BigInt(CHAIN_ID), auctionContract: contracts().auction.address.toLowerCase() as Address, auctionId: view.id };
      const { envelope, commitment } = await encryptBid({ spki: hexToBytes(key.publicKeySpki), domain, bidder: address.toLowerCase() as Address, amountUnits: amount, expectedKeyId: fresh.keyId });
      mark("encrypt", "done");

      const { token, auction } = contracts();
      const allowance = await readAllowance(address);
      const approve = allowance < fresh.depositUnits;
      setNeedsApproval(approve);
      if (approve) {
        mark("approve-sign", "active");
        const h = await write(client, token, "approve", [auction.address, fresh.depositUnits]);
        setHashes((p) => ({ ...p, approve: h }));
        mark("approve-sign", "done"); mark("approve-confirm", "active");
        const r = await (await import("@/lib/client")).publicClient.waitForTransactionReceipt({ hash: h });
        if (r.status !== "success") throw new Error("Approval reverted. No bid was sent.");
        mark("approve-confirm", "done");
      } else {
        mark("approve-sign", "done"); mark("approve-confirm", "done");
      }

      mark("bid-sign", "active");
      const h = await write(client, auction, "placeBid", [view.id, bytesToHex(envelope)]);
      setHashes((p) => ({ ...p, bid: h }));
      mark("bid-sign", "done"); mark("bid-confirm", "active");
      const receipt = await (await import("@/lib/client")).publicClient.waitForTransactionReceipt({ hash: h });
      if (receipt.status !== "success") throw new Error("Bid transaction reverted. Deposit was not taken.");
      const ev = receipt.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, data: l.data, topics: l.topics }); } catch { return undefined; } }).find((e) => e?.eventName === "BidPlaced");
      const onchain = (ev?.args as { commitment?: Hex } | undefined)?.commitment;
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
            <dt>Who can see the amount</dt><dd>Nobody until the auction closes; only the winning amount becomes public. Your address, deposit and transaction time are public.</dd>
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
            {STAGES.filter(([s]) => needsApproval || !s.startsWith("approve")).map(([s, label]) => (
              <li key={s} data-state={stageState[s]}>{label}{s === "approve-confirm" && hashes.approve && <> · <TxLink hash={hashes.approve} /></>}{s === "bid-confirm" && hashes.bid && <> · <TxLink hash={hashes.bid} /></>}</li>
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
              {integrity === "mismatch" && <Alert tone="error" title="Integrity check failed">The commitment in the receipt differs from the one computed in this browser. Do not bid again; inspect the receipt.</Alert>}
              {integrity === "ok" && <p className="small muted">Commitment in the receipt matches the one computed locally.</p>}
              <p className="small">Your entered bid: <Money units={amount!} /> — kept only in this page&apos;s memory, not sent to any server.</p>
              <button type="button" className="btn btn-block" onClick={onClose}>Done</button>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
