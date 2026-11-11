// KEEPER for the private path (Aurora testnet + NEAR adapter + OutLayer).
// 1. Permissionless Aurora timers: requestSettlement / retrySettlement / expireClaim / cancelAfterSolverTimeout.
// 2. For every active settlement request, rebuild the public manifest from BidPlaced logs and hand it to the NEAR
//    adapter (`submit_manifest`), which runs the pinned solver in the TEE and delivers the Aurora callback itself.
// This process never sees a private key or a plaintext bid; the adapter only accepts the manifest from the operator
// account and the solver re-verifies every commitment and the ordered digest against the on-chain snapshot.
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { auctionAbi, chainFor, deployments } from "@maskbid/contracts";
import { AUCTION_STATES, canonicalManifest, sha256Utf8, type Manifest } from "@maskbid/protocol";

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error(`missing env ${k}`); })();
const chainId = Number(env("CHAIN_ID", "1313161555"));
const rpcUrl = env("RPC_URL", "https://testnet.aurora.dev");
const deployment = deployments[String(chainId)];
if (!deployment) throw new Error(`no deployment for chain ${chainId}`);
const account = privateKeyToAccount(env("KEEPER_KEY") as Hex);
const nearAdapter = env("NEAR_ADAPTER_ACCOUNT", deployment.nearAdapterAccount);
const nearKeeper = env("NEAR_KEEPER_ACCOUNT", "maskbid-keeper.testnet");
const nearNetwork = env("NEAR_NETWORK", "testnet");
const evidenceDir = env("EVIDENCE_DIR", "./evidence");
const pollMs = Number(env("POLL_MS", "6000"));
const resubmitMs = 6 * 60 * 1000; // the adapter refuses a re-dispatch for 5 min; give the TEE run time
// Gate-run knob (scripts/testnet-gates.mjs stale): auction ids whose FIRST attempt gets no manifest, so a retry happens.
const skipFirstAttempt = new Set((process.env.SKIP_FIRST_ATTEMPT_AUCTIONS ?? "").split(",").filter(Boolean).map(BigInt));
// Gate-run knob (scripts/testnet-gates.mjs recovery): auction ids that never get a manifest, so the solver timeout path runs.
const skipAllAttempts = new Set((process.env.SKIP_ALL_ATTEMPTS_AUCTIONS ?? "").split(",").filter(Boolean).map(BigInt));
mkdirSync(evidenceDir, { recursive: true });

const chain = chainFor(chainId, rpcUrl);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ chain, transport: http(rpcUrl), account });
const auction = { address: deployment.auction, abi: auctionAbi } as const;
const read = <T,>(fn: string, args: unknown[] = []) => publicClient.readContract({ ...auction, functionName: fn as never, args: args as never }) as Promise<T>;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const run = promisify(execFile);

async function send(functionName: string, args: unknown[]) {
  const hash = await walletClient.writeContract({ ...auction, functionName: functionName as never, args: args as never });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return hash;
}

// ---------------------------------------------------------------- NEAR adapter (near-cli-rs with the keeper's legacy keychain)
async function nearView(method: string, args: Record<string, unknown>): Promise<unknown> {
  const { stdout } = await run("near", ["contract", "call-function", "as-read-only", nearAdapter, method, "json-args", JSON.stringify(args), "network-config", nearNetwork, "now"], { maxBuffer: 1 << 22 });
  const text = stdout.replace(/\x1b\[[0-9;]*m/g, "");
  if (/^\s*null\s*$/m.test(text) && !text.includes("{")) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  return JSON.parse(text.slice(start, end + 1));
}
async function nearCall(method: string, args: Record<string, unknown>) {
  const { stdout, stderr } = await run("near", [
    "contract", "call-function", "as-transaction", nearAdapter, method, "json-args", JSON.stringify(args),
    "prepaid-gas", "300 Tgas", "attached-deposit", "0 NEAR", "sign-as", nearKeeper, "network-config", nearNetwork,
    "sign-with-legacy-keychain", "send",
  ], { maxBuffer: 1 << 22 });
  const m = /Transaction ID: (\S+)/.exec(stdout + stderr);
  if (!m) throw new Error(`near call ${method}: no transaction id\n${(stdout + stderr).slice(-2000)}`);
  return m[1];
}

// ---------------------------------------------------------------- timers (same rules as the local adapter)
async function keep(now: bigint, cfg: { maxAttempts: bigint; attemptTimeoutSeconds: bigint }) {
  const count = await read<bigint>("auctionCount");
  for (let id = 1n; id <= count; id++) {
    const a = await read<{ state: number; endTime: bigint; settlementDeadline: bigint; activeAttempt: number; attemptStartedAt: bigint; claimDeadline: bigint }>("getAuction", [id]);
    const state = AUCTION_STATES[a.state];
    const open = state === "Created" || state === "Active" || state === "Ended";
    try {
      if (state === "PendingClaim" && now >= a.claimDeadline) log("auction", id, "winner defaulted:", await send("expireClaim", [id]));
      else if (open && now >= a.settlementDeadline) log("auction", id, "settlement timed out:", await send("cancelAfterSolverTimeout", [id]));
      else if (open && now >= a.endTime && a.activeAttempt === 0) log("auction", id, "settlement requested (XCC request_solve):", await send("requestSettlement", [id]));
      else if (state === "Ended" && a.activeAttempt > 0 && a.activeAttempt < Number(cfg.maxAttempts) && now >= a.attemptStartedAt + cfg.attemptTimeoutSeconds) {
        log("auction", id, "settlement retried (attempt", a.activeAttempt + 1, "):", await send("retrySettlement", [id]));
      }
    } catch (e) {
      log("keeper", id, state, (e as Error).message.split("\n")[0]);
    }
  }
}

// ---------------------------------------------------------------- manifest submission
const submitted = new Map<string, number>();

interface AdapterRequest { status: string; dispatchedAtMs: number; lastError?: string | null; outputSha256?: string | null }

/** The evidence file is written at submission, before the TEE answers. Once the adapter reports Delivered, add its output hash
 *  and the pinned code hash. Checked at most once a minute per file; stops for good once filled. */
const backfillAt = new Map<string, number>();
async function backfillEvidence() {
  for (const f of readdirSync(evidenceDir).filter((n) => /^0x[0-9a-f]{64}\.json$/.test(n))) {
    const requestId = f.slice(0, -5);
    if (Date.now() - (backfillAt.get(requestId) ?? 0) < 60_000) continue;
    backfillAt.set(requestId, Date.now());
    try {
      const file = join(evidenceDir, f);
      const ev = JSON.parse(readFileSync(file, "utf8"));
      if (ev.outputSha256) { backfillAt.set(requestId, Number.MAX_SAFE_INTEGER); continue; }
      const rec = (await nearView("get_request", { request_id: requestId })) as AdapterRequest | null;
      if (rec?.status === "Delivered" && rec.outputSha256) writeFileSync(file, JSON.stringify({ ...ev, outputSha256: rec.outputSha256, wasmSha256: deployment.solverCodeHash, adapterStatusAfter: rec.status }, null, 2));
    } catch { /* unreadable file or adapter view failed: retry next minute */ }
  }
}

async function submitManifests(now: bigint) {
  const count = await read<bigint>("auctionCount");
  for (let id = 1n; id <= count; id++) {
    const a = await read<{ state: number; keyId: Hex; bidDigest: Hex; bidCount: number; activeRequestId: Hex; activeAttempt: number; settlementDeadline: bigint }>("getAuction", [id]);
    if (AUCTION_STATES[a.state] !== "Ended" || a.activeAttempt === 0 || now >= a.settlementDeadline) continue;
    if (skipFirstAttempt.has(id) && a.activeAttempt === 1) continue;
    if (skipAllAttempts.has(id)) continue;
    const requestId = a.activeRequestId;
    if (Date.now() - (submitted.get(requestId) ?? 0) < resubmitMs) continue;
    try {
      const rec = (await nearView("get_request", { request_id: requestId })) as AdapterRequest | null;
      if (!rec) { log("auction", id, "adapter has not received request", requestId, "yet (XCC in flight)"); continue; }
      if (rec.status === "Delivered") { submitted.set(requestId, Number.MAX_SAFE_INTEGER); continue; }
      if (rec.status === "Dispatched" && Date.now() - rec.dispatchedAtMs < 5 * 60 * 1000) { submitted.set(requestId, Date.now()); continue; }
      const manifest = await buildManifest(id, a);
      const body = canonicalManifest(manifest);
      const tx = await nearCall("submit_manifest", { request_id: requestId, manifest: body });
      submitted.set(requestId, Date.now());
      writeFileSync(join(evidenceDir, `${requestId}.json`), JSON.stringify({
        adapter: nearAdapter, verificationStatus: "available_unchecked",
        note: "Manifest handed to the NEAR adapter; the TEE output and its hashes are recorded on the adapter (get_request) and on Aurora (SettlementAccepted).",
        requestId, auctionId: id.toString(), attempt: a.activeAttempt, manifestSha256: sha256Utf8(body), submitManifestTx: tx,
        adapterStatusBefore: rec.status, lastError: rec.lastError ?? null, manifest, submittedAt: new Date().toISOString(),
      }, null, 2));
      log("auction", id, "manifest submitted to adapter:", tx, `sha256=${sha256Utf8(body)} bids=${manifest.bidCount}`);
    } catch (e) {
      log("auction", id, "manifest error", (e as Error).message.split("\n")[0]);
    }
  }
}

async function buildManifest(id: bigint, a: { keyId: Hex; bidDigest: Hex; bidCount: number; activeRequestId: Hex }): Promise<Manifest> {
  const logs = await publicClient.getContractEvents({ ...auction, eventName: "BidPlaced", args: { auctionId: id }, fromBlock: BigInt(deployment.deployBlock) });
  const bids = logs
    .map((l) => ({
      bidIndex: String(l.args.bidIndex), bidder: (l.args.bidder as Address).toLowerCase() as Address, commitment: l.args.commitment as Hex, envelope: l.args.envelope as Hex,
      txHash: l.transactionHash as Hex, blockHash: l.blockHash as Hex, blockNumber: String(l.blockNumber), logIndex: String(l.logIndex),
    }))
    .sort((x, y) => Number(x.bidIndex) - Number(y.bidIndex));
  return {
    protocolVersion: 1, chainId: String(chainId), auctionContract: deployment.auction.toLowerCase() as Address, auctionId: id.toString(),
    requestId: a.activeRequestId, keyId: a.keyId, bidDigest: a.bidDigest, bidCount: a.bidCount, bids,
  };
}

// ---------------------------------------------------------------- main loop
async function main() {
  const cfg = await read<{ callbackSender: Address; nearAdapterAccount: string; maxAttempts: bigint; attemptTimeoutSeconds: bigint; profile: string; solverCodeHash: Hex }>("getConfig");
  const adapterCfg = (await nearView("get_config", {})) as { callbackSender: string; solverCodeHash: string; configHash: string; xccPredecessor: string } | null;
  if (!adapterCfg) throw new Error("adapter get_config returned nothing");
  if (adapterCfg.callbackSender.toLowerCase() !== cfg.callbackSender.toLowerCase()) throw new Error(`callbackSender mismatch: auction ${cfg.callbackSender}, adapter ${adapterCfg.callbackSender}`);
  if (adapterCfg.solverCodeHash.toLowerCase() !== cfg.solverCodeHash.toLowerCase()) throw new Error(`solverCodeHash mismatch: auction ${cfg.solverCodeHash}, adapter ${adapterCfg.solverCodeHash}`);
  if (adapterCfg.configHash.toLowerCase() !== deployment.configHash.toLowerCase()) throw new Error("configHash mismatch between adapter and deployment");
  log(`keeper online: chain ${chainId}, auction ${deployment.auction}, adapter ${nearAdapter} (xcc predecessor ${adapterCfg.xccPredecessor}), callbackSender ${cfg.callbackSender}, profile ${cfg.profile}`);
  for (;;) {
    try {
      const block = await publicClient.getBlock();
      await keep(block.timestamp, cfg);
      await submitManifests(block.timestamp);
      await backfillEvidence();
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
