// Complete-set validation and deterministic ranking. Spec 15 §8-§10. Pure: no I/O, no logging of amounts.
import { hexToBytes, sha256, stringToBytes, type Address, type Hex } from "viem";
import { parseUintString } from "./amount.ts";
import { decryptBid, EnvelopeError, PROTOCOL_VERSION } from "./envelope.ts";
import { bidCommitment, initialDigest, nextDigest, requestIdHash, type Domain } from "./hash.ts";

export const MAX_BIDS = 32;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export interface SettlementRequest {
  protocolVersion: number;
  chainId: string;
  auctionContract: Address;
  auctionId: string;
  requestId: Hex;
  attempt: number;
  bidDigest: Hex;
  bidCount: number;
  keyId: Hex;
  solverCodeHash: Hex;
  configHash: Hex;
  reserveUnits: string;
  endTime: string;
  settlementDeadline: string;
  manifestUrl?: string;
  manifestSha256?: Hex;
  keyRequestId?: Hex;
}

export interface ManifestBid {
  bidIndex: string;
  bidder: Address;
  commitment: Hex;
  envelope: Hex;
  txHash: Hex;
  blockHash: Hex;
  blockNumber: string;
  logIndex: string;
}

export interface Manifest {
  protocolVersion: number;
  chainId: string;
  auctionContract: Address;
  auctionId: string;
  requestId: Hex;
  keyId: Hex;
  bidDigest: Hex;
  bidCount: number;
  bids: ManifestBid[];
}

export interface SettlementResult {
  protocolVersion: number;
  chainId: string;
  auctionContract: Address;
  auctionId: string;
  requestId: Hex;
  attempt: number;
  bidDigest: Hex;
  bidCount: number;
  keyId: Hex;
  solverCodeHash: Hex;
  configHash: Hex;
  outcome: "WINNER" | "NO_SALE";
  winner: Address;
  winningAmountUnits: string;
  validBidCount: number;
  invalidBidCount: number;
}

export type FatalCode =
  | "MANIFEST_UNAVAILABLE"
  | "MANIFEST_INCOMPLETE"
  | "COMMITMENT_MISMATCH"
  | "DOMAIN_MISMATCH"
  | "KEY_UNAVAILABLE"
  | "RUNTIME_FAILURE";

/** Fatal is never NO_SALE: the job must retry or time out. */
export class SolverFatal extends Error {
  readonly code: FatalCode;
  readonly retryable: boolean;
  readonly requestId: Hex;
  constructor(code: FatalCode, requestId: Hex, detail: string, retryable = true) {
    super(`${code}: ${detail}`);
    this.name = "SolverFatal";
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
  }
}

export function domainOf(r: { chainId: string; auctionContract: Address; auctionId: string }): Domain {
  return { chainId: parseUintString(r.chainId), auctionContract: r.auctionContract.toLowerCase() as Address, auctionId: parseUintString(r.auctionId) };
}

/** Steps 1-5: everything structural, before any key material is touched. */
export function validateManifest(request: SettlementRequest, manifest: Manifest): void {
  const rid = request.requestId;
  const domain = domainOf(request);
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new SolverFatal("DOMAIN_MISMATCH", rid, "protocol version", false);
  if (
    manifest.protocolVersion !== request.protocolVersion ||
    manifest.chainId !== request.chainId ||
    manifest.auctionContract.toLowerCase() !== domain.auctionContract ||
    manifest.auctionId !== request.auctionId ||
    manifest.requestId.toLowerCase() !== rid.toLowerCase() ||
    manifest.keyId.toLowerCase() !== request.keyId.toLowerCase()
  ) {
    throw new SolverFatal("DOMAIN_MISMATCH", rid, "manifest header does not match request");
  }
  if (request.bidCount > MAX_BIDS || manifest.bidCount !== request.bidCount || manifest.bids.length !== request.bidCount) {
    throw new SolverFatal("MANIFEST_INCOMPLETE", rid, `expected ${request.bidCount} bids, manifest has ${manifest.bids.length}`);
  }
  const expectedRequestId = requestIdHash(domain, request.bidDigest, BigInt(request.bidCount), request.attempt, request.configHash);
  if (expectedRequestId !== rid.toLowerCase()) throw new SolverFatal("DOMAIN_MISMATCH", rid, "requestId does not bind digest/count/attempt/config");

  const seen = new Set<string>();
  let digest = initialDigest(domain, request.keyId);
  manifest.bids.forEach((b, i) => {
    if (b.bidIndex !== String(i)) throw new SolverFatal("MANIFEST_INCOMPLETE", rid, `bid index gap at ${i}`);
    const bidder = b.bidder.toLowerCase() as Address;
    if (seen.has(bidder)) throw new SolverFatal("MANIFEST_INCOMPLETE", rid, "duplicate bidder");
    seen.add(bidder);
    let envelope: Uint8Array;
    try {
      envelope = hexToBytes(b.envelope);
    } catch {
      throw new SolverFatal("COMMITMENT_MISMATCH", rid, `bid ${i} envelope is not hex`);
    }
    if (envelope.length !== 490) throw new SolverFatal("COMMITMENT_MISMATCH", rid, `bid ${i} envelope length`);
    const commitment = bidCommitment(domain, bidder, request.keyId, envelope);
    if (commitment !== b.commitment.toLowerCase()) throw new SolverFatal("COMMITMENT_MISMATCH", rid, `bid ${i} commitment`);
    digest = nextDigest(digest, BigInt(i), bidder, commitment);
  });
  if (digest !== request.bidDigest.toLowerCase() || manifest.bidDigest.toLowerCase() !== digest) {
    throw new SolverFatal("MANIFEST_INCOMPLETE", rid, "ordered digest does not match request");
  }
}

/** Steps 6-8. Malformed-but-present bids are invalid; missing data was already fatal above. */
export async function solve(request: SettlementRequest, manifest: Manifest, pkcs8: Uint8Array, subtle?: SubtleCrypto): Promise<SettlementResult> {
  validateManifest(request, manifest);
  const domain = domainOf(request);
  const reserve = parseUintString(request.reserveUnits);
  let best: { index: number; bidder: Address; amount: bigint } | undefined;
  let valid = 0;
  for (let i = 0; i < manifest.bids.length; i++) {
    const b = manifest.bids[i];
    const bidder = b.bidder.toLowerCase() as Address;
    try {
      const p = await decryptBid({ pkcs8, envelope: hexToBytes(b.envelope), domain, bidder, keyId: request.keyId, subtle });
      if (p.amountUnits < reserve) continue; // complete but below reserve: invalid
      valid++;
      if (!best || p.amountUnits > best.amount) best = { index: i, bidder, amount: p.amountUnits }; // ties keep earliest index
    } catch (e) {
      if (e instanceof EnvelopeError) continue; // complete but malformed: invalid
      throw new SolverFatal("RUNTIME_FAILURE", request.requestId, e instanceof Error ? e.message : "decrypt failure");
    }
  }
  return {
    protocolVersion: request.protocolVersion,
    chainId: request.chainId,
    auctionContract: request.auctionContract,
    auctionId: request.auctionId,
    requestId: request.requestId,
    attempt: request.attempt,
    bidDigest: request.bidDigest,
    bidCount: request.bidCount,
    keyId: request.keyId,
    solverCodeHash: request.solverCodeHash,
    configHash: request.configHash,
    outcome: best ? "WINNER" : "NO_SALE",
    winner: best ? best.bidder : ZERO_ADDRESS,
    winningAmountUnits: best ? best.amount.toString() : "0",
    validBidCount: valid,
    invalidBidCount: manifest.bids.length - valid,
  };
}

const MANIFEST_FIELDS = ["protocolVersion", "chainId", "auctionContract", "auctionId", "requestId", "keyId", "bidDigest", "bidCount"] as const;
const BID_FIELDS = ["bidIndex", "bidder", "commitment", "envelope", "txHash", "blockHash", "blockNumber", "logIndex"] as const;
const RESULT_FIELDS = [
  "protocolVersion", "chainId", "auctionContract", "auctionId", "requestId", "attempt", "bidDigest", "bidCount", "keyId",
  "solverCodeHash", "configHash", "outcome", "winner", "winningAmountUnits", "validBidCount", "invalidBidCount",
] as const;

const pick = <T extends object>(o: T, keys: readonly (keyof T)[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/** Canonical UTF-8 JSON: fixed field order, no whitespace. Hash the raw bytes of this string, never a re-encoding. */
export function canonicalManifest(m: Manifest): string {
  return JSON.stringify({ ...pick(m, MANIFEST_FIELDS), bids: m.bids.map((b) => pick(b, BID_FIELDS)) });
}

export function canonicalResult(r: SettlementResult): string {
  return JSON.stringify(pick(r, RESULT_FIELDS));
}

export function sha256Utf8(s: string): Hex {
  return sha256(stringToBytes(s));
}
