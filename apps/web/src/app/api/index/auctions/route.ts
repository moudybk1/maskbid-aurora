import { NextResponse } from "next/server";
import { AUCTION_STATES } from "@maskbid/protocol";
import { CHAIN_ID, deployment } from "@/lib/config";
import { db, STALE_SECONDS } from "@/lib/db";

const off = (status: number, reason: string) => NextResponse.json({ status: reason }, { status, headers: { "cache-control": "no-store" } });
const sec = (column: string) => `coalesce(extract(epoch FROM ${column})::bigint, 0)::text`;

/** Catalog from the read model (FR-08): newest first, keyset pagination by auction id (`before`), optional lifecycle
    filter (`state`). Rows carry the contract's own struct fields, uint256 as decimal strings. No RPC in this path.
    501 = no database configured, 503 = indexer behind or stopped; in both cases the browser reads the chain instead. */
export async function GET(req: Request) {
  if (!db || !deployment) return off(501, "not_configured");
  const p = new URL(req.url).searchParams;
  const limit = Math.min(100, Math.max(1, Number(p.get("limit")) || 100));
  const before = p.get("before"), state = p.get("state");
  if ((before && !/^\d{1,78}$/.test(before)) || (state && !(AUCTION_STATES as readonly string[]).includes(state))) return off(400, "invalid_query");
  const key = [CHAIN_ID, deployment.auction.toLowerCase()];
  try {
    const cp = (await db.query(`SELECT last_block::text AS block, state, extract(epoch FROM now() - updated_at)::float8 AS age, extract(epoch FROM now())::bigint::text AS now
                                FROM indexer_checkpoints WHERE chain_id=$1 AND contract=$2`, key)).rows[0];
    if (!cp || cp.state !== "healthy" || cp.age > STALE_SECONDS) return off(503, "stale");
    const { rows } = await db.query(
      `SELECT a.auction_id::text AS id, a.token_id::text AS "tokenId", a.seller, a.reserve_units::text AS "reserveUnits", a.deposit_units::text AS "depositUnits",
              ${sec("a.start_time")} AS "startTime", ${sec("a.end_time")} AS "endTime", a.state, a.key_id AS "keyId", a.solver_code_hash AS "solverCodeHash", a.config_hash AS "configHash",
              a.bid_count AS "bidCount", a.bid_digest AS "bidDigest", ${sec("a.settlement_deadline")} AS "settlementDeadline", a.active_request_id AS "activeRequestId",
              a.active_attempt AS "activeAttempt", ${sec("t.started_at")} AS "attemptStartedAt", a.winner, coalesce(a.winning_amount_units, 0)::text AS "winningAmountUnits",
              ${sec("a.claim_deadline")} AS "claimDeadline", a.cancel_reason AS "cancelReason", a.returned_asset_claimed AS "returnedAssetClaimed",
              s.issuer, s.metadata_uri AS "metadataURI", s.metadata_hash AS "metadataHash", s.verification_status AS status, s.reviewer, s.review_digest AS "reviewDigest", s.minted, s.redeemed
       FROM auctions a
       JOIN assets s ON s.chain_id = a.chain_id AND s.asset_contract = a.asset_contract AND s.token_id = a.token_id
       LEFT JOIN settlement_attempts t ON t.request_id = a.active_request_id
       WHERE a.chain_id=$1 AND a.auction_contract=$2 AND ($3::numeric IS NULL OR a.auction_id < $3::numeric) AND ($4::text IS NULL OR a.state = $4::auction_state)
       ORDER BY a.auction_id DESC LIMIT $5`, [...key, before, state, limit]);
    return NextResponse.json({ source: "indexer", block: cp.block, now: cp.now, auctions: rows, nextBefore: rows.length === limit ? rows[rows.length - 1].id : null }, { headers: { "cache-control": "no-store" } });
  } catch {
    return off(503, "error");
  }
}
