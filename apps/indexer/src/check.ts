// The indexer's one runnable check (spec 12: T-INDEX-01, T-INDEX-02, plus the write boundary of spec 08 §7).
// Stop the worker first: this takes the leader lock, catches up, then
//   1. compares every projection with the contract views (auctions, bids, assets, balances, keys, credits, totals)
//   2. ingests the whole range a second time: nothing may be applied twice
//   3. drops the projections and replays the stored events: the result must be identical
//   4. forgets everything and ingests from the chain again (the reorg path): identical again
//   5. checks that the API login cannot write a projection
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { zeroAddress, zeroHash } from "viem";
import { assetAbi, auctionAbi } from "@maskbid/contracts";
import { AUCTION_STATES, DEPOSIT_STATUSES } from "@maskbid/protocol";
import { assertDeployment, asset, auction, chainId, client, deployment, ingest, lead, pool, readCheckpoint, replay, reset } from "./lib.ts";

const CANCEL = [null, "SELLER_CANCELLED", "NO_VALID_BID", "WINNER_DEFAULT", "SOLVER_TIMEOUT"];
const KEY = ["none", "requested", "ready", "consumed"], ASSET = ["Pending", "Verified", "Rejected"];
const A = { address: deployment.auction, abi: auctionAbi } as const, T = { address: deployment.asset, abi: assetAbi } as const;
const read = (c: typeof A | typeof T, functionName: string, args: unknown[] = []) => client.readContract({ ...c, functionName, args } as never) as Promise<any>;
const rows = async (sql: string, values: unknown[] = [chainId]) => (await pool.query(sql, values)).rows;
const orNull = (v: string, zero: string) => (v.toLowerCase() === zero ? null : v.toLowerCase());
const epoch = (c: string) => `extract(epoch FROM ${c})::bigint::text AS ${c}`;

/** Everything a replay must reproduce. updated_at is wall clock and source_event_id is a serial, so both are left out. */
async function snapshot() {
  const out: Record<string, string> = {};
  for (const t of ["assets", "asset_balances", "auction_keys", "auctions", "bids", "seller_credits", "settlement_attempts"]) {
    out[t] = (await rows(`SELECT md5(coalesce(string_agg(r, '|' ORDER BY r), '')) AS h FROM (SELECT (to_jsonb(x) - 'updated_at' - 'source_event_id')::text AS r FROM ${t} x WHERE chain_id=$1) s`))[0].h;
  }
  return out;
}

async function reconcile() {
  const bad: string[] = [];
  const eq = (what: string, db: unknown, chain: unknown) => { if (String(db) !== String(chain)) bad.push(`${what}: db ${db} != chain ${chain}`); };

  const count = Number(await read(A, "auctionCount"));
  const auctions = await rows(`SELECT *, auction_id::text AS id, ${epoch("start_time")}, ${epoch("end_time")}, ${epoch("settlement_deadline")}, ${epoch("claim_deadline")} FROM auctions WHERE chain_id=$1 ORDER BY auction_id`);
  eq("auction count", auctions.length, count);
  for (const d of auctions) {
    const c = await read(A, "getAuction", [BigInt(d.id)]), n = `auction ${d.id}`;
    eq(`${n} token`, d.token_id, c.tokenId); eq(`${n} seller`, d.seller, c.seller.toLowerCase());
    eq(`${n} reserve`, d.reserve_units, c.reserveUnits); eq(`${n} deposit`, d.deposit_units, c.depositUnits);
    eq(`${n} start`, d.start_time, c.startTime); eq(`${n} end`, d.end_time, c.endTime); eq(`${n} settlement deadline`, d.settlement_deadline, c.settlementDeadline);
    eq(`${n} state`, d.state, AUCTION_STATES[c.state]); eq(`${n} key`, d.key_id, c.keyId);
    eq(`${n} solver hash`, d.solver_code_hash, c.solverCodeHash); eq(`${n} config hash`, d.config_hash, c.configHash);
    eq(`${n} bid count`, d.bid_count, c.bidCount); eq(`${n} digest`, d.bid_digest, c.bidDigest);
    eq(`${n} request`, d.active_request_id, orNull(c.activeRequestId, zeroHash)); eq(`${n} attempt`, d.active_attempt, c.activeAttempt);
    eq(`${n} winner`, d.winner, orNull(c.winner, zeroAddress)); eq(`${n} winning amount`, d.winning_amount_units ?? "0", c.winningAmountUnits);
    eq(`${n} claim deadline`, d.claim_deadline ?? "0", c.claimDeadline); eq(`${n} cancel reason`, d.cancel_reason, CANCEL[c.cancelReason]);
    eq(`${n} returned asset`, d.returned_asset_claimed, c.returnedAssetClaimed);
    const bids = await rows(`SELECT * FROM bids WHERE chain_id=$1 AND auction_id=$2 ORDER BY bid_index`, [chainId, d.id]);
    eq(`${n} bid rows`, bids.length, c.bidCount);
    for (const b of bids) {
      const cb = await read(A, "getBid", [BigInt(d.id), BigInt(b.bid_index)]), m = `${n} bid ${b.bid_index}`;
      eq(`${m} bidder`, b.bidder, cb.bidder.toLowerCase()); eq(`${m} identity`, b.identity_id, cb.identityId);
      eq(`${m} commitment`, b.commitment, cb.commitment); eq(`${m} deposit`, b.deposit_status, DEPOSIT_STATUSES[cb.depositStatus]);
    }
  }
  const assets = await rows(`SELECT *, token_id::text AS id FROM assets WHERE chain_id=$1`);
  for (const d of assets) {
    const c = await read(T, "getAsset", [BigInt(d.id)]), n = `asset ${d.id}`;
    eq(`${n} issuer`, d.issuer, c.issuer.toLowerCase()); eq(`${n} uri`, d.metadata_uri, c.metadataURI); eq(`${n} hash`, d.metadata_hash, c.metadataHash);
    eq(`${n} status`, d.verification_status, ASSET[c.status]); eq(`${n} minted`, d.minted, c.minted); eq(`${n} redeemed`, d.redeemed, c.redeemed);
    eq(`${n} reviewer`, d.reviewer, orNull(c.reviewer, zeroAddress)); eq(`${n} review digest`, d.review_digest, orNull(c.reviewDigest, zeroHash));
  }
  const balances = await rows(`SELECT token_id::text AS id, wallet, balance FROM asset_balances WHERE chain_id=$1`);
  for (const d of balances) eq(`balance of ${d.wallet} for asset ${d.id}`, d.balance, await read(T, "balanceOf", [d.wallet, BigInt(d.id)]));
  const keys = await rows(`SELECT * FROM auction_keys WHERE chain_id=$1`);
  for (const d of keys) {
    const c = await read(A, "getKeyRecord", [d.key_request_id]), n = `key ${d.key_request_id.slice(0, 10)}`;
    eq(`${n} status`, d.status, KEY[c.status]); eq(`${n} owner`, d.owner_wallet, c.owner.toLowerCase());
    eq(`${n} key id`, d.key_id, orNull(c.keyId, zeroHash)); eq(`${n} blob hash`, d.sealed_blob_hash, orNull(c.sealedBlobHash, zeroHash));
  }
  const credits = await rows(`SELECT seller, amount_units FROM seller_credits WHERE chain_id=$1`);
  for (const d of credits) eq(`credit of ${d.seller}`, d.amount_units, await read(A, "getSellerCredit", [d.seller]));
  eq("total seller credits", (await rows(`SELECT coalesce(sum(amount_units), 0)::text AS s FROM seller_credits WHERE chain_id=$1`))[0].s, await read(A, "totalSellerCredits"));
  eq("total locked deposits", (await rows(`SELECT coalesce(sum(deposit_units), 0)::text AS s FROM bids WHERE chain_id=$1 AND deposit_status='Locked'`))[0].s, await read(A, "totalLockedDeposits"));
  assert.deepEqual(bad, [], "read model differs from the chain");
  return { auctions: auctions.length, bids: Number((await rows(`SELECT count(*) AS n FROM bids WHERE chain_id=$1`))[0].n), assets: assets.length, balances: balances.length, keys: keys.length };
}

assert.ok(await lead(), "the indexer worker holds the leader lock; stop it and run the check again");
await assertDeployment();
const t0 = Date.now(), first = BigInt(deployment.deployBlock);
const head = (await client.getBlockNumber()) - 3n, cp = await readCheckpoint();
if (!cp || BigInt(cp.last_block) < head) await ingest(cp ? BigInt(cp.last_block) + 1n : first, head);
const events = async () => Number((await rows(`SELECT count(*) AS n FROM chain_events WHERE chain_id=$1`))[0].n);

const counts = await reconcile();
console.log(`1 ok  read model equals the chain at block ${head}:`, JSON.stringify(counts));
const before = await snapshot(), stored = await events();

assert.equal(await ingest(first, head), 0, "a second ingest of the same range applied events again");
assert.equal(await events(), stored);
assert.deepEqual(await snapshot(), before, "duplicate ingest changed a projection");
console.log(`2 ok  second ingest of ${first}..${head} applied nothing (${stored} events stored once)`);

assert.equal(await replay(), stored);
assert.deepEqual(await snapshot(), before, "replay from stored events differs");
console.log(`3 ok  projections dropped and replayed from ${stored} stored events: identical`);

await reset();
assert.equal(await ingest(first, head), stored, "re-ingest from the chain found a different number of events");
assert.deepEqual(await snapshot(), before, "rebuild from the chain differs");
await reconcile();
console.log("4 ok  everything forgotten and ingested from the chain again: identical, and still equal to the chain");

const api = new pg.Client({ connectionString: process.env.DATABASE_URL_API ?? "postgres://maskbid_api_app@localhost:5432/maskbid" });
await api.connect();
assert.ok((await api.query(`SELECT count(*) AS n FROM maskbid.auctions`)).rows[0].n > 0, "the API login cannot read the catalog");
await assert.rejects(api.query(`UPDATE maskbid.auctions SET winner = NULL`), { code: "42501" }, "the API login was able to write a projection");
await api.end();
console.log("5 ok  API login reads the projections and is refused a write");

const result = { checkedAt: new Date().toISOString(), chainId, auction, asset, block: head.toString(), events: stored, ...counts, seconds: Math.round((Date.now() - t0) / 1000) };
if (process.env.EVIDENCE) { // keep whatever else the file holds (the bench section)
  const kept = existsSync(process.env.EVIDENCE) ? JSON.parse(readFileSync(process.env.EVIDENCE, "utf8")) : {};
  writeFileSync(process.env.EVIDENCE, JSON.stringify({ ...kept, check: result }, null, 2) + "\n");
}
console.log("\nINDEXER CHECK OK", JSON.stringify(result));
process.exit(0);
