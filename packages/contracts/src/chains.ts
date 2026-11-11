import { defineChain, type Chain } from "viem";
import { auroraTestnet, foundry } from "viem/chains";

/** The only two chains this deployment knows. Anything else is refused: no silent fallback network. */
export function chainFor(chainId: number, rpcUrl?: string): Chain {
  const base = chainId === foundry.id ? foundry : chainId === auroraTestnet.id ? auroraTestnet : undefined;
  if (!base) throw new Error(`Unsupported chain ${chainId}; expected ${foundry.id} (Anvil) or ${auroraTestnet.id} (Aurora testnet)`);
  if (!rpcUrl) return base;
  return defineChain({ ...base, rpcUrls: { default: { http: [rpcUrl] } } });
}

export const EXPLORERS: Record<number, string | undefined> = {
  [auroraTestnet.id]: "https://explorer.testnet.aurora.dev",
  [foundry.id]: undefined,
};
