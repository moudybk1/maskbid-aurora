// One full auction on the NEAR-native deployment, with the real OutLayer TEE: key, sealed bids, settlement, claim,
// refund, and the credit fallback for a payout that could not be delivered. Writes release/near-testnet-run.json.
// Usage: node scripts/near-testnet.mjs              one auction (signs through near-cli-rs with ~/.near-credentials/testnet; rerunnable)
//        node scripts/near-testnet.mjs recover <id>  the solver-timeout exit for an auction whose attempts ran out
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { bytesToHex } from "viem";
import { encryptBid } from "../packages/protocol/src/index.ts";

const C = process.env.MASKBID_CONTRACT ?? "maskbid-v2.testnet", TOKEN = "maskbid-usdc.testnet", KEEPER = "maskbid-keeper.testnet";
const SELLER = `seller.${KEEPER}`, ALICE = `alice.${KEEPER}`, BOB = `bob.${KEEPER}`;
const RPC = process.env.NEAR_RPC ?? "https://rpc.testnet.near.org";
const RESERVE = 100_000_000n, DEPOSIT = 10_000_000n, BIDS = { [ALICE]: 130_000_000n, [BOB]: 150_000_000n };
const FEE = "0.1 NEAR"; // executionDeposit: one OutLayer run

const evidence = { contract: C, token: TOKEN, startedAt: new Date().toISOString(), txs: {} };
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const sha = (s) => `0x${createHash("sha256").update(s).digest("hex")}`;
const until = async (label, fn, timeoutMs = 420_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() - t0 < timeoutMs, `timeout waiting: ${label}`); await sleep(5000); } };

async function view(contract, method, args = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const body = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } };
      const r = await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
      if (!r.result?.result) throw new Error(JSON.stringify(r.error ?? r.result));
      return JSON.parse(Buffer.from(r.result.result).toString());
    } catch (e) {
      if (attempt >= 4) throw new Error(`view ${contract}.${method}: ${e.message}`);
      await sleep(3000);
    }
  }
}
/** Sends a transaction; `ok` is the CLI's verdict, the caller asserts the effect through views. */
function call(label, signer, contract, method, args, { deposit = "0 NEAR", gas = "100 Tgas" } = {}) {
  // The CLI prints the return value on stdout and the transaction id, gas and logs on stderr.
  const r = spawnSync("near", ["contract", "call-function", "as-transaction", contract, method, "json-args", JSON.stringify(args), "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-legacy-keychain", "send"], { encoding: "utf8", maxBuffer: 1 << 22 });
  const ok = r.status === 0;
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).replace(/\x1b\[[0-9;]*m/g, "");
  const tx = /Transaction ID: (\S+)/.exec(out)?.[1] ?? null;
  const gasBurnt = /Gas burned: ([\d.]+ \w+)/.exec(out)?.[1];
  console.log(`  ${method} by ${signer} ok=${ok}${gasBurnt ? ` gas=${gasBurnt}` : ""} ${tx ? `https://testnet.nearblocks.io/txns/${tx}` : ""}`);
  if (!ok) console.log(out.slice(-1500));
  if (tx) evidence.txs[label] = gasBurnt ? { tx, gasBurnt } : { tx };
  return { ok, tx, out };
}
const balance = async (who) => BigInt(await view(TOKEN, "ft_balance_of", { account_id: who }));
const auction = (id) => view(C, "get_auction", { auction_id: id });
const evidencePath = new URL("../release/near-testnet-run.json", import.meta.url);
const earlier = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")).runs : [];
const save = () => writeFileSync(evidencePath, JSON.stringify({ runs: [...earlier, evidence] }, null, 2) + "\n");

/** After the settlement deadline anyone cancels the auction, every bidder takes the deposit back and the seller the unit. */
async function recover(id) {
  step(`recover auction ${id} after its settlement deadline`);
  let a = await auction(id);
  assert.ok(["Created", "Active", "Ended"].includes(a.state), `auction ${id} is ${a.state}`);
  await until("settlement deadline", () => now() > a.settlementDeadline + 3, 2_400_000);
  const locked = BigInt((await view(C, "get_config")).totalLockedDeposits);
  call("cancelAfterSolverTimeout", ALICE, C, "cancel_after_solver_timeout", { auction_id: id }); // anyone may
  a = await auction(id);
  assert.deepEqual([a.state, a.cancelReason], ["Cancelled", "SolverTimeout"]);
  for (let i = 0; i < a.bidCount; i++) {
    const { bidder } = await view(C, "get_bid", { auction_id: id, bid_index: i });
    const had = await balance(bidder);
    call(`refund:${bidder}`, bidder, C, "claim_refund", { auction_id: id });
    await until("refund", async () => (await balance(bidder)) === had + BigInt(a.depositUnits), 60_000);
  }
  call("claimReturnedAsset", a.seller, C, "claim_returned_asset", { auction_id: id });
  assert.equal((await view(C, "nft_token", { token_id: a.tokenId })).owner_id, a.seller, "unit back with the seller");
  assert.equal(BigInt((await view(C, "get_config")).totalLockedDeposits), locked - BigInt(a.depositUnits) * BigInt(a.bidCount));
  Object.assign(evidence, { recoveredAuctionId: id, cancelReason: a.cancelReason, lastError: a.lastError, finishedAt: new Date().toISOString() });
  save();
  console.log(`\nOK: auction ${id} cancelled after the solver timeout, ${a.bidCount} deposits refunded, unit returned.`);
}
if (process.argv[2] === "recover") {
  await recover(Number(process.argv[3]));
  process.exit(0);
}

step("deployment");
const cfg = await view(C, "get_config");
const held = [cfg.totalLockedDeposits, cfg.totalCredits, String(await balance(C))]; // other auctions' money: must not move
assert.equal(cfg.token, TOKEN);
Object.assign(evidence, { chainId: cfg.chainId, contractAddress: cfg.contractAddress, solverCodeHash: cfg.solverCodeHash, wasmUrl: cfg.wasmUrl, configHash: cfg.configHash, outlayer: cfg.outlayer });
console.log(`  ${C} address ${cfg.contractAddress} configHash ${cfg.configHash}\n  solver ${cfg.solverCodeHash} via ${cfg.outlayer}`);

step("participants and tokens");
if (!(await view(TOKEN, "storage_balance_of", { account_id: C }))) call("registerContractOnToken", KEEPER, TOKEN, "storage_deposit", { account_id: C }, { deposit: "0.00125 NEAR" });
for (const who of [SELLER, ALICE, BOB]) {
  if (!(await view(C, "is_eligible", { account: who }))) call(`register:${who}`, who, C, "register_simulated", {}); // self-service simulator assurance
  assert.equal(await view(C, "is_eligible", { account: who }), true, `${who} eligible`);
}
for (const who of [ALICE, BOB]) if ((await view(TOKEN, "storage_balance_of", { account_id: who })) === null || (await balance(who)) < 200_000_000n) call(`faucet:${who}`, who, TOKEN, "faucet", { to: who });

step("asset: register and verify");
const before = await view(C, "get_config");
call("registerAsset", SELLER, C, "register_asset", { metadata_uri: `ipfs://maskbid-near-testnet/${Date.now()}`, metadata_hash: sha("metadata") });
const tokenId = before.nextTokenId;
call("verifyAndMint", KEEPER, C, "verify_and_mint", { token_id: tokenId, review_digest: sha("review") });
assert.equal((await view(C, "nft_token", { token_id: tokenId })).owner_id, SELLER);
evidence.tokenId = tokenId;

step("auction key from the TEE (INIT_KEY)");
const keyTx = call("prepareAuctionKey", SELLER, C, "prepare_auction_key", { client_salt: `0x${randomBytes(32).toString("hex")}` }, { deposit: FEE, gas: "300 Tgas" });
const keyRequestId = /"keyRequestId":"(0x[0-9a-f]{64})"/.exec(keyTx.out)?.[1]; // from the key_requested event
assert.ok(keyRequestId, `no key request id in the CLI output:\n${keyTx.out.slice(-1500)}`);
let key = await until("key answer", async () => { const k = await view(C, "get_key", { key_request_id: keyRequestId }); return k.status === "Requested" ? null : k; });
for (let i = 0; key.status === "Failed" && i < 4; i++) {
  console.log(`  key run failed: ${key.lastError}; redispatching`);
  call(`redispatchKey${i + 1}`, KEEPER, C, "redispatch_key", { key_request_id: keyRequestId }, { deposit: FEE, gas: "300 Tgas" });
  key = await until("key answer", async () => { const k = await view(C, "get_key", { key_request_id: keyRequestId }); return k.status === "Requested" ? null : k; });
}
assert.equal(key.status, "Ready", `key: ${key.lastError}`);
Object.assign(evidence, { keyRequestId, keyId: key.keyId, sealedBlobHash: key.sealedBlobHash });
console.log(`  keyId ${key.keyId}`);
save();

step("auction: create, sealed bids");
const endTime = now() + 215; // demo profile: 180 s minimum
call("createAuction", SELLER, C, "create_auction", { token_id: tokenId, reserve_units: String(RESERVE), deposit_units: String(DEPOSIT), start_time: 0, end_time: endTime, key_id: key.keyId });
const id = (await view(C, "get_config")).auctionCount;
let a = await auction(id);
assert.deepEqual([a.tokenId, a.seller, a.keyId], [tokenId, SELLER, key.keyId]);
assert.equal((await view(C, "nft_token", { token_id: tokenId })).owner_id, C, "unit in escrow");
evidence.auctionId = id;
const spki = Uint8Array.from(Buffer.from(key.publicKeySpki, "base64"));
const domain = { chainId: BigInt(cfg.chainId), auctionContract: cfg.contractAddress, auctionId: BigInt(id) };
const start = {};
for (const who of [ALICE, BOB]) {
  start[who] = await balance(who);
  const { envelope } = await encryptBid({ spki, domain, bidder: await view(C, "address_of", { account: who }), amountUnits: BIDS[who], expectedKeyId: key.keyId });
  const msg = JSON.stringify({ action: "bid", auction_id: id, envelope: bytesToHex(envelope) });
  if (who === ALICE) {
    call("bidWrongDeposit", who, TOKEN, "ft_transfer_call", { receiver_id: C, amount: String(DEPOSIT + 1n), msg }, { deposit: "1 yoctoNEAR", gas: "150 Tgas" });
    assert.equal(await balance(who), start[who], "a refused bid is refunded in full");
  }
  call(`bid:${who}`, who, TOKEN, "ft_transfer_call", { receiver_id: C, amount: String(DEPOSIT), msg }, { deposit: "1 yoctoNEAR", gas: "150 Tgas" });
  assert.equal(await balance(who), start[who] - DEPOSIT, `${who} deposit locked`);
}
a = await auction(id);
assert.deepEqual([a.state, a.bidCount], ["Active", 2]);
console.log(`  auction ${id}: 2 bids, digest ${a.bidDigest}`);
save();

step("settlement in the TEE (SOLVE)");
await until("auction end", () => now() > endTime + 3);
call("requestSettlement", KEEPER, C, "request_settlement", { auction_id: id }, { deposit: FEE, gas: "300 Tgas" });
const settled = () => until("settlement answer", async () => { const x = await auction(id); return x.state !== "Ended" || x.attemptFailed ? x : null; });
a = await settled();
for (let i = 0; a.state === "Ended" && a.activeAttempt < Number(cfg.maxAttempts); i++) {
  console.log(`  attempt ${a.activeAttempt} failed: ${a.lastError}; retrying`);
  call(`retrySettlement${i + 1}`, KEEPER, C, "retry_settlement", { auction_id: id }, { deposit: FEE, gas: "300 Tgas" });
  a = await settled();
}
if (a.state === "Ended") {
  Object.assign(evidence, { settlementFailed: a.lastError, attempts: a.activeAttempt, settlementDeadline: a.settlementDeadline });
  save();
  console.log(`\nOutLayer gave no result in ${a.activeAttempt} attempts (${a.lastError}). Auction ${id} stays locked until its settlement deadline; then run: node scripts/near-testnet.mjs recover ${id}`);
  process.exit(1);
}
assert.deepEqual([a.state, a.winner, a.winningAmountUnits], ["PendingClaim", BOB, String(BIDS[BOB])], `settlement: ${a.lastError}`);
Object.assign(evidence, { requestId: a.activeRequestId, attempts: a.activeAttempt, bidDigest: a.bidDigest, outputSha256: a.outputSha256, winner: a.winner, winningAmountUnits: a.winningAmountUnits });
console.log(`  winner ${a.winner} at ${a.winningAmountUnits}, output ${a.outputSha256}`);
save();

step("claim, payout, refund");
const sellerRegistered = (await view(TOKEN, "storage_balance_of", { account_id: SELLER })) !== null;
const sellerBefore = sellerRegistered ? await balance(SELLER) : 0n;
call("claim", BOB, TOKEN, "ft_transfer_call", { receiver_id: C, amount: String(BIDS[BOB] - DEPOSIT), msg: JSON.stringify({ action: "claim", auction_id: id }) }, { deposit: "1 yoctoNEAR", gas: "150 Tgas" });
assert.equal((await auction(id)).state, "Finalized");
assert.equal((await view(C, "nft_token", { token_id: tokenId })).owner_id, BOB, "winner holds the unit");
assert.equal(await balance(BOB), start[BOB] - BIDS[BOB]);
if (!sellerRegistered) {
  // The seller cannot hold the token yet, so the payout fails and stays owed as a credit.
  await until("payout fallback", async () => BigInt(await view(C, "get_credit", { account: SELLER })) === BIDS[BOB], 60_000);
  console.log(`  payout to an unregistered seller became a credit of ${BIDS[BOB]}`);
  evidence.creditFallback = true;
  call("sellerRegistersOnToken", SELLER, TOKEN, "storage_deposit", {}, { deposit: "0.00125 NEAR" });
  call("withdrawCredit", SELLER, C, "withdraw_credit", {});
}
await until("seller paid", async () => (await balance(SELLER)) === sellerBefore + BIDS[BOB], 60_000);
call("claimRefund", ALICE, C, "claim_refund", { auction_id: id });
await until("refund", async () => (await balance(ALICE)) === start[ALICE], 60_000);

const end = await view(C, "get_config");
assert.deepEqual([end.totalLockedDeposits, end.totalCredits, String(await balance(C))], held, "this auction left nothing behind");
assert.equal(BigInt(held[2]), BigInt(held[0]) + BigInt(held[1]), "token balance = locked deposits + credits");
evidence.finishedAt = new Date().toISOString();
save();
console.log("\nOK: full auction settled on NEAR testnet. Evidence: release/near-testnet-run.json");
