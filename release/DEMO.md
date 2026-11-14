# Demo script (4 minutes, Aurora testnet)

Everything below runs against the deployment in `contracts/deployments/1313161555.json`. Record a real run; do not
substitute a solver response (blueprint 13 §7). Two full rehearsals with fresh auctions come first.

## Before recording

1. `npm run demo` starts the keeper (timers + manifest submission), the indexer and the web app on http://localhost:3001 together
   (`npm run indexer:setup` once beforehand; under the lots it should read "from the indexer").
   Check `maskbid-adapter.testnet` and `maskbid-keeper.testnet` still hold NEAR (each TEE run costs the adapter 0.1 NEAR).
   Run `npm run demo:seed` the same day: it lists three live background lots that close after 24 h.
2. The first screen is the Demo / Mainnet card; choose Demo. It is asked once per browser, so record in a fresh profile
   (or clear the site data) to have it on camera. MetaMask on Aurora testnet (chain 1313161555), wallets seller S,
   verifier/deployer V, bidders A/B/C from `.env.aurora-testnet` (never show that file). Each needs a little testnet ETH
   and mUSDC: `node scripts/testnet-gates.mjs setup` tops up gas, registers the simulator identities and calls the token faucet (a visitor with their own wallet uses the in-app mUSDC faucet instead).
3. The demo profile needs a 3 minute minimum auction. Pre-create the main auction (reserve 100, deposit 10) about 6 minutes
   before the take, with a key prepared a few minutes earlier ("Prepare auction key" took 9–14 s on testnet, `release/latency.json`).
4. Keep the recorded recovery auctions open in tabs: `/auctions/5/evidence` (no-sale), `/auctions/6/evidence` (winner
   default), `/auctions/7/evidence` (solver timeout). Golden reference: `/auctions/2/evidence`.

## Shot list

| Time | Screen | Say |
| --- | --- | --- |
| 0:00 | Demo / Mainnet card → Landing | MaskBid runs as a demo on Aurora testnet for now; mainnet is not open. Sealed-bid auctions: bids are encrypted in the browser, every bid is committed on Aurora, only the winning bid is ever revealed. |
| 0:25 | Sell → Verifier → Create auction | Asset is reviewed by a verifier before it can be auctioned; the seller prepares a per-auction key through Aurora → NEAR → OutLayer. The private key only exists inside the TEE. |
| 1:05 | Auction page, bid dialog as A, B, C (150 / 120 / 135) | One transaction: deposit + 490-byte envelope + commitment. The dialog shows deposit, remainder and default rule before confirming. |
| 2:00 | Wait for close; `/auctions/<id>/evidence` | Keeper requests settlement; the solver refuses an incomplete or reordered manifest, ranks the full set privately, and Aurora accepts the result only from the pinned callback sender. |
| 2:40 | Winner pays remainder, losers withdraw | Winner pays 150 − 10, seller receives exactly 150, token moves in the same transaction; losers refund independently. |
| 3:05 | Evidence of auctions 5, 6, 7 | No-sale refunds everyone and returns the asset; a winner who does not pay forfeits the deposit; a solver that never answers cannot lock funds. |
| 3:40 | `/config` + README "What is not here" | Honest limits: attestation recorded as available, not verified; identity is a labelled simulator; the read model serves the catalog only. |

## Fallback

If OutLayer testnet does not answer (on 2026-11-14 its worker resolved requests minutes late, so every
`prepareAuctionKey` hit the two-minute timeout), record the live flow on the local chain and the TEE evidence from testnet:

1. README step 3: `npm run anvil`, `npm run deploy:local`, `npm run solver`, `npm run web`. "Connect wallet" offers the
   Anvil demo accounts, so no MetaMask is needed: seller `#0`, verifier `#7`, bidders A / B / C. Three bids by hand take
   about two minutes, so a 3 minute lot is tight; publish it right before the take or pick 10 minutes.
2. Say on camera that this run uses the local mock adapter, not a TEE. `/config` and every evidence page carry that banner.
3. For the private path show the recorded testnet auctions with `npm run web:live`: `/auctions/2/evidence` (golden) and
   5, 6, 7 (recoveries); their transaction hashes are in `release/gate-run.json`. Only one `next dev` runs per checkout,
   so stop the local web before starting this one.

Do not claim a World ID flow or a verified TDX attestation.
