// Golden auction end to end against a running Anvil + local adapter (T-DEMO-01).
// Seller #0 registers an asset, verifier #7 mints it, seller prepares a key and lists it (reserve 100, deposit 10),
// bidders #1/#2/#3 encrypt 150/120/135 in the browser codec, the auction closes, the adapter settles,
// the winner pays 140 and receives the token, the two losers refund 10 each. Balances are asserted from receipts.
import assert from "node:assert/strict";
import { createPublicClient, createWalletClient, http, keccak256, stringToBytes, bytesToHex, hexToBytes, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { auctionAbi, assetAbi, tokenAbi, chainFor, deployments } from "../packages/contracts/src/index.ts";
import { encryptBid, parseUnits6, reviewDigest, formatMoney } from "../packages/protocol/src/index.ts";

const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const chainId = Number(process.env.CHAIN_ID ?? 31337);
const d = deployments[String(chainId)];
const chain = chainFor(chainId, rpc);
const pub = createPublicClient({ chain, transport: http(rpc) });
const KEYS = {
  seller: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  a: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  b: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  c: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  verifier: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
};
const wallet = (k) => createWalletClient({ chain, transport: http(rpc), account: privateKeyToAccount(k) });
const S = wallet(KEYS.seller), A = wallet(KEYS.a), B = wallet(KEYS.b), C = wallet(KEYS.c), V = wallet(KEYS.verifier);
const auction = { address: d.auction, abi: auctionAbi }, asset = { address: d.asset, abi: assetAbi }, token = { address: d.token, abi: tokenAbi };
const tx = async (w, c, functionName, args) => {
  const hash = await w.writeContract({ ...c, functionName, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", `${functionName} reverted`);
  return r;
};
const bal = (who) => pub.readContract({ ...token, functionName: "balanceOf", args: [who] });
const getAuction = (id) => pub.readContract({ ...auction, functionName: "getAuction", args: [id] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (label, fn, timeoutMs = 120_000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    assert.ok(Date.now() - t0 < timeoutMs, `timeout waiting: ${label}`);
    await sleep(1500);
  }
};
const step = (s) => console.log(`\n== ${s}`);

step("register + verify + mint asset");
const metadata = JSON.stringify({ schemaVersion: 1, title: "Demo Collector Watch #001", description: "Synthetic demo asset", category: "watch", condition: "excellent", isDemo: true, issuerWallet: S.account.address.toLowerCase(), images: [] });
const metadataHash = `0x${Buffer.from(await crypto.subtle.digest("SHA-256", stringToBytes(metadata))).toString("hex")}`;
let r = await tx(S, asset, "registerAsset", ["http://localhost:3000/api/metadata/demo", metadataHash]);
const tokenId = decodeEventLog({ abi: assetAbi, ...r.logs[0] }).args.tokenId;
const digest = reviewDigest({ chainId: BigInt(chainId), assetContract: d.asset, tokenId, reviewer: V.account.address, metadataHash, decision: 1, reason: "metadata complete" });
await tx(V, asset, "verifyAndMint", [tokenId, digest]);
assert.equal(await pub.readContract({ ...asset, functionName: "balanceOf", args: [S.account.address, tokenId] }), 1n);
console.log("tokenId", tokenId);

step("prepare auction key via local adapter");
r = await tx(S, auction, "prepareAuctionKey", [keccak256(stringToBytes(`salt-${Date.now()}`))]);
const keyRequestId = decodeEventLog({ abi: auctionAbi, ...r.logs[0] }).args.keyRequestId;
let key;
await until("key READY", async () => { key = await pub.readContract({ ...auction, functionName: "getKeyRecord", args: [keyRequestId] }); return key.status === 2; });
console.log("keyId", key.keyId);

step("create auction: reserve 100, deposit 10, 3-minute demo duration");
const now = (await pub.getBlock()).timestamp;
await tx(S, asset, "setApprovalForAll", [d.auction, true]);
r = await tx(S, auction, "createAuction", [tokenId, parseUnits6("100"), parseUnits6("10"), 0n, now + 240n, key.keyId]);
const auctionId = decodeEventLog({ abi: auctionAbi, ...r.logs.find((l) => l.address.toLowerCase() === d.auction.toLowerCase()) }).args.auctionId;
const a0 = await getAuction(auctionId);
console.log("auctionId", auctionId, "ends", new Date(Number(a0.endTime) * 1000).toISOString());

step("three sealed bids: 150 / 120 / 135");
const domain = { chainId: BigInt(chainId), auctionContract: d.auction.toLowerCase(), auctionId };
const spki = hexToBytes(key.publicKeySpki);
const before = { a: await bal(A.account.address), b: await bal(B.account.address), c: await bal(C.account.address), s: await bal(S.account.address) };
for (const [w, amount] of [[A, "150"], [B, "120"], [C, "135"]]) {
  const { envelope, commitment } = await encryptBid({ spki, domain, bidder: w.account.address.toLowerCase(), amountUnits: parseUnits6(amount), expectedKeyId: key.keyId });
  await tx(w, token, "approve", [d.auction, parseUnits6("10")]);
  const rc = await tx(w, auction, "placeBid", [auctionId, bytesToHex(envelope)]);
  const ev = rc.logs.map((l) => { try { return decodeEventLog({ abi: auctionAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "BidPlaced");
  assert.equal(ev.args.commitment, commitment, "browser commitment equals on-chain commitment");
  console.log(`bid #${ev.args.bidIndex} by ${w.account.address.slice(0, 8)} recorded; digest ${ev.args.newDigest.slice(0, 18)}…`);
}
assert.equal((await getAuction(auctionId)).bidCount, 3);
assert.equal(await bal(d.auction), parseUnits6("30"));

step("wait for close + private settlement (local adapter)");
await until("PendingClaim", async () => (await getAuction(auctionId)).state === 3, 300_000);
const a1 = await getAuction(auctionId);
assert.equal(a1.winner.toLowerCase(), A.account.address.toLowerCase(), "highest valid bid wins");
assert.equal(a1.winningAmountUnits, parseUnits6("150"));
console.log("winner", a1.winner, "at", formatMoney(a1.winningAmountUnits));
assert.equal(await bal(d.auction), parseUnits6("30"), "callback moved no money");

step("loser refund before winner pays, winner claims, second loser refunds");
await tx(B, auction, "claimRefund", [auctionId]);
assert.equal(await bal(B.account.address), before.b);
await tx(A, token, "approve", [d.auction, parseUnits6("140")]);
await tx(A, auction, "claimWin", [auctionId, A.account.address]);
assert.equal(before.a - (await bal(A.account.address)), parseUnits6("150"), "winner paid 150 total");
assert.equal((await bal(S.account.address)) - before.s, parseUnits6("150"), "seller received exactly 150");
assert.equal(await pub.readContract({ ...asset, functionName: "balanceOf", args: [A.account.address, tokenId] }), 1n, "winner holds the token");
await tx(C, auction, "claimRefund", [auctionId]);
assert.equal(await bal(C.account.address), before.c);
assert.equal(await bal(d.auction), 0n, "escrow empty");
assert.equal((await getAuction(auctionId)).state, 4, "Finalized");
console.log("\nGOLDEN AUCTION OK: seller +150, winner -150 (+token), losers refunded, escrow 0.");
