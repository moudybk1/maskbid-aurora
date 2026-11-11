// Solver code identity for the local adapter: SHA-256 over the protocol sources the solver executes.
// A real OutLayer deployment pins the WASM binary hash instead.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SOLVER_SOURCES = ["amount.ts", "hash.ts", "envelope.ts", "solver.ts"];

export function solverCodeHash() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../packages/protocol/src");
  const h = createHash("sha256");
  for (const f of SOLVER_SOURCES) h.update(readFileSync(join(dir, f)));
  return `0x${h.digest("hex")}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(solverCodeHash());
