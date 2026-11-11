import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import {
  aadHash, bidCommitment, canonicalManifest, decryptBid, displayPhase, domainOf, encryptBid, formatUnits6, initialDigest,
  nextDigest, parseUnits6, requestIdHash, sha256Utf8, solve, SolverFatal, validateManifest, type Manifest,
} from "../src/index.ts";

const v = JSON.parse(readFileSync(new URL("../vectors/protocol-vectors.json", import.meta.url), "utf8"));
const pem = (v.testPrivateKeyPkcs8Pem as string).replace(/-----[A-Z ]+-----|\s/g, "");
const pkcs8 = Uint8Array.from(Buffer.from(pem, "base64"));
const spki = Uint8Array.from(Buffer.from(v.publicKeySpkiBase64, "base64"));
const domain = domainOf(v.request);
const keyId = v.request.keyId as Hex;

test("hashes recompute from fixtures", async () => {
  let digest = initialDigest(domain, keyId);
  assert.equal(digest, v.initialDigest);
  for (const [i, b] of v.bids.entries()) {
    const envelope = hexToBytes(b.envelope);
    assert.equal(envelope.length, 490);
    assert.equal(aadHash(domain, b.bidder, keyId), b.aad);
    assert.equal(bidCommitment(domain, b.bidder, keyId, envelope), b.commitment);
    digest = nextDigest(digest, BigInt(i), b.bidder, b.commitment);
    assert.equal(digest, b.digestAfter);
    const p = await decryptBid({ pkcs8, envelope, domain, bidder: b.bidder, keyId });
    assert.equal(p.amountUnits.toString(), b.amountUnits);
    assert.equal(bytesToHex(p.nonce), b.nonce);
  }
  assert.equal(requestIdHash(domain, digest, 3n, 1, v.request.configHash), v.request.requestId);
});

test("solver reproduces the fixture result (tie resolves to earliest index)", async () => {
  const result = await solve(v.request, v.manifest, pkcs8);
  assert.deepEqual(result, v.result);
  const canonical = canonicalManifest(v.manifest);
  assert.equal(canonical, v.manifestCanonicalUtf8);
  assert.equal(sha256Utf8(canonical), v.request.manifestSha256);
});

test("missing, reordered, tampered or duplicated bids are fatal, never a partial result", async () => {
  const m = v.manifest as Manifest;
  const expectFatal = async (mutate: (m: Manifest) => void, code: string) => {
    const copy: Manifest = JSON.parse(JSON.stringify(m));
    mutate(copy);
    await assert.rejects(solve(v.request, copy, pkcs8), (e: unknown) => e instanceof SolverFatal && e.code === code);
  };
  await expectFatal((c) => c.bids.splice(1, 1), "MANIFEST_INCOMPLETE");
  await expectFatal((c) => { c.bids.pop(); c.bidCount = 2; }, "MANIFEST_INCOMPLETE");
  await expectFatal((c) => { [c.bids[0], c.bids[1]] = [c.bids[1], c.bids[0]]; }, "MANIFEST_INCOMPLETE");
  await expectFatal((c) => { c.bids[2].envelope = (c.bids[2].envelope.slice(0, -2) + "00") as Hex; }, "COMMITMENT_MISMATCH");
  await expectFatal((c) => { c.bids[1].bidder = c.bids[0].bidder; }, "MANIFEST_INCOMPLETE");
  await expectFatal((c) => { c.bids[1].bidder = "0x9999999999999999999999999999999999999999"; }, "COMMITMENT_MISMATCH");
  await expectFatal((c) => { c.keyId = "0x" + "11".repeat(32) as Hex; }, "DOMAIN_MISMATCH");
  await assert.rejects(
    solve({ ...v.request, bidDigest: "0x" + "22".repeat(32) }, m, pkcs8),
    (e: unknown) => e instanceof SolverFatal && e.code === "DOMAIN_MISMATCH",
  );
  validateManifest(v.request, m); // the untouched manifest still validates
});

async function syntheticManifest(entries: { bidder: Address; amount: bigint; wrongBidderInPlaintext?: boolean }[], attempt = 1) {
  const bids = [];
  let digest = initialDigest(domain, keyId);
  for (const [i, e] of entries.entries()) {
    const plaintextBidder = e.wrongBidderInPlaintext ? ("0x" + "77".repeat(20) as Address) : e.bidder;
    const { envelope } = await encryptBid({ spki, domain, bidder: plaintextBidder, amountUnits: e.amount, expectedKeyId: keyId });
    // AAD binds the manifest bidder; a plaintext encrypted for another bidder fails authentication -> invalid bid.
    const commitment = bidCommitment(domain, e.bidder, keyId, envelope);
    digest = nextDigest(digest, BigInt(i), e.bidder, commitment);
    bids.push({ bidIndex: String(i), bidder: e.bidder, commitment, envelope: bytesToHex(envelope), txHash: "0x" + "00".repeat(32), blockHash: "0x" + "00".repeat(32), blockNumber: "1", logIndex: "0" });
  }
  const requestId = requestIdHash(domain, digest, BigInt(entries.length), attempt, v.request.configHash);
  const request = { ...v.request, requestId, bidDigest: digest, bidCount: entries.length, attempt };
  const manifest: Manifest = { ...v.manifest, requestId, bidDigest: digest, bidCount: entries.length, bids };
  return { request, manifest };
}

test("fresh encryption roundtrips, randomizes and ranks with reserve, ties, invalid and no-sale", async () => {
  const a = "0x2222222222222222222222222222222222222222" as Address;
  const b = "0x3333333333333333333333333333333333333333" as Address;
  const c = "0x4444444444444444444444444444444444444444" as Address;

  const one = await encryptBid({ spki, domain, bidder: a, amountUnits: 150_000_000n, expectedKeyId: keyId });
  const two = await encryptBid({ spki, domain, bidder: a, amountUnits: 150_000_000n, expectedKeyId: keyId });
  assert.equal(one.envelope.length, 490);
  assert.notEqual(bytesToHex(one.envelope), bytesToHex(two.envelope), "no deterministic encryption");
  assert.equal((await decryptBid({ pkcs8, envelope: one.envelope, domain, bidder: a, keyId })).amountUnits, 150_000_000n);
  await assert.rejects(decryptBid({ pkcs8, envelope: one.envelope, domain, bidder: b, keyId }), /authentication/);
  await assert.rejects(encryptBid({ spki, domain, bidder: a, amountUnits: 1n, expectedKeyId: "0x" + "00".repeat(32) as Hex }), /could not be verified/);

  // golden: 150 / 120 / 135 -> a wins at 150
  let s = await syntheticManifest([{ bidder: a, amount: 150_000_000n }, { bidder: b, amount: 120_000_000n }, { bidder: c, amount: 135_000_000n }]);
  let r = await solve(s.request, s.manifest, pkcs8);
  assert.equal(r.outcome, "WINNER"); assert.equal(r.winner, a); assert.equal(r.winningAmountUnits, "150000000"); assert.equal(r.validBidCount, 3);

  // tie: 150 / 120 / 150 -> earliest index wins
  s = await syntheticManifest([{ bidder: a, amount: 150_000_000n }, { bidder: b, amount: 120_000_000n }, { bidder: c, amount: 150_000_000n }]);
  r = await solve(s.request, s.manifest, pkcs8);
  assert.equal(r.winner, a);

  // below reserve and wrong-domain plaintext are invalid but counted; the valid one wins
  s = await syntheticManifest([{ bidder: a, amount: 50_000_000n }, { bidder: b, amount: 120_000_000n }, { bidder: c, amount: 999_000_000n, wrongBidderInPlaintext: true }]);
  r = await solve(s.request, s.manifest, pkcs8);
  assert.equal(r.winner, b); assert.equal(r.validBidCount, 1); assert.equal(r.invalidBidCount, 2);

  // nothing qualifies -> NO_SALE with zero winner
  s = await syntheticManifest([{ bidder: a, amount: 1_000_000n }]);
  r = await solve(s.request, s.manifest, pkcs8);
  assert.equal(r.outcome, "NO_SALE"); assert.equal(r.winner, "0x0000000000000000000000000000000000000000"); assert.equal(r.winningAmountUnits, "0");

  // zero bids is a legitimate NO_SALE, not an error
  s = await syntheticManifest([]);
  r = await solve(s.request, s.manifest, pkcs8);
  assert.equal(r.outcome, "NO_SALE"); assert.equal(r.bidCount, 0);
});

test("amount grammar is exact and never floating point", () => {
  assert.equal(parseUnits6("125"), 125_000_000n);
  assert.equal(parseUnits6("125.5"), 125_500_000n);
  assert.equal(parseUnits6("0.000001"), 1n);
  assert.equal(parseUnits6("0"), 0n);
  assert.equal(parseUnits6("115792089237316195423570985008687907853269984665640564039457584007913129.639935"), (1n << 256n) - 1n);
  for (const bad of ["1e6", "-1", "1.1234567", "00", "1,000", "", " ", "1.", ".5", "NaN", "Infinity", "115792089237316195423570985008687907853269984665640564039457584007913129.639936"]) {
    assert.throws(() => parseUnits6(bad), undefined, bad);
  }
  assert.equal(formatUnits6(150_250_000n), "150.25");
  assert.equal(formatUnits6(100_000_000n), "100");
  assert.equal(formatUnits6(1n), "0.000001");
  assert.equal(formatUnits6(0n), "0");
});

test("display phase derives from state and chain time", () => {
  const base = { startTime: 100n, endTime: 200n, activeAttempt: 0 };
  assert.equal(displayPhase({ ...base, state: "Created", now: 50n }), "Scheduled");
  assert.equal(displayPhase({ ...base, state: "Created", now: 150n }), "Live");
  assert.equal(displayPhase({ ...base, state: "Active", now: 250n }), "Closed");
  assert.equal(displayPhase({ ...base, state: "Ended", now: 250n, activeAttempt: 1 }), "Resolving");
  assert.equal(displayPhase({ ...base, state: "PendingClaim", now: 250n }), "Claim");
});
