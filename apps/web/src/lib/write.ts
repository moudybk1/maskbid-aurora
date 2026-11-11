import type { Abi, Address, Hash, WalletClient } from "viem";
import { publicClient } from "./client";

/** Simulate first so reverts are decoded into custom error names, then sign exactly that request. */
export async function write(client: WalletClient, c: { address: Address; abi: Abi }, functionName: string, args: readonly unknown[] = []): Promise<Hash> {
  const { request } = await publicClient.simulateContract({ address: c.address, abi: c.abi, functionName, args, account: client.account! } as never);
  return client.writeContract(request as never);
}
