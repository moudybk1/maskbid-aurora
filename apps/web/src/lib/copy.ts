// Copy deck (spec 10 §9). No "trustless", "ZK verified" or "guaranteed authentic".
export const COPY = {
  privacy: "Your bid amount is encrypted. Account names, deposits and transaction times remain public.",
  firstPrice: "The highest valid bid wins and pays its own bid amount. Ties go to the earliest recorded bid.",
  defaultRule: "If you miss the payment deadline, your deposit is forfeited to the seller.",
  bidRecorded: "Bid recorded on chain. Your activity view is synchronizing.",
  keyError: "The auction encryption key could not be verified. No bid was sent.",
  solverDelayed: "The result is taking longer than expected. Your deposit remains in the auction contract.",
  timeout: "Settlement timed out. You can now withdraw your deposit.",
  evidenceUnchecked: "Execution receipt available. Attestation has not been checked by this viewer.",
  demoAsset: "Demo asset. This token does not include physical delivery.",
  simulator: "Simulated participant verification — demo environment.",
  redeem: "Burn this test token. This action does not confirm physical delivery.",
};
