"use client";
import { useCallback, useState } from "react";
import { NearError, type TxResult } from "./near";
import { useWallet } from "./wallet";
import { write, type Call } from "./write";

/** Contract error names rendered as user copy (spec 07 §10: never faked into success). */
const ERROR_COPY: Record<string, string> = {
  AuctionClosed: "This auction is closed. Nothing was taken.",
  AuctionNotStarted: "This auction has not started yet.",
  AuctionNotEnded: "This auction is still open.",
  NotEligible: "This account is not a verified participant.",
  DuplicateBid: "This account has already placed a bid in this auction. Your deposit was returned.",
  SellerCannotBid: "The seller cannot bid on their own auction.",
  BidCapReached: "The auction reached its maximum of 32 bids. Your deposit was returned.",
  InvalidEnvelopeLength: "The encrypted bid was malformed. No bid was recorded.",
  KeyNotReady: "The auction encryption key is not ready, or belongs to another account.",
  KeyAlreadyConsumed: "That key was already used for another auction.",
  WrongState: "The auction is not in a state that allows this action. Refresh and try again.",
  DeadlinePassed: "The deadline for this action has passed.",
  DeadlineNotReached: "The settlement deadline has not passed yet.",
  ClaimWindowOpen: "The winner can still pay. Try again after the payment deadline.",
  NotWinner: "Only the winner can claim this auction.",
  InvalidPayment: "The payment must be exactly the winning bid minus the deposit. Nothing was taken.",
  AlreadyRefunded: "This deposit was already withdrawn or consumed.",
  NotRefundable: "This deposit cannot be refunded right now.",
  NothingToWithdraw: "There is no credit to withdraw.",
  EntryPaused: "New entries are paused by the operator. Exits remain available.",
  AttemptNotTimedOut: "The current settlement attempt is still running.",
  MaxAttemptsReached: "All settlement attempts were used. Refunds open at the settlement deadline.",
  DispatchPending: "The key request is still running. Try again in a few minutes.",
  AttachExecutionDeposit: "This call must carry the exact execution deposit for one private computation.",
  InvalidDeposit: "The deposit must be exactly this auction's fixed deposit (and, for a new auction, at most the reserve).",
  InvalidDuration: "Schedule is outside the allowed duration for this deployment profile.",
  AssetNotVerified: "Only a verified, unredeemed asset can be auctioned.",
  AssetBusy: "This asset is escrowed in an auction.",
  NotSeller: "Only the seller can do this.",
  NotHolder: "This account does not hold the token.",
  AlreadyRedeemed: "This token was already redeemed.",
  AlreadyClaimed: "The asset was already returned.",
  ReviewerIsIssuer: "A reviewer cannot verify their own asset.",
  Unauthorized: "This account does not hold the role this action needs.",
  UnknownAuction: "That auction does not exist.",
};

export function describeError(e: unknown): string {
  if (e instanceof NearError) {
    if (e.panic && ERROR_COPY[e.panic]) return ERROR_COPY[e.panic];
    if (e.panic && /doesn't have enough balance/.test(e.panic)) return "Not enough mUSDC in this account.";
    if (e.panic && /is not registered/.test(e.panic)) return "That account cannot hold mUSDC yet. Get test mUSDC from the faucet first.";
    if (e.panic) return `The contract refused the call: ${e.panic}`;
  }
  return e instanceof Error ? e.message : String(e);
}

export type TxStatus = "idle" | "signing" | "confirming" | "success" | "error";

export interface TxState {
  status: TxStatus;
  hash?: string;
  error?: string;
  label?: string;
}

/** One write at a time: sign, broadcast, wait until the chain has run it. Success means the call succeeded on chain, nothing less. */
export function useTx() {
  const { client } = useWallet();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(async (label: string, call: Call): Promise<TxResult> => {
    if (!client) throw new Error("Connect an account first");
    setState({ status: "signing", label });
    try {
      const result = await write(client, call, (hash) => setState({ status: "confirming", hash, label }));
      setState({ status: "success", hash: result.hash, label });
      return result;
    } catch (e) {
      setState({ status: "error", error: describeError(e), label, hash: e instanceof NearError ? e.hash : undefined });
      throw e;
    }
  }, [client]);

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset };
}
