"use client";
import { useEffect, useState } from "react";
import { NETWORK } from "@/lib/config";
import { Arrow } from "./Hero";
import { Stipple } from "./Stipple";
import { Modal } from "./ui";

const KEY = "maskbid.mode";

// ponytail: "demo" is the testnet deployment this build points at and the mainnet card is static, because no mainnet
// deployment exists. When one lands, make the contract in lib/config.ts follow this choice.
const DEMO = { where: NETWORK, facts: ["Free test mUSDC from the faucet", "Bids ranked by the private solver in a TEE", "Needs a NEAR testnet account with a little NEAR for gas"] };
const MAINNET = ["Waiting on real World ID verification", "Waiting on a checked TEE attestation", "Contracts are not audited yet"];

/** Asked once on entering the app: demo or mainnet. The header chip reopens it. */
export function ModeGate() {
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    let saved = false;
    try { saved = localStorage.getItem(KEY) === "demo"; } catch {}
    if (saved) setEntered(true);
    else setOpen(true);
  }, []);

  const enter = () => {
    try { localStorage.setItem(KEY, "demo"); } catch {}
    setEntered(true);
    setOpen(false);
  };

  return (
    <>
      <button type="button" className="mode-chip" onClick={() => setOpen(true)} title={`Demo on ${DEMO.where}. Mainnet is not open yet.`}>Demo</button>
      {open && (
        <Modal title="Choose where to enter" onClose={() => setOpen(false)} closable={entered} wide>
          <p className="mode-lead">MaskBid runs as a demo for now. Mainnet opens later.</p>
          <div className="mode-cards">
            <div className="mode-card live">
              <div className="mode-art art"><Stipple kind="scene" seed={29} /></div>
              <div className="mode-body">
                <p className="mode-top"><span className="chip mint">Open now</span><span>{DEMO.where}</span></p>
                <h3>Demo</h3>
                <p>The full auction on real contracts, paid in test mUSDC. Nothing here has real value.</p>
                <ul className="mode-facts">{DEMO.facts.map((f) => <li key={f}>{f}</li>)}</ul>
                <button type="button" className="btn" onClick={enter}>{entered ? "Continue in demo" : "Enter demo"} <Arrow /></button>
              </div>
            </div>
            <div className="mode-card soon">
              <div className="mode-art"><Stipple kind="cloud" seed={31} className="cloud" /></div>
              <div className="mode-body">
                <p className="mode-top"><span className="chip peach">Coming soon</span><span>NEAR mainnet</span></p>
                <h3>Mainnet</h3>
                <p>Real assets and real funds. Not deployed yet.</p>
                <ul className="mode-facts">{MAINNET.map((f) => <li key={f}>{f}</li>)}</ul>
                <button type="button" className="btn btn-outline" disabled>Not available yet</button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
