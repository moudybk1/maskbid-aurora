// Plaintext (201 bytes) and hybrid envelope (490 bytes). Spec 15 §3-§4. Web Crypto only; no fallback.
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { aadHash, bidCommitment, keyIdFromSpki, type Domain } from "./hash.ts";

export const PROTOCOL_VERSION = 1;
export const PLAINTEXT_BYTES = 201;
export const ENVELOPE_BYTES = 490;
export const WRAPPED_KEY_BYTES = 256;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const CIPHERTEXT_AND_TAG_BYTES = PLAINTEXT_BYTES + TAG_BYTES; // 217

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export interface BidPlaintext extends Domain {
  bidder: Address;
  amountUnits: bigint;
  keyId: Hex;
  nonce: Uint8Array;
}

const u256 = (v: bigint): Uint8Array => hexToBytes(`0x${v.toString(16).padStart(64, "0")}`);
const be = (b: Uint8Array): bigint => BigInt(bytesToHex(b));
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

export function encodePlaintext(p: BidPlaintext): Uint8Array {
  if (p.nonce.length !== 32) throw new EnvelopeError("nonce must be 32 bytes");
  const out = concat(
    new Uint8Array([PROTOCOL_VERSION]),
    u256(p.chainId),
    hexToBytes(p.auctionContract),
    u256(p.auctionId),
    hexToBytes(p.bidder),
    u256(p.amountUnits),
    hexToBytes(p.keyId),
    p.nonce,
  );
  if (out.length !== PLAINTEXT_BYTES) throw new EnvelopeError("plaintext length");
  return out;
}

export function decodePlaintext(b: Uint8Array): BidPlaintext {
  if (b.length !== PLAINTEXT_BYTES) throw new EnvelopeError("plaintext must be 201 bytes");
  if (b[0] !== PROTOCOL_VERSION) throw new EnvelopeError("unsupported protocol version");
  return {
    chainId: be(b.subarray(1, 33)),
    auctionContract: bytesToHex(b.subarray(33, 53)) as Address,
    auctionId: be(b.subarray(53, 85)),
    bidder: bytesToHex(b.subarray(85, 105)) as Address,
    amountUnits: be(b.subarray(105, 137)),
    keyId: bytesToHex(b.subarray(137, 169)),
    nonce: b.slice(169, 201),
  };
}

export interface ParsedEnvelope {
  wrappedKey: Uint8Array;
  iv: Uint8Array;
  ciphertextAndTag: Uint8Array;
}

export function parseEnvelope(e: Uint8Array): ParsedEnvelope {
  if (e.length !== ENVELOPE_BYTES) throw new EnvelopeError("envelope must be 490 bytes");
  if (e[0] !== 0x01) throw new EnvelopeError("envelope version");
  if (e[1] !== 0x01 || e[2] !== 0x00) throw new EnvelopeError("wrapped key length header");
  if (e[271] !== 0x00 || e[272] !== 0xd9) throw new EnvelopeError("ciphertext length header");
  return { wrappedKey: e.subarray(3, 259), iv: e.subarray(259, 271), ciphertextAndTag: e.subarray(273, 490) };
}

const RSA = { name: "RSA-OAEP", hash: "SHA-256" } as const;
// TS 5.7 types Uint8Array<ArrayBufferLike>; Web Crypto wants BufferSource. Views are passed as-is at runtime.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;
const subtleOf = (s?: SubtleCrypto): SubtleCrypto => {
  const subtle = s ?? globalThis.crypto?.subtle;
  if (!subtle) throw new EnvelopeError("Web Crypto is not available; no bid was sent");
  return subtle;
};

export interface EncryptInput {
  spki: Uint8Array;
  domain: Domain;
  bidder: Address;
  amountUnits: bigint;
  /** Must equal the pinned key record; checked against SHA-256(spki) before encrypting. */
  expectedKeyId: Hex;
  subtle?: SubtleCrypto;
}

export interface EncryptedBid {
  envelope: Uint8Array;
  commitment: Hex;
  keyId: Hex;
}

/** Fresh content key, IV and nonce every call; the same amount never yields the same envelope. */
export async function encryptBid(input: EncryptInput): Promise<EncryptedBid> {
  const subtle = subtleOf(input.subtle);
  const keyId = keyIdFromSpki(input.spki);
  if (keyId !== input.expectedKeyId.toLowerCase()) throw new EnvelopeError("The auction encryption key could not be verified. No bid was sent.");
  if (input.amountUnits <= 0n) throw new EnvelopeError("amount must be positive");
  const publicKey = await subtle.importKey("spki", bs(input.spki), RSA, false, ["encrypt"]);

  const contentKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const plaintext = encodePlaintext({ ...input.domain, bidder: input.bidder, amountUnits: input.amountUnits, keyId, nonce });
  const aad = hexToBytes(aadHash(input.domain, input.bidder, keyId));

  const aesKey = await subtle.importKey("raw", bs(contentKey), { name: "AES-GCM" }, false, ["encrypt"]);
  const ctTag = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: bs(iv), additionalData: bs(aad), tagLength: 128 }, aesKey, bs(plaintext)));
  const wrapped = new Uint8Array(await subtle.encrypt(RSA, publicKey, bs(contentKey)));
  if (ctTag.length !== CIPHERTEXT_AND_TAG_BYTES || wrapped.length !== WRAPPED_KEY_BYTES) throw new EnvelopeError("unexpected cipher output size");

  const envelope = concat(new Uint8Array([0x01, 0x01, 0x00]), wrapped, iv, new Uint8Array([0x00, 0xd9]), ctTag);
  contentKey.fill(0);
  plaintext.fill(0);
  return { envelope, commitment: bidCommitment(input.domain, input.bidder, keyId, envelope), keyId };
}

export interface DecryptInput {
  pkcs8: Uint8Array;
  envelope: Uint8Array;
  domain: Domain;
  bidder: Address;
  keyId: Hex;
  subtle?: SubtleCrypto;
}

/** Throws EnvelopeError for any authentication, size or domain failure (generic on purpose). */
export async function decryptBid(input: DecryptInput): Promise<BidPlaintext> {
  const subtle = subtleOf(input.subtle);
  const parsed = parseEnvelope(input.envelope);
  const privateKey = await subtle.importKey("pkcs8", bs(input.pkcs8), RSA, false, ["decrypt"]);
  let plain: Uint8Array;
  try {
    const contentKey = new Uint8Array(await subtle.decrypt(RSA, privateKey, bs(parsed.wrappedKey)));
    const aesKey = await subtle.importKey("raw", bs(contentKey), { name: "AES-GCM" }, false, ["decrypt"]);
    const aad = hexToBytes(aadHash(input.domain, input.bidder, input.keyId));
    plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: bs(parsed.iv), additionalData: bs(aad), tagLength: 128 }, aesKey, bs(parsed.ciphertextAndTag)));
  } catch {
    throw new EnvelopeError("envelope authentication failed");
  }
  const p = decodePlaintext(plain);
  if (
    p.chainId !== input.domain.chainId ||
    p.auctionContract !== input.domain.auctionContract.toLowerCase() ||
    p.auctionId !== input.domain.auctionId ||
    p.bidder !== input.bidder.toLowerCase() ||
    p.keyId !== input.keyId.toLowerCase()
  ) {
    throw new EnvelopeError("plaintext domain mismatch");
  }
  return p;
}
