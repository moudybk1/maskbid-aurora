"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
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

export async function loadAuction(id: bigint, now?: bigint): Promise<AuctionView> {
  const [a, t] = await Promise.all([readAuction(id), now ?? chainNow()]);
  const asset = await readAsset(a.tokenId);
  const meta = await fetchMetadata(asset.metadataURI, asset.metadataHash);
  const state = AUCTION_STATES[a.state];
  return {
    id, a, asset, metadata: meta.data, integrity: meta.integrity, state, now: t,
    cancelReason: CANCEL_REASONS[a.cancelReason],
    phase: displayPhase({ state, startTime: a.startTime, endTime: a.endTime, activeAttempt: a.activeAttempt, now: t }),
  };
}

export async function loadAuctions(): Promise<AuctionView[]> {
  const [count, now] = await Promise.all([readAuctionCount(), chainNow()]);
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  return Promise.all(ids.map((id) => loadAuction(id, now)));
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
