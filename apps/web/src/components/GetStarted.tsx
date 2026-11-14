"use client";
import { useState, type ReactNode } from "react";
import { formatMoney } from "@maskbid/protocol";
import { assetEvents, auctionEvents, contracts, publicClient, readAsset, readAssetBalance, readEligible, readTokenBalance } from "@/lib/client";
import { IS_LOCAL } from "@/lib/config";
import { useChainData } from "@/lib/data";
import { useTx } from "@/lib/tx";
import { useWallet } from "@/lib/wallet";
import { write } from "@/lib/write";
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
    const [eligible, balance, gas, bids, registered, listed] = await Promise.all([
      readEligible(address), readTokenBalance(address), publicClient.getBalance({ address }),
      auctionEvents("BidPlaced", { bidder: address }), assetEvents("AssetRegistered", { issuer: address }), auctionEvents("AuctionCreated", { seller: address }),
    ]);
    const assets = await Promise.all(registered.map(async (l) => {
      const id = l.args.tokenId as bigint;
      const [a, held] = await Promise.all([readAsset(id), readAssetBalance(address, id)]);
      return { id, verified: a.status === 1, listable: a.status === 1 && !a.redeemed && held === 1n };
    }));
    return { eligible, balance, gas, bid: bids.length > 0, registered: assets.length > 0, verified: assets.some((a) => a.verified), listable: assets.find((a) => a.listable)?.id, listed: listed.length > 0 };
  }, [address, tx.status], 8000);

  const ret = track === "bid" ? "/#start" : "/sell";
  const connect: Step = { title: "Connect a wallet", text: "Connecting only reads your address. Nothing is sent until you sign.", done: Boolean(address),
    cta: <button type="button" className="btn btn-sm" onClick={() => w.setConnectOpen(true)}>Connect wallet</button> };
  const verify: Step = { title: "Verify you are one person", text: "One verified person, one bid per auction. This is not KYC, and refunds never need it.", done: Boolean(data?.eligible),
    cta: <a className="btn btn-sm" href={`/verify?return=${encodeURIComponent(ret)}`}>Verify this wallet <Arrow /></a> };

  // Testnet transactions need gas the wallet has to bring; the local chain's demo accounts are pre-funded.
  const gas: Step[] = IS_LOCAL ? [] : [{ title: "Get testnet ETH for gas", text: "Every transaction on Aurora testnet costs a little ETH. The Aurora faucet sends some to your wallet for free.", done: (data?.gas ?? 0n) > 0n,
    cta: <a className="btn btn-sm" href="https://aurora.dev/faucet" target="_blank" rel="noreferrer">Open the Aurora faucet <Arrow /></a> }];

  const steps: Step[] = track === "bid" ? [
    connect, verify, ...gas,
    { title: "Get mUSDC for the deposit", text: "Each bid locks a fixed deposit in the auction contract. The test token has a free faucet.", done: (data?.balance ?? 0n) > 0n,
      cta: <button type="button" className="btn btn-sm" disabled={tx.status === "signing" || tx.status === "confirming"}
        onClick={() => address && run("Faucet 1,000 mUSDC", (c) => write(c, contracts().token, "faucet", [address])).then(refresh).catch(() => {})}>Get 1,000 test mUSDC</button>, extra: <TxStatus state={tx} /> },
    { title: "Place a sealed bid", text: "Open a live lot and type your amount. It is encrypted in this browser before it is sent.", done: Boolean(data?.bid),
      cta: <a className="btn btn-sm" href="/#lots">Browse live lots <Arrow /></a>, extra: data && <span className="caption">Deposit varies by lot; you hold {formatMoney(data.balance)}.</span> },
  ] : [
    connect, verify, ...gas,
    { title: "Register your asset", text: "Describe it once. The details are frozen to a hash on chain and cannot be edited later.", done: Boolean(data?.registered),
      cta: <a className="btn btn-sm" href="/assets/new">Register asset <Arrow /></a> },
    { title: "Get it reviewed", text: IS_LOCAL ? "A verifier checks the listing and mints its token to you. On this demo, switch to the verifier account and approve it in the Verifier queue." : "A verifier checks the listing and mints its token to you. This page updates when it is approved.", done: Boolean(data?.verified),
      cta: IS_LOCAL ? <button type="button" className="btn btn-sm" onClick={() => w.setConnectOpen(true)}>Switch to verifier</button> : undefined },
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
          ? `${count} steps from wallet to sealed bid. Losing bids stay sealed for good; only the winning amount is ever made public.`
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
