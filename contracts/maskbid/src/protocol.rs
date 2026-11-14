//! MaskBid protocol v1 hashes (spec 15): the same 32-byte words the TEE solver and `@maskbid/protocol` hash, so
//! neither of them changes. A NEAR account fills the protocol's 20-byte address slot as the last 20 bytes of
//! keccak256(account id); `chain_id` is the deployment's domain number (398 NEAR testnet, 397 mainnet).
use near_sdk::env;

pub const VERSION: u128 = 1;
pub const ENVELOPE_BYTES: usize = 490;

pub type H256 = [u8; 32];
pub type Addr = [u8; 20];

pub struct Domain {
    pub chain_id: u64,
    pub contract: Addr,
}

pub fn addr(account: &str) -> Addr {
    env::keccak256_array(account.as_bytes())[12..].try_into().unwrap()
}
pub fn type_hash(label: &str) -> H256 {
    env::keccak256_array(label.as_bytes())
}
pub fn word(v: u128) -> H256 {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}
fn word_addr(a: &Addr) -> H256 {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}
pub fn hash(words: &[H256]) -> H256 {
    env::keccak256_array(words.concat())
}

pub fn bid_hash(d: &Domain, auction_id: u64, bidder: &Addr, key_id: &H256, envelope: &[u8]) -> H256 {
    hash(&[
        type_hash("MASKBID_BID_V1"),
        word(d.chain_id as u128),
        word_addr(&d.contract),
        word(auction_id as u128),
        word_addr(bidder),
        *key_id,
        env::keccak256_array(envelope),
    ])
}

pub fn initial_digest(d: &Domain, auction_id: u64, key_id: &H256) -> H256 {
    hash(&[type_hash("MASKBID_SET_V1"), word(d.chain_id as u128), word_addr(&d.contract), word(auction_id as u128), *key_id])
}

pub fn next_digest(previous: &H256, bid_index: u32, bidder: &Addr, commitment: &H256) -> H256 {
    hash(&[*previous, word(bid_index as u128), word_addr(bidder), *commitment])
}

pub fn request_id(d: &Domain, auction_id: u64, bid_digest: &H256, bid_count: u32, attempt: u32, config_hash: &H256) -> H256 {
    hash(&[
        type_hash("MASKBID_REQUEST_V1"),
        word(d.chain_id as u128),
        word_addr(&d.contract),
        word(auction_id as u128),
        *bid_digest,
        word(bid_count as u128),
        word(attempt as u128),
        *config_hash,
    ])
}

pub fn key_request_id(d: &Domain, owner: &Addr, nonce: u64, client_salt: &H256, config_hash: &H256) -> H256 {
    hash(&[
        type_hash("MASKBID_KEY_REQUEST_V1"),
        word(d.chain_id as u128),
        word_addr(&d.contract),
        word_addr(owner),
        word(nonce as u128),
        *client_salt,
        *config_hash,
    ])
}

/// Envelope header: version 0x01, wrappedKeyLength 256, ciphertextAndTagLength 217. The crypto is checked by the solver.
pub fn envelope_header_valid(e: &[u8]) -> bool {
    e.len() == ENVELOPE_BYTES && e[0] == 0x01 && e[1] == 0x01 && e[2] == 0x00 && e[271] == 0x00 && e[272] == 0xd9
}
