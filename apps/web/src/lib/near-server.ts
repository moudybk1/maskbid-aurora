import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Secret key of a testnet account from the near-cli keychain on this machine (`~/.near-credentials/testnet`). Server only. */
export function keychainKey(accountId: string): string | undefined {
  if (!/^[a-z0-9._-]{2,64}$/.test(accountId)) return undefined;
  try {
    return (JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${accountId}.json`), "utf8")) as { private_key?: string }).private_key;
  } catch {
    return undefined;
  }
}
