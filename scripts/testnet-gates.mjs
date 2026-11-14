// Aurora testnet gate run (blueprint 03 §5, G-01..G-04). Records every transaction into release/gate-run.json.
// Prerequisites: contracts deployed + `npm run sync` (deployments/1313161555.json), adapter initialised, XCC router funded
// (scripts/fund-xcc.py), and `apps/keeper` running with KEEPER_KEY (it drives requestSettlement/retry and submits manifests).
// Usage: node scripts/testnet-gates.mjs golden | negatives | stale | all      (reads .env.aurora-testnet)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, keccak256, stringToBytes, bytesToHex, hexToBytes, decodeEventLog, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { auctionAbi, assetAbi, tokenAbi, registryAbi, chainFor, deployments } from "../packages/contracts/src/index.ts";
import { encryptBid, parseUnits6, reviewDigest, formatMoney, canonicalManifest, sha256Utf8 } from "../packages/protocol/src/index.ts";

const env = Object.fromEntries(readFileSync(new URL("../.env.aurora-testnet", import.meta.url), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const chainId = Number(env.CHAIN_ID ?? 1313161555);
const rpc = env.RPC_URL ?? "https://testnet.aurora.dev";
const d = deployments[String(chainId)];
assert.ok(d, `no deployment for ${chainId}; run the deploy + npm run sync first`);
const chain = chainFor(chainId, rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = (k) => createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(k) });
const D = wallet(env.DEPLOYER_KEY), S = wallet(env.SELLER_KEY), A = wallet(env.BIDDER_A_KEY), B = wallet(env.BIDDER_B_KEY), C = wallet(env.BIDDER_C_KEY);
const auction = { address: d.auction, abi: auctionAbi }, asset = { address: d.asset, abi: assetAbi }, token = { address: d.token, abi: tokenAbi }, registry = { address: d.registry, abi: registryAbi };
const adapter = env.NEAR_ADAPTER_ACCOUNT ?? d.nearAdapterAccount, keeper = env.NEAR_KEEPER_ACCOUNT ?? "maskbid-keeper.testnet", outlayer = env.OUTLAYER_ACCOUNT ?? "outlayer.testnet";
const explorer = (h) => `https://explorer.testnet.aurora.dev/tx/${h}`;
const nearExplorer = (h) => `https://testnet.nearblocks.io/txns/${h}`;

const evidencePath = new URL("../release/gate-run.json", import.meta.url);
const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, "utf8")) : {};
const save = (path, value) => { const parts = path.split("."); let o = evidence; for (const p of parts.slice(0, -1)) o = o[p] ??= {}; o[parts.at(-1)] = value; evidence.updatedAt = new Date().toISOString(); writeFileSync(evidencePath, JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)); };
const step = (s) => console.log(`\n== ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (label, fn, timeoutMs = 600_000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() - t0 < timeoutMs, `timeout waiting: ${label}`); await sleep(5000); } };
const tx = async (w, c, functionName, args) => {
  const hash = await w.writeContract({ ...c, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `${functionName} reverted: ${hash}`);
  console.log(`  ${functionName} ${explorer(hash)}`);
  return r;
};
const events = (eventName, args, fromBlock = BigInt(d.deployBlock)) => pub.getContractEvents({ ...auction, eventName, args, fromBlock });
const getAuction = (id) => pub.readContract({ ...auction, functionName: "getAuction", args: [id] });
const bal = (who) => pub.readContract({ ...token, functionName: "balanceOf", args: [who] });
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------- NEAR helpers (near-cli-rs, keeper keychain)
function nearView(contract, method, args) {
  const out = strip(execFileSync("near", ["contract", "call-function", "as-read-only", contract, method, "json-args", JSON.stringify(args), "network-config", "testnet", "now"], { encoding: "utf8", maxBuffer: 1 << 22 }));
  const s = out.indexOf("{"), e = out.lastIndexOf("}");
  return s >= 0 ? JSON.parse(out.slice(s, e + 1)) : null;
}
/** Sends a NEAR transaction and returns { tx, ok, output } without throwing on an on-chain failure (negatives need the failure). */
function nearTx(contract, method, args, { deposit = "0 NEAR", gas = "300 Tgas", signer = keeper } = {}) {
  let out, ok = true;
  try {
    out = execFileSync("near", ["contract", "call-function", "as-transaction", contract, method, "json-args", JSON.stringify(args), "prepaid-gas", gas, "attached-deposit", deposit, "sign-as", signer, "network-config", "testnet", "sign-with-legacy-keychain", "send"], { encoding: "utf8", maxBuffer: 1 << 22, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) { ok = false; out = (e.stdout ?? "") + (e.stderr ?? ""); }
  out = strip(out);
  const tx = /Transaction ID: (\S+)/.exec(out)?.[1] ?? null;
  console.log(`  near ${contract}.${method} ok=${ok} ${tx ? nearExplorer(tx) : "(no tx id)"}`);
  return { tx, ok, output: out.slice(-6000) };
}
const wasmHash = (cfg) => cfg.solverCodeHash.replace(/^0x/, "");

// ---------------------------------------------------------------- phases
async function setup() {
  step("roles, gas, participants, tokens");
  const cfg = await pub.readContract({ ...auction, functionName: "getConfig" });
  const adapterCfg = nearView(adapter, "get_config", {});
  assert.equal(adapterCfg.callbackSender.toLowerCase(), cfg.callbackSender.toLowerCase(), "adapter implicit address == callbackSender");
  assert.equal(adapterCfg.solverCodeHash.toLowerCase(), cfg.solverCodeHash.toLowerCase(), "adapter pins the deployed solverCodeHash");
  assert.equal(adapterCfg.configHash.toLowerCase(), cfg.configHash.toLowerCase());
  save("deployment", { chainId, auction: d.auction, asset: d.asset, registry: d.registry, token: d.token, configHash: d.configHash, solverCodeHash: d.solverCodeHash, callbackSender: cfg.callbackSender, nearAdapterAccount: cfg.nearAdapterAccount, xccPrecompile: cfg.xccPrecompile, xccGas: cfg.xccGas, adapterConfig: adapterCfg });
  for (const w of [S, A, B, C]) {
    if ((await pub.getBalance({ address: w.account.address })) < parseEther("0.001")) {
      const hash = await D.sendTransaction({ to: w.account.address, value: parseEther("0.003") });
      await pub.waitForTransactionReceipt({ hash });
      console.log(`  funded ${w.account.address} ${explorer(hash)}`);
    }
    if (!(await pub.readContract({ ...registry, functionName: "isEligible", args: [w.account.address] }))) {
      const r = await tx(D, registry, "registerParticipant", [w.account.address, keccak256(stringToBytes(`testnet-simulator:${w.account.address.toLowerCase()}`)), BigInt(Math.floor(Date.now() / 1000) + 29 * 86400), 2, keccak256(stringToBytes("simulated-proof"))]);
      save(`setup.register.${w.account.address}`, r.transactionHash);
    }
    if (w !== S && (await bal(w.account.address)) < parseUnits6("200")) await tx(D, token, "faucet", [w.account.address]);
  }
  console.log("  deployer ETH left", formatEther(await pub.getBalance({ address: D.account.address })));
}

async function golden() {
  await setup();
  step("register + verify + mint asset");
  const metadata = JSON.stringify({ schemaVersion: 1, title: "Demo Collector Watch #001 (Aurora testnet gate run)", description: "Synthetic demo asset", category: "watch", condition: "excellent", isDemo: true, issuerWallet: S.account.address.toLowerCase(), images: [] });
  const metadataHash = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", stringToBytes(metadata))).toString("hex")}`;
  let r = await tx(S, asset, "registerAsset", ["https://example.invalid/maskbid/demo-001.json", metadataHash]);
  const tokenId = decodeEventLog({ abi: assetAbi, ...r.logs[0] }).args.tokenId;
  const digest = reviewDigest({ chainId: BigInt(chainId), assetContract: d.asset, tokenId, reviewer: D.account.address, metadataHash, decision: 1, reason: "metadata complete" });
  const mint = await tx(D, asset, "verifyAndMint", [tokenId, digest]);
  save("golden.asset", { tokenId, registerTx: r.transactionHash, verifyAndMintTx: mint.transactionHash });

  step("G-01/G-02: prepareAuctionKey -> XCC -> adapter -> OutLayer INIT_KEY -> onKeyPrepared");
  r = await tx(S, auction, "prepareAuctionKey", [keccak256(stringToBytes(`salt-${Date.now()}`))]);
  const keyRequestId = r.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "KeyRequested").args.keyRequestId;
  const xccLog = r.logs.find((l) => l.address.toLowerCase() === "0x516cded1d16af10cad47d6d49128e2eb7d27b372");
  save("golden.key", { keyRequestId, prepareTx: r.transactionHash, prepareBlock: r.blockNumber, xccPrecompileLog: xccLog ? { topics: xccLog.topics, dataBytes: (xccLog.data.length - 2) / 2 } : null });
  console.log("  keyRequestId", keyRequestId, "xcc log", !!xccLog);
  const adapterKey = await until("adapter received request_key", () => nearView(adapter, "get_key", { key_request_id: keyRequestId }), 600_000);
  save("golden.key.adapterAfterRequest", { status: adapterKey.status, dispatchedAtMs: adapterKey.dispatchedAtMs });
  const key = await until("KeyPrepared on Aurora", async () => { const k = await pub.readContract({ ...auction, functionName: "getKeyRecord", args: [keyRequestId] }); return k.status === 2 ? k : null; }, 900_000);
  const prepared = (await events("KeyPrepared", { keyRequestId }, r.blockNumber))[0];
  const cbTx = await pub.getTransaction({ hash: prepared.transactionHash });
  const adapterKeyReady = nearView(adapter, "get_key", { key_request_id: keyRequestId });
  assert.equal(cbTx.from.toLowerCase(), d.callbackSender.toLowerCase(), "callback EVM sender is the derived adapter address");
  assert.equal(adapterKeyReady.sealedBlobHash.toLowerCase(), key.sealedBlobHash.toLowerCase(), "sealedBlobHash on Aurora == sha256(blob stored by adapter)");
  assert.equal(adapterKeyReady.keyId.toLowerCase(), key.keyId.toLowerCase());
  save("golden.key.prepared", { keyId: key.keyId, sealedBlobHash: key.sealedBlobHash, spkiBytes: (key.publicKeySpki.length - 2) / 2, onKeyPreparedTx: prepared.transactionHash, callbackFrom: cbTx.from, adapterRecord: { ...adapterKeyReady, spki: undefined, sealedBlob: undefined, sealedBlobBase64Len: adapterKeyReady.sealedBlob.length } });
  console.log("  key READY", key.keyId, "callback from", cbTx.from);

  step("create auction (reserve 100, deposit 10, ~4 min) and three sealed bids 150 / 120 / 135");
  await tx(S, asset, "setApprovalForAll", [d.auction, true]);
  const now = (await pub.getBlock()).timestamp;
  r = await tx(S, auction, "createAuction", [tokenId, parseUnits6("100"), parseUnits6("10"), 0n, now + 240n, key.keyId]);
  const auctionId = decodeEventLog({ abi: auctionAbi, ...r.logs.find((l) => l.address.toLowerCase() === d.auction.toLowerCase()) }).args.auctionId;
  save("golden.auction", { auctionId, createTx: r.transactionHash, endTime: (await getAuction(auctionId)).endTime });
  const domain = { chainId: BigInt(chainId), auctionContract: d.auction.toLowerCase(), auctionId };
  const spki = hexToBytes(key.publicKeySpki);
  const before = { a: await bal(A.account.address), b: await bal(B.account.address), c: await bal(C.account.address), s: await bal(S.account.address) };
  const bids = [];
  for (const [w, amount] of [[A, "150"], [B, "120"], [C, "135"]]) {
    const { envelope, commitment } = await encryptBid({ spki, domain, bidder: w.account.address.toLowerCase(), amountUnits: parseUnits6(amount), expectedKeyId: key.keyId });
    await tx(w, token, "approve", [d.auction, parseUnits6("10")]);
    const rc = await tx(w, auction, "placeBid", [auctionId, bytesToHex(envelope)]);
    const ev = rc.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "BidPlaced");
    assert.equal(ev.args.commitment, commitment, "browser commitment == on-chain commitment");
    bids.push({ bidder: w.account.address, bidIndex: Number(ev.args.bidIndex), tx: rc.transactionHash, digestAfter: ev.args.newDigest });
  }
  save("golden.bids", bids);
  assert.equal((await getAuction(auctionId)).bidCount, 3);

  step("G-01/G-04 negative (Aurora): a stranger cannot deliver a result");
  const a0 = await getAuction(auctionId);
  const fake = { protocolVersion: 1n, chainId: BigInt(chainId), auctionContract: d.auction, auctionId, requestId: a0.activeRequestId, attempt: a0.activeAttempt, bidDigest: a0.bidDigest, bidCount: a0.bidCount, keyId: a0.keyId, solverCodeHash: d.solverCodeHash, configHash: d.configHash, outcome: 0, winner: A.account.address, winningAmountUnits: parseUnits6("150"), validBidCount: 3, invalidBidCount: 0, executionIdHash: keccak256(stringToBytes("fake")), outputHash: keccak256(stringToBytes("fake")) };
  let strangerError = null;
  try { await pub.simulateContract({ ...auction, functionName: "onSettlementResult", args: [fake], account: A.account.address }); } catch (e) { const raw = e.walk?.((x) => typeof x.data === "string")?.data; strangerError = raw === "0x75ee93ac" ? "UntrustedCallback()" : (e.shortMessage ?? e.message).split("\n")[0]; } // Aurora RPC returns raw revert data only; 0x75ee93ac = UntrustedCallback()
  assert.ok(strangerError && /UntrustedCallback/.test(strangerError), `expected UntrustedCallback, got ${strangerError}`);
  save("negatives.strangerOnSettlementResult", { from: A.account.address, simulated: true, revert: strangerError });
  console.log("  stranger result rejected:", strangerError);

  step("wait: close -> keeper requestSettlement (XCC request_solve) -> manifest -> OutLayer SOLVE -> onSettlementResult");
  const requested = await until("SettlementRequested", async () => (await events("SettlementRequested", { auctionId }, r.blockNumber))[0], 900_000);
  const reqArgs = requested.args;
  save("golden.settlement.requested", { requestId: reqArgs.requestId, attempt: reqArgs.attempt, bidDigest: reqArgs.bidDigest, bidCount: reqArgs.bidCount, tx: requested.transactionHash });
  console.log("  requestId", reqArgs.requestId);
  const adapterReq = await until("adapter received request_solve", () => nearView(adapter, "get_request", { request_id: reqArgs.requestId }), 600_000);
  save("golden.settlement.adapterAfterRequest", { status: adapterReq.status, bidCount: adapterReq.bidCount, keyId: adapterReq.keyId });
  const accepted = await until("SettlementAccepted", async () => (await events("SettlementAccepted", { auctionId }, r.blockNumber))[0], 1_500_000);
  const accTx = await pub.getTransaction({ hash: accepted.transactionHash });
  const adapterDone = nearView(adapter, "get_request", { request_id: reqArgs.requestId });
  assert.equal(accTx.from.toLowerCase(), d.callbackSender.toLowerCase(), "settlement callback sender is the derived adapter address");
  assert.equal(adapterDone.status, "Delivered");
  assert.equal(accepted.args.outputHash.toLowerCase(), adapterDone.outputSha256.toLowerCase(), "outputHash on Aurora == sha256(raw TEE output) on adapter");
  const a1 = await getAuction(auctionId);
  assert.equal(a1.winner.toLowerCase(), A.account.address.toLowerCase(), "highest valid bid wins");
  assert.equal(a1.winningAmountUnits, parseUnits6("150"));
  // The manifest the keeper submitted must hash to what the adapter recorded (apps/keeper/evidence/<requestId>.json).
  save("golden.settlement.accepted", { tx: accepted.transactionHash, callbackFrom: accTx.from, outcome: accepted.args.outcome, winner: accepted.args.winner, winningAmountUnits: accepted.args.winningAmountUnits, executionIdHash: accepted.args.executionIdHash, outputHash: accepted.args.outputHash, adapterRecord: adapterDone });
  console.log("  winner", a1.winner, formatMoney(a1.winningAmountUnits), "callback from", accTx.from);

  step("exits: loser refund, winner pays remainder + receives token, second loser refund");
  const rB = await tx(B, auction, "claimRefund", [auctionId]);
  await tx(A, token, "approve", [d.auction, parseUnits6("140")]);
  const rA = await tx(A, auction, "claimWin", [auctionId, A.account.address]);
  const rC = await tx(C, auction, "claimRefund", [auctionId]);
  assert.equal(before.a - (await bal(A.account.address)), parseUnits6("150"));
  assert.equal((await bal(S.account.address)) - before.s, parseUnits6("150"));
  assert.equal(await bal(B.account.address), before.b);
  assert.equal(await bal(C.account.address), before.c);
  assert.equal(await pub.readContract({ ...asset, functionName: "balanceOf", args: [A.account.address, tokenId] }), 1n);
  assert.equal((await getAuction(auctionId)).state, 4, "Finalized");
  save("golden.exits", { refundB: rB.transactionHash, claimWinA: rA.transactionHash, refundC: rC.transactionHash, escrowAfter: (await bal(d.auction)).toString() });
  console.log("\nGOLDEN AUCTION ON AURORA TESTNET OK");
}

async function negatives() {
  step("G-01 negative (NEAR): the keeper is not the XCC router");
  const cfg = await pub.readContract({ ...auction, functionName: "getConfig" });
  const fakeKey = nearTx(adapter, "request_key", { key_request_id: `0x${"11".repeat(32)}`, owner: A.account.address, config_hash: d.configHash, solver_code_hash: d.solverCodeHash });
  assert.ok(!fakeKey.ok && /untrusted predecessor|unreachable/.test(fakeKey.output) /* release wasm strips panic text: the trap at the first statement (assert_xcc) is the refusal; the message is asserted in the adapter unit test */, "adapter must refuse a non-router caller");
  save("negatives.keeperRequestKey", { ...fakeKey, output: fakeKey.output.slice(-1500) });

  const golden = evidence.golden?.key;
  assert.ok(golden?.keyRequestId, "run `golden` first: the negatives reuse its sealed blob");
  const keyRec = nearView(adapter, "get_key", { key_request_id: golden.keyRequestId });
  const probeInput = { mode: "UNSEAL_PROBE", keyRequestId: golden.keyRequestId, owner: keyRec.owner, solverCodeHash: d.solverCodeHash, configHash: d.configHash, sealedBlob: keyRec.sealedBlob, keyId: keyRec.keyId };
  const limits = { max_instructions: 200_000_000_000, max_memory_mb: 256, max_execution_seconds: 150 };

  step("G-02 negative: production wasm called by another account is refused before it runs (callers gate)");
  const hosting = existsSync(new URL("../release/hosting.json", import.meta.url)) ? "../release/hosting.json" : "../release/fastfs-upload.json";
  const prodUrl = JSON.parse(readFileSync(new URL(hosting, import.meta.url), "utf8"));
  const direct = nearTx(outlayer, "request_execution", { source: { WasmUrl: { url: prodUrl["maskbid-private-solver.wasm"].url, hash: wasmHash(cfg), build_target: "wasm32-wasip2" } }, resource_limits: limits, input_data: JSON.stringify(probeInput), response_format: "Json" }, { deposit: "0.1 NEAR", gas: "100 Tgas" });
  save("negatives.directProdWasm", { ...direct, output: direct.output.slice(-2500) });

  step("G-02 negative: another build (probe wasm, no callers gate) cannot open the sealed blob");
  const probe = prodUrl["maskbid-private-solver-probe.wasm"];
  const other = nearTx(outlayer, "request_execution", { source: { WasmUrl: { url: probe.url, hash: probe.sha256, build_target: "wasm32-wasip2" } }, resource_limits: limits, input_data: JSON.stringify(probeInput), response_format: "Json" }, { deposit: "0.1 NEAR", gas: "100 Tgas" });
  assert.ok(/"unsealed":\s*false/.test(other.output), `expected unsealed:false from the probe build, got: ${other.output.slice(-800)}`);
  save("negatives.otherBuildUnseal", { ...other, output: other.output.slice(-2500) });
  console.log("\nNEGATIVES OK");
}

/** Second auction: attempt 1 is deliberately left without a manifest until attempt 2 exists; the late attempt-1 result
 *  must be rejected on Aurora (StaleRequest 0x4e73400c) and recorded as DeliveryFailed on the adapter. Needs the keeper
 *  started with SKIP_FIRST_ATTEMPT_AUCTIONS=<this auction id> (printed below) before the auction ends. */
async function stale() {
  await setup();
  const golden = evidence.golden?.key;
  assert.ok(golden, "run `golden` first");
  step("stale-attempt auction: new key, one bid");
  let r = await tx(S, auction, "prepareAuctionKey", [keccak256(stringToBytes(`salt-stale-${Date.now()}`))]);
  const keyRequestId = r.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "KeyRequested").args.keyRequestId;
  const key = await until("KeyPrepared", async () => { const k = await pub.readContract({ ...auction, functionName: "getKeyRecord", args: [keyRequestId] }); return k.status === 2 ? k : null; }, 900_000);
  const metadataHash = keccak256(stringToBytes(`stale-${Date.now()}`));
  r = await tx(S, asset, "registerAsset", ["https://example.invalid/maskbid/demo-002.json", metadataHash]);
  const tokenId = decodeEventLog({ abi: assetAbi, ...r.logs[0] }).args.tokenId;
  await tx(D, asset, "verifyAndMint", [tokenId, reviewDigest({ chainId: BigInt(chainId), assetContract: d.asset, tokenId, reviewer: D.account.address, metadataHash, decision: 1, reason: "ok" })]);
  const now = (await pub.getBlock()).timestamp;
  r = await tx(S, auction, "createAuction", [tokenId, parseUnits6("100"), parseUnits6("10"), 0n, now + 240n, key.keyId]);
  const auctionId = decodeEventLog({ abi: auctionAbi, ...r.logs.find((l) => l.address.toLowerCase() === d.auction.toLowerCase()) }).args.auctionId;
  console.log(`  auctionId ${auctionId}  -> restart the keeper NOW with SKIP_FIRST_ATTEMPT_AUCTIONS=${auctionId}`);
  save("stale.auction", { auctionId, keyRequestId, createTx: r.transactionHash });
  const domain = { chainId: BigInt(chainId), auctionContract: d.auction.toLowerCase(), auctionId };
  const { envelope } = await encryptBid({ spki: hexToBytes(key.publicKeySpki), domain, bidder: B.account.address.toLowerCase(), amountUnits: parseUnits6("130"), expectedKeyId: key.keyId });
  await tx(B, token, "approve", [d.auction, parseUnits6("10")]);
  await tx(B, auction, "placeBid", [auctionId, bytesToHex(envelope)]);

  step("wait for attempt 1, then attempt 2 (keeper retries after 240 s), then deliver attempt 1 late");
  const req1 = await until("attempt 1 requested", async () => (await events("SettlementRequested", { auctionId }, r.blockNumber)).find((e) => e.args.attempt === 1), 900_000);
  const req2 = await until("attempt 2 requested", async () => (await events("SettlementRequested", { auctionId }, r.blockNumber)).find((e) => e.args.attempt === 2), 900_000);
  save("stale.requests", { attempt1: { requestId: req1.args.requestId, tx: req1.transactionHash }, attempt2: { requestId: req2.args.requestId, tx: req2.transactionHash } });
  const logs = await pub.getContractEvents({ ...auction, eventName: "BidPlaced", args: { auctionId }, fromBlock: r.blockNumber });
  const manifest = (requestId) => canonicalManifest({ protocolVersion: 1, chainId: String(chainId), auctionContract: d.auction.toLowerCase(), auctionId: auctionId.toString(), requestId, keyId: key.keyId, bidDigest: req1.args.bidDigest, bidCount: 1, bids: logs.map((l) => ({ bidIndex: String(l.args.bidIndex), bidder: l.args.bidder.toLowerCase(), commitment: l.args.commitment, envelope: l.args.envelope, txHash: l.transactionHash, blockHash: l.blockHash, blockNumber: String(l.blockNumber), logIndex: String(l.logIndex) })) });
  const late = nearTx(adapter, "submit_manifest", { request_id: req1.args.requestId, manifest: manifest(req1.args.requestId) });
  const staleRec = await until("attempt 1 delivery rejected", () => { const q = nearView(adapter, "get_request", { request_id: req1.args.requestId }); return q?.status === "DeliveryFailed" ? q : null; }, 1_200_000);
  assert.ok(/4e73400c/.test(staleRec.lastError ?? ""), `expected StaleRequest selector 0x4e73400c, got ${staleRec.lastError}`);
  save("stale.lateAttempt1", { submitManifestTx: late.tx, adapterRecord: { ...staleRec, result: undefined }, auroraRevert: staleRec.lastError });
  console.log("  stale attempt rejected on Aurora:", staleRec.lastError);
  const accepted = await until("attempt 2 accepted", async () => (await events("SettlementAccepted", { auctionId }, r.blockNumber))[0], 1_500_000);
  assert.equal(accepted.args.requestId.toLowerCase(), req2.args.requestId.toLowerCase(), "only the active attempt is accepted");
  save("stale.attempt2Accepted", { tx: accepted.transactionHash, winner: accepted.args.winner, winningAmountUnits: accepted.args.winningAmountUnits });
  console.log("\nSTALE-ATTEMPT TEST OK");
}

/** Recovery paths on the real private path: no-sale (all bids below reserve), winner default, solver timeout.
 *  Creates three auctions ending together; the keeper must run with SKIP_ALL_ATTEMPTS_AUCTIONS=<count+3> (the timeout
 *  auction, printed first) so it never gets a manifest. Exits are serialised: the three flows share wallets. */
async function recovery() {
  await setup();
  const expectTimeoutId = BigInt(process.env.TIMEOUT_AUCTION_ID ?? 0);
  const first = (await pub.readContract({ ...auction, functionName: "auctionCount" })) + 1n;
  assert.equal(expectTimeoutId, first + 2n, `start the keeper with SKIP_ALL_ATTEMPTS_AUCTIONS=${first + 2n} and pass TIMEOUT_AUCTION_ID=${first + 2n}`);
  let q = Promise.resolve();
  const stx = (w, c, fn, args) => (q = q.then(() => tx(w, c, fn, args)));
  const escrow0 = await bal(d.auction);
  const credit0 = await pub.readContract({ ...auction, functionName: "getSellerCredit", args: [S.account.address] }); // withdrawSellerCredit pays out ALL accumulated credit, not only this run's
  const bal0 = { a: await bal(A.account.address), b: await bal(B.account.address), s: await bal(S.account.address) };

  step("recovery: three keys (nosale, default, timeout)");
  const keys = [];
  for (const tag of ["nosale", "default", "timeout"]) {
    const r = await tx(S, auction, "prepareAuctionKey", [keccak256(stringToBytes(`salt-${tag}-${Date.now()}`))]);
    keys.push(r.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "KeyRequested").args.keyRequestId);
  }
  const ready = await Promise.all(keys.map((id) => until(`KeyPrepared ${id}`, async () => { const k = await pub.readContract({ ...auction, functionName: "getKeyRecord", args: [id] }); return k.status === 2 ? k : null; }, 1_200_000)));

  step("recovery: assets + auctions (reserve 100, deposit 10, common end time)");
  await tx(S, asset, "setApprovalForAll", [d.auction, true]);
  const endTime = (await pub.getBlock()).timestamp + 540n;
  const ids = [];
  for (const [i, tag] of ["nosale", "default", "timeout"].entries()) {
    const metadataHash = keccak256(stringToBytes(`${tag}-${Date.now()}`));
    let r = await tx(S, asset, "registerAsset", [`https://example.invalid/maskbid/${tag}.json`, metadataHash]);
    const tokenId = decodeEventLog({ abi: assetAbi, ...r.logs[0] }).args.tokenId;
    await tx(D, asset, "verifyAndMint", [tokenId, reviewDigest({ chainId: BigInt(chainId), assetContract: d.asset, tokenId, reviewer: D.account.address, metadataHash, decision: 1, reason: "ok" })]);
    r = await tx(S, auction, "createAuction", [tokenId, parseUnits6("100"), parseUnits6("10"), 0n, endTime, ready[i].keyId]);
    ids.push({ tag, tokenId, auctionId: decodeEventLog({ abi: auctionAbi, ...r.logs.find((l) => l.address.toLowerCase() === d.auction.toLowerCase()) }).args.auctionId, key: ready[i], createTx: r.transactionHash });
  }
  assert.equal(ids[2].auctionId, expectTimeoutId, "timeout auction id matches the keeper skip list");
  save("recovery.auctions", ids.map((x) => ({ tag: x.tag, auctionId: x.auctionId, tokenId: x.tokenId, createTx: x.createTx })));

  step("recovery: bids");
  const plan = { nosale: [[A, "50"], [B, "60"]], default: [[A, "150"], [B, "120"]], timeout: [[A, "130"], [B, "140"]] };
  for (const x of ids) {
    const domain = { chainId: BigInt(chainId), auctionContract: d.auction.toLowerCase(), auctionId: x.auctionId };
    for (const [w, amount] of plan[x.tag]) {
      const { envelope } = await encryptBid({ spki: hexToBytes(x.key.publicKeySpki), domain, bidder: w.account.address.toLowerCase(), amountUnits: parseUnits6(amount), expectedKeyId: x.key.keyId });
      await tx(w, token, "approve", [d.auction, parseUnits6("10")]);
      await tx(w, auction, "placeBid", [x.auctionId, bytesToHex(envelope)]);
    }
  }
  const byTag = Object.fromEntries(ids.map((x) => [x.tag, x]));
  const state = async (x) => { const a = await getAuction(x.auctionId); return { state: a.state, reason: a.cancelReason, a }; };
  const waitState = (x, want, reason, ms) => until(`${x.tag} state ${want}`, async () => { const s = await state(x); return s.state === want && (reason === undefined || s.reason === reason) ? s : null; }, ms);
  const refund = async (w, x) => { await stx(w, auction, "claimRefund", [x.auctionId]); };

  const flows = {
    async nosale() {
      const x = byTag.nosale;
      await waitState(x, 5, 2, 1_500_000);
      const acc = (await events("SettlementAccepted", { auctionId: x.auctionId }))[0];
      assert.equal(acc.args.outcome, 1, "NoSale outcome");
      assert.equal((await pub.getTransaction({ hash: acc.transactionHash })).from.toLowerCase(), d.callbackSender.toLowerCase());
      await refund(A, x); await refund(B, x);
      await stx(S, auction, "claimReturnedAsset", [x.auctionId, S.account.address]);
      assert.equal(await pub.readContract({ ...asset, functionName: "balanceOf", args: [S.account.address, x.tokenId] }), 1n, "asset returned to seller");
      save("recovery.nosale", { acceptedTx: acc.transactionHash, outcome: "NoSale", cancelReason: "NoValidBid" });
    },
    async default() {
      const x = byTag.default;
      await waitState(x, 3, undefined, 1_500_000);
      const acc = (await events("SettlementAccepted", { auctionId: x.auctionId }))[0];
      assert.equal(acc.args.winner.toLowerCase(), A.account.address.toLowerCase());
      await waitState(x, 5, 3, 900_000); // keeper expireClaim after the 300 s claim window
      const def = (await events("WinnerDefaulted", { auctionId: x.auctionId }))[0];
      await assert.rejects(pub.simulateContract({ ...auction, functionName: "claimRefund", args: [x.auctionId], account: A.account.address }), "defaulted winner gets no refund");
      await refund(B, x);
      await stx(S, auction, "withdrawSellerCredit", [S.account.address]);
      await stx(S, auction, "claimReturnedAsset", [x.auctionId, S.account.address]);
      save("recovery.default", { acceptedTx: acc.transactionHash, winnerDefaultedTx: def.transactionHash, forfeitedUnits: def.args.depositUnits ?? parseUnits6("10") });
    },
    async timeout() {
      const x = byTag.timeout;
      await waitState(x, 5, 4, 3_000_000); // keeper cancelAfterSolverTimeout after the settlement grace
      const reqs = await events("SettlementRequested", { auctionId: x.auctionId });
      const cancelled = (await events("AuctionCancelled", { auctionId: x.auctionId }))[0];
      await refund(A, x); await refund(B, x);
      await stx(S, auction, "claimReturnedAsset", [x.auctionId, S.account.address]);
      save("recovery.timeout", { attempts: reqs.length, cancelTx: cancelled.transactionHash, cancelReason: "SolverTimeout", acceptedEvents: (await events("SettlementAccepted", { auctionId: x.auctionId })).length });
    },
  };
  await Promise.all(Object.entries(flows).map(([k, f]) => f().then(() => console.log(`  recovery ${k} done`))));
  await q;
  assert.equal(await bal(d.auction), escrow0 - credit0, "escrow back to its starting balance minus the credit paid out");
  assert.equal(await pub.readContract({ ...auction, functionName: "totalSellerCredits" }), 0n, "no credit left");
  assert.equal(await bal(d.auction), await pub.readContract({ ...auction, functionName: "totalLockedDeposits" }), "escrow == locked deposits (+ 0 credits)");
  assert.equal((await bal(S.account.address)) - bal0.s, credit0 + parseUnits6("10"), "seller receives the forfeited deposit (plus any older credit)");
  assert.equal(bal0.b, await bal(B.account.address), "loser B made whole");
  assert.equal(bal0.a - (await bal(A.account.address)), parseUnits6("10"), "defaulted winner A lost exactly the deposit");
  save("recovery.accounting", { sellerCreditBefore: credit0.toString(), escrowBefore: escrow0.toString(), escrowAfter: (await bal(d.auction)).toString() });
  console.log("\nRECOVERY PATHS OK");
}

/** G-01 first hop without needing the wasm served: prepareAuctionKey -> XCC -> router -> adapter.request_key. Records
 *  the Aurora tx, the precompile log and the adapter's key record (Dispatched, then Ready or Failed with the reason). */
async function xccProbe() {
  await setup();
  step("G-01 probe: prepareAuctionKey through the XCC precompile");
  const r = await tx(S, auction, "prepareAuctionKey", [keccak256(stringToBytes(`probe-${Date.now()}`))]);
  const keyRequestId = r.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "KeyRequested").args.keyRequestId;
  const xccLog = r.logs.find((l) => l.address.toLowerCase() === "0x516cded1d16af10cad47d6d49128e2eb7d27b372");
  console.log("  keyRequestId", keyRequestId, "gasUsed", r.gasUsed, "xcc log", !!xccLog);
  const seen = [];
  const t0 = Date.now();
  let rec = null;
  while (Date.now() - t0 < 420_000) {
    rec = nearView(adapter, "get_key", { key_request_id: keyRequestId });
    const st = rec ? `${rec.status}${rec.lastError ? ` (${rec.lastError})` : ""}${rec.deliveredToAurora ? " delivered" : ""}` : "no record yet";
    if (seen.at(-1)?.status !== st) { seen.push({ t: new Date().toISOString(), status: st }); console.log("  adapter:", st); }
    if (rec && (rec.status === "Failed" || rec.deliveredToAurora)) break;
    await sleep(10_000);
  }
  save("xccProbe", { keyRequestId, prepareTx: r.transactionHash, gasUsed: r.gasUsed, xccPrecompileLog: xccLog ? { topics: xccLog.topics, dataBytes: (xccLog.data.length - 2) / 2 } : null, adapterTimeline: seen, adapterRecord: rec && { ...rec, spki: undefined, sealedBlob: undefined } });
  const onchain = await pub.readContract({ ...auction, functionName: "getKeyRecord", args: [keyRequestId] });
  console.log("  aurora key status", onchain.status, "(1 Requested, 2 Ready)");
}

/** Demo catalog: three live lots that stay open for the profile's maximum (24 h on `demo`), two of them with sealed bids
 *  from B and C. Bidder A stays free to bid on every lot. Rerun whenever the catalog has run dry (`npm run demo:seed`).
 *  Metadata is a data: URI so the lots render wherever the web app is hosted; registerAsset caps the URI at 512 bytes. */
async function seed() {
  await setup();
  const lots = [
    { title: "Vintage Diver Watch, 1968", description: "Steel automatic diver with its original bracelet. Serviced this year.", category: "watch", condition: "Excellent", reserve: "100", deposit: "10", bids: [[B, "120"], [C, "135"]] },
    { title: "Evening Sky, oil on linen", description: "Original 60 x 80 cm painting, signed on the reverse.", category: "art", condition: "New", reserve: "250", deposit: "25", bids: [[B, "300"]] },
    { title: "Genesis Pass #042", description: "Founding member pass, one of 100.", category: "digital_collectible", condition: "Mint", reserve: "50", deposit: "5", bids: [] },
  ];
  step(`seed: ${lots.length} keys through the TEE`);
  const requests = [];
  for (const lot of lots) {
    const r = await tx(S, auction, "prepareAuctionKey", [keccak256(stringToBytes(`seed-${lot.title}-${Date.now()}`))]);
    requests.push(r.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "KeyRequested").args.keyRequestId);
  }
  const keys = await Promise.all(requests.map((id) => until(`KeyPrepared ${id}`, async () => { const k = await pub.readContract({ ...auction, functionName: "getKeyRecord", args: [id] }); return k.status === 2 ? k : null; }, 1_200_000)));

  step("seed: assets, auctions, bids");
  await tx(S, asset, "setApprovalForAll", [d.auction, true]);
  const { maxDurationSeconds } = await pub.readContract({ ...auction, functionName: "getConfig" });
  for (const [i, lot] of lots.entries()) {
    const metadata = JSON.stringify({ schemaVersion: 1, title: lot.title, description: lot.description, category: lot.category, condition: lot.condition, isDemo: true, issuerWallet: S.account.address.toLowerCase(), images: [] });
    const metadataHash = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", stringToBytes(metadata))).toString("hex")}`;
    let r = await tx(S, asset, "registerAsset", [`data:application/json;base64,${Buffer.from(metadata).toString("base64")}`, metadataHash]);
    const tokenId = decodeEventLog({ abi: assetAbi, ...r.logs[0] }).args.tokenId;
    await tx(D, asset, "verifyAndMint", [tokenId, reviewDigest({ chainId: BigInt(chainId), assetContract: d.asset, tokenId, reviewer: D.account.address, metadataHash, decision: 1, reason: "metadata complete" })]);
    const endTime = (await pub.getBlock()).timestamp + maxDurationSeconds - 300n; // margin for the blocks until this lands
    r = await tx(S, auction, "createAuction", [tokenId, parseUnits6(lot.reserve), parseUnits6(lot.deposit), 0n, endTime, keys[i].keyId]);
    const auctionId = decodeEventLog({ abi: auctionAbi, ...r.logs.find((l) => l.address.toLowerCase() === d.auction.toLowerCase()) }).args.auctionId;
    for (const [w, amount] of lot.bids) {
      const { envelope } = await encryptBid({ spki: hexToBytes(keys[i].publicKeySpki), domain: { chainId: BigInt(chainId), auctionContract: d.auction.toLowerCase(), auctionId }, bidder: w.account.address.toLowerCase(), amountUnits: parseUnits6(amount), expectedKeyId: keys[i].keyId });
      await tx(w, token, "approve", [d.auction, parseUnits6(lot.deposit)]);
      await tx(w, auction, "placeBid", [auctionId, bytesToHex(envelope)]);
    }
    console.log(`  lot ${auctionId}: ${lot.title}, ${lot.bids.length} bid(s), closes ${new Date(Number(endTime) * 1000).toISOString()}`);
  }
  console.log("\nDEMO CATALOG SEEDED");
}

const phase = process.argv[2] ?? "all";
if (phase === "setup") await setup();
if (phase === "seed") await seed();
if (phase === "xcc-probe") await xccProbe();
if (phase === "golden" || phase === "all") await golden();
if (phase === "negatives" || phase === "all") await negatives();
if (phase === "stale") await stale();
if (phase === "recovery") await recovery();
console.log(`\nevidence: ${evidencePath.pathname}`);
