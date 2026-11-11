"use client";
import { useEffect, useRef, useState } from "react";
import { bytesToHex, zeroAddress, type Hex } from "viem";
import { ENVELOPE_BYTES, encryptBid, keyIdFromSpki, parseUnits6, TOKEN_SYMBOL } from "@maskbid/protocol";
import { CHAIN_ID, deployment } from "@/lib/config";
import { short } from "@/lib/format";
import { Dots } from "./Dots";

const EMPTY = "00".repeat(ENVELOPE_BYTES);

/** The real browser codec seals whatever you type, with a throwaway key made in this tab. */
export function SealDemo() {
  const [amount, setAmount] = useState("150");
  const [out, setOut] = useState<{ hex: Hex; commitment: Hex }>();
  const [error, setError] = useState<string>();
  const key = useRef<Promise<{ spki: Uint8Array; keyId: Hex }>>(undefined);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        key.current ??= crypto.subtle
          .generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"])
          .then(async (k) => { const spki = new Uint8Array(await crypto.subtle.exportKey("spki", k.publicKey)); return { spki, keyId: keyIdFromSpki(spki) }; });
        const { spki, keyId } = await key.current;
        const domain = { chainId: BigInt(CHAIN_ID), auctionContract: deployment?.auction ?? zeroAddress, auctionId: 1n };
        const r = await encryptBid({ spki, domain, bidder: zeroAddress, amountUnits: parseUnits6(amount), expectedKeyId: keyId });
        if (alive) { setOut({ hex: bytesToHex(r.envelope), commitment: r.commitment }); setError(undefined); }
      } catch (e) {
        if (alive) setError(amount ? (e as Error).message : "Type an amount");
      }
    }, 140);
    return () => { alive = false; clearTimeout(t); };
  }, [amount]);

  return (
    <div className="seal-panel glass" data-ui>
      <h3>Seal a bid <span>runs in this tab</span></h3>
      <label className="seal-input">
        <span className="sr-only">Bid amount</span>
        <input inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.trim())} aria-describedby="seal-note" />
        <span>{TOKEN_SYMBOL}</span>
      </label>
      <div className="seal-dots"><Dots hex={error ? EMPTY : out?.hex ?? EMPTY} cols={35} glow label={`${ENVELOPE_BYTES}-byte sealed envelope`} /></div>
      <div className="seal-meta" aria-live="polite">
        {error ? <span>{error}</span> : <><span><b>{ENVELOPE_BYTES}</b> bytes sealed</span><span>commitment <b>{out ? short(out.commitment, 6, 4) : "sealing…"}</b></span></>}
      </div>
      <p className="note" id="seal-note">Each keystroke makes a fresh envelope, even for the same amount. The key is thrown away; nothing leaves this tab.</p>
    </div>
  );
}
