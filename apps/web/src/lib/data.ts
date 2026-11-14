"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import { AUCTION_STATES, CANCEL_REASONS, DEPOSIT_STATUSES, displayPhase, initialDigest, nextDigest, type DisplayPhase } from "@maskbid/protocol";
import {
  chainNow, fetchMetadata, listAuctions, readAsset, readAuction, readBid, readConfig, readKeyById,
  type Account, type AssetMetadata, type AssetStruct, type AuctionStruct, type KeyRecord,
} from "./client";

/** Poll a chain read: loading / error / data / lastSynced. Writes always re-read before acting.
    Public RPC nodes are rate-limited, so nothing polls faster than every 10 s or while the tab is hidden; an action refreshes at once. */
export function useChainData<T>(fetcher: () => Promise<T>, deps: unknown[], interval = 10_000) {
  const intervalMs = Math.max(interval, 10_000);
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
    const tick = () => { if (alive && document.visibilityState === "visible") refresh(); };
    refresh();
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

export interface Catalog { list: AuctionView[]; source: "chain" }

/** Lots for the landing page, straight from the contract: one view for the whole catalogue. */
export async function loadAuctions(): Promise<Catalog> {
  const [lots, now] = await Promise.all([listAuctions(), chainNow()]);
  return { list: await Promise.all(lots.map(({ id, a, asset }) => toView(id, a, asset, now))), source: "chain" };
}

export interface BidRow {
  index: number; bidder: Account; bidderAddress: Hex; commitment: Hex; depositStatus: (typeof DEPOSIT_STATUSES)[number]; envelope: Hex;
  /** The ordered digest after this bid, recomputed in this browser from the stored commitments. */
  digestAfter: Hex;
}

/** The bid set as the contract stores it. The digest chain is rebuilt here, so a page can compare its end with the contract's digest. */
export async function loadBids(id: bigint): Promise<BidRow[]> {
  const [a, cfg] = await Promise.all([readAuction(id), readConfig()]);
  const bids = await Promise.all(Array.from({ length: a.bidCount }, (_, i) => readBid(id, BigInt(i))));
  let digest = initialDigest({ chainId: cfg.chainId, auctionContract: cfg.contractAddress, auctionId: id }, a.keyId);
  return bids.map((b, index) => {
    digest = nextDigest(digest, BigInt(index), b.bidderAddress, b.commitment);
    return { index, bidder: b.bidder, bidderAddress: b.bidderAddress, commitment: b.commitment, depositStatus: DEPOSIT_STATUSES[b.depositStatus], envelope: b.envelope, digestAfter: digest };
  });
}

export const loadKey = (keyId: Hex): Promise<KeyRecord | undefined> => readKeyById(keyId);
