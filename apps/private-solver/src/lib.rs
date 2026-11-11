//! MaskBid protocol v1 for the private solver: a byte-for-byte port of
//! packages/protocol/src/{hash,envelope,solver}.ts (spec 15_PROTOCOL). Pure: no I/O, no
//! logging. Amounts never leave this module except as the single winning amount.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use num_bigint_dig::BigUint;
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use rsa::pkcs8::EncodePublicKey;
use rsa::{Oaep, RsaPrivateKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use zeroize::Zeroize;

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_BIDS: usize = 32;
pub const ENVELOPE_BYTES: usize = 490;
pub const PLAINTEXT_BYTES: usize = 201;
pub const ZERO_ADDRESS: &str = "0x0000000000000000000000000000000000000000";
/// Sealed record = version byte || 32-byte RSA seed. The same build regenerates the same key from the seed.
pub const SEALED_RECORD_VERSION: u8 = 1;

pub type H256 = [u8; 32];
pub type Addr = [u8; 20];

// ------------------------------------------------------------------ primitives

pub fn keccak(data: &[u8]) -> H256 {
    Keccak256::digest(data).into()
}
pub fn sha256(data: &[u8]) -> H256 {
    Sha256::digest(data).into()
}
pub fn type_hash(label: &str) -> H256 {
    keccak(label.as_bytes())
}
pub fn hex_lower(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
pub fn parse_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    hex::decode(s).ok()
}
pub fn parse_h256(s: &str) -> Option<H256> {
    parse_hex(s)?.try_into().ok()
}
pub fn parse_addr(s: &str) -> Option<Addr> {
    parse_hex(s)?.try_into().ok()
}
/// Canonical decimal uint256 string ("0" or digits without leading zero) -> 32-byte big-endian. Spec 15 §2.
pub fn parse_uint(s: &str) -> Option<H256> {
    let canonical = s == "0" || (!s.is_empty() && !s.starts_with('0') && s.bytes().all(|c| c.is_ascii_digit()));
    if !canonical {
        return None;
    }
    let v = BigUint::parse_bytes(s.as_bytes(), 10)?;
    if v.bits() > 256 {
        return None;
    }
    let b = v.to_bytes_be();
    let mut out = [0u8; 32];
    out[32 - b.len()..].copy_from_slice(&b);
    Some(out)
}
pub fn uint_to_string(b: &H256) -> String {
    BigUint::from_bytes_be(b).to_str_radix(10)
}
fn word_addr(a: &Addr) -> H256 {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}
fn word_u32(v: u32) -> H256 {
    let mut w = [0u8; 32];
    w[28..].copy_from_slice(&v.to_be_bytes());
    w
}

// ------------------------------------------------------------------ domain hashes (abi.encode, never encodePacked)

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Domain {
    pub chain_id: H256,
    pub auction_contract: Addr,
    pub auction_id: H256,
}

pub fn aad_hash(d: &Domain, bidder: &Addr, key_id: &H256) -> H256 {
    keccak(&[type_hash("MASKBID_AAD_V1"), d.chain_id, word_addr(&d.auction_contract), d.auction_id, word_addr(bidder), *key_id].concat())
}
pub fn bid_commitment(d: &Domain, bidder: &Addr, key_id: &H256, envelope: &[u8]) -> H256 {
    keccak(
        &[type_hash("MASKBID_BID_V1"), d.chain_id, word_addr(&d.auction_contract), d.auction_id, word_addr(bidder), *key_id, keccak(envelope)]
            .concat(),
    )
}
pub fn initial_digest(d: &Domain, key_id: &H256) -> H256 {
    keccak(&[type_hash("MASKBID_SET_V1"), d.chain_id, word_addr(&d.auction_contract), d.auction_id, *key_id].concat())
}
pub fn next_digest(previous: &H256, bid_index: u32, bidder: &Addr, commitment: &H256) -> H256 {
    keccak(&[*previous, word_u32(bid_index), word_addr(bidder), *commitment].concat())
}
pub fn request_id_hash(d: &Domain, bid_digest: &H256, bid_count: u32, attempt: u32, config_hash: &H256) -> H256 {
    keccak(
        &[
            type_hash("MASKBID_REQUEST_V1"),
            d.chain_id,
            word_addr(&d.auction_contract),
            d.auction_id,
            *bid_digest,
            word_u32(bid_count),
            word_u32(attempt),
            *config_hash,
        ]
        .concat(),
    )
}

// ------------------------------------------------------------------ keys

/// RSA-OAEP-2048 key from a 32-byte seed through a fixed CSPRNG stream: the same build always
/// regenerates the same key, so only the seed has to be sealed (the TEE callback payload is small).
pub fn rsa_from_seed(seed: &[u8; 32]) -> RsaPrivateKey {
    let mut rng = ChaCha20Rng::from_seed(*seed);
    RsaPrivateKey::new(&mut rng, 2048).expect("RSA keygen")
}
pub fn spki_der(key: &RsaPrivateKey) -> Vec<u8> {
    RsaPublicKey::from(key).to_public_key_der().expect("SPKI").as_bytes().to_vec()
}
/// keyId = SHA-256(SPKI DER).
pub fn key_id_of(spki: &[u8]) -> H256 {
    sha256(spki)
}
/// Host sealing AAD: canonical binary keyRequestId || owner20 || solverCodeHash || configHash (spec 15 §7).
pub fn sealing_aad(key_request_id: &H256, owner: &Addr, solver_code_hash: &H256, config_hash: &H256) -> Vec<u8> {
    [&key_request_id[..], &owner[..], &solver_code_hash[..], &config_hash[..]].concat()
}
pub fn seal_record(seed: &[u8; 32]) -> [u8; 33] {
    let mut r = [0u8; 33];
    r[0] = SEALED_RECORD_VERSION;
    r[1..].copy_from_slice(seed);
    r
}
pub fn open_record(record: &[u8]) -> Option<[u8; 32]> {
    if record.len() != 33 || record[0] != SEALED_RECORD_VERSION {
        return None;
    }
    record[1..].try_into().ok()
}

// ------------------------------------------------------------------ envelope (490 bytes) and plaintext (201 bytes)

pub struct Envelope<'a> {
    pub wrapped_key: &'a [u8],
    pub iv: &'a [u8],
    pub ciphertext_and_tag: &'a [u8],
}

pub fn parse_envelope(e: &[u8]) -> Option<Envelope<'_>> {
    if e.len() != ENVELOPE_BYTES || e[0] != 0x01 || e[1] != 0x01 || e[2] != 0x00 || e[271] != 0x00 || e[272] != 0xd9 {
        return None;
    }
    Some(Envelope { wrapped_key: &e[3..259], iv: &e[259..271], ciphertext_and_tag: &e[273..490] })
}

/// Unwrap, authenticate and domain-check one envelope. Any failure is `None` on purpose (no oracle).
/// Returns the amount only; the plaintext buffer is zeroised before return.
pub fn decrypt_bid(key: &RsaPrivateKey, envelope: &[u8], d: &Domain, bidder: &Addr, key_id: &H256) -> Option<H256> {
    let env = parse_envelope(envelope)?;
    let mut content_key = key.decrypt(Oaep::new::<Sha256>(), env.wrapped_key).ok()?;
    if content_key.len() != 32 {
        content_key.zeroize();
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(&content_key).ok();
    content_key.zeroize();
    let aad = aad_hash(d, bidder, key_id);
    let mut pt = cipher?.decrypt(Nonce::from_slice(env.iv), Payload { msg: env.ciphertext_and_tag, aad: &aad }).ok()?;
    let ok = pt.len() == PLAINTEXT_BYTES
        && pt[0] == PROTOCOL_VERSION as u8
        && pt[1..33] == d.chain_id
        && pt[33..53] == d.auction_contract
        && pt[53..85] == d.auction_id
        && pt[85..105] == *bidder
        && pt[137..169] == *key_id;
    let amount = if ok { pt[105..137].try_into().ok() } else { None };
    pt.zeroize();
    amount
}

// ------------------------------------------------------------------ request / manifest / result (JSON shapes of spec 15 §8-§10)

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementRequest {
    pub protocol_version: u64,
    pub chain_id: String,
    pub auction_contract: String,
    pub auction_id: String,
    pub request_id: String,
    pub attempt: u32,
    pub bid_digest: String,
    pub bid_count: u32,
    pub key_id: String,
    pub solver_code_hash: String,
    pub config_hash: String,
    pub reserve_units: String,
    pub end_time: String,
    pub settlement_deadline: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_request_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestBid {
    pub bid_index: String,
    pub bidder: String,
    pub commitment: String,
    pub envelope: String,
    pub tx_hash: String,
    pub block_hash: String,
    pub block_number: String,
    pub log_index: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub protocol_version: u64,
    pub chain_id: String,
    pub auction_contract: String,
    pub auction_id: String,
    pub request_id: String,
    pub key_id: String,
    pub bid_digest: String,
    pub bid_count: u32,
    pub bids: Vec<ManifestBid>,
}

/// Field order is the canonical serializer order (spec 15 §10); `serde_json::to_string` emits exactly it.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettlementResult {
    pub protocol_version: u64,
    pub chain_id: String,
    pub auction_contract: String,
    pub auction_id: String,
    pub request_id: String,
    pub attempt: u32,
    pub bid_digest: String,
    pub bid_count: u32,
    pub key_id: String,
    pub solver_code_hash: String,
    pub config_hash: String,
    pub outcome: String,
    pub winner: String,
    pub winning_amount_units: String,
    pub valid_bid_count: u32,
    pub invalid_bid_count: u32,
}

pub fn canonical_result(r: &SettlementResult) -> String {
    serde_json::to_string(r).expect("result json")
}

/// Fatal is never NO_SALE: the job must retry or time out.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Fatal {
    pub code: &'static str,
    pub request_id: String,
    pub retryable: bool,
    pub detail: String,
}

fn fatal(code: &'static str, request_id: &str, detail: impl Into<String>, retryable: bool) -> Fatal {
    Fatal { code, request_id: request_id.to_string(), retryable, detail: detail.into() }
}

pub fn domain_of(r: &SettlementRequest) -> Result<Domain, Fatal> {
    let bad = |what: &str| fatal("DOMAIN_MISMATCH", &r.request_id, format!("request {what} is not canonical"), false);
    Ok(Domain {
        chain_id: parse_uint(&r.chain_id).ok_or_else(|| bad("chainId"))?,
        auction_contract: parse_addr(&r.auction_contract).ok_or_else(|| bad("auctionContract"))?,
        auction_id: parse_uint(&r.auction_id).ok_or_else(|| bad("auctionId"))?,
    })
}

/// Steps 1-5 of spec 15 §9: everything structural, before any key material is touched.
pub fn validate_manifest(request: &SettlementRequest, manifest: &Manifest) -> Result<Domain, Fatal> {
    let rid = request.request_id.as_str();
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(fatal("DOMAIN_MISMATCH", rid, "protocol version", false));
    }
    let domain = domain_of(request)?;
    let lc = |s: &str| s.to_ascii_lowercase();
    if manifest.protocol_version != request.protocol_version
        || manifest.chain_id != request.chain_id
        || lc(&manifest.auction_contract) != lc(&request.auction_contract)
        || manifest.auction_id != request.auction_id
        || lc(&manifest.request_id) != lc(rid)
        || lc(&manifest.key_id) != lc(&request.key_id)
    {
        return Err(fatal("DOMAIN_MISMATCH", rid, "manifest header does not match request", true));
    }
    if request.bid_count as usize > MAX_BIDS || manifest.bid_count != request.bid_count || manifest.bids.len() != request.bid_count as usize {
        return Err(fatal(
            "MANIFEST_INCOMPLETE",
            rid,
            format!("expected {} bids, manifest has {}", request.bid_count, manifest.bids.len()),
            true,
        ));
    }
    let key_id = parse_h256(&request.key_id).ok_or_else(|| fatal("DOMAIN_MISMATCH", rid, "keyId", false))?;
    let bid_digest = parse_h256(&request.bid_digest).ok_or_else(|| fatal("DOMAIN_MISMATCH", rid, "bidDigest", false))?;
    let config_hash = parse_h256(&request.config_hash).ok_or_else(|| fatal("DOMAIN_MISMATCH", rid, "configHash", false))?;
    let expected = request_id_hash(&domain, &bid_digest, request.bid_count, request.attempt, &config_hash);
    if hex_lower(&expected) != lc(rid) {
        return Err(fatal("DOMAIN_MISMATCH", rid, "requestId does not bind digest/count/attempt/config", true));
    }

    let mut seen: Vec<Addr> = Vec::with_capacity(manifest.bids.len());
    let mut digest = initial_digest(&domain, &key_id);
    for (i, b) in manifest.bids.iter().enumerate() {
        if b.bid_index != i.to_string() {
            return Err(fatal("MANIFEST_INCOMPLETE", rid, format!("bid index gap at {i}"), true));
        }
        let bidder = parse_addr(&b.bidder).ok_or_else(|| fatal("MANIFEST_INCOMPLETE", rid, format!("bid {i} bidder"), true))?;
        if seen.contains(&bidder) {
            return Err(fatal("MANIFEST_INCOMPLETE", rid, "duplicate bidder", true));
        }
        seen.push(bidder);
        let envelope = parse_hex(&b.envelope).ok_or_else(|| fatal("COMMITMENT_MISMATCH", rid, format!("bid {i} envelope is not hex"), true))?;
        if envelope.len() != ENVELOPE_BYTES {
            return Err(fatal("COMMITMENT_MISMATCH", rid, format!("bid {i} envelope length"), true));
        }
        let commitment = bid_commitment(&domain, &bidder, &key_id, &envelope);
        if hex_lower(&commitment) != lc(&b.commitment) {
            return Err(fatal("COMMITMENT_MISMATCH", rid, format!("bid {i} commitment"), true));
        }
        digest = next_digest(&digest, i as u32, &bidder, &commitment);
    }
    if digest != bid_digest || lc(&manifest.bid_digest) != hex_lower(&digest) {
        return Err(fatal("MANIFEST_INCOMPLETE", rid, "ordered digest does not match request", true));
    }
    Ok(domain)
}

/// Steps 6-8. Malformed-but-present bids are invalid; missing data was already fatal above.
/// Largest amount wins; equal amounts keep the smallest bidIndex. O(n), one running maximum.
pub fn solve(request: &SettlementRequest, manifest: &Manifest, key: &RsaPrivateKey) -> Result<SettlementResult, Fatal> {
    let domain = validate_manifest(request, manifest)?;
    let rid = request.request_id.as_str();
    let key_id = parse_h256(&request.key_id).ok_or_else(|| fatal("DOMAIN_MISMATCH", rid, "keyId", false))?;
    let reserve = parse_uint(&request.reserve_units).ok_or_else(|| fatal("DOMAIN_MISMATCH", rid, "reserveUnits", false))?;
    let mut best: Option<(Addr, H256)> = None;
    let mut valid = 0u32;
    for b in &manifest.bids {
        let bidder = parse_addr(&b.bidder).expect("validated");
        let envelope = parse_hex(&b.envelope).expect("validated");
        let Some(amount) = decrypt_bid(key, &envelope, &domain, &bidder, &key_id) else { continue }; // malformed: invalid
        if amount < reserve {
            continue; // complete but below reserve: invalid
        }
        valid += 1;
        if best.as_ref().map_or(true, |(_, a)| amount > *a) {
            best = Some((bidder, amount));
        }
    }
    Ok(SettlementResult {
        protocol_version: request.protocol_version,
        chain_id: request.chain_id.clone(),
        auction_contract: request.auction_contract.clone(),
        auction_id: request.auction_id.clone(),
        request_id: request.request_id.clone(),
        attempt: request.attempt,
        bid_digest: request.bid_digest.clone(),
        bid_count: request.bid_count,
        key_id: request.key_id.clone(),
        solver_code_hash: request.solver_code_hash.clone(),
        config_hash: request.config_hash.clone(),
        outcome: if best.is_some() { "WINNER" } else { "NO_SALE" }.to_string(),
        winner: best.as_ref().map_or(ZERO_ADDRESS.to_string(), |(w, _)| hex_lower(w)),
        winning_amount_units: best.as_ref().map_or("0".to_string(), |(_, a)| uint_to_string(a)),
        valid_bid_count: valid,
        invalid_bid_count: manifest.bids.len() as u32 - valid,
    })
}
