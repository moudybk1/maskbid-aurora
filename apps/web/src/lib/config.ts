import { chainFor, deployments, EXPLORERS, type Deployment } from "@maskbid/contracts";

/** Single network configuration. Missing deployment disables writes; there is no fallback network. */
export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
export const deployment: Deployment | undefined = deployments[String(CHAIN_ID)];
export const chain = chainFor(CHAIN_ID, RPC_URL);
export const explorer = EXPLORERS[CHAIN_ID];
export const IS_LOCAL = CHAIN_ID === 31337;

export function requireDeployment(): Deployment {
  if (!deployment) throw new Error(`No deployment recorded for chain ${CHAIN_ID}. Run npm run deploy:local or add deployments/${CHAIN_ID}.json.`);
  return deployment;
}

export const txUrl = (hash: string) => (explorer ? `${explorer}/tx/${hash}` : undefined);
export const addressUrl = (a: string) => (explorer ? `${explorer}/address/${a}` : undefined);
