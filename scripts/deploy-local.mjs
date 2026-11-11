// Deploys to a running Anvil (demo profile, simulator identity, seeded accounts) and regenerates ABIs.
// Roles on Anvil: #0 deployer/admin/registrar/seller, #1-#5 participants, #7 verifier, #9 local adapter (callback sender).
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { solverCodeHash } from "./solver-hash.mjs";

export const ANVIL = {
  deployerKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  verifier: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  adapter: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  adapterKey: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6",
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rpc = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const env = {
  ...process.env,
  PATH: `${process.env.HOME}/.foundry/bin:${process.env.PATH}`,
  PROFILE: process.env.PROFILE ?? "demo",
  SOLVER_CODE_HASH: solverCodeHash(),
  CALLBACK_SENDER: ANVIL.adapter,
  VERIFIER: ANVIL.verifier,
  ALLOW_SIMULATOR: "true",
  SEED_LOCAL: "true",
};
execSync(
  `forge script script/Deploy.s.sol --rpc-url ${rpc} --broadcast --private-key ${ANVIL.deployerKey} -vv`,
  { cwd: join(root, "contracts"), env, stdio: "inherit" },
);
execSync("node scripts/sync-abi.mjs", { cwd: root, stdio: "inherit" });
