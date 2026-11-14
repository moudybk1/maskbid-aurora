import { useId } from "react";
import { keccak256, type Hex } from "viem";
import { Stipple } from "./Stipple";

/** Bytes drawn as dots, opacity = byte value. A sealed bid is 490 of them. `glow` paints them in the sky colours. */
export function Dots({ hex, cols, className, label, glow }: { hex: string; cols: number; className?: string; label?: string; glow?: boolean }) {
  const id = `g${useId().replace(/[^\w-]/g, "")}`;
  const bytes = hex.replace(/^0x/, "").match(/../g) ?? [];
  const w = cols * 10, h = Math.ceil(bytes.length / cols) * 10;
  return (
    <svg className={`dots ${className ?? ""}`} viewBox={`0 0 ${w} ${h}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {glow && (
        <defs>
          <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={w} y2={h}>
            <stop offset="0" stopColor="#7d84d6" /><stop offset=".5" stopColor="#de8a66" /><stop offset="1" stopColor="#2e4058" />
          </linearGradient>
        </defs>
      )}
      <g fill={glow ? `url(#${id})` : "var(--accent)"}>
        {bytes.map((b, i) => <circle key={i} cx={(i % cols) * 10 + 5} cy={Math.floor(i / cols) * 10 + 5} r={3.4} opacity={0.1 + (0.9 * parseInt(b, 16)) / 255} />)}
      </g>
    </svg>
  );
}

/** Stretch a 32-byte hash to n bytes by chaining keccak. */
export function expandHash(seed: Hex, n: number): Hex {
  let out = "", h = seed;
  while (out.length < n * 2) { out += h.slice(2); h = keccak256(h); }
  return `0x${out.slice(0, n * 2)}`;
}

// The object painted for each asset category; anything else keeps the sealed envelope.
const OBJECT: Record<string, "watch" | "art" | "pass"> = { watch: "watch", art: "art", digital_collectible: "pass" };

/** Picture for an asset without images: stippled clouds and the category's object, arranged by the asset's own hash. */
export function AssetArt({ seed, category }: { seed: string; category?: string; large?: boolean }) {
  const n = parseInt(seed.replace(/^0x/, "").slice(0, 8).padEnd(8, "0"), 16) || 1;
  return <div className="art" aria-hidden="true"><Stipple kind={OBJECT[category ?? ""] ?? "scene"} seed={n} /></div>;
}

export function BrandMark() {
  return (
    <svg viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="10.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M13 2.5a10.5 10.5 0 0 1 0 21z" fill="var(--accent)" />
    </svg>
  );
}
