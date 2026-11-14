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

  seal(ctx, 0, H * 0.18, W * 0.115);
  ctx.restore();
}

const NAVY = "#2e4058", PEACH = "#f3b89b", EDGE = "rgba(186, 126, 108, .5)";

/** The MaskBid mark as a wax seal. Every lot object carries one, so each reads as sealed. */
function seal(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fillStyle = NAVY; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r * 0.64, 0, 6.2832); ctx.strokeStyle = PEACH; ctx.lineWidth = Math.max(1.2, r * 0.113); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r * 0.64, -Math.PI / 2, Math.PI / 2); ctx.closePath(); ctx.fillStyle = PEACH; ctx.fill();
}

/** Pointillist shading over a box, inside whatever clip is set: `shade` and `light` give the chance of a dark or a white dot at u,v (0..1). */
function shadeBox(ctx: Ctx, x0: number, y0: number, w: number, h: number, rnd: Rnd, shade: (u: number, v: number) => number, light?: (u: number, v: number) => number, dark = ["#c4a6d6", "#e3a597"], bright = "#ffffff") {
  const ink = new Ink(), s = 1.6;
  for (let gy = y0; gy < y0 + h; gy += s) {
    for (let gx = x0; gx < x0 + w; gx += s) {
      const px = gx + (rnd() - 0.5) * s, py = gy + (rnd() - 0.5) * s, u = (px - x0) / w, v = (py - y0) / h;
      if (rnd() < shade(u, v)) ink.dot(px, py, 0.6 + rnd() * 0.35, dark[rnd() < 0.55 ? 0 : 1]);
      else if (light && rnd() < light(u, v)) ink.dot(px, py, 0.55 + rnd() * 0.3, bright);
    }
  }
  ink.paint(ctx);
}
// the envelope's light: from the top left, so shadow gathers at the bottom left
const lowLeft = (u: number, v: number) => Math.max(0, v * 0.75 + (1 - u) * 0.3 - 0.56) * 1.25;

/** A round wristwatch on a navy strap, about W tall, centred at cx,cy. */
export function watch(ctx: Ctx, cx: number, cy: number, W: number, angle: number, rnd: Rnd) {
  const R = W * 0.27, sw = R * 1.04, half = W * 0.48;
  const disc = (r: number, fill: string) => { ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.2832); ctx.fillStyle = fill; ctx.fill(); };
  const hand = (clock: number, from: number, to: number, width: number, colour: string) => {
    const t = clock - Math.PI / 2;
    ctx.beginPath(); ctx.moveTo(Math.cos(t) * from, Math.sin(t) * from); ctx.lineTo(Math.cos(t) * to, Math.sin(t) * to);
    ctx.lineWidth = width; ctx.lineCap = "round"; ctx.strokeStyle = colour; ctx.stroke();
  };
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // strap: two tongues behind the case, with a few lighter flecks where the light lands
  ctx.beginPath();
  ctx.roundRect(-sw / 2, -half, sw, half, [sw * 0.3, sw * 0.3, 0, 0]);
  ctx.roundRect(-sw / 2, 0, sw, half, [0, 0, sw * 0.3, sw * 0.3]);
  ctx.fillStyle = NAVY; ctx.fill();
  ctx.save(); ctx.clip();
  shadeBox(ctx, -sw / 2, -half, sw, half * 2, rnd, (u, v) => 0.05 + 0.2 * Math.max(0, 0.7 - u - v * 0.25), undefined, ["#5a7093", "#7f86c9"]);
  ctx.restore();
  for (const y of [0.62, 0.74, 0.86]) { ctx.beginPath(); ctx.arc(0, half * y, sw * 0.055, 0, 6.2832); ctx.fillStyle = "#1c2a3d"; ctx.fill(); }

  // crown, case, diver's bezel
  ctx.beginPath(); ctx.roundRect(R * 0.93, -R * 0.13, R * 0.22, R * 0.26, R * 0.06); ctx.fillStyle = "#efbea9"; ctx.fill(); ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
  disc(R, "#f7d3c1");
  ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
  disc(R * 0.9, NAVY);
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * 6.2832 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(Math.cos(t) * R * 0.8, Math.sin(t) * R * 0.8, R * (i ? 0.022 : 0.05), 0, 6.2832); ctx.fillStyle = PEACH; ctx.fill();
  }

  // dial, shaded like the envelope
  disc(R * 0.7, "#fff6ea");
  ctx.save(); ctx.clip();
  shadeBox(ctx, -R * 0.7, -R * 0.7, R * 1.4, R * 1.4, rnd, lowLeft, (u, v) => 0.16 * Math.max(0, u - v));
  ctx.restore();
  for (let i = 0; i < 12; i++) hand((i / 12) * 6.2832, R * (i % 3 ? 0.58 : 0.52), R * 0.63, R * (i % 3 ? 0.026 : 0.045), NAVY);
  hand((10 + 10 / 60) / 12 * 6.2832, 0, R * 0.34, R * 0.075, NAVY); // ten past ten
  hand((10 / 60) * 6.2832, 0, R * 0.52, R * 0.05, NAVY);
  hand(0.62 * 6.2832, -R * 0.12, R * 0.56, R * 0.02, "#d9825e");
  seal(ctx, 0, 0, R * 0.12);
  ctx.restore();
}

/** A framed picture of the evening sky, W wide, centred at cx,cy. */
export function framed(ctx: Ctx, cx: number, cy: number, W: number, angle: number, rnd: Rnd) {
  const H = W * 0.78, f = W * 0.075, m = W * 0.035, x0 = -W / 2, y0 = -H / 2, x1 = W / 2, y1 = H / 2;
  const poly = (pts: number[][], fill: string) => {
    ctx.beginPath();
    pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // frame: four bevels, lit from the top left
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x0, y0, W, H, W * 0.022); ctx.clip();
  poly([[x0, y0], [x1, y0], [x1 - f, y0 + f], [x0 + f, y0 + f]], "#fdebe0");
  poly([[x0, y0], [x0 + f, y0 + f], [x0 + f, y1 - f], [x0, y1]], "#f7d3c1");
  poly([[x1, y0], [x1, y1], [x1 - f, y1 - f], [x1 - f, y0 + f]], "#f0c2ac");
  poly([[x0, y1], [x0 + f, y1 - f], [x1 - f, y1 - f], [x1, y1]], "#e8b19a");
  shadeBox(ctx, x0, y0, W, H, rnd, (u, v) => lowLeft(u, v) * 0.9, (u, v) => 0.2 * Math.max(0, 0.5 - v));
  ctx.restore();
  ctx.beginPath(); ctx.roundRect(x0, y0, W, H, W * 0.022); ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();

  // mat, then the picture: a small evening sky with its own clouds
  ctx.fillStyle = "#fff8ee"; ctx.fillRect(x0 + f, y0 + f, W - 2 * f, H - 2 * f);
  const px = x0 + f + m, py = y0 + f + m, pw = W - 2 * (f + m), ph = H - 2 * (f + m);
  ctx.save();
  ctx.beginPath(); ctx.rect(px, py, pw, ph); ctx.clip();
  const sky = ctx.createLinearGradient(0, py, 0, py + ph);
  sky.addColorStop(0, "#c3c7f1"); sky.addColorStop(0.42, "#e6c4d6"); sky.addColorStop(0.72, "#f5c2a4"); sky.addColorStop(1, "#f9e3c2");
  ctx.fillStyle = sky; ctx.fillRect(px, py, pw, ph);
  ctx.beginPath(); ctx.arc(px + pw * 0.68, py + ph * 0.5, pw * 0.085, 0, 6.2832); ctx.fillStyle = "#fff5dd"; ctx.fill();
  cloud(ctx, px - pw * 0.12, py + ph * 0.52, pw * 1.24, ph * 0.62, rnd);
  cloud(ctx, px + pw * 0.08, py + ph * 0.1, pw * 0.38, ph * 0.26, rnd);
  ctx.restore();
  ctx.strokeStyle = "rgba(186, 126, 108, .35)"; ctx.lineWidth = 1;
  ctx.strokeRect(px, py, pw, ph);
  ctx.strokeRect(x0 + f, y0 + f, W - 2 * f, H - 2 * f);

  seal(ctx, x1 - f * 1.05, y1 - f * 1.05, W * 0.075);
  ctx.restore();
}

/** A collector's pass: a navy card with a band of foil and a row of byte dots, a second card behind it. W wide, centred at cx,cy. */
export function pass(ctx: Ctx, cx: number, cy: number, W: number, angle: number, rnd: Rnd) {
  const H = W * 0.63, r = W * 0.07, x0 = -W / 2, y0 = -H / 2;
  const card = () => { ctx.beginPath(); ctx.roundRect(x0, y0, W, H, r); };
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  ctx.save(); // the card behind
  ctx.translate(W * 0.05, -H * 0.13); ctx.rotate(0.15);
  card(); ctx.fillStyle = "#f7d3c1"; ctx.fill();
  ctx.save(); ctx.clip();
  shadeBox(ctx, x0, y0, W, H, rnd, lowLeft, (u, v) => 0.18 * Math.max(0, 0.6 - v));
  ctx.restore();
  card(); ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();

  card(); ctx.fillStyle = NAVY; ctx.fill();
  ctx.save(); ctx.clip();
  // foil: a diagonal band stippled in the sky's colours, plus a few flecks across the card
  const ink = new Ink(), s = 1.7;
  for (let gy = y0; gy < y0 + H; gy += s) {
    for (let gx = x0; gx < x0 + W; gx += s) {
      const px = gx + (rnd() - 0.5) * s, py = gy + (rnd() - 0.5) * s;
      const d = ((px - x0) / W) * 0.78 - ((py - y0) / H) * 0.4; // leans away from the mark and the byte dots
      const t = (d - 0.2) / 0.32;
      if (t > 0 && t < 1) { if (rnd() < 0.2 + 0.62 * Math.sin(t * Math.PI)) ink.dot(px, py, 0.6 + rnd() * 0.4, CLOUD[clamp(Math.round(t * 6 + (rnd() - 0.5) * 2), 0, 6)]); }
      else if (rnd() < 0.03) ink.dot(px, py, 0.5 + rnd() * 0.3, "#5a7093");
    }
  }
  ink.paint(ctx);
  ctx.restore();
  card(); ctx.strokeStyle = "rgba(244, 242, 232, .22)"; ctx.lineWidth = 1; ctx.stroke();

  seal(ctx, x0 + W * 0.15, y0 + H * 0.25, W * 0.085);
  const dots = new Ink(); // three rows of byte dots, like a sealed bid
  for (let row = 0; row < 3; row++) for (let col = 0; col < 9; col++) dots.dot(x0 + W * (0.09 + col * 0.045), y0 + H * (0.66 + row * 0.085), W * 0.012, `rgba(243, 184, 155, ${(0.25 + 0.75 * rnd()).toFixed(2)})`);
  dots.paint(ctx);
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

/** Picture for a lot without photographs: a bank of cloud, a small cloud and the lot's object above them, arranged by the seed.
    The envelope flies with its trail; the other objects float, turned half as far. */
function scene(ctx: Ctx, w: number, h: number, rnd: Rnd, object: typeof envelope) {
  const left = rnd() < 0.5;
  cloud(ctx, -0.12 * w, 0.5 * h, 1.24 * w, 0.56 * h, rnd);
  cloud(ctx, left ? 0.04 * w : 0.58 * w, 0.06 * h, 0.38 * w, 0.2 * h, rnd);
  const W = Math.min(0.42 * w, 0.62 * h), cx = left ? 0.6 * w : 0.42 * w, cy = 0.44 * h, a = -0.18 - rnd() * 0.26;
  if (object === envelope) trail(ctx, cx - Math.cos(a) * W * 0.38, cy - Math.sin(a) * W * 0.38 + W * 0.06, cx - 0.55 * w, h * 1.02, W * 0.08, W * 0.42, Math.round(w * h * 0.045), rnd);
  object(ctx, cx, cy, W, object === envelope ? a : a / 2, rnd);
}
export const paintScene = (ctx: Ctx, w: number, h: number, rnd: Rnd) => scene(ctx, w, h, rnd, envelope);
export const paintWatch = (ctx: Ctx, w: number, h: number, rnd: Rnd) => scene(ctx, w, h, rnd, watch);
export const paintArt = (ctx: Ctx, w: number, h: number, rnd: Rnd) => scene(ctx, w, h, rnd, framed);
export const paintPass = (ctx: Ctx, w: number, h: number, rnd: Rnd) => scene(ctx, w, h, rnd, pass);
