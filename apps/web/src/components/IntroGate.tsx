"use client";
import { useEffect } from "react";

const MIN = 1800; // ms after navigation: long enough for the envelope to fly into the window
const LATE = 3400; // past this the CSS fallback in globals.css opens the intro by itself (at 3.6 s)

/** Opens the first-visit intro once fonts are in and the hero has painted its clouds and envelope. */
export function IntroGate() {
  useEffect(() => {
    const root = document.documentElement;
    if (root.hasAttribute("data-seen") || root.hasAttribute("data-open")) return;
    let fonts = !document.fonts, timer = 0;
    document.fonts?.ready.then(() => { fonts = true; });
    const start = performance.now();
    const painted = () => Array.from(document.querySelectorAll<HTMLCanvasElement>(".hero canvas.stipple")).every((c) => !c.clientWidth || c.hasAttribute("data-ready"));
    const tick = () => {
      const t = performance.now();
      if (t > LATE) return;
      if (t >= MIN && ((fonts && painted()) || t - start > 1800)) root.setAttribute("data-open", "");
      else timer = window.setTimeout(tick, 60);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);
  return null;
}
