// Shared six-state enum and derived display phase (spec 05 §6). Enum storage never changes by time alone.
export const AUCTION_STATES = ["Created", "Active", "Ended", "PendingClaim", "Finalized", "Cancelled"] as const;
export type AuctionState = (typeof AUCTION_STATES)[number];
export const CANCEL_REASONS = ["None", "SellerCancelled", "NoValidBid", "WinnerDefault", "SolverTimeout"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
export const DEPOSIT_STATUSES = ["Locked", "Refunded", "Consumed", "Forfeited"] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];
export const KEY_STATUSES = ["None", "Requested", "Ready", "Consumed"] as const;

export type DisplayPhase = "Scheduled" | "Live" | "Closed" | "Resolving" | "Claim" | "Completed" | "Cancelled";

export interface PhaseInput {
  state: AuctionState;
  startTime: bigint;
  endTime: bigint;
  activeAttempt: number;
  now: bigint;
}

export function displayPhase(a: PhaseInput): DisplayPhase {
  switch (a.state) {
    case "Finalized":
      return "Completed";
    case "Cancelled":
      return "Cancelled";
    case "PendingClaim":
      return "Claim";
    case "Ended":
      return a.activeAttempt > 0 ? "Resolving" : "Closed";
    default:
      if (a.now < a.startTime) return "Scheduled";
      return a.now < a.endTime ? "Live" : "Closed";
  }
}

export const CANCEL_REASON_LABEL: Record<CancelReason, string> = {
  None: "",
  SellerCancelled: "Cancelled by seller before any bid",
  NoValidBid: "No valid bid met the reserve",
  WinnerDefault: "Winner missed the payment deadline",
  SolverTimeout: "Settlement timed out",
};
