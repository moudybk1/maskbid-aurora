import { createPublicClient, http, type Address, type ContractEventName, type Hex } from "viem";
import { assetAbi, auctionAbi, registryAbi, tokenAbi } from "@maskbid/contracts";
import { chain, requireDeployment, RPC_URL } from "./config";

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL), batch: { multicall: false } });

export function contracts() {
  const d = requireDeployment();
  return {
    auction: { address: d.auction, abi: auctionAbi } as const,
    asset: { address: d.asset, abi: assetAbi } as const,
    registry: { address: d.registry, abi: registryAbi } as const,
    token: { address: d.token, abi: tokenAbi } as const,
    deployment: d,
  };
}

export type AuctionStruct = {
  tokenId: bigint; seller: Address; reserveUnits: bigint; depositUnits: bigint; startTime: bigint; endTime: bigint; state: number;
  keyId: Hex; solverCodeHash: Hex; configHash: Hex; bidCount: number; bidDigest: Hex; settlementDeadline: bigint; activeRequestId: Hex;
  activeAttempt: number; attemptStartedAt: bigint; winner: Address; winningAmountUnits: bigint; claimDeadline: bigint; cancelReason: number;
  returnedAssetClaimed: boolean;
};
export type AssetStruct = { issuer: Address; metadataURI: string; metadataHash: Hex; status: number; reviewer: Address; reviewDigest: Hex; minted: boolean; redeemed: boolean };
export type KeyRecord = { owner: Address; keyRequestId: Hex; keyId: Hex; publicKeySpki: Hex; sealedBlobHash: Hex; status: number };
export type BidStruct = { bidder: Address; identityId: Hex; commitment: Hex; depositStatus: number };

export const readAuction = (id: bigint) => publicClient.readContract({ ...contracts().auction, functionName: "getAuction", args: [id] }) as Promise<AuctionStruct>;
export const readAsset = (tokenId: bigint) => publicClient.readContract({ ...contracts().asset, functionName: "getAsset", args: [tokenId] }) as Promise<AssetStruct>;
export const readKeyById = (keyId: Hex) => publicClient.readContract({ ...contracts().auction, functionName: "getKeyByKeyId", args: [keyId] }) as Promise<KeyRecord>;
export const readKeyRecord = (id: Hex) => publicClient.readContract({ ...contracts().auction, functionName: "getKeyRecord", args: [id] }) as Promise<KeyRecord>;
export const readBid = (id: bigint, index: bigint) => publicClient.readContract({ ...contracts().auction, functionName: "getBid", args: [id, index] }) as Promise<BidStruct>;
export const readBidIndex = (id: bigint, who: Address) => publicClient.readContract({ ...contracts().auction, functionName: "getBidIndex", args: [id, who] }) as Promise<bigint>;
export const readAuctionCount = () => publicClient.readContract({ ...contracts().auction, functionName: "auctionCount" }) as Promise<bigint>;
export const readEligible = (who: Address) => publicClient.readContract({ ...contracts().registry, functionName: "isEligible", args: [who] }) as Promise<boolean>;
export const readParticipant = (who: Address) => publicClient.readContract({ ...contracts().registry, functionName: "participants", args: [who] }) as Promise<readonly [Hex, bigint, number, boolean]>;
export const readTokenBalance = (who: Address) => publicClient.readContract({ ...contracts().token, functionName: "balanceOf", args: [who] }) as Promise<bigint>;
export const readAllowance = (who: Address) => publicClient.readContract({ ...contracts().token, functionName: "allowance", args: [who, contracts().auction.address] }) as Promise<bigint>;
export const readAssetBalance = (who: Address, tokenId: bigint) => publicClient.readContract({ ...contracts().asset, functionName: "balanceOf", args: [who, tokenId] }) as Promise<bigint>;
export const readSellerCredit = (who: Address) => publicClient.readContract({ ...contracts().auction, functionName: "getSellerCredit", args: [who] }) as Promise<bigint>;
export const readConfig = () => publicClient.readContract({ ...contracts().auction, functionName: "getConfig" }) as Promise<{
  chainId: bigint; auctionContract: Address; paymentToken: Address; assetContract: Address; participantRegistry: Address; callbackSender: Address;
  nearAdapterAccount: string; solverCodeHash: Hex; configHash: Hex; profile: string; protocolVersion: bigint; maxBids: bigint; minDurationSeconds: bigint;
  maxDurationSeconds: bigint; claimWindowSeconds: bigint; settlementGraceSeconds: bigint; attemptTimeoutSeconds: bigint; maxAttempts: bigint; envelopeBytes: bigint;
}>;

export async function chainNow(): Promise<bigint> {
  return (await publicClient.getBlock()).timestamp;
}

export function auctionEvents<N extends ContractEventName<typeof auctionAbi>>(eventName: N, args?: Record<string, unknown>) {
  const { auction, deployment } = contracts();
  return publicClient.getContractEvents({ ...auction, eventName, args: args as never, fromBlock: BigInt(deployment.deployBlock) });
}

export function assetEvents<N extends ContractEventName<typeof assetAbi>>(eventName: N, args?: Record<string, unknown>) {
  const { asset, deployment } = contracts();
  return publicClient.getContractEvents({ ...asset, eventName, args: args as never, fromBlock: BigInt(deployment.deployBlock) });
}

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
