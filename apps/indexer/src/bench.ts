// T-PERF-01 / NFR-01 and NFR-02, measured against a running web app and indexer worker.
//   NFR-01  p95 of 100 warm catalog requests (no RPC in the read path)
//   NFR-02  index lag = chain head time minus the time of the block the checkpoint stands on, sampled 10 times
import { readFileSync, writeFileSync } from "node:fs";
import { client } from "./lib.ts";

const web = process.env.WEB_URL ?? "http://localhost:3001";
const pct = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)];
const get = async (path: string) => { const t = performance.now(); const r = await fetch(web + path); const body = await r.json(); if (!r.ok) throw new Error(`${path} -> ${r.status} ${JSON.stringify(body)}`); return { ms: performance.now() - t, body }; };

for (let i = 0; i < 5; i++) await get("/api/index/auctions"); // warm
const ms: number[] = [];
let lots = 0;
for (let i = 0; i < 100; i++) { const r = await get("/api/index/auctions"); ms.push(r.ms); lots = r.body.auctions.length; }

const lag: number[] = [];
for (let i = 0; i < 10; i++) {
  const [{ body }, head] = await Promise.all([get("/api/index/status"), client.getBlock()]);
  lag.push(Number(head.timestamp - (await client.getBlock({ blockNumber: BigInt(body.block) })).timestamp));
  await new Promise((r) => setTimeout(r, 2500));
}
const bench = { measuredAt: new Date().toISOString(), web, catalog: { requests: ms.length, concurrency: 1, lots, p50Ms: Math.round(pct(ms, 0.5)), p95Ms: Math.round(pct(ms, 0.95)), maxMs: Math.round(Math.max(...ms)) }, lagSeconds: { samples: lag.length, p50: pct(lag, 0.5), max: Math.max(...lag) } };
console.log(JSON.stringify(bench, null, 2));
if (process.env.EVIDENCE) writeFileSync(process.env.EVIDENCE, JSON.stringify({ ...JSON.parse(readFileSync(process.env.EVIDENCE, "utf8")), bench }, null, 2) + "\n");
process.exit(0);
