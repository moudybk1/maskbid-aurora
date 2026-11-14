// Read model for MaskBid (spec 08): Aurora logs -> chain_blocks / chain_events -> projections, one database
// transaction per block (events + projection + checkpoint). The chain stays the source of truth; nothing here
// chooses a winner, and replaying the stored events must rebuild every projection byte for byte.
import pg from "pg";
import { createPublicClient, decodeEventLog, http, sha256, stringToBytes, zeroAddress, type Hex, type Log } from "viem";
import { assetAbi, auctionAbi, chainFor, deployments } from "@maskbid/contracts";
import { initialDigest } from "@maskbid/protocol";

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`missing env ${k}`); })();
export const chainId = Number(env("CHAIN_ID", "1313161555"));
const rpcUrl = env("RPC_URL", "https://testnet.aurora.dev");
export const deployment = deployments[String(chainId)] ?? (() => { throw new Error(`no deployment for chain ${chainId}`); })();
export const auction = deployment.auction.toLowerCase(), asset = deployment.asset.toLowerCase();
export const client = createPublicClient({ chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl) });
// search_path keeps every statement inside the reference schema; the login role is a member of maskbid_indexer only.
export const pool = new pg.Pool({ connectionString: env("DATABASE_URL", "postgres://maskbid_indexer_app@localhost:5432/maskbid"), options: "-c search_path=maskbid", max: 4 });
export const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

type Q = (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
export interface Ev { id: string; contract: string; name: string; args: Record<string, any>; txHash: string; time: Date }

const CANCEL = ["", "SELLER_CANCELLED", "NO_VALID_BID", "WINNER_DEFAULT", "SOLVER_TIMEOUT"];
const hexBytes = (h: string) => Buffer.from(h.slice(2), "hex");
const at = (seconds: string | number | bigint) => new Date(Number(seconds) * 1000);
/** Event args as stored in chain_events.decoded: uint256 as decimal strings, addresses lowercase (the schema's domains). */
const plain = (v: unknown): unknown =>
  typeof v === "bigint" ? v.toString() : Array.isArray(v) ? v.map(plain) : typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase()
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;

let limits: { grace: bigint; claim: bigint } | undefined;
/** Two deadlines are derived from immutable contract config rather than carried by an event. */
async function config() {
  if (!limits) {
    const c = (await client.readContract({ address: deployment.auction, abi: auctionAbi, functionName: "getConfig" })) as { settlementGraceSeconds: bigint; claimWindowSeconds: bigint };
    limits = { grace: c.settlementGraceSeconds, claim: c.claimWindowSeconds };
  }
  return limits;
}

/** One event -> its projection change. Used by live ingestion and by replay alike, always from the stored decoded args. */
export async function apply(q: Q, e: Ev) {
  const a = e.args, A = [chainId, auction], T = [chainId, asset];
  const own = async (wallet: string, tokenId: string, balance: 0 | 1) => {
    if (wallet === zeroAddress) return;
    await q(`INSERT INTO asset_balances (chain_id, asset_contract, token_id, wallet, balance, source_event_id) VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (chain_id, asset_contract, token_id, wallet) DO UPDATE SET balance = EXCLUDED.balance, source_event_id = EXCLUDED.source_event_id`, [...T, tokenId, wallet, balance, e.id]);
  };
  const move = async (from: string, to: string, tokenId: string) => {
    if (from === zeroAddress) await q(`UPDATE assets SET minted = true, updated_at = now() WHERE chain_id=$1 AND asset_contract=$2 AND token_id=$3`, [...T, tokenId]);
    await own(from, tokenId, 0);
    await own(to, tokenId, 1);
  };
  const bid = (status: string, wallet: string) => q(`UPDATE bids SET deposit_status = $4 WHERE chain_id=$1 AND auction_contract=$2 AND auction_id=$3 AND bidder=$5`, [...A, a.auctionId, status, wallet]);
  const set = (sql: string, values: unknown[]) => q(`UPDATE auctions SET ${sql}, updated_at = now() WHERE chain_id=$1 AND auction_contract=$2 AND auction_id=$3`, [...A, a.auctionId, ...values]);

  switch (`${e.contract === auction ? "auction" : "asset"}.${e.name}`) {
    case "asset.AssetRegistered":
      await q(`INSERT INTO assets (chain_id, asset_contract, token_id, issuer, metadata_uri, metadata_hash, verification_status, minted, redeemed, source_event_id)
               VALUES ($1,$2,$3,$4,$5,$6,'Pending',false,false,$7)`, [...T, a.tokenId, a.issuer, a.metadataURI, a.metadataHash, e.id]);
      break;
    case "asset.AssetVerified":
      await q(`UPDATE assets SET verification_status='Verified', reviewer=$4, review_digest=$5, updated_at=now() WHERE chain_id=$1 AND asset_contract=$2 AND token_id=$3`, [...T, a.tokenId, a.reviewer, a.reviewDigest]);
      break;
    case "asset.AssetRejected":
      await q(`UPDATE assets SET verification_status='Rejected', reviewer=$4, updated_at=now() WHERE chain_id=$1 AND asset_contract=$2 AND token_id=$3`, [...T, a.tokenId, a.reviewer]);
      break;
    case "asset.AssetRedeemed":
      await q(`UPDATE assets SET redeemed=true, updated_at=now() WHERE chain_id=$1 AND asset_contract=$2 AND token_id=$3`, [...T, a.tokenId]);
      break;
    case "asset.TransferSingle":
      await move(a.from, a.to, a.id);
      break;
    case "asset.TransferBatch":
      for (const id of a.ids as string[]) await move(a.from, a.to, id);
      break;

    case "auction.KeyRequested":
      await q(`INSERT INTO auction_keys (chain_id, auction_contract, key_request_id, owner_wallet, solver_code_hash, config_hash, status, source_event_id)
               VALUES ($1,$2,$3,$4,$5,$6,'requested',$7)`, [...A, a.keyRequestId, a.owner, deployment.solverCodeHash, a.configHash, e.id]);
      break;
    case "auction.KeyPrepared":
      await q(`UPDATE auction_keys SET key_id=$4, public_key_spki=$5, sealed_blob_hash=$6, solver_code_hash=$7, status='ready' WHERE chain_id=$1 AND auction_contract=$2 AND key_request_id=$3`,
        [...A, a.keyRequestId, a.keyId, hexBytes(a.publicKeySpki), a.sealedBlobHash, a.solverCodeHash]);
      break;
    case "auction.AuctionCreated": {
      const digest = initialDigest({ chainId: BigInt(chainId), auctionContract: auction as Hex, auctionId: BigInt(a.auctionId) }, a.keyId);
      await q(`INSERT INTO auctions (chain_id, auction_contract, auction_id, asset_contract, token_id, seller, reserve_units, deposit_units, start_time, end_time, settlement_deadline,
                 state, key_id, solver_code_hash, config_hash, bid_digest, source_event_id, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Created',$12,$13,$14,$15,$16,$17)`,
        [...A, a.auctionId, asset, a.tokenId, a.seller, a.reserveUnits, a.depositUnits, at(a.startTime), at(a.endTime), at(BigInt(a.endTime) + (await config()).grace),
          a.keyId, deployment.solverCodeHash, a.configHash, digest, e.id, e.time]);
      await q(`UPDATE auction_keys SET status='consumed' WHERE chain_id=$1 AND auction_contract=$2 AND key_id=$3`, [...A, a.keyId]);
      break;
    }
    case "auction.AuctionActivated":
      await set(`state='Active'`, []);
      break;
    case "auction.AuctionEnded":
      await set(`state='Ended'`, []);
      break;
    case "auction.BidPlaced":
      await q(`INSERT INTO bids (chain_id, auction_contract, auction_id, bid_index, bidder, identity_id, commitment, envelope, deposit_units, deposit_status, tx_hash, block_hash, block_number, log_index, source_event_id, created_at)
               SELECT a.chain_id, a.auction_contract, a.auction_id, $4,$5,$6,$7,$8, a.deposit_units, 'Locked', c.tx_hash, c.block_hash, c.block_number, c.log_index, c.id, $10
               FROM auctions a, chain_events c WHERE a.chain_id=$1 AND a.auction_contract=$2 AND a.auction_id=$3 AND c.id=$9`,
        [...A, a.auctionId, a.bidIndex, a.bidder, a.identityId, a.commitment, hexBytes(a.envelope), e.id, e.time]);
      await set(`bid_count=$4, bid_digest=$5`, [Number(a.bidIndex) + 1, a.newDigest]);
      break;
    case "auction.SettlementRequested":
      // a retry supersedes whatever attempt was still waiting
      await q(`UPDATE settlement_attempts SET status='stale', finished_at=$4 WHERE chain_id=$1 AND auction_contract=$2 AND auction_id=$3 AND status='requested'`, [...A, a.auctionId, e.time]);
      await q(`INSERT INTO settlement_attempts (request_id, chain_id, auction_contract, auction_id, attempt, bid_digest, bid_count, status, request_tx_hash, started_at)
               VALUES ($4,$1,$2,$3,$5,$6,$7,'requested',$8,$9)`, [...A, a.auctionId, a.requestId, a.attempt, a.bidDigest, a.bidCount, e.txHash, e.time]);
      await set(`active_request_id=$4, active_attempt=$5`, [a.requestId, a.attempt]);
      break;
    case "auction.SettlementAccepted":
      await q(`UPDATE settlement_attempts SET status='accepted', callback_tx_hash=$2, finished_at=$3 WHERE request_id=$1`, [a.requestId, e.txHash, e.time]);
      if (Number(a.outcome) === 0) await set(`state='PendingClaim', winner=$4, winning_amount_units=$5, claim_deadline=$6`, [a.winner, a.winningAmountUnits, at(BigInt(Math.floor(e.time.getTime() / 1000)) + (await config()).claim)]);
      else await set(`state='Cancelled', cancel_reason='NO_VALID_BID'`, []);
      break;
    case "auction.AuctionCancelled":
      await set(`state='Cancelled', cancel_reason=$4`, [CANCEL[Number(a.reason)]]);
      if (Number(a.reason) === 4) await q(`UPDATE settlement_attempts SET status='timed_out', finished_at=$4 WHERE chain_id=$1 AND auction_contract=$2 AND auction_id=$3 AND status='requested'`, [...A, a.auctionId, e.time]);
      break;
    case "auction.WinClaimed":
      await set(`state='Finalized'`, []);
      await bid("Consumed", a.winner);
      break;
    case "auction.DepositRefunded":
      await bid("Refunded", a.bidder);
      break;
    case "auction.WinnerDefaulted":
      await bid("Forfeited", a.winner);
      await q(`INSERT INTO seller_credits (chain_id, auction_contract, seller, amount_units, source_event_id) VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (chain_id, auction_contract, seller) DO UPDATE SET amount_units = seller_credits.amount_units + EXCLUDED.amount_units, source_event_id = EXCLUDED.source_event_id`, [...A, a.seller, a.penalty, e.id]);
      break;
    case "auction.SellerCreditWithdrawn":
      await q(`UPDATE seller_credits SET amount_units = amount_units - $4, source_event_id=$5 WHERE chain_id=$1 AND auction_contract=$2 AND seller=$3`, [...A, a.seller, a.amount, e.id]);
      break;
    case "auction.ReturnedAssetClaimed":
      await set(`returned_asset_claimed=true`, []);
      break;
    // roles, pauses, approvals and URI events are kept in chain_events only
  }
}

function decode(l: Log): { name: string; args: unknown } {
  try {
    const d = decodeEventLog({ abi: l.address.toLowerCase() === auction ? auctionAbi : assetAbi, data: l.data, topics: l.topics }) as { eventName: string; args: unknown };
    return { name: d.eventName, args: plain(d.args) };
  } catch {
    log(`unknown event at ${l.transactionHash}#${l.logIndex}; recorded without a projection`);
    return { name: "Unknown", args: { topics: l.topics, data: l.data } };
  }
}

/** Ingest every allowlisted log in [from, to] and move the checkpoint to `to`. Safe to repeat: an event already stored is skipped. */
export async function ingest(from: bigint, to: bigint): Promise<number> {
  const logs = await client.getLogs({ address: [deployment.auction, deployment.asset], fromBlock: from, toBlock: to });
  const blocks = new Map<Hex, Log[]>();
  for (const l of logs) blocks.set(l.blockHash!, [...(blocks.get(l.blockHash!) ?? []), l]);
  let applied = 0;
  for (const [hash, list] of [...blocks].sort((x, y) => Number(x[1][0].blockNumber! - y[1][0].blockNumber!))) {
    const b = await client.getBlock({ blockHash: hash });
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(`INSERT INTO chain_blocks (chain_id, number, hash, parent_hash, block_time, canonical) VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (chain_id, hash) DO NOTHING`, [chainId, b.number, hash, b.parentHash, at(b.timestamp)]);
      for (const l of list.sort((x, y) => x.logIndex! - y.logIndex!)) {
        const d = decode(l), contract = l.address.toLowerCase();
        const row = await db.query(`INSERT INTO chain_events (chain_id, contract, tx_hash, log_index, block_number, block_hash, event_name, decoded) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                                    ON CONFLICT (chain_id, tx_hash, log_index, block_hash) DO NOTHING RETURNING id`, [chainId, contract, l.transactionHash, l.logIndex, b.number, hash, d.name, JSON.stringify(d.args)]);
        if (!row.rowCount) continue; // already applied by an earlier run
        await apply((t, v) => db.query(t, v), { id: row.rows[0].id, contract, name: d.name, args: d.args as Record<string, any>, txHash: l.transactionHash!, time: at(b.timestamp) });
        await db.query(`UPDATE chain_events SET applied_at = now() WHERE id=$1`, [row.rows[0].id]);
        applied++;
      }
      await checkpoint(db, b.number, hash, "catching_up");
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  await checkpoint(pool, to, (await client.getBlock({ blockNumber: to })).hash, "healthy");
  return applied;
}

const checkpoint = (db: { query: Q }, block: bigint, hash: Hex, state: string) =>
  db.query(`INSERT INTO indexer_checkpoints (chain_id, contract, last_block, last_block_hash, state) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (chain_id, contract) DO UPDATE SET last_block = EXCLUDED.last_block, last_block_hash = EXCLUDED.last_block_hash, state = EXCLUDED.state, updated_at = now()`, [chainId, auction, block, hash, state]);

export const readCheckpoint = async () => (await pool.query(`SELECT last_block, last_block_hash FROM indexer_checkpoints WHERE chain_id=$1 AND contract=$2`, [chainId, auction])).rows[0] as { last_block: string; last_block_hash: string } | undefined;

const PROJECTIONS = ["settlement_attempts", "bids", "seller_credits", "auctions", "auction_keys", "asset_balances", "assets"]; // children before parents

/** T-INDEX-02: drop every projection and rebuild it from the stored canonical events, in one transaction. */
export async function replay(): Promise<number> {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const t of PROJECTIONS) await db.query(`DELETE FROM ${t} WHERE chain_id=$1`, [chainId]);
    const events = await db.query(`SELECT e.id, e.contract, e.event_name AS name, e.decoded AS args, e.tx_hash AS "txHash", b.block_time AS time FROM chain_events e
                                   JOIN chain_blocks b ON b.chain_id = e.chain_id AND b.hash = e.block_hash WHERE e.chain_id=$1 AND e.canonical ORDER BY e.block_number, e.log_index`, [chainId]);
    for (const e of events.rows) await apply((t, v) => db.query(t, v), e);
    await db.query("COMMIT");
    return events.rowCount ?? 0;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}

/** A changed block hash means the stored history is not the chain's. Spec 08 §6, simple form: forget it all and ingest again. */
export async function reset() {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    for (const t of [...PROJECTIONS, "chain_events", "chain_blocks", "indexer_checkpoints"]) await db.query(`DELETE FROM ${t} WHERE chain_id=$1`, [chainId]);
    await db.query("COMMIT");
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  } finally {
    db.release();
  }
}

/** One leader per deployment (spec 09): a session advisory lock held for the life of the process. */
export async function lead(): Promise<boolean> {
  const db = await pool.connect(); // kept on purpose; the lock dies with the connection
  return (await db.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`maskbid-indexer:${chainId}:${auction}`])).rows[0].ok;
}

/** The deployment row is written at bootstrap by the database owner (setup.sh); the indexer only reads it. */
export async function assertDeployment() {
  if ((await client.getChainId()) !== chainId) throw new Error(`RPC is not chain ${chainId}`);
  const d = (await pool.query(`SELECT config_hash, asset_contract FROM deployments WHERE chain_id=$1 AND auction_contract=$2`, [chainId, auction])).rows[0];
  if (!d) throw new Error(`no deployments row for ${chainId}/${auction}; run npm run indexer:setup`);
  if (d.config_hash !== deployment.configHash.toLowerCase() || d.asset_contract !== asset) throw new Error("deployments row does not match contracts/deployments; refusing to index");
}

export const abiHash = () => sha256(stringToBytes(JSON.stringify(auctionAbi)));
