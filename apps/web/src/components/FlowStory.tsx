"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";

export const FLOW = [
  ["Lock and seal", "Your deposit and the encrypted bid travel in one transaction. The receipt's commitment is checked against the one your browser computed."],
  ["Commit the set", "Every accepted bid extends one ordered keccak digest, so the complete set is pinned on chain before anyone ranks it."],
  ["Rank privately", "After the close the solver decrypts the whole set and ranks it. A missing or altered bid stops the run; there is never a partial winner."],
  ["Settle at once", "The winner pays the remainder and receives the token in the same transaction. Every other deposit is refundable right away."],
] as const;

/** Line drawings for the four stages, centred on 0,0. Shared by the story diagram and the parts accordion. */
export function Glyph({ k }: { k: 0 | 1 | 2 | 3 }) {
  if (k === 0) return (
    <g className="glyph" filter="url(#mb-glow)">
      <rect x="-50" y="-33" width="100" height="66" rx="7" />
      <path d="M-50 -31 L0 7 L50 -31 M-50 33 L-13 4 M50 33 L13 4" />
      <circle cx="0" cy="7" r="11" className="hot" />
    </g>
  );
  if (k === 1) return (
    <g className="glyph" filter="url(#mb-glow)">
      {[-93, -45, 3].map((x) => <rect key={x} x={x} y="-15" width="40" height="30" rx="6" />)}
      <path d="M-53 0 h8 M-5 0 h8 M43 0 h8" />
      <rect x="51" y="-15" width="40" height="30" rx="6" className="hot" />
    </g>
  );
  if (k === 2) return (
    <g className="glyph" filter="url(#mb-glow)">
      <circle r="78" className="halo" />
      <circle r="64" className="orb" />
      <circle r="60" className="dots" />
      <path d="M-64 0 a64 22 0 0 0 128 0" className="faint" />
    </g>
  );
  return (
    <g className="glyph" filter="url(#mb-glow)">
      <circle r="38" />
      <circle r="27" />
      <path d="M-11 0 L-3 9 L13 -9" className="hot-line" />
    </g>
  );
}

const NODES = [[160, 305, "Sealed bid", 100, -64], [405, 140, "Ordered digest", 130, -48], [650, 305, "Solver", 76, -100], [405, 470, "Settlement", 108, 64]] as const;

function FlowDiagram() {
  return (
    <svg className="story-svg" viewBox="0 0 800 600" aria-hidden="true" focusable="false">
      <g className="scene">
        <ellipse cx="405" cy="305" rx="245" ry="165" className="orbit" filter="url(#mb-glow)" />
        <circle r="5" className="orbit-dot" filter="url(#mb-glow)">
          <animateMotion dur="9s" repeatCount="indefinite" path="M160,305 A245,165 0 1,1 650,305 A245,165 0 1,1 160,305" />
        </circle>
        {NODES.map(([x, y, label, w, ly], i) => (
          <g key={label} className={`node n${i}`} transform={`translate(${x} ${y})`}>
            <Glyph k={i as 0 | 1 | 2 | 3} />
            <g className="tag" transform={`translate(0 ${ly})`}>
              <rect x={-w / 2} y="-15" width={w} height="30" rx="15" />
              <text textAnchor="middle" dy="5">{label}</text>
            </g>
          </g>
        ))}
      </g>
    </svg>
  );
}

/** The four stages as a pinned scroll story: the section holds still while scrolling moves through the stages,
    the copy swaps to the stage being read and the diagram turns to it. */
export function FlowStory() {
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect(), span = r.height - window.innerHeight;
      const p = span > 0 ? Math.min(0.999, Math.max(0, -r.top / span)) : 0;
      setAt(Math.floor(p * FLOW.length));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); cancelAnimationFrame(raf); };
  }, []);
  return (
    <section ref={ref} id="how" className="story" aria-labelledby="flow-title" style={{ "--steps": FLOW.length } as CSSProperties}>
      <div className="story-pin">
        <div className="container story-in">
          <div className="story-head">
            <p className="eyebrow">How it works</p>
            <h2 id="flow-title">From sealed bid to settled lot</h2>
          </div>
          <ol className="story-steps">
            {FLOW.map(([title, text], i) => (
              <li key={title} data-on={i === at || undefined} aria-current={i === at ? "step" : undefined}>
                <span className="story-n" aria-hidden="true">{i + 1}</span>
                <div className="story-detail"><div><h3>{title}</h3><p>{text}</p></div></div>
              </li>
            ))}
          </ol>
          <div className="story-stage" data-step={at}><FlowDiagram /></div>
        </div>
      </div>
    </section>
  );
}
