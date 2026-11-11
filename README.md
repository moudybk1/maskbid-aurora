# MaskBid Aurora

Sealed-bid auctions for one verified asset token: bidders lock a fixed deposit and submit an encrypted bid in one
transaction, every accepted bid is committed to an ordered on-chain digest, a solver ranks the complete set privately,
and payment, token delivery, refunds and default penalties settle on the auction contract.

Built from the [MaskBid Aurora blueprint](../MaskBid-Aurora-Blueprint/aurora-spec/README.md). Contracts, protocol codec
and the web app implement the spec. Settlement has two paths: the **private path** (Aurora XCC → NEAR adapter → OutLayer
TEE solver → Aurora callback, see "Aurora testnet") and a **clearly labelled local-only fallback adapter** for Anvil
(`apps/solver`, not a TEE).

## Layout

| Path | What |
| --- | --- |
| `contracts/` | Foundry. `ParticipantRegistry`, `MaskBidAsset` (ERC-1155, one unit per id), `MaskBidAuction`, `MockUSDC`, `Protocol` hashing library. 31 tests: golden auction accounting, winner default, no-sale, solver timeout, retry/stale/duplicate callbacks, XCC dispatch, bid rules, entry pause, key binding, asset roles, Solidity-side protocol vectors. |
| `packages/protocol/` | TypeScript protocol v1: amount grammar (bigint only), keccak domain hashes, 201-byte plaintext, 490-byte AES-GCM + RSA-OAEP envelope, manifest validation, deterministic ranking. Tested against `vectors/protocol-vectors.json`; the same vectors are checked in Solidity (`contracts/test/Protocol.t.sol`). |
| `packages/contracts/` | Generated ABIs + deployment manifest (`npm run sync`), chain helpers. |
| `apps/private-solver/` | Rust `wasm32-wasip2` OutLayer guest: `INIT_KEY` (RSA-OAEP-2048 keygen, seed sealed with the host key `auction_keys` bound to this exact build + the adapter as predecessor), `SOLVE` (manifest steps 1-8, decrypt, rank, canonical result), `UNSEAL_PROBE` (G-02 negatives). Reproduces `protocol-vectors.json` byte for byte (`cargo test`). `build.sh` prints the SHA-256 that is `SOLVER_CODE_HASH`. |
| `apps/near-adapter/` | NEAR contract (near-sdk): accepts `request_key` / `request_solve` only from the pinned XCC router `<hex(auction)>.aurora`, runs the pinned WasmUrl on `outlayer.testnet`, stores SPKI + sealed blob + keyId, checks every result binding, delivers `onKeyPrepared` / `onSettlementResult` through the engine `call` (EVM sender = implicit address of the adapter account = `callbackSender`). |
| `apps/keeper/` | Testnet keeper: permissionless Aurora timers plus manifest submission to the adapter (`submit_manifest`). Holds no key material. |
| `apps/solver/` | **Local-only fallback adapter (Anvil).** Generates per-auction RSA keys unsealed on disk, acts as keeper, builds the manifest from `BidPlaced` logs, runs the TypeScript solver, delivers the callback from the pinned EOA. Not a TEE; never deploy it against a public chain. |
| `release/` | Evidence of the Aurora testnet gate run (tx hashes, hashes, negative tests). |
| `apps/web/` | Next.js 16 app: catalog, auction detail with sealed-bid dialog (browser-side encryption), evidence page, seller flow (register → review → key → publish), verifier queue, activity, simulated verification, config page. |
| `scripts/` | `deploy-local.mjs`, `sync-abi.mjs`, `solver-hash.mjs` (local-mock code identity), `e2e.mjs` (golden auction end to end), `fastfs-upload.py` (publish a wasm to FastFS), `testnet-gates.mjs` (Aurora testnet gate run: `golden`, `negatives`, `stale`, `recovery`), `bench.mjs` (solver p50/p95 for 1/3/32 bids), `latency.mjs` (key and settlement latency from testnet logs). |

## Run locally

Requirements: Node 22+, Foundry (`~/.foundry/bin` on PATH), npm.

```bash
npm install
npm test                      # forge test + protocol vector tests
npm run anvil                 # terminal 1: local chain, 2 s blocks
npm run deploy:local          # terminal 2: deploys demo profile, seeds Anvil accounts, regenerates ABIs
npm run solver                # terminal 3: local adapter + keeper + solver
npm run web                   # terminal 4: http://localhost:3000
npm run e2e                   # optional: scripted golden auction (needs anvil + solver running)
```

`apps/web/.env.local` is created from `.env.example` by hand (copy it). Demo profile timers: 3 min minimum duration,
5 min claim window, 30 min settlement grace, 240 s attempt timeout, 3 attempts, 32 bids.

Anvil roles after `deploy:local`: `#0` seller / admin / registrar, `#1`–`#5` verified participants, `#7` verifier,
`#9` callback sender (the adapter). The web app offers these as "dev accounts" on chain 31337 only; a browser wallet
(MetaMask) works on any configured chain.

Demo walkthrough: connect `#0` → Sell → Register asset → connect `#7` → Verifier queue → Approve → connect `#0` →
Create auction (Prepare key, terms, publish) → connect `#1`/`#2`/`#3` → Place sealed bid (150 / 120 / 135) → wait for
close → adapter settles → winner pays remainder, losers withdraw, evidence page shows digest/request/output hashes.

## Protocol guarantees implemented

- Bid = one transaction: deposit transfer + 490-byte envelope in `BidPlaced` + commitment + ordered digest update.
  No API stores ciphertext; the manifest is rebuilt from logs.
- Solver refuses incomplete, reordered, tampered or duplicated manifests (fatal, never a partial winner); malformed or
  below-reserve bids that are present count as invalid; zero qualifying bids → `NO_SALE`.
- Contract accepts a result only from the pinned callback sender, for the active request and attempt, with matching
  chain/contract/auction/config/code/key/count/digest, before the settlement deadline, exactly once.
- Winner pays `winningAmount − deposit`, seller receives exactly `winningAmount`, token moves in the same transaction.
  Losers refund independently; default forfeits the deposit into a pull-based seller credit; seller timeout and no-sale
  open refunds and a separate returned-asset claim. Entry pause never blocks exits.
- Money is `bigint`/`uint256` end to end; the UI parses `^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$`.

## What is not here (honest limits)

- **The local profile is not private.** On Anvil (`nearAdapterAccount = local-mock-adapter`, `xccPrecompile = 0`) the
  auction emits events only and `apps/solver` plays adapter + TEE: keys are unsealed files in `keystore/`, evidence is
  `available_unchecked`. Operator privacy is claimed only for the Aurora testnet deployment and only to the extent the
  gate table below shows as passed.
- **No World ID.** `/verify` uses a labelled simulator (assurance = 2) through a server-held registrar key. Real
  deployments must deploy the registry with `allowSimulator = false`.
- **No PostgreSQL / indexer.** The UI reads auctions, bids and evidence straight from the chain and the adapter's
  evidence folder. Fine for ≤ a few dozen auctions; add the spec's indexer when log scans get slow.
- No SIWE session, uploads/object storage, rate limits or reorg handling. Metadata is frozen by `/api/metadata` into
  `apps/web/data/` with a SHA-256 content address.
- On Anvil the solver code identity is the SHA-256 of the four protocol source files (`scripts/solver-hash.mjs`); on
  Aurora testnet it is the SHA-256 of the solver wasm component (`apps/private-solver/dist/SHA256`).
- TEE attestation is recorded as `available_unchecked`: the OutLayer execution ids and output hashes are stored, but the
  Intel TDX quote is not verified by this repository (use OutLayer's `/executions` page or `outlayer-verify`).

## Aurora testnet

Private-compute path (blueprint 04 §5/§7, 15 §7/§11). Money and the asset never leave Aurora; the NEAR side only
authenticates requests, runs the pinned solver and returns bound results.

```
seller/keeper tx ─▶ MaskBidAuction (Aurora 1313161555)
                      │ prepareAuctionKey / requestSettlement: borsh Eager promise to the XCC precompile
                      ▼
            <hex(auction)>.aurora  (XCC router; the ONLY predecessor the adapter accepts)
                      ▼
            maskbid-adapter.testnet  request_key / request_solve  (snapshot: digest, count, attempt, key, reserve, times)
                      │ request_execution(WasmUrl = pinned sha256, encryption key auction_keys bind=wasm caller=predecessor)
                      ▼
            outlayer.testnet → TEE worker runs apps/private-solver (INIT_KEY / SOLVE)
                      │ JSON output ≤ 1 KiB (keyId + SPKI + sealed seed, or the canonical result)
                      ▼
            adapter on_key / on_solve: verify bindings, store, engine `call` → auction.onKeyPrepared / onSettlementResult
                      ▼
            msg.sender == implicit("maskbid-adapter.testnet") == callbackSender  (0x780dFA1E400790fffAeC39CF89c4c8182843570C)
```

Deploy (demo profile): build the solver (`apps/private-solver/build.sh`, note `SOLVER_CODE_HASH`), publish the wasm at an
https URL whose bytes hash to it (`scripts/fastfs-upload.py dist/... maskbid-keeper.testnet`), then

```bash
cd contracts && PROFILE=demo SOLVER_CODE_HASH=0x<sha256> NEAR_ADAPTER_ACCOUNT=maskbid-adapter.testnet \
  forge script script/Deploy.s.sol --rpc-url https://testnet.aurora.dev --private-key $DEPLOYER_KEY --broadcast --legacy
npm run sync                                  # folds contracts/deployments/1313161555.json into the app
# NEAR: deploy + init the adapter with the auction address, configHash and the wasm url/hash, then create the XCC router
near contract deploy maskbid-adapter.testnet use-file apps/near-adapter/dist/maskbid-near-adapter.wasm with-init-call new json-args '{...}' ...
near contract call-function as-transaction aurora fund_xcc_sub_account file-args <borsh: auction address || 0x00> attached-deposit '2.5 NEAR' ...
KEEPER_KEY=... npm -w @maskbid/keeper start    # timers + manifest submission
```

`CALLBACK_SENDER` is derived in `Deploy.s.sol` from `NEAR_ADAPTER_ACCOUNT` (`Protocol.implicitAuroraAddress`); the
adapter's `get_config` reports the same address and the keeper refuses to start on a mismatch. Deviation from 15 §7: the
sealed record is `0x01 || 32-byte RSA seed` (the same build regenerates the key deterministically) instead of the PKCS#8
DER, because OutLayer's on-chain resume payload is 1 KiB; the AAD is exactly `keyRequestId || owner || solverCodeHash ||
configHash`. The adapter stores the sealed blob; OutLayer storage is not used (unavailable for direct WasmUrl runs).

### Gate results

Run of 2026-10-23 (evidence in `release/gate-run.json`, `release/build.json`, `release/hosting.json`). Deployed and bound:
auction `0x9802a6510D47941B139720d54bdBd61954ed5C5A`, adapter `maskbid-adapter.testnet`, router
`9802a651…5c5a.aurora` (funded, tx `2fHNYQEc…`), callback sender `0x780dFA1E…570C` reported identically by the contract
and the adapter.

**Run of 2026-11-08 (OutLayer testnet downloader back online): the private path works end to end.** The earlier run
(2026-10-23) stopped at the TEE because the testnet had no download-capable worker; the Workers page now lists
`testnet-downloader`, FastFS serves the pinned wasm (SHA-256 matches `solverCodeHash`), and the gates ran with the keeper
(`npm run keeper:testnet`). Evidence: `release/gate-run.json` (`golden`, `negatives`, `stale`).

| Gate | Evidence | Status |
| --- | --- | --- |
| G-01 XCC round trip | `prepareAuctionKey` reached the adapter as the pinned router, OutLayer ran INIT_KEY, and `onKeyPrepared` came back from `0x780dFA1E…570C` (the adapter's implicit address). A non-router caller of `request_key` is refused (release wasm strips the panic text, so on chain it shows as a trap at the first statement `assert_xcc`; the message is asserted in the adapter unit test). | passed |
| G-02 TEE key lifecycle | Key generated and sealed in the TEE; the production wasm called by another account is refused before it runs; a different build (probe wasm) cannot open the sealed blob (`unsealed:false`). | passed |
| G-03 Complete-set solver | Three bids (150/120/135) ranked in the TEE; winner 150 accepted on Aurora; winner paid the remainder and received the token, both losers refunded, escrow 0. | passed |
| G-04 Callback integrity | Stranger `onSettlementResult` reverts `UntrustedCallback()` (raw selector `0x75ee93ac`; Aurora RPC returns no error names). Attempt 1 skipped, attempt 2 retried by the keeper and accepted; the late attempt-1 result was rejected by Aurora with `WrongState()` (`0xde4168ba`) because attempt 2 had already settled the auction. The `StaleRequest()` path itself is covered by Foundry `Xcc.t.sol` and was not the revert observed on chain. | passed, with that caveat |
| Recovery: no-sale | Auction 5: two below-reserve bids, the TEE returned `NO_SALE`, both deposits refunded, asset returned to the seller. | passed |
| Recovery: winner default | Auction 6: winner never paid, keeper `expireClaim`, 10 mUSDC deposit forfeited into seller credit, defaulted winner refused a refund, loser refunded, asset returned. | passed |
| Recovery: solver timeout | Auction 7: keeper withheld every manifest, 3 attempts, `cancelAfterSolverTimeout` after the 30 min grace, refunds and asset claim worked. The solver was never asked, so this proves the on-chain exit only. | passed, see caveat |

Recovery run of 2026-11-08 (`node scripts/testnet-gates.mjs recovery`): the three flows passed their own asserts; the script's final aggregate
escrow assert was mis-specified (it ignored 30 mUSDC of older seller credit paid out by the same withdrawal) and failed. The accounting was
verified from chain state afterwards and the assert is fixed but not re-run; details in `release/REPORT.md` and `release/gate-run.json`.

Not claimed: the Intel TDX quote is not verified by this repository (execution ids and output hashes are recorded as
`available_unchecked`; check them on OutLayer's executions page). Operator privacy therefore rests on the pinned code hash,
the sealed key and the callers gate, not on an attestation this repo has checked.

### Measurements and release report

`release/REPORT.md` lists every gate, the requirement status (FR-01..28, NFR-01..10) and what was not done. Native solver benchmark
(`node scripts/bench.mjs`, `release/bench.json`, 20 samples, not a TEE): SOLVE p50 1.5 / 2.6 / 24.7 ms for 1 / 3 / 32 bids, RSA-2048 key from seed p50 81 ms.
Testnet private path (`node scripts/latency.mjs`, `release/latency.json`): key preparation p50 10 s / p95 14 s (7 samples), settlement p50 17 s / p95 38 s (6 samples).
Demo script: `release/DEMO.md`. No demo video or screenshots are recorded yet.

### Deployed addresses (Aurora testnet 1313161555)

| Contract | Address |
| --- | --- |
| MaskBidAuction | `0x9802a6510D47941B139720d54bdBd61954ed5C5A` |
| MaskBidAsset | `0x5A4FA1404e8d2D20d2fb8558908B9cC8B5Dc7351` |
| ParticipantRegistry | `0x5034949260CCEd2b5EedC54FAc864e0f945eA767` |
| MockUSDC (mUSDC) | `0x650E37C7F1eE39f753734A689F1122861321D8f9` |
| NEAR adapter | `maskbid-adapter.testnet` (callback sender `0x780dFA1E400790fffAeC39CF89c4c8182843570C`) |
| Solver code hash | `0xccca50e5634049e41ff08054fbb2c65e34b6165906b17d9e7f4955b775a21ae8` |

### Source and contribution

Upstream design and UI concepts: [UyLeQuoc/MaskBid](https://github.com/UyLeQuoc/MaskBid) (commit `a3dd70ce`). Written here: the Aurora contracts,
the protocol codec and cross-language vectors, the OutLayer TEE solver and NEAR adapter, the keeper, and the web app. Track: Privacy.

Web against the testnet deployment: `npm run web:testnet` (profile in `.env.web-testnet`, gitignored); keeper: `npm run keeper:testnet`.
