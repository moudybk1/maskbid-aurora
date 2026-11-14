// INDEXER worker: follows the chain a few blocks behind the head and keeps the read model current.
//   node src/index.ts            follow the chain (one leader per deployment)
//   node src/index.ts --replay   rebuild every projection from the stored events, then exit
//   node src/index.ts --deployment-sql   print the bootstrap row for `deployments` (used by setup.sh)
import { abiHash, assertDeployment, auction, chainId, client, deployment, ingest, lead, log, pool, readCheckpoint, replay, reset } from "./lib.ts";

if (process.argv.includes("--deployment-sql")) {
  const commit = process.env.SOURCE_COMMIT ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("SOURCE_COMMIT must be the 40-character git commit");
  const d = deployment, lc = (s: string) => s.toLowerCase();
  console.log(`INSERT INTO maskbid.deployments (chain_id, auction_contract, asset_contract, participant_registry, payment_token, token_symbol, token_decimals, profile, deployment_block, config_hash, solver_code_hash, near_adapter, callback_sender, source_commit, abi_hash)
VALUES (${chainId}, '${auction}', '${lc(d.asset)}', '${lc(d.registry)}', '${lc(d.token)}', 'mUSDC', 6, '${d.profile}', ${d.deployBlock}, '${lc(d.configHash)}', '${lc(d.solverCodeHash)}', '${d.nearAdapterAccount}', '${lc(d.callbackSender)}', '${commit}', '${abiHash()}')
ON CONFLICT (chain_id, auction_contract) DO NOTHING;`);
  process.exit(0);
}

const pollMs = Number(process.env.POLL_MS ?? 4000);
const confirmations = BigInt(process.env.CONFIRMATIONS ?? 3);
const maxSpan = BigInt(process.env.MAX_SPAN ?? 1_000_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!(await lead())) { console.error("another indexer already leads this deployment"); process.exit(1); }
await assertDeployment();

if (process.argv.includes("--replay")) {
  log(`replayed ${await replay()} stored events into fresh projections`);
  process.exit(0);
}

log(`indexer online: chain ${chainId}, auction ${auction}, from block ${(await readCheckpoint())?.last_block ?? deployment.deployBlock}`);
process.on("SIGINT", () => process.exit(0)); // every block is its own transaction, so stopping between polls loses nothing
process.on("SIGTERM", () => process.exit(0));

let span = maxSpan, backoff = 1000;
for (;;) {
  try {
    const cp = await readCheckpoint();
    if (cp && (await client.getBlock({ blockNumber: BigInt(cp.last_block) })).hash !== cp.last_block_hash) {
      log(`block ${cp.last_block} changed hash: reorg, rebuilding from the deployment block`);
      await reset();
      continue;
    }
    const head = (await client.getBlockNumber()) - confirmations;
    const from = cp ? BigInt(cp.last_block) + 1n : BigInt(deployment.deployBlock);
    if (from <= head) {
      const to = head - from >= span ? from + span - 1n : head;
      let applied: number;
      try {
        applied = await ingest(from, to);
      } catch (e) {
        // an RPC that refuses the range gets a smaller one; never skip a block
        if (span > 1n && /getLogs|eth_getLogs|range|limit|timeout|too many/i.test(String((e as Error).message))) { span /= 2n; log(`RPC refused ${from}..${to}; span now ${span}`); continue; }
        throw e;
      }
      if (applied) log(`applied ${applied} events up to block ${to}`);
      if (span < maxSpan) span *= 2n;
      backoff = 1000;
      if (to < head) continue;
    }
  } catch (e) {
    log("error:", (e as Error).message.split("\n")[0]);
    await pool.query(`UPDATE indexer_checkpoints SET state='halted' WHERE chain_id=$1 AND contract=$2`, [chainId, auction]).catch(() => {});
    await sleep(backoff + Math.random() * 500);
    backoff = Math.min(backoff * 2, 30_000);
    continue;
  }
  await sleep(pollMs);
}
