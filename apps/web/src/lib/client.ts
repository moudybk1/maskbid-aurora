import { bytesToHex, type Hex } from "viem";
import { AUCTION_STATES, CANCEL_REASONS, DEPOSIT_STATUSES } from "@maskbid/protocol";
import { CONTRACT, TOKEN } from "./config";
import { blockTime, view } from "./near";

/** A NEAR account id. Inside bid envelopes and commitments an account is its 20-byte protocol address (`addressOf`). */
export type Account = string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;
const ASSET_STATUSES = ["Pending", "Verified", "Rejected"];
const KEY_STATES = ["Failed", "Requested", "Ready", "Consumed"]; // index 1..3 line up with KEY_STATUSES of the protocol package
const n = (v: unknown) => BigInt(v as string | number);

export type AuctionStruct = {
  tokenId: bigint; seller: Account; reserveUnits: bigint; depositUnits: bigint; startTime: bigint; endTime: bigint; state: number;
  keyId: Hex; bidCount: number; bidDigest: Hex; settlementDeadline: bigint; activeRequestId: Hex;
  activeAttempt: number; attemptStartedAt: bigint; attemptFailed: boolean; winner: Account; winningAmountUnits: bigint; claimDeadline: bigint; cancelReason: number;
  returnedAssetClaimed: boolean; outputSha256?: Hex; lastError?: string;
};
export type AssetStruct = { issuer: Account; metadataURI: string; metadataHash: Hex; status: number; reviewer: Account; reviewDigest: Hex; minted: boolean; redeemed: boolean; owner: Account; inEscrow: boolean };
/** `status`: 0 failed, 1 requested, 2 ready, 3 consumed. */
export type KeyRecord = { owner: Account; keyRequestId: Hex; keyId: Hex; publicKeySpki: Hex; sealedBlobHash: Hex; status: number; lastError?: string };
export type BidStruct = { bidder: Account; bidderAddress: Hex; identityId: Hex; commitment: Hex; envelope: Hex; depositStatus: number };
export type Config = {
  chainId: bigint; contract: Account; contractAddress: Hex; token: Account; admin: Account; registrar: Account; verifier: Account; outlayer: Account; wasmUrl: string;
  solverCodeHash: Hex; configHash: Hex; profile: string; protocolVersion: bigint; maxBids: bigint; minDurationSeconds: bigint; maxDurationSeconds: bigint;
  claimWindowSeconds: bigint; settlementGraceSeconds: bigint; attemptTimeoutSeconds: bigint; maxAttempts: bigint; envelopeBytes: bigint; executionDeposit: bigint;
  entryPaused: boolean; allowSimulator: boolean; auctionCount: bigint; nextTokenId: bigint; totalLockedDeposits: bigint; totalCredits: bigint;
};

const toConfig = (c: Raw): Config => ({
  ...(c as object), chainId: n(c.chainId), protocolVersion: n(c.protocolVersion), maxBids: n(c.maxBids), minDurationSeconds: n(c.minDurationSeconds), maxDurationSeconds: n(c.maxDurationSeconds),
  claimWindowSeconds: n(c.claimWindowSeconds), settlementGraceSeconds: n(c.settlementGraceSeconds), attemptTimeoutSeconds: n(c.attemptTimeoutSeconds), maxAttempts: n(c.maxAttempts),
  envelopeBytes: n(c.envelopeBytes), executionDeposit: n(c.executionDeposit), auctionCount: n(c.auctionCount), nextTokenId: n(c.nextTokenId),
  totalLockedDeposits: n(c.totalLockedDeposits), totalCredits: n(c.totalCredits),
} as Config);
/** Counters and totals, read fresh. */
export const readState = () => view<Raw>(CONTRACT, "get_config").then(toConfig);
let cached: { at: number; value: Promise<Config> } | undefined;
/** Deployment parameters. They never change, so one read serves a minute of polling. */
export function readConfig(): Promise<Config> {
  if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), value: readState().catch((e) => { cached = undefined; throw e; }) };
  return cached.value;
}

const toAuction = (a: Raw): AuctionStruct => ({
  tokenId: n(a.tokenId), seller: a.seller, reserveUnits: n(a.reserveUnits), depositUnits: n(a.depositUnits), startTime: n(a.startTime), endTime: n(a.endTime),
  state: AUCTION_STATES.indexOf(a.state), keyId: a.keyId, bidCount: a.bidCount, bidDigest: a.bidDigest, settlementDeadline: n(a.settlementDeadline),
  activeRequestId: a.activeRequestId, activeAttempt: a.activeAttempt, attemptStartedAt: n(a.attemptStartedAt), attemptFailed: a.attemptFailed, winner: a.winner ?? "",
  winningAmountUnits: n(a.winningAmountUnits), claimDeadline: n(a.claimDeadline), cancelReason: CANCEL_REASONS.indexOf(a.cancelReason), returnedAssetClaimed: a.returnedAssetClaimed,
  outputSha256: a.outputSha256 ?? undefined, lastError: a.lastError ?? undefined,
});
const toAsset = (a: Raw): AssetStruct => ({
  issuer: a.issuer, metadataURI: a.metadataUri, metadataHash: a.metadataHash, status: ASSET_STATUSES.indexOf(a.status), reviewer: a.reviewer ?? "", reviewDigest: a.reviewDigest,
  minted: a.minted, redeemed: a.redeemed, owner: a.owner ?? "", inEscrow: a.inEscrow,
});

export async function readAuction(id: bigint): Promise<AuctionStruct> {
  const a = await view<Raw | null>(CONTRACT, "get_auction", { auction_id: Number(id) });
  if (!a) throw new Error(`Lot ${id} does not exist on ${CONTRACT}.`);
  return toAuction(a);
}
/** Every lot with its asset, in one call. ponytail: first 50 lots; page with `from_id` when a deployment outgrows that. */
export async function listAuctions(): Promise<{ id: bigint; a: AuctionStruct; asset: AssetStruct }[]> {
  return (await view<Raw[]>(CONTRACT, "get_auctions", {})).map((r) => ({ id: n(r.auctionId), a: toAuction(r), asset: toAsset(r.asset) }));
}

export async function readAsset(tokenId: bigint): Promise<AssetStruct> {
  const a = await view<Raw | null>(CONTRACT, "get_asset", { token_id: tokenId.toString() });
  if (!a) throw new Error(`Asset #${tokenId} does not exist on ${CONTRACT}.`);
  return toAsset(a);
}
/** Every registered asset, newest first, in one call. ponytail: first 100 assets; page with `from_id` beyond that. */
export async function listAssets(): Promise<{ tokenId: bigint; a: AssetStruct }[]> {
  return (await view<Raw[]>(CONTRACT, "get_assets", {})).map((r) => ({ tokenId: n(r.tokenId), a: toAsset(r) })).reverse();
}
/** The account's bids across all lots. */
export const listBidsOf = async (who: Account) => (await view<{ auctionId: number; bidIndex: number; depositStatus: (typeof DEPOSIT_STATUSES)[number] }[]>(CONTRACT, "get_bids_of", { account: who })).map((b) => ({ ...b, auctionId: BigInt(b.auctionId) }));

const toKey = (k: Raw): KeyRecord => ({
  owner: k.owner, keyRequestId: k.keyRequestId, keyId: k.keyId, sealedBlobHash: k.sealedBlobHash, status: KEY_STATES.indexOf(k.status), lastError: k.lastError ?? undefined,
  publicKeySpki: bytesToHex(Uint8Array.from(atob(k.publicKeySpki), (c) => c.charCodeAt(0))),
});
export const readKeyById = async (keyId: Hex): Promise<KeyRecord | undefined> => { const k = await view<Raw | null>(CONTRACT, "get_key_by_key_id", { key_id: keyId }); return k ? toKey(k) : undefined; };
export const readKeyRecord = async (keyRequestId: Hex): Promise<KeyRecord | undefined> => { const k = await view<Raw | null>(CONTRACT, "get_key", { key_request_id: keyRequestId }); return k ? toKey(k) : undefined; };

export async function readBid(id: bigint, index: bigint): Promise<BidStruct> {
  const b = await view<Raw | null>(CONTRACT, "get_bid", { auction_id: Number(id), bid_index: Number(index) });
  if (!b) throw new Error(`Bid ${index} of lot ${id} does not exist.`);
  return { bidder: b.bidder, bidderAddress: b.bidderAddress, identityId: b.identityId, commitment: b.commitment, envelope: b.envelope, depositStatus: DEPOSIT_STATUSES.indexOf(b.depositStatus) };
}
/** Bid index plus one; zero when the account has not bid. */
export const readBidIndex = async (id: bigint, who: Account): Promise<bigint> => { const i = await view<number | null>(CONTRACT, "get_bid_index", { auction_id: Number(id), account: who }); return i === null ? 0n : BigInt(i) + 1n; };
export const readAuctionCount = async () => (await readState()).auctionCount;
export const readEligible = (who: Account) => view<boolean>(CONTRACT, "is_eligible", { account: who });
export const readParticipant = (who: Account) => view<{ uniquenessId: Hex; verifiedUntil: number; assurance: number; revoked: boolean } | null>(CONTRACT, "get_participant", { account: who });
export const readTokenBalance = async (who: Account) => n(await view<string>(TOKEN, "ft_balance_of", { account_id: who }));
/** 1 when the account holds the unit, like a balance. */
export const readAssetBalance = async (who: Account, tokenId: bigint) => ((await readAsset(tokenId)).owner === who ? 1n : 0n);
/** Token units the contract owes the account: forfeited deposits and payouts that could not be delivered. */
export const readCredit = async (who: Account) => n(await view<string>(CONTRACT, "get_credit", { account: who }));
/** The 20-byte address an account has inside envelopes, commitments and solver results. */
export const addressOf = (who: Account) => view<Hex>(CONTRACT, "address_of", { account: who });
export const chainNow = blockTime;

/** Public metadata fetched by URI, with the on-chain hash recomputed over the raw bytes. */
export interface AssetMetadata {
  title?: string; description?: string; category?: string; condition?: string; isDemo?: boolean; issuerWallet?: string; images?: string[];
}
type MetadataResult = { data?: AssetMetadata; integrity: "verified" | "mismatch" | "unavailable" };
const metadataCache = new Map<string, Promise<MetadataResult>>();
/** Frozen metadata cannot change for a given hash, so each lot is fetched once per page load instead of on every poll.
    ponytail: failures are remembered too (a reload retries); add a retry with backoff if metadata hosts turn out flaky. */
export function fetchMetadata(uri: string, expectedHash: Hex): Promise<MetadataResult> {
  const key = `${expectedHash}|${uri}`;
  let hit = metadataCache.get(key);
  if (!hit) metadataCache.set(key, (hit = loadMetadata(uri, expectedHash)));
  return hit;
}
async function loadMetadata(uri: string, expectedHash: Hex): Promise<MetadataResult> {
  if (!/^https?:\/\//.test(uri)) return { integrity: "unavailable" }; // only web URIs can be fetched here
  try {
    const res = await fetch(uri, { cache: "force-cache" });
    if (!res.ok) return { integrity: "unavailable" };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const digest = `0x${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    const data = JSON.parse(new TextDecoder().decode(bytes)) as AssetMetadata;
    return { data, integrity: digest === expectedHash.toLowerCase() ? "verified" : "mismatch" };
  } catch {
    return { integrity: "unavailable" };
  }
}
