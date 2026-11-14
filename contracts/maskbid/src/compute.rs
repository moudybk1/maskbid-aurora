//! Private compute on OutLayer (spec 04, 15 §7-§11). This contract is the only caller of the pinned solver:
//! INIT_KEY makes the per-auction RSA key and seals its seed to that wasm build and to this account, SOLVE opens it
//! and ranks the bids. Each result is the promise result of the request that asked for it, and every binding is
//! checked against this contract's own state before anything changes.
//!
//! Each run costs `execution_deposit` NEAR, attached by whoever asks for it: the contract never spends its own
//! balance on compute. The caller is named as OutLayer's payer, so unused budget and the refund of a failed run
//! go back to them.
use crate::protocol::{key_request_id, request_id};
use crate::*;
use base64::Engine;
use near_sdk::{serde_json, Gas, Promise};
use AuctionState::*;

const EXECUTION_GAS: Gas = Gas::from_tgas(100);
const KEY_CALLBACK_GAS: Gas = Gas::from_tgas(30);
const SOLVE_CALLBACK_GAS: Gas = Gas::from_tgas(50);
const REDISPATCH_AFTER: u64 = 300;
const MAX_OUTPUT_BYTES: usize = 16 * 1024;
// ponytail: fixed resource limits; RSA-2048 keygen inside wasm dominates. Unused budget is refunded by OutLayer.
const INIT_KEY_INSTRUCTIONS: u64 = 200_000_000_000;
const SOLVE_INSTRUCTIONS: u64 = 300_000_000_000;
const MAX_EXECUTION_SECONDS: u64 = 150;
const MAX_MEMORY_MB: u32 = 256;

pub(crate) fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
pub(crate) fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}
/// First bytes of a raw OutLayer output for the error record (a failed run returns `null` or an error object, never key material).
fn snippet(output: &[u8]) -> String {
    String::from_utf8_lossy(&output[..output.len().min(300)]).into_owned()
}

#[near]
impl MaskBid {
    // ---------------------------------------------------------------- key lifecycle

    /// Asks the TEE for a fresh auction key owned by the caller. Returns the key request id; the key is ready
    /// (`get_key`) once OutLayer answers, usually within a minute. Attach exactly `executionDeposit`.
    #[payable]
    pub fn prepare_auction_key(&mut self, client_salt: String) -> String {
        require!(!self.entry_paused, "EntryPaused");
        let owner = env::predecessor_account_id();
        require!(self.eligible(&owner), "NotEligible");
        let nonce = self.key_nonce.get(&owner).copied().unwrap_or(0);
        self.key_nonce.insert(owner.clone(), nonce + 1);
        let krid = key_request_id(&self.domain(), &addr(owner.as_str()), nonce, &h256(&client_salt), &self.config_hash);
        emit("key_requested", json!({ "keyRequestId": hex0x(&krid), "owner": owner, "configHash": hex0x(&self.config_hash) }));
        self.keys.insert(
            krid,
            KeyRecord { owner, key_id: [0u8; 32], spki: vec![], sealed_blob: vec![], status: KeyStatus::Requested, dispatched_at: 0, last_error: None },
        );
        self.dispatch_key(krid);
        hex0x(&krid)
    }

    /// Retry for a key whose run failed, or whose answer is five minutes overdue. Anyone may pay for it; the
    /// bindings of the request cannot change.
    #[payable]
    pub fn redispatch_key(&mut self, key_request_id: String) {
        let krid = h256(&key_request_id);
        let k = self.keys.get(&krid).unwrap_or_else(|| env::panic_str("UnknownKey"));
        require!(matches!(k.status, KeyStatus::Requested | KeyStatus::Failed), "WrongState");
        require!(k.status == KeyStatus::Failed || k.dispatched_at + REDISPATCH_AFTER <= now(), "DispatchPending");
        self.dispatch_key(krid);
    }

    #[private]
    pub fn on_key(&mut self, key_request_id: String) -> bool {
        self.apply_key(h256(&key_request_id), env::promise_result_checked(0, MAX_OUTPUT_BYTES).ok())
    }

    // ---------------------------------------------------------------- settlement

    /// Closes the auction if its time is up and starts the first solver run. Returns the request id.
    /// Attach exactly `executionDeposit` and 300 Tgas.
    #[payable]
    pub fn request_settlement(&mut self, auction_id: u64) -> String {
        self.end_auction(auction_id);
        let a = self.auction(auction_id);
        require!(a.state == Ended && a.active_attempt == 0, "WrongState");
        self.request(auction_id, a, 1)
    }

    /// Next attempt, once the active one failed or timed out. Same deposit and gas as `request_settlement`.
    #[payable]
    pub fn retry_settlement(&mut self, auction_id: u64) -> String {
        let a = self.auction(auction_id);
        require!(a.state == Ended && a.active_attempt != 0, "WrongState");
        require!(a.active_attempt < MAX_ATTEMPTS, "MaxAttemptsReached");
        require!(a.attempt_failed || now() >= a.attempt_started_at + ATTEMPT_TIMEOUT, "AttemptNotTimedOut");
        let attempt = a.active_attempt + 1;
        self.request(auction_id, a, attempt)
    }

    #[private]
    pub fn on_solve(&mut self, auction_id: u64, request_id: String) -> bool {
        self.apply_solve(auction_id, h256(&request_id), env::promise_result_checked(0, MAX_OUTPUT_BYTES).ok())
    }

    // ---------------------------------------------------------------- views

    pub fn get_key(&self, key_request_id: String) -> Option<Value> {
        let krid = h256(&key_request_id);
        self.keys.get(&krid).map(|k| {
            json!({
                "keyRequestId": hex0x(&krid), "owner": k.owner, "ownerAddress": hex0x(&addr(k.owner.as_str())), "status": k.status,
                "keyId": hex0x(&k.key_id), "publicKeySpki": b64(&k.spki), "sealedBlobHash": hex0x(&env::sha256_array(&k.sealed_blob)),
                "dispatchedAt": k.dispatched_at, "lastError": k.last_error,
            })
        })
    }

    pub fn get_key_by_key_id(&self, key_id: String) -> Option<Value> {
        self.key_request_of_key_id.get(&h256(&key_id)).and_then(|krid| self.get_key(hex0x(krid)))
    }
}

impl MaskBid {
    fn outlayer_call(&self, input: Value, max_instructions: u64) -> Promise {
        require!(env::attached_deposit() == self.execution_deposit, "AttachExecutionDeposit");
        let args = json!({
            "source": { "WasmUrl": { "url": self.wasm_url, "hash": hex::encode(self.solver_code_hash), "build_target": "wasm32-wasip2" } },
            "resource_limits": { "max_instructions": max_instructions, "max_memory_mb": MAX_MEMORY_MB, "max_execution_seconds": MAX_EXECUTION_SECONDS },
            "input_data": input.to_string(),
            "response_format": "Json",
            "payer_account_id": env::predecessor_account_id(),
        });
        Promise::new(self.outlayer.clone()).function_call("request_execution".to_string(), args.to_string().into_bytes(), self.execution_deposit, EXECUTION_GAS)
    }

    fn dispatch_key(&mut self, krid: H256) {
        let k = self.keys.get_mut(&krid).unwrap_or_else(|| env::panic_str("UnknownKey"));
        k.status = KeyStatus::Requested;
        k.dispatched_at = now();
        let input = json!({
            "mode": "INIT_KEY", "keyRequestId": hex0x(&krid), "owner": hex0x(&addr(k.owner.as_str())),
            "solverCodeHash": hex0x(&self.solver_code_hash), "configHash": hex0x(&self.config_hash),
        });
        self.outlayer_call(input, INIT_KEY_INSTRUCTIONS)
            .then(Self::ext(env::current_account_id()).with_static_gas(KEY_CALLBACK_GAS).on_key(hex0x(&krid)))
            .detach();
    }

    /// `output` is the raw OutLayer result, `None` when the run failed. A run that answers after the key was
    /// already bound (a retry racing a late first run) is ignored.
    pub(crate) fn apply_key(&mut self, krid: H256, output: Option<Vec<u8>>) -> bool {
        let status = self.keys.get(&krid).unwrap_or_else(|| env::panic_str("UnknownKey")).status;
        if !matches!(status, KeyStatus::Requested | KeyStatus::Failed) {
            return false;
        }
        let parsed = self.parse_key(output.as_deref());
        let k = self.keys.get_mut(&krid).unwrap();
        match parsed {
            Ok((key_id, spki, sealed_blob)) => {
                emit(
                    "key_prepared",
                    json!({
                        "keyRequestId": hex0x(&krid), "keyId": hex0x(&key_id), "owner": k.owner, "publicKeySpki": b64(&spki),
                        "sealedBlobHash": hex0x(&env::sha256_array(&sealed_blob)), "solverCodeHash": hex0x(&self.solver_code_hash),
                    }),
                );
                (k.key_id, k.spki, k.sealed_blob, k.status, k.last_error) = (key_id, spki, sealed_blob, KeyStatus::Ready, None);
                self.key_request_of_key_id.insert(key_id, krid);
                true
            }
            Err(why) => {
                emit("key_failed", json!({ "keyRequestId": hex0x(&krid), "error": why }));
                (k.status, k.last_error) = (KeyStatus::Failed, Some(why));
                false
            }
        }
    }

    fn parse_key(&self, output: Option<&[u8]>) -> Result<(H256, Vec<u8>, Vec<u8>), String> {
        let output = output.ok_or("outlayer request_execution failed")?;
        let v: Value = serde_json::from_slice(output).unwrap_or(Value::Null);
        if let Some(f) = v.get("fatal") {
            return Err(format!("solver fatal {f}"));
        }
        let (Some(key_id), Some(spki), Some(sealed)) = (v["keyId"].as_str(), v["spki"].as_str(), v["sealedBlob"].as_str()) else {
            return Err(format!("unexpected solver output: {}", snippet(output)));
        };
        let (Some(spki), Some(sealed)) = (unb64(spki), unb64(sealed)) else { return Err("solver output encoding".into()) };
        let key_id: H256 = hex::decode(key_id.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).ok_or("keyId malformed")?;
        if env::sha256_array(&spki) != key_id || spki.len() != 294 || sealed.is_empty() {
            return Err("keyId != sha256(spki) or bad sizes".into());
        }
        if self.key_request_of_key_id.contains_key(&key_id) {
            return Err("keyId already bound".into());
        }
        Ok((key_id, spki, sealed))
    }

    fn request(&mut self, auction_id: u64, mut a: Auction, attempt: u32) -> String {
        require!(now() < a.settlement_deadline, "DeadlinePassed");
        let rid = request_id(&self.domain(), auction_id, &a.bid_digest, a.bid_count, attempt, &self.config_hash);
        (a.active_request_id, a.active_attempt, a.attempt_started_at, a.attempt_failed, a.last_error) = (rid, attempt, now(), false, None);
        emit(
            "settlement_requested",
            json!({
                "auctionId": auction_id, "requestId": hex0x(&rid), "attempt": attempt, "bidDigest": hex0x(&a.bid_digest),
                "bidCount": a.bid_count, "deadline": a.settlement_deadline,
            }),
        );
        let input = self.solve_input(auction_id, &a);
        self.auctions.insert(auction_id, a);
        self.outlayer_call(input, SOLVE_INSTRUCTIONS)
            .then(Self::ext(env::current_account_id()).with_static_gas(SOLVE_CALLBACK_GAS).on_solve(auction_id, hex0x(&rid)))
            .detach();
        hex0x(&rid)
    }

    /// The solver's SOLVE input (spec 15 §8-§9): the request snapshot and the complete ordered manifest, both from
    /// this contract's state. The solver still recomputes every commitment and the digest before it opens the key.
    pub(crate) fn solve_input(&self, auction_id: u64, a: &Auction) -> Value {
        let d = self.domain();
        let krid = self.key_request_of_key_id.get(&a.key_id).unwrap_or_else(|| env::panic_str("UnknownKey"));
        let key = self.keys.get(krid).unwrap_or_else(|| env::panic_str("UnknownKey"));
        let (chain_id, contract, id, rid) = (d.chain_id.to_string(), hex0x(&d.contract), auction_id.to_string(), hex0x(&a.active_request_id));
        let bids: Vec<Value> = (0..a.bid_count)
            .map(|i| {
                let b = self.bids.get(&(auction_id, i)).unwrap_or_else(|| env::panic_str("MissingBid"));
                // The provenance fields belong to manifests rebuilt from logs; here the bid set is the contract's own state.
                json!({
                    "bidIndex": i.to_string(), "bidder": hex0x(&addr(b.bidder.as_str())), "commitment": hex0x(&b.commitment),
                    "envelope": hex0x(&b.envelope), "txHash": "", "blockHash": "", "blockNumber": "", "logIndex": "",
                })
            })
            .collect();
        json!({
            "mode": "SOLVE", "keyRequestId": hex0x(krid), "owner": hex0x(&addr(key.owner.as_str())), "sealedBlob": b64(&key.sealed_blob),
            "request": {
                "protocolVersion": 1, "chainId": chain_id, "auctionContract": contract, "auctionId": id, "requestId": rid,
                "attempt": a.active_attempt, "bidDigest": hex0x(&a.bid_digest), "bidCount": a.bid_count, "keyId": hex0x(&a.key_id),
                "solverCodeHash": hex0x(&self.solver_code_hash), "configHash": hex0x(&self.config_hash),
                "reserveUnits": a.reserve_units.to_string(), "endTime": a.end_time.to_string(),
                "settlementDeadline": a.settlement_deadline.to_string(), "keyRequestId": hex0x(krid),
            },
            "manifest": {
                "protocolVersion": 1, "chainId": chain_id, "auctionContract": contract, "auctionId": id, "requestId": rid,
                "keyId": hex0x(&a.key_id), "bidDigest": hex0x(&a.bid_digest), "bidCount": a.bid_count, "bids": bids,
            },
        })
    }

    /// `output` is the raw OutLayer result, `None` when the run failed. An answer to anything but the active
    /// request of an ended auction inside its deadline is stale and changes nothing.
    pub(crate) fn apply_solve(&mut self, auction_id: u64, rid: H256, output: Option<Vec<u8>>) -> bool {
        let mut a = self.auction(auction_id);
        if a.state != Ended || a.active_request_id != rid || now() >= a.settlement_deadline {
            emit("settlement_stale", json!({ "auctionId": auction_id, "requestId": hex0x(&rid) }));
            return false;
        }
        let accepted = match self.check_result(auction_id, &a, output.as_deref()) {
            Ok((winner, v)) => {
                let output_hash = env::sha256_array(output.as_deref().unwrap_or_default());
                a.output_hash = Some(output_hash);
                match &winner {
                    Some((account, amount)) => {
                        (a.state, a.winner, a.winning_amount_units, a.claim_deadline) = (PendingClaim, Some(account.clone()), *amount, now() + self.claim_window);
                    }
                    None => (a.state, a.cancel_reason) = (Cancelled, CancelReason::NoValidBid),
                }
                emit(
                    "settlement_accepted",
                    json!({
                        "auctionId": auction_id, "requestId": hex0x(&rid), "outcome": v["outcome"], "winner": a.winner,
                        "winnerAddress": v["winner"], "winningAmountUnits": U128(a.winning_amount_units),
                        "validBidCount": v["validBidCount"], "invalidBidCount": v["invalidBidCount"], "outputSha256": hex0x(&output_hash),
                    }),
                );
                if a.state == Cancelled {
                    emit("auction_cancelled", json!({ "auctionId": auction_id, "reason": a.cancel_reason }));
                }
                true
            }
            Err(why) => {
                emit("settlement_failed", json!({ "auctionId": auction_id, "requestId": hex0x(&rid), "attempt": a.active_attempt, "error": why }));
                (a.attempt_failed, a.last_error) = (true, Some(why));
                false
            }
        };
        self.auctions.insert(auction_id, a);
        accepted
    }

    /// Every binding of the result must equal this contract's state. Returns the winner (account, amount) or `None`
    /// for a no-sale, plus the parsed output.
    fn check_result(&self, auction_id: u64, a: &Auction, output: Option<&[u8]>) -> Result<(Option<(AccountId, u128)>, Value), String> {
        let output = output.ok_or("outlayer request_execution failed")?;
        let v: Value = serde_json::from_slice(output).unwrap_or(Value::Null);
        if let Some(f) = v.get("fatal") {
            return Err(format!("solver fatal {f}"));
        }
        if !v.is_object() {
            return Err(format!("unexpected solver output: {}", snippet(output))); // `null`: OutLayer's yield timed out
        }
        let text = |k: &str| v[k].as_str().ok_or_else(|| format!("{k} missing: {}", snippet(output)));
        let same = |k: &str, want: String| -> Result<(), String> {
            if text(k)?.eq_ignore_ascii_case(&want) { Ok(()) } else { Err(format!("{k} mismatch")) }
        };
        let count = |k: &str| v[k].as_u64().ok_or_else(|| format!("{k} missing"));
        let d = self.domain();
        if count("protocolVersion")? != 1 || count("attempt")? != a.active_attempt as u64 || count("bidCount")? != a.bid_count as u64 {
            return Err("protocolVersion/attempt/bidCount mismatch".into());
        }
        same("chainId", d.chain_id.to_string())?;
        same("auctionContract", hex0x(&d.contract))?;
        same("auctionId", auction_id.to_string())?;
        same("requestId", hex0x(&a.active_request_id))?;
        same("bidDigest", hex0x(&a.bid_digest))?;
        same("keyId", hex0x(&a.key_id))?;
        same("solverCodeHash", hex0x(&self.solver_code_hash))?;
        same("configHash", hex0x(&self.config_hash))?;
        if count("validBidCount")? + count("invalidBidCount")? != a.bid_count as u64 {
            return Err("valid+invalid != bidCount".into());
        }
        let winner: Addr = hex::decode(text("winner")?.trim_start_matches("0x")).ok().and_then(|b| b.try_into().ok()).ok_or("winner malformed")?;
        let amount: u128 = text("winningAmountUnits")?.parse().map_err(|_| "winningAmountUnits malformed")?;
        let winner = match text("outcome")? {
            "WINNER" => {
                let index = self.bid_index.get(&(auction_id, winner)).ok_or("InvalidWinner")?;
                if amount < a.reserve_units {
                    return Err("BelowReserve".into());
                }
                Some((self.bids.get(&(auction_id, *index)).ok_or("InvalidWinner")?.bidder.clone(), amount))
            }
            "NO_SALE" if winner == [0u8; 20] && amount == 0 => None,
            _ => return Err("outcome/winner/amount inconsistent".into()),
        };
        Ok((winner, v))
    }
}
