# Release gate report (blueprint 12 §8)

Date: 2026-11-08; recovery rerun and demo entry 2026-11-12. Network: Aurora testnet (1313161555) + NEAR testnet + OutLayer testnet. The gate runs predate the
repository's first commit (`c7e4746`, https://github.com/moudybk1/maskbid-aurora), so they carry no commit hash; `release/build.json` pins the solver wasm SHA-256 (`0xccca50e5…1ae8`), `contracts/deployments/1313161555.json`
pins the deployment. Raw transaction hashes: `release/gate-run.json`. Status words: PASS / PASS-with-caveat / NOT DONE.

## Gates

| Gate | Result | How to reproduce | Artifact | Limits |
| --- | --- | --- | --- | --- |
| G-01 XCC round trip | PASS | `node scripts/testnet-gates.mjs golden` | `gate-run.json` `golden.key`, `negatives.keeperRequestKey` | non-router refusal on chain is a trap at `assert_xcc` (release wasm strips panic text); message asserted in adapter unit test |
| G-02 TEE key lifecycle | PASS | `… golden`, `… negatives` | `golden.key.prepared`, `negatives.directProdWasm`, `negatives.otherBuildUnseal` | sealed record is `0x01‖seed` (deviation from spec 15 §7, documented in README) |
| G-03 Complete-set solver | PASS | `… golden` | `golden.settlement`, `golden.exits` | 3 bids on chain; 32 bids only natively (see benchmark) |
| G-04 Callback integrity | PASS-with-caveat | `… golden`, `… stale` | `negatives.strangerOnSettlementResult`, `stale.*` | the late attempt-1 result was rejected as `WrongState`, not `StaleRequest`; `StaleRequest` is covered in Foundry `Xcc.t.sol` only |
| Recovery: no-sale | PASS | `TIMEOUT_AUCTION_ID=<n+3> node scripts/testnet-gates.mjs recovery` | `gate-run.json` `recovery.nosale` | auctions 5 (2026-11-08) and 11 (2026-11-12): two below-reserve bids → TEE `NO_SALE`, both deposits refunded, asset returned to seller |
| Recovery: winner default | PASS | same run | `recovery.default` | auctions 6 and 12: winner never paid → keeper `expireClaim`, deposit forfeited to seller credit, defaulted winner refused a refund, loser refunded, asset returned |
| Recovery: solver timeout | PASS | same run (keeper started with `SKIP_ALL_ATTEMPTS_AUCTIONS=<n+3>`) | `recovery.timeout` | auctions 7 and 13: keeper withheld every manifest; 3 attempts, then `cancelAfterSolverTimeout` after the 30 min grace, both refunds and the asset claim worked. The solver was never asked, so this proves the on-chain exit, not adapter failure handling |
| Contracts | PASS | `npm run test:contracts` | 31/31 Foundry tests | not an external audit |
| Protocol vectors TS / Rust / Solidity | PASS | `npm run test:protocol`; `cd apps/private-solver && cargo test --release`; Foundry `Protocol.t.sol` | 6/6 TS, 6/6 Rust, 2/2 Solidity, byte-identical | fixture key is public |
| NEAR adapter unit tests | PASS | `cd apps/near-adapter && cargo test` | 8/8 | `env::promise_result` deprecation warnings (near-sdk) not addressed |
| Web build + types | PASS | `npm -w web run build`, `npx tsc --noEmit -p apps/web` | 18 routes | |
| Live TDX attestation check | NOT DONE | — | execution ids and output hashes recorded as `available_unchecked` | verify on OutLayer's executions page or `outlayer-verify`; the UI never labels it verified |
| Real World ID | NOT DONE | — | `/verify` is a labelled simulator (assurance 2) | needs provider access; registry must be deployed with `allowSimulator = false` for real use |

## Measurements

- Solver, native (not TEE), 20 samples, `release/bench.json`: RSA-2048 key from seed p50 81 ms / p95 122 ms (10 samples);
  Rust SOLVE p50 1.5 / 2.6 / 24.7 ms for 1 / 3 / 32 bids; TypeScript SOLVE p50 0.7 / 1.9 / 19.4 ms.
- Private path on testnet, `release/latency.json` (block-timestamp resolution, small samples): key preparation p50 10 s / p95 14 s (7 samples); settlement p50 17 s / p95 38 s (6 samples).
- UI checks, built-in browser at 375 px on `/`, `/auctions/2`, `/activity`, `/sell`, `/verifier`, `/config`, `/verify`:
  no horizontal page overflow, one `main` and one `h1` per page, no unnamed controls, no images without `alt`,
  `prefers-reduced-motion` rules present. Automated heuristics only: no screen-reader pass, no keyboard-focus-return test,
  no contrast measurement.

## Requirements (ids from the blueprint's `requirements.csv`; the blueprint is kept outside this repository)

| ID | Status | Evidence / gap |
| --- | --- | --- |
| FR-01 | done | `apps/web/src/lib/config.ts`: one chain, no fallback; writes disabled without a deployment |
| FR-02 | partial | wallet connect with a switch-chain action; no SIWE session |
| FR-03 | partial | `ParticipantRegistry` enforces eligibility, expiry, duplicate identity (Foundry); provider is a simulator, not World ID |
| FR-04..06 | done | `Asset.t.sol`, seller + verifier pages; reviewer ≠ issuer, no self mint |
| FR-07 | done | `createAuction`, `/auctions/new`; golden auction on testnet |
| FR-08 | done | catalog from the read model (`/api/index/auctions`: keyset pagination, lifecycle filter, last sync and source shown); falls back to chain reads when the indexer is behind or absent |
| FR-09 | done | browser AES-GCM + RSA-OAEP, no plaintext fallback; vectors in three languages |
| FR-10, FR-11 | done | atomic bid, 32-bid cap, one bid per wallet and identity (Foundry; testnet golden) |
| FR-12 | done | keeper `requestSettlement` after close; testnet |
| FR-13 | done | manifest rebuilt from `BidPlaced` logs, digest checked in solver; tamper cases fatal (TS + Rust tests) |
| FR-14 | done | tie → earliest index, below-reserve invalid; vectors |
| FR-15 | done | pinned callback sender, active request/attempt only; testnet negatives |
| FR-16, FR-17 | done | golden accounting asserted on testnet (winner −150, seller +150, losers whole) |
| FR-18 | done | Foundry + testnet auction 6 (`recovery.default`) |
| FR-19 | done | Foundry + testnet auction 5 (no-sale) and auction 7 (seller exit after timeout) |
| FR-20 | done | Foundry + testnet auction 7 (`recovery.timeout`, 3 attempts) |
| FR-21 | partial | evidence page shows source per row; attestation unchecked by design |
| FR-22 | done | `npm run indexer:check`: projections dropped and replayed from stored events are identical, unique event key stops double application, balances follow ERC-1155 transfers (`release/indexer.json`) |
| FR-23 | partial | contract errors mapped to user copy (`lib/tx.ts`); no persisted pending-transaction recovery |
| FR-24 | done | entry pause never blocks exits (Foundry) |
| FR-25 | partial | mobile layout and static a11y heuristics checked; no assistive-tech test |
| FR-26 | done | `MaskBidAsset.redeem`, asset page |
| FR-27 | partial | activity page reads chain; the read model holds bids, balances and seller credits but no route serves them yet; no receipt sync status |
| FR-28 | done | simulator labelled in UI and in `/config`; registry flag `allowSimulator` |
| NFR-01 | met locally | catalog read p50 5 ms / p95 6 ms, max 12 ms over 100 warm requests, one client, 13 lots, development server and local PostgreSQL (`npm run indexer:bench`); no regional deployment and no cold-start sample |
| NFR-02 | met on small samples | index lag p50 4 s, max 7 s over 10 samples (chain head time minus the checkpoint block's time); target ≤ 30 s |
| NFR-03 | met on small samples | SettlementRequested → SettlementAccepted p50 17 s, p95 38 s, max 38 s over 6 settlements (`latency.json`); target p95 ≤ 180 s |
| NFR-04 | done | accounting asserted per scenario; after the recovery run escrow == locked deposits and seller credits == 0 (see Notes) |
| NFR-05 | partial | no-sale, default and solver timeout all exit with funds returned; no backup/restore drill; the read model was dropped and rebuilt from the chain instead (`release/indexer.json`) |
| NFR-06 | partial | no plaintext bid reaches any server; no log scrubbing audit |
| NFR-07, NFR-08 | partial | see UI checks; one browser engine only |
| NFR-09 | partial | dist wasm hash equals the pin in `release/build.json` and the deployed `solverCodeHash`; a clean rebuild on another machine was not repeated |
| NFR-10 | done | MAX_BIDS 32, 1 KiB output, benchmark above |

## Notes

- **Recovery run accounting.** The three recovery flows each passed their own asserts. The script's last aggregate assert
  ("escrow back to its starting balance") failed because it was mis-specified: `withdrawSellerCredit` pays out all of a
  seller's accumulated credit, and 30 mUSDC of older defaulted-winner credit from earlier gate runs was in it. Verified afterwards
  from chain state: net token flow since the first recovery bid A −10, B 0, seller +40 (10 new + 30 older), escrow −30; `totalSellerCredits` 0 and
  escrow 20 mUSDC equal to `totalLockedDeposits` (20 mUSDC left locked by earlier runs, not by this one). `release/gate-run.json`
  `recovery_2026_11_08.accounting` records that post-hoc check.
  **Rerun of 2026-11-12 with the fixed assert (auctions 11, 12, 13): all three flows and every final accounting assert passed.**
  Escrow was 65 mUSDC before and after and equals `totalLockedDeposits` (20 mUSDC left locked by earlier runs plus 45 mUSDC of
  deposits on the open demo lots 8 and 9), seller credits are 0, the loser was made whole and the defaulted winner lost exactly the
  10 mUSDC deposit. `release/gate-run.json` `recovery` now holds this run; the first run is kept as `recovery_2026_11_08`.
- **Evidence viewer.** The testnet profile now reads `apps/keeper/evidence` (`SOLVER_EVIDENCE_DIR`), the keeper fills in the adapter's
  output hash once delivered, and the viewer no longer reports "does not match" when that hash is simply absent. Auction 5 now shows
  "Output hash matches the accepted on-chain result".
- **Hero media.** The hero is painted on canvas at runtime (`apps/web/src/lib/stipple.ts`), with no image or video file. The
  earlier `plate.jpg` / `plate.mp4`, copied from a CDN link whose licence was never recorded, were no longer referenced and were
  removed from the tree on 2026-11-12. They are still in the history of commit `c7e4746`.
- **Console noise on testnet.** Lots created by the gate scripts have asset metadata URIs at `https://example.invalid/...`, so the
  catalog logs ~20 `ERR_NAME_NOT_RESOLVED` requests; cards fall back to "Asset #n". A lot registered with a reachable
  metadata URL should not (not tested).
  The demo lots listed by `npm run demo:seed` carry their metadata as a `data:` URI and load without a request.
- **Demo entry (2026-11-12).** The app opens with a Demo / Mainnet card (`apps/web/src/components/ModeGate.tsx`): Demo enters the
  deployment the build points at, Mainnet is shown as coming soon because no mainnet deployment exists. `npm run demo` starts the
  keeper and the web app together; `npm run demo:seed` listed lots 8, 9 and 10 (open until 2026-11-13 14:50 UTC, three sealed bids
  between them). Checked in the built-in browser at desktop width and 375 px: the card waits for the intro, cannot be dismissed
  before a choice, is not asked again after it, and reopens from the header chip. Screenshots: `release/screenshots/`.
- **Indexer (2026-11-12).** `apps/indexer` replays Aurora logs into PostgreSQL 16 with the blueprint's `schema.sql` applied verbatim
  (indexer-owned tables only). `npm run indexer:check` passed on testnet at block 277386291: 218 events, 13 auctions, 23 bids, 15 assets,
  29 balances and 14 keys equal to the contract views, `totalLockedDeposits` and `totalSellerCredits` included; a second ingest applied
  nothing (T-INDEX-01 duplicate); drop-and-replay and a full rebuild from the chain were identical (T-INDEX-02); the API login could
  read and was refused a write. Limits: crash-before-commit rests on the per-block transaction and was not fault-injected; the reorg
  path was exercised as a forced rebuild, not with a real reorg; an unknown event is stored without a projection but none occurred;
  only event-bearing blocks are stored. The web catalog was checked in the built-in browser both ways: "from the indexer" while the
  worker ran, "from chain" with all 13 lots after it was stopped for 30 s.
- **Lot illustrations (2026-11-12).** Lots without photographs now get an object painted on canvas for their category (watch, framed
  picture, collector's pass; any other category keeps the sealed envelope), in the same stipple technique as the clouds, placed by
  the metadata hash. No image files. Checked on the three demo lots at desktop width and at 390 px (headless Chrome), on the lot page and on the catalog cards.
