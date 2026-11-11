// End-to-end private-path latency from Aurora testnet logs: KeyRequested -> KeyPrepared and SettlementRequested ->
// SettlementAccepted (the accepted request only), block-timestamp resolution. Writes release/latency.json.
// Usage: node scripts/latency.mjs   (read-only, no keys needed)
import { writeFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { auctionAbi, chainFor, deployments } from "../packages/contracts/src/index.ts";

const chainId = 1313161555, rpc = "https://testnet.aurora.dev", d = deployments[String(chainId)];
const pub = createPublicClient({ chain: chainFor(chainId, rpc), transport: http(rpc) });
const get = (eventName) => pub.getContractEvents({ address: d.auction, abi: auctionAbi, eventName, fromBlock: BigInt(d.deployBlock) });
const ts = async (log) => Number((await pub.getBlock({ blockNumber: log.blockNumber })).timestamp);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const stats = (xs) => ({ samples: xs.length, min_s: Math.min(...xs), p50_s: pct(xs, 0.5), p95_s: pct(xs, 0.95), max_s: Math.max(...xs), values_s: xs });

const keyReq = new Map((await get("KeyRequested")).map((l) => [l.args.keyRequestId, l]));
const keyOk = await get("KeyPrepared");
const keyLat = [];
for (const l of keyOk) { const q = keyReq.get(l.args.keyRequestId); if (q) keyLat.push((await ts(l)) - (await ts(q))); }

const reqs = new Map((await get("SettlementRequested")).map((l) => [l.args.requestId, l]));
const settleLat = [];
for (const l of await get("SettlementAccepted")) { const q = reqs.get(l.args.requestId); if (q) settleLat.push((await ts(l)) - (await ts(q))); }

const out = { at: new Date().toISOString(), chainId, auction: d.auction, keyPreparation: stats(keyLat), settlement: stats(settleLat), note: "includes the keeper manifest hop (poll 6 s), OutLayer queue and TEE run, and the Aurora callback" };
writeFileSync(new URL("../release/latency.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
