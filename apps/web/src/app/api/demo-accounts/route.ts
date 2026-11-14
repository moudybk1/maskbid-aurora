import { NextResponse } from "next/server";
import { keychainKey } from "@/lib/near-server";

export const dynamic = "force-dynamic";

/** Local demo only: hands the browser the testnet keys of the accounts named in NEAR_DEMO_ACCOUNTS
    ("account=Label,account=Label"), read from this machine's near-cli keychain, so one browser can play every role.
    Off unless that variable is set, and only ever answered on localhost. Never set it on a public deployment. */
export function GET(req: Request) {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(req.url).hostname);
  const wanted = local ? (process.env.NEAR_DEMO_ACCOUNTS ?? "").split(",").map((s) => s.trim()).filter(Boolean) : [];
  const accounts = wanted.flatMap((entry) => {
    const [accountId, label] = entry.split("=");
    const key = keychainKey(accountId);
    return key ? [{ accountId, key, label: label ?? accountId }] : [];
  });
  return NextResponse.json({ accounts });
}
