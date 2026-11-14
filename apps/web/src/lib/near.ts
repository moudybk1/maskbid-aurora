// Minimal NEAR client for the browser: JSON-RPC views, and one-function-call transactions sent either through the
// user's wallet (NEAR Connect) or, for the local demo accounts, signed here with a testnet key.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";
import { base58 } from "@scure/base";
import { RPC_URL } from "./config";

export class NearError extends Error {
  /** `panic` is the contract's error name ("NotEligible") when a contract refused the call. */
  constructor(message: string, public panic?: string, public hash?: string) {
    super(message);
    this.name = "NearError";
  }
}

/** The configured endpoint, then public fallbacks: a rate-limited or unreachable node moves the request to the next one. */
const ENDPOINTS = [...new Set([RPC_URL, "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"])];
let preferred = 0;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  let last: unknown;
  for (let i = 0; i < ENDPOINTS.length; i++) {
    const at = (preferred + i) % ENDPOINTS.length;
    try {
      const res = await fetch(ENDPOINTS[at], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" });
      if (res.status === 429 || res.status >= 500) throw new Error(`RPC ${res.status}`);
      const j = await res.json();
      preferred = at;
      if (j.error) throw new NearError(typeof j.error.data === "string" ? j.error.data : j.error.cause?.name ?? j.error.message ?? "RPC error");
      return j.result as T;
    } catch (e) {
      if (e instanceof NearError) throw e; // the node answered; another node would say the same
      last = e;
    }
  }
  throw new NearError(`NEAR RPC unreachable (${(last as Error)?.message ?? "no answer"})`);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Identical views asked within two seconds share one request, so components polling the same data do not multiply calls. */
const recent = new Map<string, { at: number; value: Promise<unknown> }>();
export function view<T>(contract: string, method: string, args: object = {}): Promise<T> {
  const key = `${contract}.${method}(${JSON.stringify(args)})`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < 2000) return hit.value as Promise<T>;
  const value = rpc<{ result?: number[]; error?: string }>("query", { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: b64(utf8(JSON.stringify(args))) })
    .then((r) => {
      if (!r.result) throw new NearError(r.error ?? `${method} failed`);
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))) as T;
    });
  if (recent.size > 200) recent.clear();
  recent.set(key, { at: Date.now(), value });
  value.catch(() => recent.delete(key));
  return value;
}
/** Forget cached views: called after a transaction so the next read sees its effect. */
export const forgetViews = () => recent.clear();

/** Seconds of the latest block: the clock the contract uses. The offset to this machine's clock is measured once a
    minute, so reading the time does not cost a request on every poll. */
let clock: { at: number; offset: Promise<number> } | undefined;
export async function blockTime(): Promise<bigint> {
  if (!clock || Date.now() - clock.at > 60_000) {
    const offset = rpc<{ header: { timestamp: number } }>("block", { finality: "optimistic" }).then((b) => b.header.timestamp / 1e9 - Date.now() / 1000);
    clock = { at: Date.now(), offset };
    offset.catch(() => { clock = undefined; });
  }
  return BigInt(Math.floor(Date.now() / 1000 + (await clock.offset)));
}

export async function nearBalance(accountId: string): Promise<bigint> {
  const a = await rpc<{ amount: string }>("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
  return BigInt(a.amount);
}

export interface Signer { accountId: string; seed: Uint8Array; publicKey: Uint8Array }

/** `key` is a NEAR secret key: "ed25519:" + base58 of the 32-byte seed, optionally followed by the public key. */
export function signerFromKey(accountId: string, key: string): Signer {
  let bytes: Uint8Array;
  try { bytes = base58.decode(key.trim().replace(/^ed25519:/, "")); } catch { throw new NearError("That is not a NEAR ed25519 secret key."); }
  if (bytes.length !== 32 && bytes.length !== 64) throw new NearError("That is not a NEAR ed25519 secret key.");
  const seed = bytes.slice(0, 32);
  return { accountId: accountId.trim().toLowerCase(), seed, publicKey: ed25519.getPublicKey(seed) };
}

const accessKey = (s: Signer) => rpc<{ nonce: number; block_hash: string }>("query", { request_type: "view_access_key", finality: "optimistic", account_id: s.accountId, public_key: `ed25519:${base58.encode(s.publicKey)}` });

/** True when the key is an access key of the account, which is what makes it able to sign for it. */
export const canSign = (s: Signer) => accessKey(s).then(() => true, () => false);

export interface NearCall {
  contract: string;
  method: string;
  args: object;
  /** yoctoNEAR attached to the call. */
  deposit?: bigint;
  /** Tgas attached; unused gas is refunded. */
  gas?: number;
  /** "all": every receipt has run. "first": the call itself has run, its promises (a TEE run) are still out. */
  wait?: "all" | "first";
  /** A panic of one of these contracts anywhere in the transaction fails it, also where the chain reports success
      because the token refunded the sender. */
  watch?: string[];
}
export interface TxResult { hash: string; value: unknown }

// Borsh, little-endian.
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
const str = (s: string) => { const e = utf8(s); return cat(u32(e.length), e); };

/** Transaction { signer, ed25519 key, nonce, receiver, block hash, [FunctionCall] } followed by its ed25519 signature. */
export function signFunctionCall(s: Signer, call: NearCall, nonce: bigint, blockHash: string): Uint8Array {
  const args = utf8(JSON.stringify(call.args));
  const deposit = call.deposit ?? 0n;
  const tx = cat(
    str(s.accountId), Uint8Array.of(0), s.publicKey, u64(nonce), str(call.contract), base58.decode(blockHash),
    u32(1), Uint8Array.of(2), str(call.method), u32(args.length), args, u64(BigInt(call.gas ?? 100) * 10n ** 12n),
    u64(deposit & 0xffffffffffffffffn), u64(deposit >> 64n),
  );
  return cat(tx, Uint8Array.of(0), ed25519.sign(sha256(tx), s.seed));
}

type Status = { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
interface TxStatus {
  final_execution_status: string;
  status?: Status;
  transaction_outcome?: { outcome: { receipt_ids: string[] } };
  receipts_outcome?: { id: string; outcome: { executor_id: string; status: Status } }[];
}
const decode = (v?: string) => { if (!v) return undefined; try { return JSON.parse(new TextDecoder().decode(unb64(v))); } catch { return undefined; } };
function failure(f: unknown, hash: string): NearError {
  const text = JSON.stringify(f);
  const panic = /Smart contract panicked: ([^"\\]+)/.exec(text)?.[1];
  return new NearError(panic ?? (/NotEnoughBalance|LackBalance/.test(text) ? "Not enough NEAR in this account for the call." : text.slice(0, 300)), panic, hash);
}

/** An account the app can act for: `send` resolves only when the call (and, for "all", everything it started) succeeded. */
export interface Account { accountId: string; send: (call: NearCall, onHash?: (hash: string) => void) => Promise<TxResult> }

/** A demo account whose key this browser holds. */
export const keyAccount = (s: Signer): Account => ({
  accountId: s.accountId,
  send: async (call, onHash) => {
    const key = await accessKey(s).catch(() => { throw new NearError(`This key cannot sign for ${s.accountId}.`); });
    let hash: string;
    try {
      hash = await rpc<string>("broadcast_tx_async", [b64(signFunctionCall(s, call, BigInt(key.nonce) + 1n, key.block_hash))]);
    } catch (e) {
      throw /NotEnoughBalance|LackBalance/.test(String((e as Error).message)) ? new NearError("Not enough NEAR in this account for the call.") : e;
    }
    onHash?.(hash);
    return settle(hash, s.accountId, call);
  },
});

/** The subset of a NEAR Connect wallet this app uses. */
export interface ConnectedWallet {
  signAndSendTransaction(p: { signerId?: string; receiverId: string; actions: { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } }[] }): Promise<unknown>;
}

/** An account signed in through a wallet: the wallet signs and sends, this app then reads the outcome itself. */
export const walletAccount = (accountId: string, wallet: ConnectedWallet): Account => ({
  accountId,
  send: async (call, onHash) => {
    let outcome: { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | undefined;
    try {
      outcome = (await wallet.signAndSendTransaction({
        signerId: accountId, receiverId: call.contract,
        actions: [{ type: "FunctionCall", params: { methodName: call.method, args: call.args, gas: (BigInt(call.gas ?? 100) * 10n ** 12n).toString(), deposit: (call.deposit ?? 0n).toString() } }],
      })) as typeof outcome;
    } catch (e) {
      const text = e instanceof Error ? e.message : JSON.stringify(e);
      const panic = /Smart contract panicked: ([^"\\]+)/.exec(text)?.[1];
      throw new NearError(panic ?? (/reject|cancel|denied|closed/i.test(text) ? "You declined the request in your wallet. Nothing was sent." : text.slice(0, 300)), panic);
    }
    const hash = outcome?.transaction?.hash ?? outcome?.transaction_outcome?.id;
    if (!hash) throw new NearError("The wallet did not return a transaction. Check your wallet's activity before trying again.");
    onHash?.(hash);
    return settle(hash, accountId, call);
  },
});

/** Waits until the chain has run the transaction and checks every receipt of the watched contracts. */
async function settle(hash: string, signerId: string, call: NearCall): Promise<TxResult> {
  const watch = new Set([call.contract, ...(call.watch ?? [])]);
  for (const started = Date.now(); ; ) {
    await sleep(800);
    const late = Date.now() - started > 90_000;
    let t: TxStatus;
    try {
      t = await rpc<TxStatus>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signerId, wait_until: "NONE" });
    } catch (e) {
      if (late) throw e; // not known to this node yet
      continue;
    }
    if (t.status?.Failure) throw failure(t.status.Failure, hash);
    const firstId = t.transaction_outcome?.outcome.receipt_ids[0];
    const receipts = t.receipts_outcome ?? [];
    for (const r of receipts) if (r.outcome.status.Failure && (r.id === firstId || watch.has(r.outcome.executor_id))) throw failure(r.outcome.status.Failure, hash);
    const first = receipts.find((r) => r.id === firstId);
    if (call.wait === "first" ? first : ["EXECUTED_OPTIMISTIC", "EXECUTED", "FINAL"].includes(t.final_execution_status)) {
      forgetViews();
      return { hash, value: decode(call.wait === "first" ? first?.outcome.status.SuccessValue : t.status?.SuccessValue) };
    }
    if (late) throw new NearError("The transaction was sent but its result is taking too long. Check the explorer before trying again.", undefined, hash);
  }
}
