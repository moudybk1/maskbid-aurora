/* Stipple painter: pastel cumulus, a sealed envelope and its trail, drawn as thousands of small dots like a pointillist print.
   Pure canvas code, deterministic per seed, no assets. */

export type Rnd = () => number;
type Ctx = CanvasRenderingContext2D;

/** mulberry32 */
export function rng(seed: number): Rnd {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(x: number, y: number, s: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** smooth value noise in 0..1 */
function noise(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Dots grouped by colour so each colour is one fill call. */
class Ink {
  private paths = new Map<string, Path2D>();
  dot(x: number, y: number, r: number, c: string) {
    let p = this.paths.get(c);
    if (!p) { p = new Path2D(); this.paths.set(c, p); }
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, 6.2832);
  }
  paint(ctx: Ctx) {
    for (const [c, p] of this.paths) { ctx.fillStyle = c; ctx.fill(p); }
    this.paths.clear();
  }
}

// shadow → highlight
const CLOUD = ["#7a81d3", "#9893dc", "#bfa3db", "#e9b0a6", "#f5c6aa", "#fde0c2", "#fff6e8"];
const GOLD = ["#fffaf0", "#fff0c2", "#ffe39a", "#ffd583", "#f6c0a0"];
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** A cumulus (or a low bank when the box is wide) filling the box x,y,w,h, lit from the top left. */
export function cloud(ctx: Ctx, x: number, y: number, w: number, h: number, rnd: Rnd) {
  const bank = w / h > 2.6;
  const base = y + h * 0.8;
  const puffs: [number, number, number][] = [];
  const n = bank ? 9 + Math.floor(rnd() * 3) : 6 + Math.floor(rnd() * 2);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n, mid = 1 - Math.abs(t - 0.5) * 1.3;
    const r = h * (bank ? 0.15 + 0.09 * rnd() : 0.14 + 0.07 * rnd()) * (0.6 + 0.5 * mid);
    puffs.push([x + w * (0.08 + 0.84 * t) + (rnd() - 0.5) * w * 0.04, base - r * 0.5, r]);
  }
  const m = 3 + Math.floor(rnd() * (bank ? 3 : 2));
  for (let j = 0; j < m; j++) {
    const t = bank ? 0.15 + 0.7 * rnd() : 0.28 + 0.44 * rnd();
    const r = h * (bank ? 0.2 + 0.1 * rnd() : 0.27 + 0.1 * rnd()) * (1 - Math.abs(t - 0.5) * 0.8);
    puffs.push([x + w * t, Math.max(y + r + 2, base - r * (0.9 + 0.5 * rnd())), r]);
  }

  const s = 1.9, fq = 5 / h, ns = Math.floor(rnd() * 1e6);
  const ink = new Ink();
  for (let gy = y; gy < y + h; gy += s) {
    for (let gx = x; gx < x + w; gx += s) {
      const px = gx + (rnd() - 0.5) * s * 0.9, py = gy + (rnd() - 0.5) * s * 0.9;
      let f = -1, o = 0;
      for (let i = 0; i < puffs.length; i++) {
        const p = puffs[i], v = 1 - Math.hypot(px - p[0], py - p[1]) / p[2];
        if (v > f) { f = v; o = i; }
      }
      if (f < -0.3) continue;
      f += (noise(px * fq, py * fq, ns) - 0.5) * 0.3 + (noise(px * fq * 3, py * fq * 3, ns + 1) - 0.5) * 0.14;
      if (py > base) f -= (py - base) / (h * 0.1);
      if (f < -0.06) continue;
      if (rnd() > (f > 0 ? Math.min(0.94, 0.3 + f * 3.2) : 0.05)) continue;
      const [cx, cy, r] = puffs[o];
      const nx = (px - cx) / r, ny = (py - cy) / r, nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lam = -0.32 * nx - 0.78 * ny + 0.54 * nz;
      // mostly lit by height in the whole cloud, a little by the bump it sits on
      const t = clamp(0.5 + 0.3 * lam - 0.8 * ((py - y) / h - 0.5), 0, 1);
      ink.dot(px, py, 0.7 + rnd() * 0.45, CLOUD[clamp(Math.round(t * 6 + (rnd() - 0.5) * 1.8), 0, 6)]);
    }
  }
  ink.paint(ctx);
}

/** Golden dust from (x0,y0) widening toward (x1,y1). */
export function trail(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, count: number, rnd: Rnd) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  const ink = new Ink();
  for (let i = 0; i < count; i++) {
    const u = Math.pow(rnd(), 1.6);
    if (rnd() < u * 0.6) continue;
    const g = (rnd() + rnd() + rnd() - 1.5) / 1.5;
    const half = w0 + (w1 - w0) * u;
    const px = x0 + ux * len * u - uy * g * half, py = y0 + uy * len * u + ux * g * half;
    ink.dot(px, py, 0.55 + rnd() * 0.75 * (1 - u * 0.5), GOLD[clamp(Math.round(Math.abs(g) * 2.6 + u * 1.4 + (rnd() - 0.5)), 0, 4)]);
  }
  ink.paint(ctx);
}

/** An envelope closed with a wax seal bearing the MaskBid mark, W wide, centred at cx,cy, turned by angle (radians). */
export function envelope(ctx: Ctx, cx: number, cy: number, W: number, angle: number, rnd: Rnd) {
  const H = W * 0.64, x0 = -W / 2, x1 = W / 2, y0 = -H / 2, y1 = H / 2, rr = W * 0.035;
  const poly = (pts: number[][], fill: string) => {
    ctx.beginPath();
    pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  const body = () => { ctx.beginPath(); ctx.roundRect(x0, y0, W, H, rr); };
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  body(); ctx.fillStyle = "#fbe4d7"; ctx.fill();
  ctx.save(); body(); ctx.clip();
  poly([[x0, y0], [-W * 0.04, H * 0.1], [x0, y1]], "#f7d3c1");
  poly([[x1, y0], [W * 0.04, H * 0.1], [x1, y1]], "#f3c9b5");
  poly([[x0, y1], [0, -H * 0.02], [x1, y1]], "#efbea9");
  poly([[x0, y0], [0, H * 0.2], [x1, y0]], "#fff2e8");
  // stipple shading: lavender and rose in the lower left, white on the top flap
  const ink = new Ink(), s = 1.6;
  for (let gy = y0; gy < y1; gy += s) {
    for (let gx = x0; gx < x1; gx += s) {
      const px = gx + (rnd() - 0.5) * s, py = gy + (rnd() - 0.5) * s;
      const u = (px - x0) / W, v = (py - y0) / H;
      const flap = py < y0 + H * 0.7 * (1 - Math.abs(px) / x1);
      const shadow = Math.max(0, v * 0.75 + (1 - u) * 0.3 - (flap ? 0.62 : 0.5)) * 1.25;
      if (rnd() < shadow) ink.dot(px, py, 0.6 + rnd() * 0.35, rnd() < 0.55 ? "#c4a6d6" : "#e3a597");
      else if (flap && rnd() < 0.22 * (1 - v)) ink.dot(px, py, 0.55 + rnd() * 0.3, "#ffffff");
    }
  }
  ink.paint(ctx);
  ctx.restore();

  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(186, 126, 108, .5)";
  ctx.beginPath(); ctx.moveTo(x0 + 1, y0 + 1); ctx.lineTo(0, H * 0.2); ctx.lineTo(x1 - 1, y0 + 1); ctx.stroke();
  ctx.strokeStyle = "rgba(186, 126, 108, .35)";
  body(); ctx.stroke();

  const sr = W * 0.115, sy = H * 0.18;
  ctx.beginPath(); ctx.arc(0, sy, sr, 0, 6.2832); ctx.fillStyle = "#2e4058"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, sy, sr * 0.64, 0, 6.2832); ctx.strokeStyle = "#f3b89b"; ctx.lineWidth = Math.max(1.2, W * 0.013); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, sy, sr * 0.64, -Math.PI / 2, Math.PI / 2); ctx.closePath(); ctx.fillStyle = "#f3b89b"; ctx.fill();
  ctx.restore();
}

/* Compositions, each filling a w×h canvas. */

export function paintCloud(ctx: Ctx, w: number, h: number, rnd: Rnd) {
  cloud(ctx, 0, 0, w, h, rnd);
}

/** The envelope flying up to the right, its trail falling away to the bottom left. */
export function paintFlight(ctx: Ctx, w: number, h: number, rnd: Rnd) {
  const W = w * 0.34, cx = w * 0.72, cy = h * 0.3, a = -0.34;
  trail(ctx, cx - Math.cos(a) * W * 0.38, cy - Math.sin(a) * W * 0.38 + W * 0.06, w * 0.02, h * 0.98, W * 0.09, W * 0.5, Math.round(w * h * 0.07), rnd);
  envelope(ctx, cx, cy, W, a, rnd);
}

/** Stand-in picture for a lot: a bank of cloud, a small cloud and a sealed envelope in flight, arranged by the seed. */
export function paintScene(ctx: Ctx, w: number, h: number, rnd: Rnd) {
  const left = rnd() < 0.5;
  cloud(ctx, -0.12 * w, 0.5 * h, 1.24 * w, 0.56 * h, rnd);
  cloud(ctx, left ? 0.04 * w : 0.58 * w, 0.06 * h, 0.38 * w, 0.2 * h, rnd);
  const W = Math.min(0.42 * w, 0.62 * h), cx = left ? 0.6 * w : 0.42 * w, cy = 0.44 * h, a = -0.18 - rnd() * 0.26;
  trail(ctx, cx - Math.cos(a) * W * 0.38, cy - Math.sin(a) * W * 0.38 + W * 0.06, cx - 0.55 * w, h * 1.02, W * 0.08, W * 0.42, Math.round(w * h * 0.045), rnd);
  envelope(ctx, cx, cy, W, a, rnd);
}
