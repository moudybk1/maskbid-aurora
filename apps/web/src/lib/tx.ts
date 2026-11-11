"use client";
import { useCallback, useState } from "react";
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Hash, type WalletClient } from "viem";
import { publicClient } from "./client";
import { useWallet } from "./wallet";

/** Contract custom errors rendered as user copy (spec 07 §10: never faked into success). */
const ERROR_COPY: Record<string, string> = {
  AuctionClosed: "This auction is closed. No transaction was sent.",
  AuctionNotStarted: "This auction has not started yet.",
  NotEligible: "This wallet is not a verified participant.",
  DuplicateBid: "This wallet has already placed a bid in this auction.",
  DuplicateIdentity: "This identity has already placed a bid in this auction.",
  SellerCannotBid: "The seller cannot bid on their own auction.",
  BidCapReached: "The auction reached its maximum of 32 bids. Your deposit was not taken.",
  InvalidEnvelopeLength: "The encrypted bid was malformed. No bid was sent.",
  KeyNotReady: "The auction encryption key could not be verified. No bid was sent.",
  KeyAlreadyConsumed: "That key was already used for another auction.",
  WrongState: "The auction is not in a state that allows this action. Refresh and try again.",
  DeadlinePassed: "The deadline for this action has passed.",
  NotWinner: "Only the winner can claim this auction.",
  AlreadyRefunded: "This deposit was already withdrawn or consumed.",
  NotRefundable: "This deposit cannot be refunded right now.",
  NothingToWithdraw: "There is no seller credit to withdraw.",
  InvalidRecipient: "The recipient address is not allowed.",
  EntryPaused: "New entries are paused by the operator. Exits remain available.",
  AttemptNotTimedOut: "The current settlement attempt has not timed out yet.",
  MaxAttemptsReached: "All settlement attempts were used. Wait for the timeout to open refunds.",
  InvalidDeposit: "Deposit must be greater than 0 and at most the reserve.",
  InvalidDuration: "Schedule is outside the allowed duration for this deployment profile.",
  AssetNotVerified: "Only a verified, unredeemed asset can be auctioned.",
  AssetBusy: "This asset is already escrowed in another auction.",
  NotSeller: "Only the seller can do this.",
  NotHolder: "You do not hold this token.",
  AlreadyRedeemed: "This token was already redeemed.",
  ReviewerIsIssuer: "A reviewer cannot verify their own asset.",
  ERC20InsufficientBalance: "Insufficient mUSDC balance.",
  ERC20InsufficientAllowance: "Token approval is missing or too small.",
};

export function describeError(e: unknown): string {
  if (e instanceof BaseError) {
    const revert = e.walk((err) => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    if (name && ERROR_COPY[name]) return ERROR_COPY[name];
    if (name) return `Transaction reverted: ${name}`;
    if (e.walk((err) => err instanceof UserRejectedRequestError)) return "You declined the wallet request. You can review and try again.";
    return e.shortMessage;
  }
  return e instanceof Error ? e.message : String(e);
}

export type TxStatus = "idle" | "signing" | "confirming" | "success" | "error";

export interface TxState {
  status: TxStatus;
  hash?: Hash;
  error?: string;
  label?: string;
}

/** One write at a time: simulate (decoded reverts), sign, wait for the receipt. Success means a mined receipt, nothing less. */
export function useTx() {
  const { client, address, wrongChain } = useWallet();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(async (label: string, build: (client: WalletClient) => Promise<Hash>) => {
    if (!client || !address) throw new Error("Connect a wallet first");
    if (wrongChain) throw new Error("Wrong network. Switch to the deployment chain before signing.");
    setState({ status: "signing", label });
    try {
      const hash = await build(client);
      setState({ status: "confirming", hash, label });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Transaction reverted on-chain.");
      setState({ status: "success", hash, label });
      return receipt;
    } catch (e) {
      setState({ status: "error", error: describeError(e), label });
      throw e;
    }
  }, [client, address, wrongChain]);

  const reset = useCallback(() => setState({ status: "idle" }), []);
  return { state, run, reset };
}
