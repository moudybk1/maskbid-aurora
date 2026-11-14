/** Single network configuration: the NEAR testnet deployment unless the env names another one. */
export const CONTRACT = process.env.NEXT_PUBLIC_MASKBID_CONTRACT ?? "maskbid-v2.testnet";
export const TOKEN = process.env.NEXT_PUBLIC_MASKBID_TOKEN ?? "maskbid-usdc.testnet";
export const RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC ?? "https://rpc.testnet.fastnear.com";
export const NETWORK = "NEAR testnet";
/** The protocol's domain number for NEAR testnet (bid envelopes and commitments are bound to it). */
export const CHAIN_ID = 398;
export const explorer = "https://testnet.nearblocks.io";

export const txUrl = (hash: string) => `${explorer}/txns/${hash}`;
export const addressUrl = (a: string) => `${explorer}/address/${a}`;
