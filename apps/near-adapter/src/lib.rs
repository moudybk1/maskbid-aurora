//! MaskBid NEAR adapter (blueprint 04 §3/§5/§7, 15 §7/§11, gates G-01..G-04).
//!
//! * Requests are accepted only from the pinned Aurora XCC router account `<hex(auction)>.aurora`,
//!   i.e. only the auction contract can ask for a key or a solve (G-01).
//! * Compute runs the pinned solver wasm (direct `WasmUrl` + SHA-256) on OutLayer. The guest seals the
//!   per-auction RSA seed with a host key bound to that exact build and to this account as predecessor;
//!   the adapter stores the sealed blob, the SPKI and the keyId (G-02).
//! * Results are checked against the trusted request snapshot and delivered to Aurora through the
//!   engine `call` method, whose EVM sender is `implicit(this account id)` = the auction's `callbackSender` (G-04).
//! * The operator can only trigger compute (submit the public manifest) and fund the account; it cannot
//!   forge keys or results, since those come out of the TEE and are hash-bound.
use base64::Engine;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, log, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult};

const EXECUTION_GAS: Gas = Gas::from_tgas(100);
const KEY_CALLBACK_GAS: Gas = Gas::from_tgas(75); // on_key + AURORA_CALL_GAS + AURORA_RESULT_GAS must fit the 200 Tgas the XCC attaches
const SOLVE_CALLBACK_GAS: Gas = Gas::from_tgas(90);
const AURORA_CALL_GAS: Gas = Gas::from_tgas(60);
const AURORA_RESULT_GAS: Gas = Gas::from_tgas(5);
/// bytes4(keccak("onKeyPrepared((bytes32,address,bytes32,bytes,bytes32,bytes32,bytes32))"))
const ON_KEY_PREPARED: [u8; 4] = [0xe9, 0x40, 0x50, 0xbb];
/// bytes4(keccak("onSettlementResult((uint256,uint256,address,uint256,bytes32,uint32,bytes32,uint32,bytes32,bytes32,bytes32,uint8,address,uint256,uint32,uint32,bytes32,bytes32))"))
const ON_SETTLEMENT_RESULT: [u8; 4] = [0xa2, 0xab, 0x24, 0x88];
const MAX_MANIFEST_BYTES: usize = 128 * 1024;
const REDISPATCH_AFTER_MS: u64 = 5 * 60 * 1000;
// ponytail: fixed resource limits; RSA-2048 keygen inside wasm dominates. Unused budget is refunded by OutLayer.
const INIT_KEY_INSTRUCTIONS: u64 = 200_000_000_000;
const SOLVE_INSTRUCTIONS: u64 = 300_000_000_000;
const MAX_EXECUTION_SECONDS: u64 = 150;
const MAX_MEMORY_MB: u32 = 256;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum KeyStatus {
    Requested,
    Dispatched,
    Ready,
    Failed,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct KeyRecord {
    pub owner: [u8; 20],
    pub status: KeyStatus,
    pub key_id: [u8; 32],
    pub spki: Vec<u8>,
    pub sealed_blob: Vec<u8>,
    pub dispatched_at_ms: u64,
    pub delivered_to_aurora: bool,
    pub last_error: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum SolveStatus {
    Requested,
    Dispatched,
    Fatal,
    Delivered,
    DeliveryFailed,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct SolveRequest {
    // ponytail: u128 ceiling for auctionId/amounts (uint256 on Aurora); mUSDC supply is far below. Widen if a token needs it.
    pub auction_id: u128,
    pub attempt: u32,
    pub bid_digest: [u8; 32],
    pub bid_count: u32,
    pub key_id: [u8; 32],
    pub key_request_id: [u8; 32],
    pub reserve_units: u128,
    pub end_time: u64,
    pub settlement_deadline: u64,
    pub status: SolveStatus,
    pub dispatched_at_ms: u64,
    pub manifest_sha256: Option<[u8; 32]>,
    pub output_sha256: Option<[u8; 32]>,
    pub result: Option<String>,
    pub last_error: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Adapter {
    operator: AccountId,
    aurora: AccountId,
    auction: [u8; 20],
    xcc_predecessor: AccountId,
    outlayer: AccountId,
    wasm_url: String,
    /// 64 lowercase hex, no 0x: the WasmUrl hash and the auction's solverCodeHash.
    wasm_hash: String,
    chain_id: u64,
    config_hash: [u8; 32],
    execution_deposit: NearToken,
    keys: LookupMap<[u8; 32], KeyRecord>,
    requests: LookupMap<[u8; 32], SolveRequest>,
}

// ---------------------------------------------------------------- pure helpers

pub fn parse_h256(s: &str) -> [u8; 32] {
    hex::decode(s.trim_start_matches("0x"))
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| env::panic_str("expected 32-byte hex"))
}
pub fn parse_addr(s: &str) -> [u8; 20] {
    hex::decode(s.trim_start_matches("0x"))
        .ok()
        .and_then(|v| v.try_into().ok())
        .unwrap_or_else(|| env::panic_str("expected 20-byte hex address"))
}
pub fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}
pub fn parse_u128(s: &str) -> u128 {
    s.parse().unwrap_or_else(|_| env::panic_str("expected decimal uint"))
}
/// Aurora EVM sender of a NEAR account calling the engine: last 20 bytes of keccak256(accountId).
pub fn implicit_address(account: &str) -> [u8; 20] {
    env::keccak256_array(account.as_bytes())[12..].try_into().unwrap()
}
/// NEAR sub-account the XCC precompile creates for an Aurora address: `<hex(address)>.<engine>`.
pub fn xcc_router_account(address: &[u8; 20], engine: &AccountId) -> AccountId {
    format!("{}.{}", hex::encode(address), engine).parse().unwrap_or_else(|_| env::panic_str("router account id"))
}
fn word_u(v: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&v.to_be_bytes());
    w
}
fn word_addr(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}
/// ABI calldata for `onKeyPrepared(KeyResult)`: one dynamic tuple (offset 0x20), `bytes publicKeySpki` in the tail.
pub fn encode_key_result(
    key_request_id: &[u8; 32],
    owner: &[u8; 20],
    key_id: &[u8; 32],
    spki: &[u8],
    sealed_blob_hash: &[u8; 32],
    solver_code_hash: &[u8; 32],
    config_hash: &[u8; 32],
) -> Vec<u8> {
    let mut out = ON_KEY_PREPARED.to_vec();
    out.extend(word_u(0x20));
    out.extend(key_request_id);
    out.extend(word_addr(owner));
    out.extend(key_id);
    out.extend(word_u(7 * 32)); // offset of spki within the tuple
    out.extend(sealed_blob_hash);
    out.extend(solver_code_hash);
    out.extend(config_hash);
    out.extend(word_u(spki.len() as u128));
    out.extend(spki);
    out.extend(vec![0u8; (32 - spki.len() % 32) % 32]);
    out
}
pub struct ResultFields {
    pub chain_id: u64,
    pub auction: [u8; 20],
    pub auction_id: u128,
    pub request_id: [u8; 32],
    pub attempt: u32,
    pub bid_digest: [u8; 32],
    pub bid_count: u32,
    pub key_id: [u8; 32],
    pub solver_code_hash: [u8; 32],
    pub config_hash: [u8; 32],
    pub outcome: u8,
    pub winner: [u8; 20],
    pub winning_amount: u128,
    pub valid: u32,
    pub invalid: u32,
    pub execution_id_hash: [u8; 32],
    pub output_hash: [u8; 32],
}
/// ABI calldata for `onSettlementResult(SettlementResult)`: a static tuple, 18 words.
pub fn encode_settlement_result(r: &ResultFields) -> Vec<u8> {
    let mut out = ON_SETTLEMENT_RESULT.to_vec();
    for w in [
        word_u(1),
        word_u(r.chain_id as u128),
        word_addr(&r.auction),
        word_u(r.auction_id),
        r.request_id,
        word_u(r.attempt as u128),
        r.bid_digest,
        word_u(r.bid_count as u128),
        r.key_id,
        r.solver_code_hash,
        r.config_hash,
        word_u(r.outcome as u128),
        word_addr(&r.winner),
        word_u(r.winning_amount),
        word_u(r.valid as u128),
        word_u(r.invalid as u128),
        r.execution_id_hash,
        r.output_hash,
    ] {
        out.extend(w);
    }
    out
}
/// Borsh `CallArgs::V2 { contract, value: 0, input }` for the Aurora engine `call` method.
pub fn aurora_call_args(contract: &[u8; 20], input: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8]; // enum variant V2
    out.extend(contract);
    out.extend([0u8; 32]);
    out.extend((input.len() as u32).to_le_bytes());
    out.extend(input);
    out
}
/// Reads the engine `SubmitResult` (borsh: version u8, status variant u8, ...). Variant 0 = Succeed.
pub fn aurora_status(result: &PromiseResult) -> Result<(), String> {
    match result {
        PromiseResult::Failed => Err("aurora call receipt failed".into()),
        PromiseResult::Successful(b) if b.len() >= 2 && b[1] == 0 => Ok(()),
        PromiseResult::Successful(b) if b.len() >= 6 && b[1] == 1 => {
            let len = u32::from_le_bytes([b[2], b[3], b[4], b[5]]) as usize;
            Err(format!("aurora revert 0x{}", hex::encode(&b[6..b.len().min(6 + len.min(4))])))
        }
        PromiseResult::Successful(b) => Err(format!("aurora status variant {}", b.get(1).copied().unwrap_or(255))),
    }
}
fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}
/// First bytes of a raw OutLayer output for the error record (a failed run returns `null` or an error object, never key material).
fn snippet(output: &[u8]) -> String {
    String::from_utf8_lossy(&output[..output.len().min(300)]).into_owned()
}

#[near]
impl Adapter {
    /// `auction` is the Aurora auction contract address; `wasm_hash` the SHA-256 of the solver component
    /// (also its `solverCodeHash`); `config_hash` the auction's `configHash`. Initialise in the deploy transaction.
    #[init]
    pub fn new(
        operator: AccountId,
        aurora: AccountId,
        auction: String,
        outlayer: AccountId,
        wasm_url: String,
        wasm_hash: String,
        chain_id: u64,
        config_hash: String,
        execution_deposit: U128,
    ) -> Self {
        let auction = parse_addr(&auction);
        let wasm_hash = wasm_hash.trim_start_matches("0x").to_ascii_lowercase();
        require!(wasm_hash.len() == 64 && hex::decode(&wasm_hash).is_ok(), "wasm_hash must be 32-byte hex");
        require!(wasm_url.starts_with("https://"), "wasm_url must be https");
        Self {
            operator,
            xcc_predecessor: xcc_router_account(&auction, &aurora),
            aurora,
            auction,
            outlayer,
            wasm_url,
            wasm_hash,
            chain_id,
            config_hash: parse_h256(&config_hash),
            execution_deposit: NearToken::from_yoctonear(execution_deposit.0),
            keys: LookupMap::new(b"k"),
            requests: LookupMap::new(b"r"),
        }
    }

    // ------------------------------------------------------------ views

    pub fn get_config(&self) -> Value {
        json!({
            "operator": self.operator, "aurora": self.aurora, "auction": hex0x(&self.auction),
            "xccPredecessor": self.xcc_predecessor, "outlayer": self.outlayer, "wasmUrl": self.wasm_url,
            "solverCodeHash": format!("0x{}", self.wasm_hash), "chainId": self.chain_id, "configHash": hex0x(&self.config_hash),
            "executionDeposit": self.execution_deposit.as_yoctonear().to_string(),
            "callbackSender": hex0x(&implicit_address(env::current_account_id().as_str())),
        })
    }

    pub fn get_key(&self, key_request_id: String) -> Option<Value> {
        self.keys.get(&parse_h256(&key_request_id)).map(|k| {
            json!({
                "owner": hex0x(&k.owner), "status": k.status, "keyId": hex0x(&k.key_id), "spki": b64(&k.spki),
                "sealedBlob": b64(&k.sealed_blob), "sealedBlobHash": hex0x(&env::sha256_array(&k.sealed_blob)),
                "dispatchedAtMs": k.dispatched_at_ms, "deliveredToAurora": k.delivered_to_aurora, "lastError": k.last_error,
            })
        })
    }

    pub fn get_request(&self, request_id: String) -> Option<Value> {
        self.requests.get(&parse_h256(&request_id)).map(|r| {
            json!({
                "auctionId": r.auction_id.to_string(), "attempt": r.attempt, "bidDigest": hex0x(&r.bid_digest), "bidCount": r.bid_count,
                "keyId": hex0x(&r.key_id), "keyRequestId": hex0x(&r.key_request_id), "reserveUnits": r.reserve_units.to_string(),
                "endTime": r.end_time, "settlementDeadline": r.settlement_deadline, "status": r.status, "dispatchedAtMs": r.dispatched_at_ms,
                "manifestSha256": r.manifest_sha256.map(|h| hex0x(&h)), "outputSha256": r.output_sha256.map(|h| hex0x(&h)),
                "result": r.result.as_deref().and_then(|s| serde_json::from_str::<Value>(s).ok()), "lastError": r.last_error,
            })
        })
    }

    // ------------------------------------------------------------ Aurora -> NEAR (XCC only)

    /// INIT_KEY. Args arrive as the JSON the auction contract builds in `prepareAuctionKey`.
    pub fn request_key(&mut self, key_request_id: String, owner: String, config_hash: String, solver_code_hash: String) -> Promise {
        self.assert_xcc();
        self.assert_bindings(&config_hash, &solver_code_hash);
        let krid = parse_h256(&key_request_id);
        require!(!self.keys.contains_key(&krid), "duplicate key request");
        self.keys.insert(
            krid,
            KeyRecord {
                owner: parse_addr(&owner),
                status: KeyStatus::Requested,
                key_id: [0; 32],
                spki: vec![],
                sealed_blob: vec![],
                dispatched_at_ms: 0,
                delivered_to_aurora: false,
                last_error: None,
            },
        );
        log!("KEY_REQUESTED {} owner={}", key_request_id, owner);
        self.dispatch_key(krid)
    }

    /// Operator retry for a key whose OutLayer run or Aurora delivery failed. Cannot change bindings.
    pub fn redispatch_key(&mut self, key_request_id: String) -> Promise {
        self.assert_operator();
        let krid = parse_h256(&key_request_id);
        let k = self.keys.get(&krid).unwrap_or_else(|| env::panic_str("unknown key request"));
        require!(k.status != KeyStatus::Ready, "key already ready");
        require!(k.dispatched_at_ms + REDISPATCH_AFTER_MS <= env::block_timestamp_ms(), "dispatch pending");
        self.dispatch_key(krid)
    }

    /// SOLVE request snapshot (trusted values: digest, count, attempt, key, reserve, times). Compute is
    /// triggered separately by `submit_manifest`, which supplies the public manifest.
    #[allow(clippy::too_many_arguments)]
    pub fn request_solve(
        &mut self,
        request_id: String,
        auction_id: String,
        attempt: u32,
        bid_digest: String,
        bid_count: u32,
        key_id: String,
        key_request_id: String,
        reserve_units: String,
        end_time: u64,
        settlement_deadline: u64,
        config_hash: String,
        solver_code_hash: String,
    ) {
        self.assert_xcc();
        self.assert_bindings(&config_hash, &solver_code_hash);
        let rid = parse_h256(&request_id);
        let krid = parse_h256(&key_request_id);
        let kid = parse_h256(&key_id);
        let key = self.keys.get(&krid).unwrap_or_else(|| env::panic_str("unknown key request"));
        require!(key.status == KeyStatus::Ready && key.key_id == kid, "key is not ready for this keyId");
        require!(bid_count <= 32 && (1..=3).contains(&attempt), "bidCount/attempt out of range");
        // Defense in depth (spec 04 §7): Aurora already refuses early requests; NEAR time must agree.
        require!(env::block_timestamp_ms() / 1000 >= end_time, "auction has not ended");
        require!(!self.requests.contains_key(&rid), "duplicate request");
        self.requests.insert(
            rid,
            SolveRequest {
                auction_id: parse_u128(&auction_id),
                attempt,
                bid_digest: parse_h256(&bid_digest),
                bid_count,
                key_id: kid,
                key_request_id: krid,
                reserve_units: parse_u128(&reserve_units),
                end_time,
                settlement_deadline,
                status: SolveStatus::Requested,
                dispatched_at_ms: 0,
                manifest_sha256: None,
                output_sha256: None,
                result: None,
                last_error: None,
            },
        );
        log!("SOLVE_REQUESTED {} auction={} attempt={} count={}", request_id, auction_id, attempt, bid_count);
    }

    // ------------------------------------------------------------ operator trigger

    /// Where OutLayer downloads the pinned module from. The URL is transport only: the worker refuses bytes whose
    /// SHA-256 differs from `wasm_hash`, which is immutable here.
    pub fn set_wasm_url(&mut self, wasm_url: String) {
        self.assert_operator();
        require!(wasm_url.starts_with("https://"), "wasm_url must be https");
        log!("WASM_URL_SET {}", wasm_url);
        self.wasm_url = wasm_url;
    }

    /// Runs SOLVE for a recorded request with the public manifest (rebuilt from `BidPlaced` logs). The
    /// manifest is untrusted input: the solver recomputes every commitment and the ordered digest against
    /// the snapshot above, so a wrong or incomplete manifest can only produce a fatal, never a winner.
    pub fn submit_manifest(&mut self, request_id: String, manifest: String) -> Promise {
        self.assert_operator();
        require!(manifest.len() <= MAX_MANIFEST_BYTES, "manifest over 128 KiB");
        let rid = parse_h256(&request_id);
        let now = env::block_timestamp_ms();
        let r = self.requests.get(&rid).unwrap_or_else(|| env::panic_str("unknown request")).clone();
        require!(r.status != SolveStatus::Delivered, "already delivered");
        require!(r.status != SolveStatus::Dispatched || r.dispatched_at_ms + REDISPATCH_AFTER_MS <= now, "dispatch pending");
        require!(now / 1000 < r.settlement_deadline, "settlement deadline passed");
        let m: Value = serde_json::from_str(&manifest).unwrap_or_else(|_| env::panic_str("manifest is not JSON"));
        require!(m["requestId"].as_str().map_or(false, |s| s.eq_ignore_ascii_case(&hex0x(&rid))), "manifest requestId");
        require!(
            m["bidCount"].as_u64() == Some(r.bid_count as u64) && m["bids"].as_array().map(|a| a.len()) == Some(r.bid_count as usize),
            "manifest bidCount"
        );
        let key = self.keys.get(&r.key_request_id).unwrap_or_else(|| env::panic_str("key record"));
        let manifest_sha = env::sha256_array(manifest.as_bytes());
        let request = json!({
            "protocolVersion": 1, "chainId": self.chain_id.to_string(), "auctionContract": hex0x(&self.auction),
            "auctionId": r.auction_id.to_string(), "requestId": hex0x(&rid), "attempt": r.attempt, "bidDigest": hex0x(&r.bid_digest),
            "bidCount": r.bid_count, "keyId": hex0x(&r.key_id), "solverCodeHash": format!("0x{}", self.wasm_hash),
            "configHash": hex0x(&self.config_hash), "reserveUnits": r.reserve_units.to_string(), "endTime": r.end_time.to_string(),
            "settlementDeadline": r.settlement_deadline.to_string(), "manifestSha256": hex0x(&manifest_sha), "keyRequestId": hex0x(&r.key_request_id),
        });
        let input = json!({
            "mode": "SOLVE", "keyRequestId": hex0x(&r.key_request_id), "owner": hex0x(&key.owner),
            "sealedBlob": b64(&key.sealed_blob), "request": request, "manifest": m,
        });
        let rec = self.requests.get_mut(&rid).unwrap();
        rec.status = SolveStatus::Dispatched;
        rec.dispatched_at_ms = now;
        rec.manifest_sha256 = Some(manifest_sha);
        rec.last_error = None;
        log!("SOLVE_DISPATCHED {} manifestSha256={}", request_id, hex0x(&manifest_sha));
        self.outlayer_request(input, SOLVE_INSTRUCTIONS)
            .then(Self::ext(env::current_account_id()).with_static_gas(SOLVE_CALLBACK_GAS).on_solve(request_id))
    }

    // ------------------------------------------------------------ OutLayer callbacks (private)

    #[private]
    pub fn on_key(&mut self, key_request_id: String) -> PromiseOrValue<bool> {
        let krid = parse_h256(&key_request_id);
        let output = match env::promise_result(0) {
            PromiseResult::Successful(b) => b,
            PromiseResult::Failed => return self.key_failed(krid, "outlayer request_execution failed"),
        };
        let v: Value = serde_json::from_slice(&output).unwrap_or(Value::Null);
        if let Some(f) = v.get("fatal") {
            return self.key_failed(krid, &format!("solver fatal {f}"));
        }
        let (Some(key_id), Some(spki), Some(sealed)) = (v["keyId"].as_str(), v["spki"].as_str(), v["sealedBlob"].as_str()) else {
            return self.key_failed(krid, &format!("unexpected solver output: {}", snippet(&output)));
        };
        let (Some(spki), Some(sealed)) = (unb64(spki), unb64(sealed)) else {
            return self.key_failed(krid, "solver output encoding");
        };
        let key_id = parse_h256(key_id);
        if env::sha256_array(&spki) != key_id || spki.len() != 294 || sealed.is_empty() {
            return self.key_failed(krid, "keyId != sha256(spki) or bad sizes");
        }
        let sealed_blob_hash = env::sha256_array(&sealed);
        let solver_code_hash = parse_h256(&self.wasm_hash);
        let config_hash = self.config_hash;
        let k = self.keys.get_mut(&krid).unwrap_or_else(|| env::panic_str("key record"));
        k.key_id = key_id;
        k.spki = spki.clone();
        k.sealed_blob = sealed;
        k.status = KeyStatus::Ready;
        k.last_error = None;
        let owner = k.owner;
        log!("KEY_READY {} keyId={} sealedBlobHash={}", key_request_id, hex0x(&key_id), hex0x(&sealed_blob_hash));
        let input = encode_key_result(&krid, &owner, &key_id, &spki, &sealed_blob_hash, &solver_code_hash, &config_hash);
        PromiseOrValue::Promise(
            self.aurora_call(input)
                .then(Self::ext(env::current_account_id()).with_static_gas(AURORA_RESULT_GAS).on_aurora_key(key_request_id)),
        )
    }

    #[private]
    pub fn on_aurora_key(&mut self, key_request_id: String) -> bool {
        let status = aurora_status(&env::promise_result(0));
        let k = self.keys.get_mut(&parse_h256(&key_request_id)).unwrap_or_else(|| env::panic_str("key record"));
        k.delivered_to_aurora = status.is_ok();
        k.last_error = status.clone().err();
        log!("KEY_DELIVERED {} ok={} {}", key_request_id, status.is_ok(), status.clone().err().unwrap_or_default());
        status.is_ok()
    }

    #[private]
    pub fn on_solve(&mut self, request_id: String) -> PromiseOrValue<bool> {
        let rid = parse_h256(&request_id);
        let output = match env::promise_result(0) {
            PromiseResult::Successful(b) => b,
            PromiseResult::Failed => return self.solve_failed(rid, SolveStatus::Fatal, "outlayer request_execution failed"),
        };
        let v: Value = serde_json::from_slice(&output).unwrap_or(Value::Null);
        if let Some(f) = v.get("fatal") {
            return self.solve_failed(rid, SolveStatus::Fatal, &format!("solver fatal {f}"));
        }
        let r = self.requests.get(&rid).unwrap_or_else(|| env::panic_str("request record")).clone();
        let fields = match self.validate_result(&r, &rid, &v) {
            Ok(f) => f,
            Err(e) => return self.solve_failed(rid, SolveStatus::Fatal, &format!("result binding: {e}: {}", snippet(&output))),
        };
        let execution_id = format!("{}/solve/{}/{}", env::current_account_id(), hex0x(&rid), r.attempt);
        let output_hash = env::sha256_array(&output);
        let encoded = encode_settlement_result(&ResultFields {
            execution_id_hash: env::keccak256_array(execution_id.as_bytes()),
            output_hash,
            ..fields
        });
        let rec = self.requests.get_mut(&rid).unwrap();
        rec.result = Some(String::from_utf8_lossy(&output).into_owned());
        rec.output_sha256 = Some(output_hash);
        log!("SOLVE_RESULT {} outcome={} outputSha256={} executionId={}", request_id, v["outcome"], hex0x(&output_hash), execution_id);
        PromiseOrValue::Promise(
            self.aurora_call(encoded)
                .then(Self::ext(env::current_account_id()).with_static_gas(AURORA_RESULT_GAS).on_aurora_solve(request_id)),
        )
    }

    #[private]
    pub fn on_aurora_solve(&mut self, request_id: String) -> bool {
        let status = aurora_status(&env::promise_result(0));
        let r = self.requests.get_mut(&parse_h256(&request_id)).unwrap_or_else(|| env::panic_str("request record"));
        r.status = if status.is_ok() { SolveStatus::Delivered } else { SolveStatus::DeliveryFailed };
        r.last_error = status.clone().err();
        log!("SOLVE_DELIVERED {} ok={} {}", request_id, status.is_ok(), status.clone().err().unwrap_or_default());
        status.is_ok()
    }

    // ------------------------------------------------------------ internals

    fn assert_xcc(&self) {
        require!(env::predecessor_account_id() == self.xcc_predecessor, "untrusted predecessor: only the pinned Aurora XCC router may request");
    }
    fn assert_operator(&self) {
        require!(env::predecessor_account_id() == self.operator, "operator only");
    }
    fn assert_bindings(&self, config_hash: &str, solver_code_hash: &str) {
        require!(parse_h256(config_hash) == self.config_hash, "configHash mismatch");
        require!(solver_code_hash.trim_start_matches("0x").eq_ignore_ascii_case(&self.wasm_hash), "solverCodeHash mismatch");
    }

    fn outlayer_request(&self, input: Value, max_instructions: u64) -> Promise {
        let args = json!({
            "source": { "WasmUrl": { "url": self.wasm_url, "hash": self.wasm_hash, "build_target": "wasm32-wasip2" } },
            "resource_limits": { "max_instructions": max_instructions, "max_memory_mb": MAX_MEMORY_MB, "max_execution_seconds": MAX_EXECUTION_SECONDS },
            "input_data": input.to_string(),
            "response_format": "Json",
            "payer_account_id": env::current_account_id(),
        });
        Promise::new(self.outlayer.clone()).function_call("request_execution".to_string(), args.to_string().into_bytes(), self.execution_deposit, EXECUTION_GAS)
    }

    fn aurora_call(&self, input: Vec<u8>) -> Promise {
        Promise::new(self.aurora.clone()).function_call("call".to_string(), aurora_call_args(&self.auction, &input), NearToken::from_yoctonear(0), AURORA_CALL_GAS)
    }

    fn dispatch_key(&mut self, krid: [u8; 32]) -> Promise {
        let k = self.keys.get_mut(&krid).unwrap_or_else(|| env::panic_str("key record"));
        k.status = KeyStatus::Dispatched;
        k.dispatched_at_ms = env::block_timestamp_ms();
        let owner = k.owner;
        let input = json!({
            "mode": "INIT_KEY", "keyRequestId": hex0x(&krid), "owner": hex0x(&owner),
            "solverCodeHash": format!("0x{}", self.wasm_hash), "configHash": hex0x(&self.config_hash),
        });
        self.outlayer_request(input, INIT_KEY_INSTRUCTIONS)
            .then(Self::ext(env::current_account_id()).with_static_gas(KEY_CALLBACK_GAS).on_key(hex0x(&krid)))
    }

    fn key_failed(&mut self, krid: [u8; 32], why: &str) -> PromiseOrValue<bool> {
        let k = self.keys.get_mut(&krid).unwrap_or_else(|| env::panic_str("key record"));
        k.status = KeyStatus::Failed;
        k.last_error = Some(why.to_string());
        log!("KEY_FAILED {} {}", hex0x(&krid), why);
        PromiseOrValue::Value(false)
    }

    fn solve_failed(&mut self, rid: [u8; 32], status: SolveStatus, why: &str) -> PromiseOrValue<bool> {
        let r = self.requests.get_mut(&rid).unwrap_or_else(|| env::panic_str("request record"));
        r.last_error = Some(why.to_string());
        r.status = status;
        log!("SOLVE_FAILED {} {}", hex0x(&rid), why);
        PromiseOrValue::Value(false)
    }

    /// G-04: every binding of the result must equal the trusted snapshot before anything reaches Aurora.
    fn validate_result(&self, r: &SolveRequest, rid: &[u8; 32], v: &Value) -> Result<ResultFields, String> {
        let s = |k: &str| v[k].as_str().ok_or_else(|| format!("{k} missing"));
        let eq_hex = |k: &str, want: &[u8]| -> Result<(), String> {
            if s(k)?.eq_ignore_ascii_case(&hex0x(want)) { Ok(()) } else { Err(format!("{k} mismatch")) }
        };
        if v["protocolVersion"].as_u64() != Some(1) {
            return Err("protocolVersion".into());
        }
        if s("chainId")? != self.chain_id.to_string() {
            return Err("chainId".into());
        }
        eq_hex("auctionContract", &self.auction)?;
        if s("auctionId")? != r.auction_id.to_string() {
            return Err("auctionId".into());
        }
        eq_hex("requestId", rid)?;
        if v["attempt"].as_u64() != Some(r.attempt as u64) {
            return Err("attempt".into());
        }
        eq_hex("bidDigest", &r.bid_digest)?;
        if v["bidCount"].as_u64() != Some(r.bid_count as u64) {
            return Err("bidCount".into());
        }
        eq_hex("keyId", &r.key_id)?;
        let solver_code_hash = parse_h256(&self.wasm_hash);
        eq_hex("solverCodeHash", &solver_code_hash)?;
        eq_hex("configHash", &self.config_hash)?;
        let valid = v["validBidCount"].as_u64().ok_or("validBidCount")?;
        let invalid = v["invalidBidCount"].as_u64().ok_or("invalidBidCount")?;
        if valid + invalid != r.bid_count as u64 {
            return Err("valid+invalid != bidCount".into());
        }
        let winner = hex::decode(s("winner")?.trim_start_matches("0x")).ok().and_then(|b| <[u8; 20]>::try_from(b).ok()).ok_or("winner")?;
        let winning_amount: u128 = s("winningAmountUnits")?.parse().map_err(|_| "winningAmountUnits")?;
        let outcome = match s("outcome")? {
            "WINNER" if winner != [0u8; 20] && winning_amount >= r.reserve_units && winning_amount > 0 => 0u8,
            "NO_SALE" if winner == [0u8; 20] && winning_amount == 0 => 1u8,
            _ => return Err("outcome/winner/amount inconsistent".into()),
        };
        Ok(ResultFields {
            chain_id: self.chain_id,
            auction: self.auction,
            auction_id: r.auction_id,
            request_id: *rid,
            attempt: r.attempt,
            bid_digest: r.bid_digest,
            bid_count: r.bid_count,
            key_id: r.key_id,
            solver_code_hash,
            config_hash: self.config_hash,
            outcome,
            winner,
            winning_amount,
            valid: valid as u32,
            invalid: invalid as u32,
            execution_id_hash: [0; 32],
            output_hash: [0; 32],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn h(s: &str) -> [u8; 32] {
        parse_h256(s)
    }
    fn adapter() -> Adapter {
        testing_env!(VMContextBuilder::new().current_account_id("maskbid-adapter.testnet".parse().unwrap()).build());
        Adapter::new(
            "maskbid-keeper.testnet".parse().unwrap(),
            "aurora".parse().unwrap(),
            "0x1111111111111111111111111111111111111111".into(),
            "outlayer.testnet".parse().unwrap(),
            "https://example.invalid/solver.wasm".into(),
            "0xede26f8342dff36f8c4851d576c90e336a8add46694925b78968d55153ac8573".into(),
            1313161555,
            "0xfcfa465a7e82db5c716ae69560bc899d0d9a02ef7af6e03dbbe414a8137a2461".into(),
            U128(100_000_000_000_000_000_000_000),
        )
    }

    #[test]
    fn callback_sender_and_router_names() {
        // cast keccak "maskbid-adapter.testnet" = 0x9eb2...2843570c -> last 20 bytes
        assert_eq!(hex0x(&implicit_address("maskbid-adapter.testnet")), "0x780dfa1e400790fffaec39cf89c4c8182843570c");
        let a = adapter();
        assert_eq!(a.xcc_predecessor.as_str(), "1111111111111111111111111111111111111111.aurora");
    }

    #[test]
    fn settlement_result_abi_matches_cast() {
        // cast abi-encode "f((uint256,uint256,address,uint256,bytes32,uint32,bytes32,uint32,bytes32,bytes32,bytes32,uint8,address,uint256,uint32,uint32,bytes32,bytes32))" ...
        let r = ResultFields {
            chain_id: 1313161555,
            auction: parse_addr("0x1111111111111111111111111111111111111111"),
            auction_id: 7,
            request_id: h("0x164af82303fff28464126ed97cfb15ed6f82594ad6ae9cda837e809eb1681476"),
            attempt: 1,
            bid_digest: h("0x1a0c96317e7202399805323cf75ca84397e71d1ff75bc7ab31af0c4a3ed6ad5e"),
            bid_count: 3,
            key_id: h("0x5a3fdc12002bf9f800bd4260df87d13cda7d9d337d4bb2d5491513cf0e8ec351"),
            solver_code_hash: h("0xede26f8342dff36f8c4851d576c90e336a8add46694925b78968d55153ac8573"),
            config_hash: h("0xfcfa465a7e82db5c716ae69560bc899d0d9a02ef7af6e03dbbe414a8137a2461"),
            outcome: 0,
            winner: parse_addr("0x2222222222222222222222222222222222222222"),
            winning_amount: 150_000_000,
            valid: 3,
            invalid: 0,
            execution_id_hash: [1u8; 32],
            output_hash: [2u8; 32],
        };
        let expected = "a2ab24880000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000004e45415300000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000007164af82303fff28464126ed97cfb15ed6f82594ad6ae9cda837e809eb168147600000000000000000000000000000000000000000000000000000000000000011a0c96317e7202399805323cf75ca84397e71d1ff75bc7ab31af0c4a3ed6ad5e00000000000000000000000000000000000000000000000000000000000000035a3fdc12002bf9f800bd4260df87d13cda7d9d337d4bb2d5491513cf0e8ec351ede26f8342dff36f8c4851d576c90e336a8add46694925b78968d55153ac8573fcfa465a7e82db5c716ae69560bc899d0d9a02ef7af6e03dbbe414a8137a2461000000000000000000000000000000000000000000000000000000000000000000000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000008f0d1800000000000000000000000000000000000000000000000000000000000000003000000000000000000000000000000000000000000000000000000000000000001010101010101010101010101010101010101010101010101010101010101010202020202020202020202020202020202020202020202020202020202020202";
        assert_eq!(hex::encode(encode_settlement_result(&r)), expected);
    }

    #[test]
    fn key_result_abi_matches_cast() {
        // cast abi-encode "f((bytes32,address,bytes32,bytes,bytes32,bytes32,bytes32))" (0x03..,0x1dfb..,0x04..,0x30820122aabb,0x05..,0x06..,0x07..)
        let out = encode_key_result(
            &[3u8; 32],
            &parse_addr("0x1dfb61D5b1975A2f536658d367363d9B346b578b"),
            &[4u8; 32],
            &hex::decode("30820122aabb").unwrap(),
            &[5u8; 32],
            &[6u8; 32],
            &[7u8; 32],
        );
        let expected = "e94050bb000000000000000000000000000000000000000000000000000000000000002003030303030303030303030303030303030303030303030303030303030303030000000000000000000000001dfb61d5b1975a2f536658d367363d9b346b578b040404040404040404040404040404040404040404040404040404040404040400000000000000000000000000000000000000000000000000000000000000e0050505050505050505050505050505050505050505050505050505050505050506060606060606060606060606060606060606060606060606060606060606060707070707070707070707070707070707070707070707070707070707070707000000000000000000000000000000000000000000000000000000000000000630820122aabb0000000000000000000000000000000000000000000000000000";
        assert_eq!(hex::encode(out), expected);
    }

    #[test]
    fn aurora_call_args_are_borsh_v2() {
        let args = aurora_call_args(&[0xaa; 20], &[1, 2, 3]);
        assert_eq!(args[0], 0);
        assert_eq!(&args[1..21], &[0xaa; 20]);
        assert_eq!(&args[21..53], &[0u8; 32]);
        assert_eq!(&args[53..57], &3u32.to_le_bytes());
        assert_eq!(&args[57..], &[1, 2, 3]);
        assert!(aurora_status(&PromiseResult::Successful(vec![7, 0, 0, 0, 0, 0])).is_ok());
        assert!(aurora_status(&PromiseResult::Successful(vec![7, 1, 4, 0, 0, 0, 0xde, 0xad, 0xbe, 0xef])).unwrap_err().contains("deadbeef"));
        assert!(aurora_status(&PromiseResult::Failed).is_err());
    }

    #[test]
    #[should_panic(expected = "untrusted predecessor")]
    fn request_key_rejects_other_callers() {
        let mut a = adapter();
        testing_env!(VMContextBuilder::new().current_account_id("maskbid-adapter.testnet".parse().unwrap()).predecessor_account_id(accounts(1)).build());
        a.request_key(
            hex0x(&[9u8; 32]),
            "0x1dfb61D5b1975A2f536658d367363d9B346b578b".into(),
            "0xfcfa465a7e82db5c716ae69560bc899d0d9a02ef7af6e03dbbe414a8137a2461".into(),
            "0xede26f8342dff36f8c4851d576c90e336a8add46694925b78968d55153ac8573".into(),
        );
    }

    #[test]
    #[should_panic(expected = "configHash mismatch")]
    fn request_key_rejects_wrong_bindings() {
        let mut a = adapter();
        testing_env!(VMContextBuilder::new()
            .current_account_id("maskbid-adapter.testnet".parse().unwrap())
            .predecessor_account_id("1111111111111111111111111111111111111111.aurora".parse().unwrap())
            .build());
        a.request_key(hex0x(&[9u8; 32]), "0x1dfb61D5b1975A2f536658d367363d9B346b578b".into(), hex0x(&[0u8; 32]), format!("0x{}", a.wasm_hash));
    }

    #[test]
    fn request_key_from_router_is_recorded_and_dispatched() {
        let mut a = adapter();
        testing_env!(VMContextBuilder::new()
            .current_account_id("maskbid-adapter.testnet".parse().unwrap())
            .predecessor_account_id("1111111111111111111111111111111111111111.aurora".parse().unwrap())
            .build());
        let krid = hex0x(&[9u8; 32]);
        a.request_key(krid.clone(), "0x1dfb61D5b1975A2f536658d367363d9B346b578b".into(), hex0x(&a.config_hash), format!("0x{}", a.wasm_hash));
        let k = a.get_key(krid).unwrap();
        assert_eq!(k["status"], "Dispatched");
        assert_eq!(k["owner"], "0x1dfb61d5b1975a2f536658d367363d9b346b578b");
    }

    #[test]
    #[should_panic(expected = "key is not ready")]
    fn request_solve_needs_ready_key() {
        let mut a = adapter();
        testing_env!(VMContextBuilder::new()
            .current_account_id("maskbid-adapter.testnet".parse().unwrap())
            .predecessor_account_id("1111111111111111111111111111111111111111.aurora".parse().unwrap())
            .build());
        let krid = hex0x(&[9u8; 32]);
        a.request_key(krid.clone(), "0x1dfb61D5b1975A2f536658d367363d9B346b578b".into(), hex0x(&a.config_hash), format!("0x{}", a.wasm_hash));
        a.request_solve(hex0x(&[1u8; 32]), "1".into(), 1, hex0x(&[2u8; 32]), 3, hex0x(&[3u8; 32]), krid, "100000000".into(), 0, 1800, hex0x(&a.config_hash), format!("0x{}", a.wasm_hash));
    }
}
