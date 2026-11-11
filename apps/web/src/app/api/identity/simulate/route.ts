import { NextResponse } from "next/server";
import { createWalletClient, http, isAddress, keccak256, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { registryAbi } from "@maskbid/contracts";
import { chain, requireDeployment, RPC_URL } from "@/lib/config";

const enabled = () => process.env.IDENTITY_SIMULATOR === "true" && Boolean(process.env.IDENTITY_REGISTRAR_KEY);
const problem = (status: number, code: string, detail: string) => NextResponse.json({ type: `urn:maskbid:error:${code.toLowerCase().replace(/_/g, "-")}`, title: detail, status, code, detail }, { status });

export async function GET() {
  return NextResponse.json({ enabled: enabled(), provider: "simulator" });
}

/** Simulator-only registrar path. Real deployments use a World ID verifier + restricted registrar worker (G-05). */
export async function POST(req: Request) {
  if (!enabled()) return problem(404, "SIMULATOR_DISABLED", "Simulated verification is not enabled on this deployment");
  if (new URL(req.url).origin !== (req.headers.get("origin") ?? new URL(req.url).origin)) return problem(403, "CROSS_ORIGIN", "Same-origin only");
  const { wallet } = (await req.json().catch(() => ({}))) as { wallet?: string };
  if (!wallet || !isAddress(wallet)) return problem(422, "INVALID_WALLET", "wallet must be an address");
  const d = requireDeployment();
  const secret = process.env.IDENTITY_HMAC_SECRET ?? "local-dev-only";
  // Opaque, deployment-scoped uniqueness id: never the raw provider nullifier.
  const uniquenessId = keccak256(stringToBytes(`${secret}|simulator|${d.chainId}|${d.registry}|${wallet.toLowerCase()}`));
  const registrar = createWalletClient({ account: privateKeyToAccount(process.env.IDENTITY_REGISTRAR_KEY as Hex), chain, transport: http(RPC_URL) });
  const verifiedUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 86400 - 60);
  try {
    const txHash = await registrar.writeContract({ address: d.registry, abi: registryAbi, functionName: "registerParticipant", args: [wallet, uniquenessId, verifiedUntil, 2, keccak256(stringToBytes("simulated-proof"))] });
    return NextResponse.json({ txHash, assurance: "simulator" });
  } catch (e) {
    return problem(409, "REGISTRATION_FAILED", (e as Error).message.split("\n")[0]);
  }
}
