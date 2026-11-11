// LOCAL-ONLY FALLBACK ADAPTER + KEEPER + SOLVER (Anvil).
// This process stands in for the NEAR adapter (apps/near-adapter) and the OutLayer TEE solver (apps/private-solver)
// during local development. It is NOT a TEE: private keys live unsealed in KEYSTORE_DIR, evidence it writes is
// "available_unchecked", and it only runs where the auction was deployed with xccPrecompile = 0 and
// nearAdapterAccount = local-mock-adapter. Never point it at a public chain; the private path is apps/keeper.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { bytesToHex, createPublicClient, createWalletClient, hexToBytes, http, keccak256, stringToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { auctionAbi, chainFor, deployments } from "@maskbid/contracts";
import {
  AUCTION_STATES, canonicalManifest, canonicalResult, keyIdFromSpki, sha256Utf8, solve, SolverFatal,
  type Manifest, type SettlementRequest,
} from "@maskbid/protocol";

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`missing env ${k}`); })();
const chainId = Number(env("CHAIN_ID", "31337"));
const rpcUrl = env("RPC_URL", "http://127.0.0.1:8545");
const deployment = deployments[String(chainId)];
if (!deployment) throw new Error(`no deployment for chain ${chainId}; run npm run deploy:local`);
const account = privateKeyToAccount(env("CALLBACK_SENDER_KEY", "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6") as Hex);
const keystoreDir = env("KEYSTORE_DIR", "./keystore");
const evidenceDir = env("EVIDENCE_DIR", "./evidence");
const pollMs = Number(env("POLL_MS", "3000"));
mkdirSync(keystoreDir, { recursive: true });
mkdirSync(evidenceDir, { recursive: true });

const chain = chainFor(chainId, rpcUrl);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });
const auction = { address: deployment.auction, abi: auctionAbi } as const;
const read = <T,>(fn: string, args: unknown[] = []) => publicClient.readContract({ ...auction, functionName: fn as never, args: args as never }) as Promise<T>;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// Code identity: same hash scripts/solver-hash.mjs pins at deployment.
function localSolverCodeHash(): Hex {
  const dir = new URL("../../../packages/protocol/src/", import.meta.url);
  const h = createHash("sha256");
  for (const f of ["amount.ts", "hash.ts", "envelope.ts", "solver.ts"]) h.update(readFileSync(new URL(f, dir)));
  return `0x${h.digest("hex")}`;
}

async function send(functionName: string, args: unknown[]) {
  const hash = await walletClient.writeContract({ ...auction, functionName: functionName as never, args: args as never });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return hash;
}

// ---------------------------------------------------------------- INIT_KEY (mock)
async function prepareKeys(fromBlock: bigint) {
  const logs = await publicClient.getContractEvents({ ...auction, eventName: "KeyRequested", fromBlock });
  for (const l of logs) {
    const keyRequestId = l.args.keyRequestId as Hex;
    const rec = await read<{ status: number; owner: Address }>("getKeyRecord", [keyRequestId]);
    if (rec.status !== 1) continue; // only Requested
    const pair = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const keyId = keyIdFromSpki(spki);
    // ponytail: a TEE seals pkcs8 with host sealing bound to code+caller; here it is a plain file.
    writeFileSync(
      join(keystoreDir, `${keyId}.json`),
      JSON.stringify({ warning: "LOCAL MOCK KEY, UNSEALED. Not a TEE.", keyRequestId, owner: rec.owner, keyId, spki: bytesToHex(spki), pkcs8: bytesToHex(pkcs8), createdAt: new Date().toISOString() }, null, 2),
    );
    const sealedBlobHash = `0x${createHash("sha256").update(pkcs8).digest("hex")}` as Hex;
    await send("onKeyPrepared", [{ keyRequestId, owner: rec.owner, keyId, publicKeySpki: bytesToHex(spki), sealedBlobHash, solverCodeHash: deployment.solverCodeHash, configHash: deployment.configHash }]);
    log("key ready", keyId, "for", rec.owner);
  }
}

// ---------------------------------------------------------------- keeper (permissionless timers)
const attempted = new Set<string>();

async function keep(now: bigint, cfg: { maxAttempts: bigint; attemptTimeoutSeconds: bigint }) {
  const count = await read<bigint>("auctionCount");
  for (let id = 1n; id <= count; id++) {
    const a = await read<{
      state: number; endTime: bigint; settlementDeadline: bigint; activeAttempt: number; attemptStartedAt: bigint;
      activeRequestId: Hex; claimDeadline: bigint;
    }>("getAuction", [id]);
    const state = AUCTION_STATES[a.state];
    try {
      if (state === "PendingClaim" && now >= a.claimDeadline) {
        await send("expireClaim", [id]);
        log("auction", id, "winner defaulted; deposit forfeited to seller credit");
      } else if ((state === "Created" || state === "Active" || state === "Ended") && now >= a.settlementDeadline) {
        await send("cancelAfterSolverTimeout", [id]);
        log("auction", id, "settlement timed out; refunds open");
      } else if ((state === "Created" || state === "Active" || state === "Ended") && now >= a.endTime && a.activeAttempt === 0) {
        await send("requestSettlement", [id]);
        log("auction", id, "settlement requested (attempt 1)");
      } else if (state === "Ended" && a.activeAttempt > 0 && a.activeAttempt < Number(cfg.maxAttempts) && now >= a.attemptStartedAt + cfg.attemptTimeoutSeconds) {
        await send("retrySettlement", [id]);
        log("auction", id, "settlement retried (attempt", a.activeAttempt + 1, ")");
      }
    } catch (e) {
      log("keeper", id, state, (e as Error).message.split("\n")[0]);
    }
  }
}

// ---------------------------------------------------------------- SOLVE (mock adapter path)
async function settle(now: bigint, codeHash: Hex) {
  const count = await read<bigint>("auctionCount");
  for (let id = 1n; id <= count; id++) {
    const a = await read<{
      state: number; keyId: Hex; bidDigest: Hex; bidCount: number; activeRequestId: Hex; activeAttempt: number;
      reserveUnits: bigint; endTime: bigint; settlementDeadline: bigint;
    }>("getAuction", [id]);
    if (AUCTION_STATES[a.state] !== "Ended" || a.activeAttempt === 0 || now >= a.settlementDeadline) continue;
    const requestId = a.activeRequestId;
    if (attempted.has(requestId) || (await read<boolean>("consumedRequests", [requestId]))) continue;
    attempted.add(requestId);

    const request: SettlementRequest = {
      protocolVersion: 1, chainId: String(chainId), auctionContract: deployment.auction.toLowerCase() as Address, auctionId: id.toString(),
      requestId, attempt: a.activeAttempt, bidDigest: a.bidDigest, bidCount: a.bidCount, keyId: a.keyId, solverCodeHash: codeHash,
      configHash: deployment.configHash, reserveUnits: a.reserveUnits.toString(), endTime: a.endTime.toString(), settlementDeadline: a.settlementDeadline.toString(),
    };
    try {
      const manifest = await buildManifest(id, request);
      const keyFile = join(keystoreDir, `${a.keyId}.json`);
      if (!existsSync(keyFile)) throw new SolverFatal("KEY_UNAVAILABLE", requestId, `no key file for ${a.keyId}`);
      const pkcs8 = hexToBytes(JSON.parse(readFileSync(keyFile, "utf8")).pkcs8);
      const result = await solve(request, manifest, pkcs8);
      const output = canonicalResult(result);
      const manifestBytes = canonicalManifest(manifest);
      const executionId = `local-${requestId.slice(2, 18)}-${Date.now()}`;
      const evidence = {
        adapter: "local-mock-adapter", verificationStatus: "available_unchecked", note: "Executed by the local mock adapter, not a TEE. Hashes are reproducible from the stored raw output.",
        executionId, request, manifestSha256: sha256Utf8(manifestBytes), inputSha256: sha256Utf8(JSON.stringify(request) + manifestBytes),
        outputSha256: sha256Utf8(output), wasmSha256: codeHash, rawOutput: output, manifest, executedAt: new Date().toISOString(),
      };
      writeFileSync(join(evidenceDir, `${requestId}.json`), JSON.stringify(evidence, null, 2));
      await send("onSettlementResult", [{
        ...result, winningAmountUnits: BigInt(result.winningAmountUnits), chainId: BigInt(result.chainId), auctionId: BigInt(result.auctionId),
        outcome: result.outcome === "WINNER" ? 0 : 1, executionIdHash: keccak256(stringToBytes(executionId)), outputHash: sha256Utf8(output),
      }]);
      log("auction", id, "result delivered:", result.outcome, result.outcome === "WINNER" ? `${result.winner}` : "", `valid=${result.validBidCount} invalid=${result.invalidBidCount}`);
    } catch (e) {
      if (e instanceof SolverFatal) {
        writeFileSync(join(evidenceDir, `${requestId}.json`), JSON.stringify({ adapter: "local-mock-adapter", fatal: { code: e.code, retryable: e.retryable }, request, executedAt: new Date().toISOString() }, null, 2));
        log("auction", id, "fatal", e.code, "- waiting for retry/timeout");
      } else {
        attempted.delete(requestId); // transient (RPC) failure: try again next tick
        log("auction", id, "settle error", (e as Error).message.split("\n")[0]);
      }
    }
  }
}

async function buildManifest(id: bigint, request: SettlementRequest): Promise<Manifest> {
  const logs = await publicClient.getContractEvents({ ...auction, eventName: "BidPlaced", args: { auctionId: id }, fromBlock: BigInt(deployment.deployBlock) });
  const bids = logs
    .map((l) => ({
      bidIndex: String(l.args.bidIndex), bidder: (l.args.bidder as Address).toLowerCase() as Address, commitment: l.args.commitment as Hex, envelope: l.args.envelope as Hex,
      txHash: l.transactionHash as Hex, blockHash: l.blockHash as Hex, blockNumber: String(l.blockNumber), logIndex: String(l.logIndex),
    }))
    .sort((x, y) => Number(x.bidIndex) - Number(y.bidIndex));
  return {
    protocolVersion: 1, chainId: request.chainId, auctionContract: request.auctionContract, auctionId: request.auctionId, requestId: request.requestId,
    keyId: request.keyId, bidDigest: request.bidDigest, bidCount: request.bidCount, bids,
  };
}

// ---------------------------------------------------------------- main loop
async function main() {
  const cfg = await read<{ callbackSender: Address; nearAdapterAccount: string; solverCodeHash: Hex; configHash: Hex; maxAttempts: bigint; attemptTimeoutSeconds: bigint; profile: string }>("getConfig");
  const codeHash = localSolverCodeHash();
  if (cfg.nearAdapterAccount !== "local-mock-adapter") throw new Error(`refusing to run: this deployment pins the real adapter ${cfg.nearAdapterAccount}; use apps/keeper`);
  if (cfg.callbackSender.toLowerCase() !== account.address.toLowerCase()) throw new Error(`callback sender mismatch: contract expects ${cfg.callbackSender}, we are ${account.address}`);
  if (cfg.solverCodeHash !== codeHash) throw new Error(`solver code hash mismatch: deployed ${cfg.solverCodeHash}, local ${codeHash}`);
  if (cfg.configHash !== deployment.configHash) throw new Error("configHash mismatch between chain and deployments file");
  log(`local adapter online: chain ${chainId}, auction ${deployment.auction}, profile ${cfg.profile}, code ${codeHash}`);
  log("WARNING: this is the LOCAL-ONLY FALLBACK adapter (not a TEE). Keys are unsealed on disk; no attestation exists.");
  for (;;) {
    try {
      const block = await publicClient.getBlock();
      await prepareKeys(BigInt(deployment.deployBlock));
      await keep(block.timestamp, cfg);
      await settle(block.timestamp, codeHash);
    } catch (e) {
      log("tick error", (e as Error).message.split("\n")[0]);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
