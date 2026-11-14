import { readConfig } from "./client";
import { CONTRACT, TOKEN } from "./config";
import { view, type Account, type TxResult } from "./near";

/** One contract call as the pages describe it. `to` defaults to the MaskBid contract. */
export interface Call { to?: "maskbid" | "token"; method: string; args?: object; deposit?: bigint; gas?: number }

/** Calls that start a TEE run: the caller attaches the execution deposit, and the answer arrives later through views. */
const COMPUTE = new Set(["prepare_auction_key", "redispatch_key", "request_settlement", "retry_settlement"]);

export async function write(account: Account, call: Call, onHash?: (hash: string) => void): Promise<TxResult> {
  const compute = COMPUTE.has(call.method);
  return account.send({
    contract: call.to === "token" ? TOKEN : CONTRACT, method: call.method, args: call.args ?? {}, watch: [CONTRACT],
    deposit: compute ? (await readConfig()).executionDeposit : call.deposit, gas: call.gas ?? (compute ? 250 : 100), wait: compute ? "first" : "all",
  }, onHash);
}

/** Tokens enter the contract only through `ft_transfer_call`; `msg` says what the transfer is for. */
const transfer = (amount: bigint, msg: object): Call => ({ to: "token", method: "ft_transfer_call", args: { receiver_id: CONTRACT, amount: amount.toString(), msg: JSON.stringify(msg) }, deposit: 1n, gas: 150 });
export const bidCall = (auctionId: bigint, deposit: bigint, envelope: string) => transfer(deposit, { action: "bid", auction_id: Number(auctionId), envelope });
export const claimCall = (auctionId: bigint, remainder: bigint): Call => (remainder > 0n ? transfer(remainder, { action: "claim", auction_id: Number(auctionId) }) : { method: "claim_win", args: { auction_id: Number(auctionId) } });
export const faucetCall = (to: string): Call => ({ to: "token", method: "faucet", args: { to } });
export const auctionCall = (method: string, auctionId: bigint): Call => ({ method, args: { auction_id: Number(auctionId) } });

/** An account must be registered on the token before it can be paid; the call that does it, or undefined if it already is. */
export async function tokenRegistration(accountId: string): Promise<Call | undefined> {
  const registered = await view<unknown>(TOKEN, "storage_balance_of", { account_id: accountId });
  return registered ? undefined : { to: "token", method: "storage_deposit", args: {}, deposit: 1_250_000_000_000_000_000_000n };
}
