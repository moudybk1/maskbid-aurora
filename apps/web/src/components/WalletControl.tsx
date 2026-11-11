"use client";
import { CHAIN_ID, IS_LOCAL } from "@/lib/config";
import { short } from "@/lib/format";
import { DEV_ACCOUNTS, useWallet } from "@/lib/wallet";
import { Modal } from "./ui";

export function WalletControl() {
  const w = useWallet();
  const close = () => w.setConnectOpen(false);
  if (w.address) {
    return (
      <>
        {w.wrongChain && <button type="button" className="btn btn-sm btn-danger" onClick={w.switchChain}>Switch to chain {CHAIN_ID}</button>}
        <span className="wallet-chip" title={`${w.address} · chain ${w.chainId}`}>{w.label && <span className="who">{w.label}</span>}{short(w.address)}</span>
        {w.kind === "dev" && <button type="button" className="btn btn-outline btn-sm hide-sm" onClick={() => w.setConnectOpen(true)}>Switch account</button>}
        <button type="button" className="btn btn-outline btn-sm" onClick={w.disconnect} aria-label="Disconnect"><span className="hide-sm">Disconnect</span><svg className="show-sm" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
        {w.connectOpen && <ConnectDialog onClose={close} />}
      </>
    );
  }
  return (
    <>
      <a className="btn btn-outline btn-sm hide-sm" href="/#start">Get started</a>
      <button type="button" className="btn btn-sm" onClick={() => w.setConnectOpen(true)}>Connect wallet</button>
      {w.connectOpen && <ConnectDialog onClose={close} />}
    </>
  );
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  return (
    <Modal title={w.address ? "Switch account" : "Connect wallet"} onClose={onClose}>
      <p className="muted">Connecting only reads your address. Nothing is sent until you sign a transaction.</p>
      <div className="stack">
        <button type="button" className="btn" disabled={!w.hasInjected} onClick={() => w.connectInjected().then(onClose).catch(() => {})}>
          {w.hasInjected ? "Browser wallet (MetaMask or compatible)" : "No browser wallet detected"}
        </button>
        {IS_LOCAL && (
          <div className="dev-accounts">
            <p className="small"><strong>Demo accounts on the local chain</strong></p>
            <p className="small muted">Play every role from one browser: list an asset as the seller, approve it as the verifier, then bid as A, B and C. These are public Anvil test keys; never use them anywhere else.</p>
            <div className="dev-grid">
              {DEV_ACCOUNTS.map((a) => {
                const [num, ...role] = a.label.split(" ");
                const current = w.label === a.label;
                return (
                  <button key={a.key} type="button" className="dev-account" aria-pressed={current} onClick={() => { w.connectDev(a.key); onClose(); }}>
                    <b>{role.join(" ")}</b><small>Account {num}{current ? " · connected" : ""}</small>
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
