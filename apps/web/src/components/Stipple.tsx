"use client";
import { useEffect, useRef } from "react";
import { paintCloud, paintFlight, paintScene, rng } from "@/lib/stipple";

const PAINT = { cloud: paintCloud, flight: paintFlight, scene: paintScene };

/** A canvas painted once with stippled dots when it comes near the viewport, and again if its size changes a lot. Size it with CSS. */
export function Stipple({ kind, seed = 1, className }: { kind: keyof typeof PAINT; seed?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    let painted = 0, near = false;
    const draw = () => {
      const w = c.clientWidth, h = c.clientHeight;
      if (!near || !w || !h || (painted && Math.abs(w - painted) < painted * 0.15)) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      painted = w;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      PAINT[kind](ctx, w, h, rng(seed));
      c.dataset.ready = "";
    };
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { near = true; draw(); io.disconnect(); } }, { rootMargin: "400px" });
    const ro = new ResizeObserver(draw);
    io.observe(c);
    ro.observe(c);
    return () => { io.disconnect(); ro.disconnect(); };
  }, [kind, seed]);
  return <canvas ref={ref} className={`stipple ${className ?? ""}`} aria-hidden="true" />;
}
