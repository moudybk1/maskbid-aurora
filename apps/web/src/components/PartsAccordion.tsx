"use client";
import { useState } from "react";
import { Glyph } from "./FlowStory";

const GROUPS = [
  ["Seal", ["AES-256-GCM", "RSA-OAEP-2048"], "Your browser encrypts the amount with AES-256-GCM and wraps the key with RSA-OAEP-2048, bound to one auction."],
  ["Commit", ["keccak-256"], "Every accepted bid extends one ordered keccak-256 digest, so the whole set is pinned on chain before anyone ranks it."],
  ["Rank", ["NEAR", "OutLayer"], "After the close, Aurora reaches a NEAR adapter by cross-contract call and the solver ranks the set in an OutLayer TEE worker."],
  ["Settle", ["Aurora", "ERC-1155", "Foundry"], "Deposits, the asset token and the final payment stay in one Aurora contract, covered by Foundry tests. Each lot is one ERC-1155 token."],
] as const;

/** Four panels; the one in focus opens, rises and shows its drawing. */
export function PartsAccordion() {
  const [on, setOn] = useState(0);
  return (
    <div className="acc">
      {GROUPS.map(([title, parts, text], i) => (
        <article key={title} className="acc-item" data-on={i === on || undefined} onMouseEnter={() => setOn(i)}>
          <button type="button" className="acc-head" aria-expanded={i === on} onClick={() => setOn(i)} onFocus={() => setOn(i)}>
            <h3>{title}</h3><span>{i + 1} of {GROUPS.length}</span>
          </button>
          <p className="acc-text">{text}</p>
          <ul className="acc-parts">{parts.map((p) => <li key={p}>{p}</li>)}</ul>
          <div className="acc-art" aria-hidden="true">
            <svg viewBox="-130 -95 260 190" focusable="false"><Glyph k={i as 0 | 1 | 2 | 3} /></svg>
          </div>
        </article>
      ))}
    </div>
  );
}
