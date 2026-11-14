import { NextResponse } from "next/server";
import { CHAIN_ID, deployment } from "@/lib/config";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Indexer health for the config page: checkpoint block, state and how long ago it last moved. */
export async function GET() {
  if (!db || !deployment) return NextResponse.json({ configured: false });
  try {
    // the API login may read projections and the checkpoint, not the raw event log
    const row = (await db.query(`SELECT c.last_block::text AS block, c.state, extract(epoch FROM now() - c.updated_at)::float8 AS "ageSeconds",
                                        (SELECT count(*)::int FROM auctions a WHERE a.chain_id = c.chain_id AND a.auction_contract = c.contract) AS auctions
                                 FROM indexer_checkpoints c WHERE c.chain_id=$1 AND c.contract=$2`, [CHAIN_ID, deployment.auction.toLowerCase()])).rows[0];
    return NextResponse.json({ configured: true, ...(row ?? { state: "empty" }) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ configured: true, state: "unreachable" }, { headers: { "cache-control": "no-store" } });
  }
}
