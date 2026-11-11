// Keccak domain hashes, byte-for-byte equal to Solidity abi.encode (spec 15 §1, §5, §6, §8, §13).
import { encodeAbiParameters, keccak256, sha256, stringToBytes, type Address, type Hex } from "viem";

export interface Domain {
  chainId: bigint;
  auctionContract: Address;
  auctionId: bigint;
}

const typeHash = (label: string): Hex => keccak256(stringToBytes(label));

export const TYPE_HASH = {
  AAD: typeHash("MASKBID_AAD_V1"),
  BID: typeHash("MASKBID_BID_V1"),
  SET: typeHash("MASKBID_SET_V1"),
  REQUEST: typeHash("MASKBID_REQUEST_V1"),
  CONFIG: typeHash("MASKBID_CONFIG_V1"),
  KEY_REQUEST: typeHash("MASKBID_KEY_REQUEST_V1"),
  REVIEW: typeHash("MASKBID_REVIEW_V1"),
} as const;

const B32 = { type: "bytes32" } as const;
const U256 = { type: "uint256" } as const;
const ADDR = { type: "address" } as const;
const U8 = { type: "uint8" } as const;
const U32 = { type: "uint32" } as const;

export function aadHash(d: Domain, bidder: Address, keyId: Hex): Hex {
  return keccak256(
    encodeAbiParameters([B32, U256, ADDR, U256, ADDR, B32], [TYPE_HASH.AAD, d.chainId, d.auctionContract, d.auctionId, bidder, keyId]),
  );
}

export function bidCommitment(d: Domain, bidder: Address, keyId: Hex, envelope: Uint8Array): Hex {
  return keccak256(
    encodeAbiParameters(
      [B32, U256, ADDR, U256, ADDR, B32, B32],
      [TYPE_HASH.BID, d.chainId, d.auctionContract, d.auctionId, bidder, keyId, keccak256(envelope)],
    ),
  );
}

export function initialDigest(d: Domain, keyId: Hex): Hex {
  return keccak256(encodeAbiParameters([B32, U256, ADDR, U256, B32], [TYPE_HASH.SET, d.chainId, d.auctionContract, d.auctionId, keyId]));
}

export function nextDigest(previous: Hex, bidIndex: bigint, bidder: Address, commitment: Hex): Hex {
  return keccak256(encodeAbiParameters([B32, U256, ADDR, B32], [previous, bidIndex, bidder, commitment]));
}

export function requestIdHash(d: Domain, bidDigest: Hex, bidCount: bigint, attempt: number, configHash: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [B32, U256, ADDR, U256, B32, U256, U32, B32],
      [TYPE_HASH.REQUEST, d.chainId, d.auctionContract, d.auctionId, bidDigest, bidCount, attempt, configHash],
    ),
  );
}

export function keyRequestIdHash(
  chainId: bigint,
  auctionContract: Address,
  owner: Address,
  nonce: bigint,
  clientSalt: Hex,
  configHash: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters([B32, U256, ADDR, ADDR, U256, B32, B32], [TYPE_HASH.KEY_REQUEST, chainId, auctionContract, owner, nonce, clientSalt, configHash]),
  );
}

export interface ReviewInput {
  chainId: bigint;
  assetContract: Address;
  tokenId: bigint;
  reviewer: Address;
  metadataHash: Hex;
  decision: 1 | 2; // 1 approve, 2 reject
  reason: string;
}

export const REVIEW_CHECKLIST_VERSION = "asset-review-v1";

export function reviewDigest(r: ReviewInput): Hex {
  return keccak256(
    encodeAbiParameters(
      [B32, U256, ADDR, U256, ADDR, B32, U8, B32, B32],
      [
        TYPE_HASH.REVIEW,
        r.chainId,
        r.assetContract,
        r.tokenId,
        r.reviewer,
        r.metadataHash,
        r.decision,
        sha256(stringToBytes(r.reason.normalize("NFC"))),
        keccak256(stringToBytes(REVIEW_CHECKLIST_VERSION)),
      ],
    ),
  );
}

/** keyId = SHA-256 of the SPKI DER. */
export function keyIdFromSpki(spki: Uint8Array): Hex {
  return sha256(spki);
}
