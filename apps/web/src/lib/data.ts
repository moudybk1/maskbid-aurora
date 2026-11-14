"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { AUCTION_STATES, CANCEL_REASONS, DEPOSIT_STATUSES, displayPhase, type DisplayPhase } from "@maskbid/protocol";
import {
  auctionEvents, chainNow, fetchMetadata, readAsset, readAuction, readAuctionCount, readBid, readKeyById,
  type AssetMetadata, type AssetStruct, type AuctionStruct, type KeyRecord,
} from "./client";

/** Poll a chain read: loading / error / data / lastSynced. Writes always re-read before acting. */
export function useChainData<T>(fetcher: () => Promise<T>, deps: unknown[], intervalMs = 5000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [syncedAt, setSyncedAt] = useState<number>();
  const fn = useRef(fetcher);
  fn.current = fetcher;
  const refresh = useCallback(async () => {
    try {
      setData(await fn.current());
      setError(undefined);
      setSyncedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  }, []);
  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) refresh(); };
    tick();
    const t = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs, refresh]);
  return { data, error, syncedAt, refresh, loading: data === undefined && !error };
}

export interface AuctionView {
  id: bigint;
  a: AuctionStruct;
  asset: AssetStruct;
  metadata?: AssetMetadata;
  integrity: "verified" | "mismatch" | "unavailable";
  phase: DisplayPhase;
  state: (typeof AUCTION_STATES)[number];
  cancelReason: (typeof CANCEL_REASONS)[number];
  now: bigint;
}

async function toView(id: bigint, a: AuctionStruct, asset: AssetStruct, now: bigint): Promise<AuctionView> {
  const meta = await fetchMetadata(asset.metadataURI, asset.metadataHash);
  const state = AUCTION_STATES[a.state];
  return {
    id, a, asset, metadata: meta.data, integrity: meta.integrity, state, now,
    cancelReason: CANCEL_REASONS[a.cancelReason],
    phase: displayPhase({ state, startTime: a.startTime, endTime: a.endTime, activeAttempt: a.activeAttempt, now }),
  };
}

export async function loadAuction(id: bigint, now?: bigint): Promise<AuctionView> {
  const [a, t] = await Promise.all([readAuction(id), now ?? chainNow()]);
  return toView(id, a, await readAsset(a.tokenId), t);
}

// How the read model spells the two enums the contract returns as numbers (schema.sql).
const CANCEL_DB = [null, "SELLER_CANCELLED", "NO_VALID_BID", "WINNER_DEFAULT", "SOLVER_TIMEOUT"];
const ASSET_DB = ["Pending", "Verified", "Rejected"];
let noReadModel = false; // 501 once: this deployment has no indexer database, so stop asking

/** The catalog from the indexer's read model, shaped exactly like the contract structs. Undefined when it is absent, behind or failing. */
async function loadIndexed(): Promise<AuctionView[] | undefined> {
  if (noReadModel) return undefined;
  const res = await fetch("/api/index/auctions", { cache: "no-store" });
  if (res.status === 501) noReadModel = true;
  if (!res.ok) return undefined;
  const j = (await res.json()) as { now: string; auctions: Record<string, string & number & boolean>[] };
  const n = BigInt;
  return Promise.all(j.auctions.map((r) => toView(n(r.id), {
    tokenId: n(r.tokenId), seller: r.seller as Address, reserveUnits: n(r.reserveUnits), depositUnits: n(r.depositUnits), startTime: n(r.startTime), endTime: n(r.endTime),
    state: AUCTION_STATES.indexOf(r.state as never), keyId: r.keyId as Hex, solverCodeHash: r.solverCodeHash as Hex, configHash: r.configHash as Hex, bidCount: r.bidCount,
    bidDigest: r.bidDigest as Hex, settlementDeadline: n(r.settlementDeadline), activeRequestId: (r.activeRequestId ?? zeroHash) as Hex, activeAttempt: r.activeAttempt,
    attemptStartedAt: n(r.attemptStartedAt), winner: (r.winner ?? zeroAddress) as Address, winningAmountUnits: n(r.winningAmountUnits), claimDeadline: n(r.claimDeadline),
    cancelReason: CANCEL_DB.indexOf(r.cancelReason ?? null), returnedAssetClaimed: r.returnedAssetClaimed,
  }, {
    issuer: r.issuer as Address, metadataURI: r.metadataURI, metadataHash: r.metadataHash as Hex, status: ASSET_DB.indexOf(r.status), reviewer: (r.reviewer ?? zeroAddress) as Address,
    reviewDigest: (r.reviewDigest ?? zeroHash) as Hex, minted: r.minted, redeemed: r.redeemed,
  }, n(j.now))));
}

export interface Catalog { list: AuctionView[]; source: "indexer" | "chain" }

/** Lots for the landing page: one request to the read model when the indexer is healthy, otherwise straight from the chain.
    ponytail: the read model serves the newest 100 lots in one page; follow `nextBefore` when a deployment outgrows that. */
export async function loadAuctions(): Promise<Catalog> {
  const indexed = await loadIndexed().catch(() => undefined);
  if (indexed) return { list: indexed, source: "indexer" };
  const [count, now] = await Promise.all([readAuctionCount(), chainNow()]);
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  return { list: await Promise.all(ids.map((id) => loadAuction(id, now))), source: "chain" };
}

export interface BidRow {
  index: number; bidder: Address; commitment: Hex; txHash: Hex; depositStatus: (typeof DEPOSIT_STATUSES)[number]; newDigest: Hex; envelope: Hex;
}

export async function loadBids(id: bigint): Promise<BidRow[]> {
  const logs = await auctionEvents("BidPlaced", { auctionId: id });
  const rows = await Promise.all(
    logs.map(async (l) => {
      const b = await readBid(id, BigInt(l.args.bidIndex as number));
      return {
        index: Number(l.args.bidIndex), bidder: l.args.bidder as Address, commitment: l.args.commitment as Hex, txHash: l.transactionHash as Hex,
        depositStatus: DEPOSIT_STATUSES[b.depositStatus], newDigest: l.args.newDigest as Hex, envelope: l.args.envelope as Hex,
      };
    }),
  );
  return rows.sort((x, y) => x.index - y.index);
}

export const loadKey = (keyId: Hex): Promise<KeyRecord> => readKeyById(keyId);
