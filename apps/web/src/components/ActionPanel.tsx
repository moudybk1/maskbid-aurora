"use client";
import { useState } from "react";
import { CANCEL_REASON_LABEL, DEPOSIT_STATUSES, formatMoney, formatUnits6, TOKEN_SYMBOL } from "@maskbid/protocol";
import { readBid, readBidIndex, readConfig, readCredit, readEligible, readTokenBalance } from "@/lib/client";
import { COPY } from "@/lib/copy";
import { useChainData, type AuctionView, type BidRow } from "@/lib/data";
import { fmtDuration, fmtRelative, fmtTime, formatNear } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { auctionCall, claimCall, faucetCall, tokenRegistration } from "@/lib/write";
import { BidDialog } from "./BidDialog";
import { Alert, Money, PhaseBadge, PhaseTrack, TxStatus } from "./ui";

export function ActionPanel({ view, bids, refresh }: { view: AuctionView; bids: BidRow[]; refresh: () => void }) {
  const { address, setConnectOpen } = useWallet();
  const { state: tx, run } = useTx();
  const [bidding, setBidding] = useState(false);
  const { a, phase, now } = view;
  const isSeller = address === a.seller;
  const isWinner = address !== undefined && address === a.winner;
  const sold = phase === "Claim" || phase === "Completed";

  const { data: mine, refresh: refreshMine } = useChainData(async () => {
    const cfg = await readConfig();
    if (!address) return { cfg };
    const idx = await readBidIndex(view.id, address);
    const bid = idx > 0n ? await readBid(view.id, idx - 1n) : undefined;
    return { cfg, idx, bid, eligible: await readEligible(address), balance: await readTokenBalance(address), credit: await readCredit(address) };
  }, [address, view.id, a.state, bids.length]);
  const cfg = mine?.cfg;
  const myDeposit = mine?.bid ? DEPOSIT_STATUSES[mine.bid.depositStatus] : undefined;
  const hasBid = (mine?.idx ?? 0n) > 0n;
  const after = () => { refresh(); refreshMine(); };
  const act = (label: string, method: string) => run(label, auctionCall(method, view.id)).then(after).catch(() => {});
  // The remainder goes to the contract with the claim message; the unit comes back in the same transaction.
  const claim = () => run("Pay and claim", claimCall(view.id, a.winningAmountUnits - a.depositUnits)).then(after).catch(() => {});
  const withdrawCredit = async () => {
    if (!address) return;
    try {
      const register = await tokenRegistration(address); // an account must be registered on the token before it can be paid
      if (register) await run("Register to hold mUSDC", register);
      await run("Withdraw credit", { method: "withdraw_credit" });
      after();
    } catch {}
  };
  const attemptOver = cfg !== undefined && (a.attemptFailed || now >= a.attemptStartedAt + cfg.attemptTimeoutSeconds);

  const Rules = () => (
    <div className="small muted stack" style={{ gap: 4 }}>
      <span>{COPY.firstPrice}</span>
      <span>Losing deposits are refundable as soon as the result is accepted, even before the winner pays.</span>
      <span>{COPY.defaultRule}</span>
      {cfg && <span>Payment window {fmtDuration(cfg.claimWindowSeconds)} · settlement grace {fmtDuration(cfg.settlementGraceSeconds)} · profile {cfg.profile}</span>}
    </div>
  );

  return (
    <div className="panel sticky">
      <div className="row between"><PhaseBadge phase={phase} />{isSeller && <span className="badge badge-accent">You are the seller</span>}</div>
      <PhaseTrack phase={phase} />
      <p className="lot-figure"><span>{formatUnits6(sold ? a.winningAmountUnits : a.reserveUnits)}</span><span className="unit">{TOKEN_SYMBOL}</span></p>
      <p className="small muted">{sold ? "Winning bid, the only amount made public" : "Reserve, the public minimum"}</p>
      <dl className="kv" style={{ marginTop: 20 }}>
        {sold && <><dt>Reserve</dt><dd><Money units={a.reserveUnits} /></dd></>}
        <dt>Fixed deposit</dt><dd><Money units={a.depositUnits} /></dd>
        <dt>{phase === "Scheduled" ? "Opens" : "Closes"}</dt>
        <dd className="num">{phase === "Scheduled" ? fmtTime(a.startTime) : fmtTime(a.endTime)}<br /><span className="small muted">{fmtRelative(phase === "Scheduled" ? a.startTime : a.endTime, now)} (chain time)</span></dd>
        <dt>Participants</dt><dd className="num">{a.bidCount} of {cfg ? Number(cfg.maxBids) : 32}</dd>
      </dl>
      <hr className="divider" />

      {/* ---- primary action by phase and role ---- */}
      {phase === "Scheduled" && !isSeller && <p className="small">Bidding opens at the scheduled time. Connect and verify now so you are ready.</p>}

      {(phase === "Live" || phase === "Scheduled") && !isSeller && address && (
        hasBid ? (
          <Alert tone="success" title="Your bid is recorded">Deposit <Money units={a.depositUnits} /> is locked in the auction contract. The amount stays sealed until the auction closes.</Alert>
        ) : mine?.eligible === false ? (
          <div className="stack">
            <p className="small"><b>Verify to bid.</b> <span className="muted">Each auction takes one bid per verified person. It is not KYC, and refunds never need it.</span></p>
            <a className="btn btn-block" href={`/verify?return=/auctions/${view.id}`}>Verify this account</a>
          </div>
        ) : mine?.balance !== undefined && mine.balance < a.depositUnits ? (
          <div className="stack">
            <p className="small"><b>Not enough mUSDC for the deposit.</b> <span className="muted">This lot locks {formatMoney(a.depositUnits)}; you hold {formatMoney(mine.balance)}.</span></p>
            <button type="button" className="btn btn-block" onClick={() => address && run("Faucet 1,000 mUSDC", faucetCall(address)).then(after).catch(() => {})}>Get 1,000 test mUSDC</button>
          </div>
        ) : phase === "Live" ? (
          <div className="stack">
            <button type="button" className="btn btn-block" onClick={() => setBidding(true)} disabled={a.bidCount >= Number(cfg?.maxBids ?? 32)}>Place sealed bid · lock {formatMoney(a.depositUnits)}</button>
            <p className="caption">Your amount is encrypted in this browser. You lock {formatMoney(a.depositUnits)} now and pay the rest only if you win.</p>
          </div>
        ) : null
      )}
      {(phase === "Live" || phase === "Scheduled") && !address && (
        <div className="stack">
          <button type="button" className="btn btn-block" onClick={() => setConnectOpen(true)}>Connect an account to bid</button>
          <p className="caption">New here? <a href="/auctions#start">See the steps</a> from account to sealed bid.</p>
        </div>
      )}

      {phase === "Closed" && (
        <div className="stack">
          <Alert tone="info" title="Auction closed — awaiting result">Bids can no longer be entered. Anyone may request the private computation.</Alert>
          {address && <button type="button" className="btn btn-block" onClick={() => act("Request resolution", "request_settlement")}>Request resolution</button>}
          {address && cfg && <p className="caption">Starts one private computation. {formatNear(cfg.executionDeposit)} NEAR is attached and the unused part comes straight back.</p>}
        </div>
      )}

      {phase === "Resolving" && cfg && (
        <div className="stack">
          <Alert tone={a.attemptFailed ? "warning" : "info"} title={`${a.attemptFailed ? "Private computation gave no result" : "Private computation in progress"} · attempt ${a.activeAttempt} of ${Number(cfg.maxAttempts)}`}>
            {a.attemptFailed ? `The solver run did not return a result (${a.lastError ?? "no detail"}). Deposits stay in the contract.` : attemptOver ? COPY.solverDelayed : `The solver is ranking ${a.bidCount} sealed bid${a.bidCount === 1 ? "" : "s"} inside the TEE. Deposits stay in the contract.`}
          </Alert>
          {address && attemptOver && a.activeAttempt < Number(cfg.maxAttempts) && now < a.settlementDeadline && (
            <button type="button" className="btn btn-secondary btn-block" onClick={() => act("Retry settlement", "retry_settlement")}>Retry settlement (attempt {a.activeAttempt + 1})</button>
          )}
          {attemptOver && a.activeAttempt >= Number(cfg.maxAttempts) && now < a.settlementDeadline && <p className="small muted">All attempts were used. Refunds open at the settlement deadline, {fmtTime(a.settlementDeadline)}.</p>}
        </div>
      )}

      {(phase === "Closed" || phase === "Resolving" || phase === "Live") && now >= a.settlementDeadline && address && (
        <div className="stack">
          <Alert tone="warning" title="Settlement deadline passed">{COPY.timeout}</Alert>
          <button type="button" className="btn btn-block" onClick={() => act("Cancel after timeout", "cancel_after_solver_timeout")}>Cancel after timeout and open refunds</button>
        </div>
      )}

      {phase === "Claim" && (
        <div className="stack">
          <dl className="kv">
            <dt>Winner</dt><dd className="mono">{a.winner}</dd>
            <dt>Winning bid</dt><dd><Money units={a.winningAmountUnits} strong /></dd>
            <dt>Payment deadline</dt><dd className="num">{fmtTime(a.claimDeadline)}<br /><span className="small muted">{fmtRelative(a.claimDeadline, now)}</span></dd>
          </dl>
          {isWinner && now < a.claimDeadline && (
            <>
              <Alert tone="success" title="You won">Deposit <Money units={a.depositUnits} /> already locked. Pay the remaining <Money units={a.winningAmountUnits - a.depositUnits} /> to receive the token in the same transaction.</Alert>
              {mine?.balance !== undefined && mine.balance < a.winningAmountUnits - a.depositUnits && <p className="small"><b>Not enough mUSDC.</b> <span className="muted">You hold {formatMoney(mine.balance)}.</span> <button type="button" className="btn btn-sm btn-secondary" onClick={() => address && run("Faucet 1,000 mUSDC", faucetCall(address)).then(after).catch(() => {})}>Get 1,000 test mUSDC</button></p>}
              <button type="button" className="btn btn-block" onClick={claim}>Pay {formatMoney(a.winningAmountUnits - a.depositUnits)} and claim token</button>
            </>
          )}
          {isWinner && now >= a.claimDeadline && <Alert tone="error" title="Payment deadline missed">{COPY.defaultRule}</Alert>}
          {hasBid && !isWinner && myDeposit === "Locked" && <button type="button" className="btn btn-block" onClick={() => act("Refund deposit", "claim_refund")}>Withdraw deposit · {formatMoney(a.depositUnits)}</button>}
          {hasBid && !isWinner && myDeposit === "Refunded" && <Alert tone="success" title="Deposit refunded">Your deposit was returned.</Alert>}
          {address && now >= a.claimDeadline && <button type="button" className="btn btn-secondary btn-block" onClick={() => act("Expire claim", "expire_claim")}>Expire unpaid claim (forfeits winner deposit to seller)</button>}
          {isSeller && <p className="small muted">Awaiting the winner&apos;s payment. You receive exactly {formatMoney(a.winningAmountUnits)} when they claim.</p>}
        </div>
      )}

      {phase === "Completed" && (
        <div className="stack">
          <Alert tone="success" title="Sold">Winner {a.winner} paid <Money units={a.winningAmountUnits} />; the token was delivered in the same transaction.</Alert>
          {hasBid && !isWinner && myDeposit === "Locked" && <button type="button" className="btn btn-block" onClick={() => act("Refund deposit", "claim_refund")}>Withdraw deposit · {formatMoney(a.depositUnits)}</button>}
          {isWinner && <p className="small">Your token: <a href={`/assets/${a.tokenId}`}>asset #{a.tokenId.toString()}</a></p>}
        </div>
      )}

      {phase === "Cancelled" && (
        <div className="stack">
          <Alert tone="warning" title="Auction cancelled">{CANCEL_REASON_LABEL[view.cancelReason]}.</Alert>
          {hasBid && myDeposit === "Locked" && <button type="button" className="btn btn-block" onClick={() => act("Refund deposit", "claim_refund")}>Withdraw deposit · {formatMoney(a.depositUnits)}</button>}
          {hasBid && myDeposit === "Forfeited" && <Alert tone="error" title="Deposit forfeited">Your winning deposit was forfeited to the seller after the payment deadline passed.</Alert>}
          {isSeller && !a.returnedAssetClaimed && address && <button type="button" className="btn btn-block" onClick={() => act("Claim returned asset", "claim_returned_asset")}>Claim returned asset</button>}
          {isSeller && a.returnedAssetClaimed && <p className="small muted">Asset returned to your account.</p>}
        </div>
      )}

      {isSeller && (phase === "Scheduled" || phase === "Live" || phase === "Closed") && a.bidCount === 0 && a.activeAttempt === 0 && (
        <button type="button" className="btn btn-secondary btn-block" style={{ marginTop: 12 }} onClick={() => act("Cancel auction", "cancel_auction")}>Cancel auction (no bids yet)</button>
      )}

      {(mine?.credit ?? 0n) > 0n && (
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="small"><b>The contract owes you {formatMoney(mine!.credit!)}.</b> <span className="muted">A forfeited deposit, or a payout that could not reach your account yet.</span></p>
          <button type="button" className="btn btn-secondary btn-block" onClick={withdrawCredit}>Withdraw credit · {formatMoney(mine!.credit!)}</button>
        </div>
      )}

      <TxStatus state={tx} />
      <hr className="divider" />
      <Rules />
      {bidding && cfg && <BidDialog view={view} claimWindow={cfg.claimWindowSeconds} onClose={() => setBidding(false)} onRecorded={after} />}
    </div>
  );
}
