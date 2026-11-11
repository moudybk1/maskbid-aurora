// Solver benchmark (blueprint 12 §6): SOLVE for 1 / 3 / 32 bids and key generation, p50/p95 over N samples.
// Native timings only (TypeScript solver on Node, Rust solver in release mode on this machine). This is NOT a TEE
// measurement: OutLayer wall-clock per request is in release/gate-run.json (dispatch -> delivered).
// Usage: node scripts/bench.mjs   (needs cargo on PATH for the Rust half)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "viem";
import { canonicalManifest, domainOf, encryptBid, initialDigest, nextDigest, bidCommitment, requestIdHash, sha256Utf8, solve } from "../packages/protocol/src/index.ts";

const SAMPLES = 20;
const v = JSON.parse(readFileSync(new URL("../packages/protocol/vectors/protocol-vectors.json", import.meta.url), "utf8"));
const pkcs8 = Uint8Array.from(Buffer.from(v.testPrivateKeyPkcs8Pem.replace(/-----[A-Z ]+-----|\s/g, ""), "base64"));
const spki = Uint8Array.from(Buffer.from(v.publicKeySpkiBase64, "base64"));
const dir = join(process.env.BENCH_DIR ?? tmpdir(), "maskbid-bench");
mkdirSync(dir, { recursive: true });

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)].toFixed(2); };
const stats = (xs) => ({ samples: xs.length, p50_ms: pct(xs, 0.5), p95_ms: pct(xs, 0.95) });

async function fixture(n) {
  const base = v.request, domain = domainOf(base), keyId = base.keyId;
  let digest = initialDigest(domain, keyId);
  const bids = [];
  for (let i = 0; i < n; i++) {
    const bidder = `0x${(i + 1).toString(16).padStart(40, "0")}`;
    const { envelope, commitment } = await encryptBid({ spki, domain, bidder, amountUnits: BigInt(100_000_000 + i * 1_000_000), expectedKeyId: keyId });
    digest = nextDigest(digest, BigInt(i), bidder, commitment);
    bids.push({ bidIndex: String(i), bidder, commitment, envelope: bytesToHex(envelope), txHash: `0x${"aa".repeat(32)}`, blockHash: `0x${"bb".repeat(32)}`, blockNumber: "1", logIndex: String(i) });
  }
  const requestId = requestIdHash(domain, digest, BigInt(n), 1, base.configHash);
  const manifest = { protocolVersion: 1, chainId: base.chainId, auctionContract: base.auctionContract, auctionId: base.auctionId, requestId, keyId, bidDigest: digest, bidCount: n, bids };
  const request = { ...base, requestId, bidDigest: digest, bidCount: n, manifestSha256: sha256Utf8(canonicalManifest(manifest)) };
  return { request, manifest };
}

const ts = {};
for (const n of [1, 3, 32]) {
  const f = await fixture(n);
  writeFileSync(join(dir, `bench-${n}.json`), JSON.stringify(f));
  const r = await solve(f.request, f.manifest, pkcs8); // warm-up + sanity: highest amount wins
  if (r.outcome !== "WINNER" || r.winningAmountUnits !== String(100_000_000 + (n - 1) * 1_000_000)) throw new Error(`bench fixture ${n} solved wrongly`);
  const t = [];
  for (let i = 0; i < SAMPLES; i++) { const t0 = performance.now(); await solve(f.request, f.manifest, pkcs8); t.push(performance.now() - t0); }
  ts[`solve_${n}_bids`] = stats(t);
}

let rust = null;
try {
  execFileSync("cargo", ["test", "--release", "--test", "bench", "--", "--ignored", "--nocapture"], { cwd: new URL("../apps/private-solver/", import.meta.url), env: { ...process.env, BENCH_DIR: dir, BENCH_SAMPLES: String(SAMPLES) }, stdio: "inherit" });
  rust = JSON.parse(readFileSync(join(dir, "rust.json"), "utf8"));
} catch (e) { console.error("rust bench skipped:", e.message.split("\n")[0]); }

const out = { at: new Date().toISOString(), machine: `${process.platform}/${process.arch} node ${process.version}`, note: "native timings, not TEE; OutLayer end-to-end latency is in release/gate-run.json", typescript: ts, rust };
writeFileSync(new URL("../release/bench.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
