//! MaskBid on NEAR: sealed-bid first-price auctions with a fixed deposit, a pinned per-auction key, an ordered bid
//! digest and a settlement computed in a TEE.
//!
//! One contract holds the participant registry, the asset ledger (NEP-171 surface) and the auctions. A cross-contract
//! read on NEAR is asynchronous, so one state keeps every eligibility, asset and escrow check atomic. The payment
//! token is a separate NEP-141 contract: bids and the winner's payment arrive through `ft_transfer_call`.
//!
//! Compute runs the pinned solver wasm on OutLayer, called by this contract itself. The solver seals each auction
//! key to that exact build and to this account as caller, and its output comes back as the promise result of the
//! call, so no bridge account or relayer sits between a request and its result. Bid envelopes are kept in state and
//! the contract assembles the solver's manifest itself: nobody can hand the solver a different bid set.
//!
//! Errors are short names (`NotEligible`, `WrongState`, ...) so a client can map them to messages.

mod asset;
mod auction;
mod compute;
mod protocol;
mod registry;
#[cfg(test)]
mod tests;

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault};
use protocol::{addr, hash, type_hash, word, Addr, Domain, H256, ENVELOPE_BYTES, VERSION};

pub const MAX_BIDS: u32 = 32; // the solver refuses larger manifests
pub const SETTLEMENT_GRACE: u64 = 1800;
pub const ATTEMPT_TIMEOUT: u64 = 240;
pub const MAX_ATTEMPTS: u32 = 8; // OutLayer testnet often times out a run; a failed attempt can be retried at once

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AuctionState {
    Created,
    Active,
    Ended,
    PendingClaim,
    Finalized,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CancelReason {
    None,
    SellerCancelled,
    NoValidBid,
    WinnerDefault,
    SolverTimeout,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DepositStatus {
    Locked,
    Refunded,
    Consumed,
    Forfeited,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum KeyStatus {
    Requested,
    Ready,
    Consumed,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AssetStatus {
    Pending,
    Verified,
    Rejected,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Participant {
    pub uniqueness_id: H256,
    pub verified_until: u64,
    pub assurance: u8,
    pub revoked: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Asset {
    pub issuer: AccountId,
    pub metadata_uri: String,
    pub metadata_hash: H256,
    pub status: AssetStatus,
    pub reviewer: Option<AccountId>,
    pub review_digest: H256,
    /// `None` before the mint and after redemption; this contract's own account while the unit is in escrow.
    pub owner: Option<AccountId>,
    pub redeemed: bool,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Auction {
    pub token_id: String,
    pub seller: AccountId,
    pub reserve_units: u128,
    pub deposit_units: u128,
    pub start_time: u64,
    pub end_time: u64,
    pub state: AuctionState,
    pub key_id: H256,
    pub bid_count: u32,
    pub bid_digest: H256,
    pub settlement_deadline: u64,
    pub active_request_id: H256,
    pub active_attempt: u32,
    pub attempt_started_at: u64,
    /// The active attempt came back without an acceptable result: a retry need not wait for the timeout.
    pub attempt_failed: bool,
    pub winner: Option<AccountId>,
    pub winning_amount_units: u128,
    pub claim_deadline: u64,
    pub cancel_reason: CancelReason,
    pub returned_asset_claimed: bool,
    pub output_hash: Option<H256>,
    pub last_error: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Bid {
    pub bidder: AccountId,
    pub identity_id: H256,
    pub commitment: H256,
    pub envelope: Vec<u8>,
    pub deposit_status: DepositStatus,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct KeyRecord {
    pub owner: AccountId,
    pub key_id: H256,
    pub spki: Vec<u8>,
    pub sealed_blob: Vec<u8>,
    pub status: KeyStatus,
    pub dispatched_at: u64,
    pub last_error: Option<String>,
}

// ponytail: storage is paid from this contract's NEAR balance (about 0.007 NEAR per bid). Every writing entry point
// is gated by the personhood registry; charge a storage deposit per call if that ever stops being enough.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MaskBid {
    admin: AccountId,
    registrar: AccountId,
    verifier: AccountId,
    token: AccountId,
    outlayer: AccountId,
    wasm_url: String,
    solver_code_hash: H256,
    chain_id: u64,
    config_hash: H256,
    profile: String,
    allow_simulator: bool,
    min_duration: u64,
    max_duration: u64,
    claim_window: u64,
    execution_deposit: NearToken,

    entry_paused: bool,
    auction_count: u64,
    next_token_id: u64,
    total_locked_deposits: u128,
    total_credits: u128,

    participants: LookupMap<AccountId, Participant>,
    account_of_uniqueness: LookupMap<H256, AccountId>,
    assets: LookupMap<String, Asset>,
    auctions: LookupMap<u64, Auction>,
    bids: LookupMap<(u64, u32), Bid>,
    /// (auction, protocol address of the bidder) -> bid index. Also rejects two accounts sharing an address. The
    /// registry binds one account to one identity for good, so one bid per account is one bid per person.
    bid_index: LookupMap<(u64, Addr), u32>,
    keys: LookupMap<H256, KeyRecord>,
    key_request_of_key_id: LookupMap<H256, H256>,
    key_nonce: LookupMap<AccountId, u64>,
    /// Token units owed to an account: forfeited deposits and any payout whose `ft_transfer` failed.
    credits: LookupMap<AccountId, u128>,
}

pub(crate) fn now() -> u64 {
    env::block_timestamp_ms() / 1000
}
pub(crate) fn h256(s: &str) -> H256 {
    hex::decode(s.trim_start_matches("0x")).ok().and_then(|v| v.try_into().ok()).unwrap_or_else(|| env::panic_str("InvalidHex32"))
}
pub(crate) fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
/// NEP-297 event. `data` keys are camelCase, like the views.
pub(crate) fn emit(event: &str, data: Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "maskbid", "version": "1.0.0", "event": event, "data": [data] })));
}

#[near]
impl MaskBid {
    /// `wasm_hash` is the SHA-256 of the solver component: the hash OutLayer checks before running it and the
    /// `solverCodeHash` every key and result is bound to. `profile` is `demo` (minutes) or `normal` (hours and days).
    /// `execution_deposit` is the NEAR each OutLayer run costs; the caller of a key or settlement request attaches it.
    /// Callable only by the account itself: deploy and initialise in one transaction.
    #[init]
    #[private]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        admin: AccountId,
        registrar: AccountId,
        verifier: AccountId,
        token: AccountId,
        outlayer: AccountId,
        wasm_url: String,
        wasm_hash: String,
        chain_id: u64,
        profile: String,
        allow_simulator: bool,
        execution_deposit: U128,
    ) -> Self {
        require!(wasm_url.starts_with("https://"), "wasm_url must be https");
        let (min_duration, max_duration, claim_window) = match profile.as_str() {
            "demo" => (180, 86_400, 300),
            "normal" => (3600, 604_800, 172_800),
            _ => env::panic_str("profile must be demo or normal"),
        };
        let solver_code_hash = h256(&wasm_hash);
        let id = |a: &AccountId| env::keccak256_array(a.as_bytes());
        let config_hash = hash(&[
            type_hash("MASKBID_CONFIG_V1"),
            word(chain_id as u128),
            id(&env::current_account_id()),
            id(&token),
            id(&outlayer),
            solver_code_hash,
            word(VERSION),
            word(MAX_BIDS as u128),
            word(min_duration as u128),
            word(max_duration as u128),
            word(claim_window as u128),
            word(SETTLEMENT_GRACE as u128),
            word(ATTEMPT_TIMEOUT as u128),
            word(MAX_ATTEMPTS as u128),
            word(ENVELOPE_BYTES as u128),
        ]);
        Self {
            admin,
            registrar,
            verifier,
            token,
            outlayer,
            wasm_url,
            solver_code_hash,
            chain_id,
            config_hash,
            profile,
            allow_simulator,
            min_duration,
            max_duration,
            claim_window,
            execution_deposit: NearToken::from_yoctonear(execution_deposit.0),
            entry_paused: false,
            auction_count: 0,
            next_token_id: 1,
            total_locked_deposits: 0,
            total_credits: 0,
            participants: LookupMap::new(b"p"),
            account_of_uniqueness: LookupMap::new(b"u"),
            assets: LookupMap::new(b"a"),
            auctions: LookupMap::new(b"x"),
            bids: LookupMap::new(b"b"),
            bid_index: LookupMap::new(b"i"),
            keys: LookupMap::new(b"k"),
            key_request_of_key_id: LookupMap::new(b"q"),
            key_nonce: LookupMap::new(b"n"),
            credits: LookupMap::new(b"c"),
        }
    }

    pub fn set_entry_paused(&mut self, paused: bool) {
        self.only(&self.admin);
        self.entry_paused = paused;
        emit("entry_pause_set", json!({ "paused": paused }));
    }

    /// Where OutLayer downloads the pinned module from. The URL is transport only: the worker refuses bytes whose
    /// SHA-256 differs from the immutable `solverCodeHash`.
    pub fn set_wasm_url(&mut self, wasm_url: String) {
        self.only(&self.admin);
        require!(wasm_url.starts_with("https://"), "wasm_url must be https");
        emit("wasm_url_set", json!({ "wasmUrl": wasm_url }));
        self.wasm_url = wasm_url;
    }

    pub fn get_config(&self) -> Value {
        json!({
            "contract": env::current_account_id(), "contractAddress": hex0x(&self.domain().contract), "chainId": self.chain_id,
            "admin": self.admin, "registrar": self.registrar, "verifier": self.verifier, "token": self.token,
            "outlayer": self.outlayer, "wasmUrl": self.wasm_url, "solverCodeHash": hex0x(&self.solver_code_hash),
            "configHash": hex0x(&self.config_hash), "profile": self.profile, "allowSimulator": self.allow_simulator,
            "protocolVersion": VERSION as u64, "maxBids": MAX_BIDS, "minDurationSeconds": self.min_duration,
            "maxDurationSeconds": self.max_duration, "claimWindowSeconds": self.claim_window,
            "settlementGraceSeconds": SETTLEMENT_GRACE, "attemptTimeoutSeconds": ATTEMPT_TIMEOUT, "maxAttempts": MAX_ATTEMPTS,
            "envelopeBytes": ENVELOPE_BYTES, "executionDeposit": U128(self.execution_deposit.as_yoctonear()),
            "entryPaused": self.entry_paused, "auctionCount": self.auction_count, "nextTokenId": self.next_token_id.to_string(),
            "totalLockedDeposits": U128(self.total_locked_deposits), "totalCredits": U128(self.total_credits),
        })
    }

    /// The 20-byte address an account has inside bid envelopes, commitments and solver results.
    pub fn address_of(&self, account: AccountId) -> String {
        hex0x(&addr(account.as_str()))
    }

}

impl MaskBid {
    pub(crate) fn only(&self, role: &AccountId) {
        require!(&env::predecessor_account_id() == role, "Unauthorized");
    }

    pub(crate) fn domain(&self) -> Domain {
        Domain { chain_id: self.chain_id, contract: addr(env::current_account_id().as_str()) }
    }
}
