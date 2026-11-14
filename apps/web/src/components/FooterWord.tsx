"use client";
import { useEffect, useRef } from "react";

const HOLD = 1100; // ms the wordmark stays on screen after the user stops scrolling, before the page springs back
const FRAME = 14; // px of sky left under the panel when the page rests (matches .footer padding)

/** The page ends at the footer panel. Scrolling past it reveals the wordmark in the clouds, then the page eases back. */
export function FooterWord() {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const word = ref.current, panel = word?.parentElement?.querySelector<HTMLElement>(".footer-panel");
    if (!word || !panel) return;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let timer = 0;
    const rest = () => Math.max(0, panel.getBoundingClientRect().bottom + scrollY + FRAME - innerHeight);
    const onScroll = () => {
      const limit = rest();
      word.toggleAttribute("data-on", scrollY > limit + 24);
      clearTimeout(timer);
      timer = window.setTimeout(() => { if (scrollY > rest() + 2) scrollTo({ top: rest(), behavior: reduce ? "auto" : "smooth" }); }, HOLD);
    };
    addEventListener("scroll", onScroll, { passive: true });
    return () => { removeEventListener("scroll", onScroll); clearTimeout(timer); };
  }, []);
  return (
    <p ref={ref} className="footer-word" aria-hidden="true">
      {"MaskBid".split("").map((c, i) => <span key={i} style={{ "--i": i } as React.CSSProperties}>{c}</span>)}
    </p>
  );
}
