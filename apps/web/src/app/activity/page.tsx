"use client";
import { useState } from "react";
import { DEPOSIT_STATUSES, formatMoney } from "@maskbid/protocol";
import { Badge, ConnectPrompt, Empty, Money, PhaseBadge, SyncLine, TxStatus } from "@/components/ui";
import { auctionEvents, contracts, readBid, readBidIndex, readSellerCredit, readTokenBalance } from "@/lib/client";
import { loadAuction, useChainData, type AuctionView } from "@/lib/data";
import { fmtTime } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { write } from "@/lib/write";

type Tab = "bidding" | "selling" | "balances";

export default function Activity() {
  const { address } = useWallet();
  const [tab, setTab] = useState<Tab>("bidding");
  const { state: tx, run } = useTx();
  const { data, error, syncedAt, refresh, loading } = useChainData(async () => {
    if (!address) return undefined;
    const [bidLogs, sellLogs, credit, balance] = await Promise.all([auctionEvents("BidPlaced", { bidder: address }), auctionEvents("AuctionCreated", { seller: address }), readSellerCredit(address), readTokenBalance(address)]);
    const bidding = await Promise.all(bidLogs.map(async (l) => {
      const id = l.args.auctionId as bigint;
      const [view, idx] = await Promise.all([loadAuction(id), readBidIndex(id, address)]);
      const bid = await readBid(id, idx - 1n);
      return { view, deposit: DEPOSIT_STATUSES[bid.depositStatus] };
    }));
    const selling = await Promise.all(sellLogs.map((l) => loadAuction(l.args.auctionId as bigint)));
    return { bidding: bidding.sort((x, y) => Number(y.view.id - x.view.id)), selling: selling.sort((x, y) => Number(y.id - x.id)), credit, balance };
  }, [address, tx.status], 8000);
  const faucet = () => run("Faucet 1,000 mUSDC", (c) => write(c, contracts().token, "faucet", [address!])).then(refresh).catch(() => {});
  const act = (label: string, fn: string, args: unknown[]) => run(label, (c) => write(c, contracts().auction, fn, args)).then(refresh).catch(() => {});

  if (!address) return <div className="stack" style={{ gap: 24 }}><h1>My activity</h1><ConnectPrompt>Your bids, sales, refunds and credits are read from the chain for the connected wallet.</ConnectPrompt></div>;

  const bidAction = (v: AuctionView, deposit: string) => {
    const me = address.toLowerCase();
    if (v.phase === "Claim" && v.a.winner.toLowerCase() === me && v.now < v.a.claimDeadline) return <a className="btn btn-sm" href={`/auctions/${v.id}`}>Pay and claim</a>;
    if (deposit === "Locked" && (v.phase === "Claim" || v.phase === "Completed" || v.phase === "Cancelled") && v.a.winner.toLowerCase() !== me) return <button type="button" className="btn btn-sm" onClick={() => act("Refund deposit", "claimRefund", [v.id])}>Withdraw {formatMoney(v.a.depositUnits)}</button>;
    if (deposit === "Locked" && v.phase === "Cancelled") return <button type="button" className="btn btn-sm" onClick={() => act("Refund deposit", "claimRefund", [v.id])}>Withdraw {formatMoney(v.a.depositUnits)}</button>;
    return <a className="btn btn-secondary btn-sm" href={`/auctions/${v.id}`}>View</a>;
  };
  const sellAction = (v: AuctionView) => {
    if (v.phase === "Cancelled" && !v.a.returnedAssetClaimed) return <button type="button" className="btn btn-sm" onClick={() => act("Claim returned asset", "claimReturnedAsset", [v.id, address])}>Claim returned asset</button>;
    if ((v.phase === "Scheduled" || v.phase === "Live" || v.phase === "Closed") && v.a.bidCount === 0 && v.a.activeAttempt === 0) return <button type="button" className="btn btn-secondary btn-sm" onClick={() => act("Cancel auction", "cancelAuction", [v.id])}>Cancel</button>;
    if (v.phase === "Closed") return <button type="button" className="btn btn-sm" onClick={() => act("Request resolution", "requestSettlement", [v.id])}>Request resolution</button>;
    return <a className="btn btn-secondary btn-sm" href={`/auctions/${v.id}`}>View</a>;
  };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row between">
        <div><h1>My activity</h1><p className="muted">Everything this wallet has bid on or sold, and the action each one is waiting for.</p></div>
        {data && (
          <div className="balance-chip glass">
            <div><span className="caption">Wallet balance</span><Money units={data.balance} strong /></div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={faucet}>Get 1,000 test mUSDC</button>
          </div>
        )}
      </div>
      <div className="row between">
        <div className="tabs" role="tablist">
          {(["bidding", "selling", "balances"] as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" className="btn btn-secondary btn-sm" aria-selected={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t === "bidding" ? "Bids" : t === "selling" ? "Sales" : "Credits"}{data && t !== "balances" && <small>{data[t].length}</small>}
            </button>
          ))}
        </div>
        <SyncLine syncedAt={syncedAt} error={error} onRefresh={refresh} />
      </div>
      <TxStatus state={tx} />
      {loading && <p className="muted" aria-busy="true">Loading…</p>}
      {data && tab === "bidding" && (data.bidding.length === 0 ? <Empty title="No bids from this wallet yet"><p>Pick a live lot, type your amount, and it is sealed in your browser before it is sent.</p><a className="btn" href="/#lots">Browse live lots</a></Empty> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Lot</th><th>Phase</th><th>Deposit</th><th>Deadline</th><th>Action</th></tr></thead><tbody>
          {data.bidding.map(({ view: v, deposit }) => (
            <tr key={v.id.toString()}><td><a href={`/auctions/${v.id}`}>{v.metadata?.title ?? `Lot ${v.id}`}</a>{v.a.winner.toLowerCase() === address.toLowerCase() && <> <Badge tone="accent">you won</Badge></>}</td><td><PhaseBadge phase={v.phase} /></td>
              <td><Badge tone={deposit === "Locked" ? "info" : deposit === "Refunded" ? "success" : deposit === "Consumed" ? "accent" : "danger"}>{deposit}</Badge></td>
              <td className="num small">{v.phase === "Claim" ? fmtTime(v.a.claimDeadline) : v.phase === "Live" || v.phase === "Scheduled" ? fmtTime(v.a.endTime) : "—"}</td><td>{bidAction(v, deposit)}</td></tr>
          ))}
        </tbody></table></div>
      ))}
      {data && tab === "selling" && (data.selling.length === 0 ? <Empty title="No auctions created by this wallet yet"><p>Register an asset, have it verified, then publish it as a sealed-bid auction.</p><a className="btn" href="/sell">Sell an asset</a></Empty> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Lot</th><th>Phase</th><th>Bids</th><th>Result</th><th>Action</th></tr></thead><tbody>
          {data.selling.map((v) => (
            <tr key={v.id.toString()}><td><a href={`/auctions/${v.id}`}>{v.metadata?.title ?? `Lot ${v.id}`}</a></td><td><PhaseBadge phase={v.phase} /></td><td className="num">{v.a.bidCount}</td>
              <td className="small">{v.phase === "Completed" ? <>Paid <Money units={v.a.winningAmountUnits} /></> : v.phase === "Claim" ? <>Awaiting <Money units={v.a.winningAmountUnits} /></> : v.phase === "Cancelled" ? v.cancelReason : "—"}</td><td>{sellAction(v)}</td></tr>
          ))}
        </tbody></table></div>
      ))}
      {data && tab === "balances" && (
        <div className="panel stack">
          <dl className="kv">
            <dt>mUSDC balance</dt><dd><Money units={data.balance} strong /></dd>
            <dt>Seller penalty credit</dt><dd><Money units={data.credit} /> {data.credit > 0n && <button type="button" className="btn btn-sm" style={{ marginLeft: 12 }} onClick={() => act("Withdraw seller credit", "withdrawSellerCredit", [address])}>Withdraw</button>}</dd>
          </dl>
          <p className="small muted">Exits never require identity verification: refunds, claims, returned assets and credits are available even if your verification expired.</p>
        </div>
      )}
    </div>
  );
}
