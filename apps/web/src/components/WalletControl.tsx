"use client";
import { useState } from "react";
import { NETWORK } from "@/lib/config";
import { short } from "@/lib/format";
import { useWallet } from "@/lib/wallet";
import { Alert, Modal } from "./ui";

export function WalletControl() {
  const w = useWallet();
  const close = () => w.setConnectOpen(false);
  if (w.address) {
    return (
      <>
        <span className="wallet-chip" title={`${w.address} · ${NETWORK}`}>{w.label && <span className="who">{w.label}</span>}{short(w.address, 10, 8)}</span>
        <button type="button" className="btn btn-outline btn-sm hide-sm" onClick={() => w.setConnectOpen(true)}>Switch account</button>
        <button type="button" className="btn btn-outline btn-sm" onClick={w.disconnect} aria-label="Disconnect"><span className="hide-sm">Disconnect</span><svg className="show-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
        {w.connectOpen && <ConnectDialog onClose={close} />}
      </>
    );
  }
  return (
    <>
      <a className="btn btn-outline btn-sm hide-sm" href="/auctions#start">Get started</a>
      <button type="button" className="btn btn-sm" onClick={() => w.setConnectOpen(true)}>Connect account</button>
      {w.connectOpen && <ConnectDialog onClose={close} />}
    </>
  );
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const wallet = () => {
    setBusy(true); setError(undefined);
    // The picker is the wallet library's own window; ours steps aside while it is open.
    onClose();
    w.connectWallet().catch((e: Error) => { setError(e.message); w.setConnectOpen(true); }).finally(() => setBusy(false));
  };
  return (
    <Modal title={w.address ? "Switch account" : "Connect a NEAR testnet account"} onClose={onClose}>
      <p className="muted">MaskBid runs on {NETWORK}. Your wallet signs every transaction; this app never sees your keys.</p>
      <div className="stack">
        <button type="button" className="btn" disabled={busy} onClick={wallet}>Connect a NEAR wallet</button>
        <p className="caption">HOT, Meteor, Intear, MyNearWallet and others, switched to testnet. No testnet account yet? Create one in your wallet, then get free testnet NEAR from the <a href="https://near-faucet.io/" target="_blank" rel="noreferrer">faucet</a>.</p>
        {error && <Alert tone="error">{error}</Alert>}
        {w.demoAccounts.length > 0 && (
          <div className="dev-accounts">
            <p className="small"><strong>Demo accounts on this machine</strong></p>
            <p className="small muted">Play every role from one browser: list an asset as the seller, approve it as the verifier, then bid as A and B. Throwaway testnet accounts from this machine&apos;s near-cli keychain, offered on localhost only.</p>
            <div className="dev-grid">
              {w.demoAccounts.map((a) => {
                const current = w.address === a.accountId;
                return (
                  <button key={a.accountId} type="button" className="dev-account" aria-pressed={current} onClick={() => { w.useDemo(a); onClose(); }}>
                    <b>{a.label}</b><small>{short(a.accountId, 10, 8)}{current ? " · connected" : ""}</small>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
