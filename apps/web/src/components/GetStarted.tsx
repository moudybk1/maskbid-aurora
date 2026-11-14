"use client";
import { useState, type ReactNode } from "react";
import { formatMoney } from "@maskbid/protocol";
import { listAssets, listBidsOf, readEligible, readTokenBalance } from "@/lib/client";
import { loadAuctions, useChainData } from "@/lib/data";
import { nearBalance } from "@/lib/near";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { faucetCall } from "@/lib/write";
import { Arrow } from "./Hero";
import { TxStatus } from "./ui";

type Track = "bid" | "sell";
type Step = { title: string; text: string; done: boolean; cta?: ReactNode; extra?: ReactNode };

const Check = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5" /></svg>;

/** First-run checklist. Every step is read from the chain for the connected wallet, so it checks itself off as the user goes. */
export function GetStarted({ fixed }: { fixed?: Track }) {
  const w = useWallet();
  const { address } = w;
  const [picked, setPicked] = useState<Track>("bid");
  const track = fixed ?? picked;
  const { state: tx, run } = useTx();
  const { data, refresh } = useChainData(async () => {
    if (!address) return undefined;
    const [eligible, balance, gas, { list }, all, bids] = await Promise.all([readEligible(address), readTokenBalance(address), nearBalance(address), loadAuctions(), listAssets(), listBidsOf(address)]);
    const assets = all.filter(({ a }) => a.issuer === address).map(({ tokenId, a }) => ({ id: tokenId, verified: a.status === 1, listable: a.status === 1 && !a.redeemed && a.owner === address }));
    return { eligible, balance, gas, bid: bids.length > 0, registered: assets.length > 0, verified: assets.some((a) => a.verified), listable: assets.find((a) => a.listable)?.id, listed: list.some((v) => v.a.seller === address) };
  }, [address, tx.status], 8000);

  const ret = track === "bid" ? "/auctions#start" : "/sell";
  const connect: Step = { title: "Connect a NEAR testnet account", text: "Nothing is sent until you confirm an action.", done: Boolean(address),
    cta: <button type="button" className="btn btn-sm" onClick={() => w.setConnectOpen(true)}>Connect account</button> };
  const verify: Step = { title: "Verify you are one person", text: "One verified person, one bid per auction. This is not KYC, and refunds never need it.", done: Boolean(data?.eligible),
    cta: <a className="btn btn-sm" href={`/verify?return=${encodeURIComponent(ret)}`}>Verify this account <Arrow /></a> };

  // Gas is prepaid and mostly refunded, so an account needs about half a NEAR on hand to bid, and a little more to start a TEE run.
  const gas: Step[] = [{ title: "Have testnet NEAR for gas", text: "Transactions on NEAR testnet prepay their gas in NEAR. Half a NEAR is plenty; the testnet faucet gives it away.", done: (data?.gas ?? 0n) >= 5n * 10n ** 23n,
    cta: <a className="btn btn-sm" href="https://near-faucet.io/" target="_blank" rel="noreferrer">Open the NEAR testnet faucet <Arrow /></a> }];

  const steps: Step[] = track === "bid" ? [
    connect, verify, ...gas,
    { title: "Get mUSDC for the deposit", text: "Each bid locks a fixed deposit in the auction contract. The test token has a free faucet.", done: (data?.balance ?? 0n) > 0n,
      cta: <button type="button" className="btn btn-sm" disabled={tx.status === "signing" || tx.status === "confirming"}
        onClick={() => address && run("Faucet 1,000 mUSDC", faucetCall(address)).then(refresh).catch(() => {})}>Get 1,000 test mUSDC</button>, extra: <TxStatus state={tx} /> },
    { title: "Place a sealed bid", text: "Open a live lot and type your amount. It is encrypted in this browser before it is sent.", done: Boolean(data?.bid),
      cta: <a className="btn btn-sm" href="/auctions">Browse live lots <Arrow /></a>, extra: data && <span className="caption">Deposit varies by lot; you hold {formatMoney(data.balance)}.</span> },
  ] : [
    connect, verify, ...gas,
    { title: "Register your asset", text: "Describe it once. The details are frozen to a hash on chain and cannot be edited later.", done: Boolean(data?.registered),
      cta: <a className="btn btn-sm" href="/assets/new">Register asset <Arrow /></a> },
    { title: "Get it reviewed", text: "A verifier checks the listing and mints its token to you. This page updates when it is approved; with the demo accounts, switch to the verifier and approve it in the Verifier queue.", done: Boolean(data?.verified),
      cta: w.demoAccounts.length > 0 ? <button type="button" className="btn btn-sm" onClick={() => w.setConnectOpen(true)}>Switch to verifier</button> : undefined },
    { title: "Publish the auction", text: "Set the public reserve, the deposit every bidder locks, and how long bidding stays open.", done: Boolean(data?.listed),
      cta: data?.listable !== undefined ? <a className="btn btn-sm" href={`/auctions/new?asset=${data.listable}`}>Create auction <Arrow /></a> : undefined },
  ];
  const current = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  const count = ["Four", "Five", "Six"][steps.length - 4];
  if (address && !data) return null; // avoid flashing a wrong checklist while the chain is read

  const toggle = !fixed && (
    <div className="seg" role="group" aria-label="What do you want to do?">
      <button type="button" aria-pressed={track === "bid"} onClick={() => setPicked("bid")}>Bid on a lot</button>
      <button type="button" aria-pressed={track === "sell"} onClick={() => setPicked("sell")}>Sell an asset</button>
    </div>
  );

  if (current < 0) {
    return (
      <div className="start start-done glass">
        <span className="start-mark" data-state="done"><Check /></span>
        <p><b>{track === "bid" ? "You are set up to bid." : "Your auction is published."}</b> {track === "bid" ? "Deposits, results and refunds for your bids are in My activity." : "Follow bids, the result and payment in My activity."}</p>
        <div className="row">{toggle}<a className="btn btn-secondary btn-sm" href="/activity">My activity <Arrow /></a></div>
      </div>
    );
  }

  return (
    <div className="start glass">
      <div className="start-intro">
        <h2>{track === "bid" ? "Your first sealed bid" : "List your first asset"}</h2>
        <p className="muted">{track === "bid"
          ? `${count} steps from account to sealed bid. Losing bids stay sealed for good; only the winning amount is ever made public.`
          : `${count} steps from a description to a live sealed-bid auction. A verifier approves the asset in between.`}</p>
        {toggle}
        <p className="start-progress" aria-live="polite"><b>{doneCount} of {steps.length}</b> done{address ? " · checked from the chain" : ""}</p>
        <div className="start-bar" aria-hidden="true"><span style={{ width: `${(100 * doneCount) / steps.length}%` }} /></div>
      </div>
      <ol className="start-steps">
        {steps.map((s, i) => {
          const state = s.done ? "done" : i === current ? "current" : undefined;
          return (
            <li key={s.title} data-state={state} aria-current={i === current ? "step" : undefined}>
              <span className="start-mark" data-state={state}>{s.done ? <Check /> : i + 1}</span>
              <div>
                <b>{s.title}</b>
                {(i === current || !s.done) && <span>{s.text}</span>}
                {i === current && s.cta && <div className="start-cta">{s.cta}</div>}
                {i === current && data && s.extra}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
