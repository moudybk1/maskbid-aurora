//! Unit tests. The settlement tests run the unchanged TEE solver library on the exact SOLVE input this contract
//! builds, with bids sealed the way a client seals them, and feed its output back as the OutLayer result.
use crate::compute::{b64, unb64};
use crate::protocol::*;
use crate::*;
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use maskbid_private_solver as solver;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{serde_json, test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};
use rsa::pkcs8::DecodePrivateKey;
use rsa::{Oaep, RsaPrivateKey, RsaPublicKey};
use AuctionState::*;

const ME: &str = "maskbid.testnet";
const TOKEN: &str = "usdc.testnet";
const ADMIN: &str = "admin.testnet";
const REGISTRAR: &str = "registrar.testnet";
const VERIFIER: &str = "verifier.testnet";
const SELLER: &str = "seller.testnet";
const BIDDERS: [&str; 3] = ["alice.testnet", "bob.testnet", "carol.testnet"];
const T0: u64 = 1_800_000_000;
const END: u64 = T0 + 660;
const FEE: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR per OutLayer run
const RESERVE: u128 = 100_000_000;
const DEPOSIT: u128 = 10_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
/// Next call comes from `who` at `time` (seconds) with `deposit` yoctoNEAR attached.
fn at(who: &str, time: u64, deposit: u128) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(acct(ME))
        .predecessor_account_id(acct(who))
        .block_timestamp(time * 1_000_000_000)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .build());
}
/// On-chain a panic reverts the call; here it does not, so use this only where nothing was written before the panic
/// or at the end of a test.
fn fails<T>(expected: &str, f: impl FnOnce() -> T) {
    let err = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).err().expect("call should have panicked");
    let msg = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    assert!(msg.contains(expected), "expected {expected}, got: {msg}");
}
fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../packages/protocol/vectors/protocol-vectors.json")).unwrap()
}
fn private_key() -> RsaPrivateKey {
    RsaPrivateKey::from_pkcs8_pem(vectors()["testPrivateKeyPkcs8Pem"].as_str().unwrap()).unwrap()
}

/// Contract with the seller and three bidders registered as simulated participants.
fn setup() -> MaskBid {
    at(ADMIN, T0, 0);
    let mut c = MaskBid::new(
        acct(ADMIN),
        acct(REGISTRAR),
        acct(VERIFIER),
        acct(TOKEN),
        acct("outlayer.testnet"),
        "https://example.invalid/solver.wasm".into(),
        hex0x(&[0xed; 32]),
        398,
        "demo".into(),
        true,
        U128(FEE),
    );
    at(REGISTRAR, T0, 0);
    for (i, who) in [SELLER].iter().chain(BIDDERS.iter()).enumerate() {
        c.register_participant(acct(who), hex0x(&[i as u8 + 1; 32]), T0 + 86_400, 2, hex0x(&[9; 32]));
    }
    c
}

/// The seller's asset is verified, the TEE (played here) returns the vector key, and auction 1 runs T0+60..END.
fn listed(c: &mut MaskBid) -> (u64, H256) {
    at(SELLER, T0, 0);
    let token_id = c.register_asset("ipfs://asset".into(), hex0x(&[5; 32]));
    at(VERIFIER, T0, 0);
    c.verify_and_mint(token_id.clone(), hex0x(&[6; 32]));
    at(SELLER, T0, FEE);
    let krid = c.prepare_auction_key(hex0x(&[7; 32]));
    let spki = unb64(vectors()["publicKeySpkiBase64"].as_str().unwrap()).unwrap();
    let key_id = env::sha256_array(&spki);
    let output = json!({ "keyId": hex0x(&key_id), "spki": b64(&spki), "sealedBlob": b64(b"sealed-by-the-tee") });
    at(ME, T0 + 30, 0);
    assert!(c.apply_key(h256(&krid), Some(output.to_string().into_bytes())));
    at(SELLER, T0 + 60, 0);
    (c.create_auction(token_id, U128(RESERVE), U128(DEPOSIT), 0, END, hex0x(&key_id)), key_id)
}

/// A 490-byte envelope sealed like the client does (spec 15 §3-§4): RSA-OAEP wraps the content key, AES-GCM carries
/// the 201-byte plaintext with the domain AAD.
fn seal(auction_id: u64, bidder: &str, key_id: &H256, amount: u128) -> Vec<u8> {
    let d = solver::Domain { chain_id: word(398), auction_contract: addr(ME), auction_id: word(auction_id as u128) };
    let bidder = addr(bidder);
    let plaintext = [&[1u8][..], &d.chain_id, &d.auction_contract, &d.auction_id, &bidder, &word(amount), key_id, &[0u8; 32]].concat();
    let (content_key, iv) = ([7u8; 32], [9u8; 12]);
    let aad = solver::aad_hash(&d, &bidder, key_id);
    let sealed = Aes256Gcm::new_from_slice(&content_key).unwrap().encrypt(Nonce::from_slice(&iv), Payload { msg: &plaintext, aad: &aad }).unwrap();
    let wrapped = RsaPublicKey::from(&private_key()).encrypt(&mut rand_core::OsRng, Oaep::new::<sha2::Sha256>(), &content_key).unwrap();
    [&[1u8, 1, 0][..], &wrapped, &iv, &[0, 0xd9], &sealed].concat()
}
fn unreadable_envelope(tag: u8) -> Vec<u8> {
    let mut e = vec![tag; 490];
    (e[0], e[1], e[2], e[271], e[272]) = (1, 1, 0, 0, 0xd9);
    e
}
fn bid(c: &mut MaskBid, auction_id: u64, who: &str, amount: u128, envelope: &[u8]) {
    at(TOKEN, T0 + 120, 0);
    c.ft_on_transfer(acct(who), U128(amount), json!({ "action": "bid", "auction_id": auction_id, "envelope": hex0x(envelope) }).to_string());
}
/// What OutLayer returns for the auction's active request: the real solver run on the contract's own SOLVE input.
fn solve(c: &MaskBid, auction_id: u64) -> Vec<u8> {
    let input = c.solve_input(auction_id, &c.auction(auction_id));
    let request: solver::SettlementRequest = serde_json::from_value(input["request"].clone()).unwrap();
    let manifest: solver::Manifest = serde_json::from_value(input["manifest"].clone()).unwrap();
    solver::canonical_result(&solver::solve(&request, &manifest, &private_key()).unwrap()).into_bytes()
}
fn request_settlement(c: &mut MaskBid, auction_id: u64) -> H256 {
    at("anyone.testnet", END, FEE);
    h256(&c.request_settlement(auction_id))
}
fn owner_of(c: &MaskBid, token_id: &str) -> Option<AccountId> {
    c.assets.get(token_id).unwrap().owner.clone()
}

#[test]
fn hashes_match_the_protocol_vectors() {
    at(ME, T0, 0);
    let v = vectors();
    let hex = |x: &Value| hex::decode(x.as_str().unwrap().trim_start_matches("0x")).unwrap();
    let num = |x: &Value| x.as_u64().unwrap_or_else(|| x.as_str().unwrap().parse().unwrap()); // number or decimal string
    let r = &v["request"];
    let d = Domain { chain_id: num(&r["chainId"]), contract: hex(&r["auctionContract"]).try_into().unwrap() };
    let (auction_id, key_id) = (num(&r["auctionId"]), h256(r["keyId"].as_str().unwrap()));
    let mut digest = initial_digest(&d, auction_id, &key_id);
    assert_eq!(hex0x(&digest), v["initialDigest"]);
    for (i, b) in v["bids"].as_array().unwrap().iter().enumerate() {
        let (bidder, envelope): (Addr, Vec<u8>) = (hex(&b["bidder"]).try_into().unwrap(), hex(&b["envelope"]));
        assert!(envelope_header_valid(&envelope));
        let commitment = bid_hash(&d, auction_id, &bidder, &key_id, &envelope);
        assert_eq!(hex0x(&commitment), b["commitment"]);
        digest = next_digest(&digest, i as u32, &bidder, &commitment);
        assert_eq!(hex0x(&digest), b["digestAfter"]);
    }
    let rid = request_id(&d, auction_id, &digest, 3, num(&r["attempt"]) as u32, &h256(r["configHash"].as_str().unwrap()));
    assert_eq!(hex0x(&rid), r["requestId"]);
    // The address a NEAR account takes in the protocol: last 20 bytes of keccak256(account id).
    assert_eq!(hex0x(&addr("maskbid-adapter.testnet")), "0x780dfa1e400790fffaec39cf89c4c8182843570c");
    assert!(!envelope_header_valid(&[1u8; 490]) && !envelope_header_valid(&unreadable_envelope(0)[..489]));
}

#[test]
fn sealed_bids_settle_through_the_solver_and_pay_out() {
    let mut c = setup();
    let (id, key_id) = listed(&mut c);
    assert_eq!(owner_of(&c, "1"), Some(acct(ME))); // escrowed
    for (who, amount) in BIDDERS.iter().zip([120_000_000u128, 150_000_000, 150_000_000]) {
        bid(&mut c, id, who, DEPOSIT, &seal(id, who, &key_id, amount));
    }
    assert_eq!((c.auction(id).state, c.auction(id).bid_count, c.total_locked_deposits), (Active, 3, 3 * DEPOSIT));

    let rid = request_settlement(&mut c, id);
    let output = solve(&c, id);
    at(ME, END + 20, 0);
    assert!(c.apply_solve(id, rid, Some(output.clone())));
    let a = c.auction(id);
    // Highest amount wins; the tie keeps the earlier bid.
    assert_eq!((a.state, a.winner.clone(), a.winning_amount_units, a.claim_deadline), (PendingClaim, Some(acct(BIDDERS[1])), 150_000_000, END + 320));
    assert_eq!(a.output_hash, Some(env::sha256_array(&output)));
    assert!(!c.apply_solve(id, rid, Some(output))); // a replayed result is stale

    // The winner pays the remainder and receives the unit in the same call; the deposit is consumed.
    at(TOKEN, END + 30, 0);
    c.ft_on_transfer(acct(BIDDERS[1]), U128(150_000_000 - DEPOSIT), json!({ "action": "claim", "auction_id": id }).to_string());
    assert_eq!((c.auction(id).state, owner_of(&c, "1")), (Finalized, Some(acct(BIDDERS[1]))));
    assert!(!c.is_refundable(id, acct(BIDDERS[1])));
    // The list views a catalogue page uses.
    let lots = c.get_auctions(None, None);
    assert_eq!((lots.len(), &lots[0]["state"], &lots[0]["asset"]["owner"]), (1, &json!("Finalized"), &json!(BIDDERS[1])));
    assert_eq!(c.get_assets(None, None)[0]["tokenId"], "1");
    assert_eq!(c.get_bids_of(acct(BIDDERS[1])), vec![json!({ "auctionId": id, "bidIndex": 1, "depositStatus": "Consumed" })]);
    assert!(c.get_bids_of(acct(SELLER)).is_empty() && c.get_auctions(Some(2), None).is_empty());
    for who in [BIDDERS[0], BIDDERS[2]] {
        at(who, END + 40, 0);
        assert!(c.is_refundable(id, acct(who)));
        c.claim_refund(id);
        assert!(!c.is_refundable(id, acct(who)));
    }
    assert_eq!(c.total_locked_deposits, 0);

    // A payout whose transfer fails stays owed and can be withdrawn later.
    testing_env!(VMContextBuilder::new().current_account_id(acct(ME)).build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
    assert!(!c.on_paid(acct(SELLER), U128(150_000_000)));
    assert_eq!((c.get_credit(acct(SELLER)).0, c.total_credits), (150_000_000, 150_000_000));
    at(SELLER, END + 50, 0);
    c.withdraw_credit();
    assert_eq!((c.get_credit(acct(SELLER)).0, c.total_credits), (0, 0));
    fails("NothingToWithdraw", || c.withdraw_credit());
    at(BIDDERS[0], END + 60, 0);
    fails("AlreadyRefunded", || c.claim_refund(id));
    at(BIDDERS[1], END + 60, 0);
    fails("NotRefundable", || c.claim_refund(id));
}

#[test]
fn no_valid_bid_cancels_and_everything_returns() {
    let mut c = setup();
    let (id, key_id) = listed(&mut c);
    bid(&mut c, id, BIDDERS[0], DEPOSIT, &seal(id, BIDDERS[0], &key_id, RESERVE - 1)); // readable, below reserve
    bid(&mut c, id, BIDDERS[1], DEPOSIT, &unreadable_envelope(3));
    let rid = request_settlement(&mut c, id);
    let output = solve(&c, id);
    at(ME, END + 20, 0);
    assert!(c.apply_solve(id, rid, Some(output)));
    assert_eq!((c.auction(id).state, c.auction(id).cancel_reason), (Cancelled, CancelReason::NoValidBid));
    for who in &BIDDERS[..2] {
        at(who, END + 30, 0);
        c.claim_refund(id);
    }
    at(SELLER, END + 30, 0);
    c.claim_returned_asset(id);
    assert_eq!((owner_of(&c, "1"), c.total_locked_deposits), (Some(acct(SELLER)), 0));
    fails("AlreadyClaimed", || c.claim_returned_asset(id));
}

#[test]
fn winner_default_forfeits_the_deposit_to_the_seller() {
    let mut c = setup();
    let (id, key_id) = listed(&mut c);
    bid(&mut c, id, BIDDERS[0], DEPOSIT, &seal(id, BIDDERS[0], &key_id, 130_000_000));
    bid(&mut c, id, BIDDERS[1], DEPOSIT, &seal(id, BIDDERS[1], &key_id, 110_000_000));
    let rid = request_settlement(&mut c, id);
    let output = solve(&c, id);
    at(ME, END + 20, 0);
    assert!(c.apply_solve(id, rid, Some(output)));

    at(TOKEN, END + 30, 0);
    let claim = json!({ "action": "claim", "auction_id": id }).to_string();
    fails("InvalidPayment", || c.ft_on_transfer(acct(BIDDERS[0]), U128(1), claim.clone()));
    fails("NotWinner", || c.ft_on_transfer(acct(BIDDERS[1]), U128(120_000_000), claim.clone()));
    fails("NotWinner", || c.claim_win(id)); // the token contract is not the winner either
    at("anyone.testnet", END + 319, 0);
    fails("ClaimWindowOpen", || c.expire_claim(id));
    at(TOKEN, END + 320, 0);
    fails("DeadlinePassed", || c.ft_on_transfer(acct(BIDDERS[0]), U128(120_000_000), claim.clone()));

    at("anyone.testnet", END + 320, 0);
    c.expire_claim(id);
    assert_eq!((c.auction(id).state, c.auction(id).cancel_reason), (Cancelled, CancelReason::WinnerDefault));
    assert_eq!((c.get_credit(acct(SELLER)).0, c.total_locked_deposits), (DEPOSIT, DEPOSIT)); // the loser's deposit is still locked
    at(BIDDERS[1], END + 330, 0);
    c.claim_refund(id);
    at(BIDDERS[0], END + 330, 0);
    fails("AlreadyRefunded", || c.claim_refund(id)); // forfeited, not refundable
}

#[test]
fn failed_runs_retry_and_the_deadline_frees_everyone() {
    let mut c = setup();
    let (id, key_id) = listed(&mut c);
    bid(&mut c, id, BIDDERS[0], DEPOSIT, &seal(id, BIDDERS[0], &key_id, 130_000_000));
    at("anyone.testnet", END - 1, FEE);
    fails("AuctionNotEnded", || c.request_settlement(id));

    let first = request_settlement(&mut c, id);
    at("anyone.testnet", END + 10, FEE);
    fails("AttemptNotTimedOut", || c.retry_settlement(id));
    // OutLayer times out: the callback sees a failed promise, and the retry need not wait for the attempt timeout.
    at(ME, END + 20, 0);
    assert!(!c.apply_solve(id, first, None));
    assert_eq!(c.auction(id).last_error.as_deref(), Some("outlayer request_execution failed"));
    at("anyone.testnet", END + 21, FEE);
    let second = h256(&c.retry_settlement(id));
    assert_ne!(first, second);

    // A late answer to the first attempt is stale; a result bound to another digest is refused.
    let good = solve(&c, id);
    let mut forged: Value = serde_json::from_slice(&good).unwrap();
    forged["bidDigest"] = json!(hex0x(&[1u8; 32]));
    at(ME, END + 40, 0);
    assert!(!c.apply_solve(id, first, Some(good)));
    assert!(!c.apply_solve(id, second, Some(forged.to_string().into_bytes())));
    assert_eq!((c.auction(id).state, c.auction(id).last_error.as_deref()), (Ended, Some("bidDigest mismatch")));

    assert!(!c.apply_solve(id, second, Some(b"null".to_vec()))); // OutLayer's own timeout answer
    assert_eq!(c.auction(id).last_error.as_deref(), Some("unexpected solver output: null"));
    // A solver fatal counts as a failed attempt too. After the third attempt nothing is left but the deadline.
    at("anyone.testnet", END + 41, FEE);
    let third = h256(&c.retry_settlement(id));
    at(ME, END + 60, 0);
    assert!(!c.apply_solve(id, third, Some(br#"{"fatal":{"code":"KEY_UNAVAILABLE"}}"#.to_vec())));
    for t in 4..=MAX_ATTEMPTS as u64 {
        at("anyone.testnet", END + 60 + t, FEE);
        let rid = h256(&c.retry_settlement(id));
        at(ME, END + 60 + t, 0);
        assert!(!c.apply_solve(id, rid, None));
    }
    at("anyone.testnet", END + 99, FEE);
    fails("MaxAttemptsReached", || c.retry_settlement(id));
    at("anyone.testnet", END + SETTLEMENT_GRACE - 1, 0);
    fails("DeadlineNotReached", || c.cancel_after_solver_timeout(id));
    at("anyone.testnet", END + SETTLEMENT_GRACE, 0);
    c.cancel_after_solver_timeout(id);
    assert_eq!(c.auction(id).cancel_reason, CancelReason::SolverTimeout);
    at(BIDDERS[0], END + SETTLEMENT_GRACE, 0);
    c.claim_refund(id);
    assert_eq!(c.total_locked_deposits, 0);
}

#[test]
fn entry_rules_refuse_bad_bids_and_callers() {
    let mut c = setup();
    let (id, _) = listed(&mut c);
    let envelope = unreadable_envelope(3);
    let msg = json!({ "action": "bid", "auction_id": id, "envelope": hex0x(&envelope) }).to_string();
    at(BIDDERS[0], T0 + 120, 0);
    fails("UnexpectedToken", || c.ft_on_transfer(acct(BIDDERS[0]), U128(DEPOSIT), msg.clone())); // only the payment token
    at(TOKEN, T0 + 120, 0);
    fails("InvalidMessage", || c.ft_on_transfer(acct(BIDDERS[0]), U128(DEPOSIT), "{}".into()));
    fails("NotEligible", || c.ft_on_transfer(acct("stranger.testnet"), U128(DEPOSIT), msg.clone()));
    fails("SellerCannotBid", || c.ft_on_transfer(acct(SELLER), U128(DEPOSIT), msg.clone()));
    fails("InvalidDeposit", || c.ft_on_transfer(acct(BIDDERS[0]), U128(DEPOSIT + 1), msg.clone()));
    fails("InvalidEnvelopeLength", || c.ft_on_transfer(acct(BIDDERS[0]), U128(DEPOSIT), msg.replace("0x01", "0x02")));
    bid(&mut c, id, BIDDERS[0], DEPOSIT, &envelope);
    fails("DuplicateBid", || c.ft_on_transfer(acct(BIDDERS[0]), U128(DEPOSIT), msg.clone()));

    at(SELLER, T0 + 130, 1);
    fails("AssetBusy", || c.nft_transfer(acct(BIDDERS[1]), "1".into(), None, None)); // escrowed units do not move
    at(SELLER, T0 + 130, 0);
    fails("WrongState", || c.cancel_auction(id)); // not once a bid is in
    fails("KeyAlreadyConsumed", || c.create_auction("1".into(), U128(RESERVE), U128(DEPOSIT), 0, END, hex0x(&c.auction(id).key_id)));
    at(BIDDERS[1], T0 + 130, 0);
    fails("AttachExecutionDeposit", || c.prepare_auction_key(hex0x(&[1; 32]))); // the caller pays for compute
    at("stranger.testnet", T0 + 130, FEE);
    fails("NotEligible", || c.prepare_auction_key(hex0x(&[1; 32])));
    at(TOKEN, END, 0);
    fails("AuctionClosed", || c.ft_on_transfer(acct(BIDDERS[1]), U128(DEPOSIT), msg.clone()));
    at(ADMIN, T0 + 140, 0);
    c.set_entry_paused(true);
    at(TOKEN, T0 + 140, 0);
    fails("EntryPaused", || c.ft_on_transfer(acct(BIDDERS[1]), U128(DEPOSIT), msg.clone()));
}

#[test]
fn keys_bind_once_and_failed_runs_can_be_redispatched() {
    let mut c = setup();
    at(SELLER, T0, FEE);
    let krid = c.prepare_auction_key(hex0x(&[7; 32]));
    assert_ne!(krid, c.prepare_auction_key(hex0x(&[7; 32]))); // the nonce separates requests with one salt
    fails("DispatchPending", || c.redispatch_key(krid.clone()));
    at(ME, T0 + 130, 0);
    assert!(!c.apply_key(h256(&krid), Some(b"null".to_vec()))); // OutLayer's yield timed out
    assert_eq!(c.get_key(krid.clone()).unwrap()["status"], "Failed");
    at("keeper.testnet", T0 + 131, FEE);
    c.redispatch_key(krid.clone());

    let spki = unb64(vectors()["publicKeySpkiBase64"].as_str().unwrap()).unwrap();
    let key = |key_id: H256| Some(json!({ "keyId": hex0x(&key_id), "spki": b64(&spki), "sealedBlob": b64(b"blob") }).to_string().into_bytes());
    at(ME, T0 + 160, 0);
    assert!(!c.apply_key(h256(&krid), key([1u8; 32]))); // keyId must be sha256(spki)
    assert!(c.apply_key(h256(&krid), key(env::sha256_array(&spki))));
    assert!(!c.apply_key(h256(&krid), key(env::sha256_array(&spki)))); // a second answer changes nothing
    let k = c.get_key(krid.clone()).unwrap();
    assert_eq!((&k["status"], &k["owner"], &k["publicKeySpki"]), (&json!("Ready"), &json!(SELLER), &json!(b64(&spki))));
    assert_eq!(c.get_key_by_key_id(k["keyId"].as_str().unwrap().into()).unwrap()["keyRequestId"], krid);

    // Only the owner can spend a key, and only on a unit they hold.
    at(BIDDERS[0], T0 + 170, 0);
    fails("KeyNotReady", || c.create_auction("1".into(), U128(RESERVE), U128(DEPOSIT), 0, T0 + 900, k["keyId"].as_str().unwrap().into()));
}

#[test]
fn registry_and_asset_rules() {
    let mut c = setup();
    at(REGISTRAR, T0, 0);
    fails("UniquenessBound", || c.register_participant(acct("dave.testnet"), hex0x(&[2; 32]), T0 + 100, 2, hex0x(&[9; 32]))); // alice's identity
    fails("UniquenessBound", || c.register_participant(acct(BIDDERS[0]), hex0x(&[8; 32]), T0 + 100, 2, hex0x(&[9; 32]))); // no rotation
    fails("InvalidValidity", || c.register_participant(acct("dave.testnet"), hex0x(&[8; 32]), T0 + 31 * 86_400, 1, hex0x(&[9; 32])));
    fails("InvalidAssurance", || c.register_participant(acct("dave.testnet"), hex0x(&[8; 32]), T0 + 100, 3, hex0x(&[9; 32])));
    c.register_participant(acct(VERIFIER), hex0x(&[8; 32]), T0 + 100, 1, hex0x(&[9; 32]));
    at(SELLER, T0, 0);
    fails("Unauthorized", || c.register_participant(acct("dave.testnet"), hex0x(&[7; 32]), T0 + 100, 2, hex0x(&[9; 32])));
    // Self-registration with simulator assurance, only where the deployment allows the simulator, never after a revocation.
    at("erin.testnet", T0, 0);
    c.register_simulated();
    assert!(c.is_eligible(acct("erin.testnet")));
    assert_eq!(c.get_participant(acct("erin.testnet")).unwrap()["assurance"], 2);
    at(REGISTRAR, T0, 0);
    c.revoke_participant(acct("erin.testnet"), hex0x(&[4; 32]));
    at("erin.testnet", T0, 0);
    fails("Revoked", || c.register_simulated());
    c.allow_simulator = false;
    at("frank.testnet", T0, 0);
    fails("InvalidAssurance", || c.register_simulated());
    c.allow_simulator = true;
    at(SELLER, T0 + 86_400, 0);
    assert!(!c.is_eligible(acct(SELLER))); // expired
    at(REGISTRAR, T0, 0);
    c.revoke_participant(acct(BIDDERS[2]), hex0x(&[4; 32]));
    assert!(c.is_eligible(acct(BIDDERS[0])) && !c.is_eligible(acct(BIDDERS[2])) && !c.is_eligible(acct("dave.testnet")));

    at(BIDDERS[2], T0, 0);
    fails("NotEligible", || c.register_asset("ipfs://x".into(), hex0x(&[5; 32])));
    at(SELLER, T0, 0);
    fails("InvalidMetadata", || c.register_asset("".into(), hex0x(&[5; 32])));
    let (kept, rejected) = (c.register_asset("ipfs://a".into(), hex0x(&[5; 32])), c.register_asset("ipfs://b".into(), hex0x(&[5; 32])));
    fails("Unauthorized", || c.verify_and_mint(kept.clone(), hex0x(&[6; 32])));
    at(VERIFIER, T0, 0);
    let own = c.register_asset("ipfs://c".into(), hex0x(&[5; 32]));
    fails("ReviewerIsIssuer", || c.verify_and_mint(own.clone(), hex0x(&[6; 32])));
    c.reject_asset(rejected.clone(), hex0x(&[4; 32]));
    c.verify_and_mint(kept.clone(), hex0x(&[6; 32]));
    fails("WrongState", || c.verify_and_mint(kept.clone(), hex0x(&[6; 32])));
    assert_eq!((c.nft_token(rejected), owner_of(&c, &kept)), (None, Some(acct(SELLER))));

    // The holder can move the unit and burn it; nobody else can.
    at(BIDDERS[0], T0, 1);
    fails("NotHolder", || c.nft_transfer(acct(BIDDERS[1]), kept.clone(), None, None));
    at(SELLER, T0, 1);
    c.nft_transfer(acct(BIDDERS[0]), kept.clone(), None, None);
    assert_eq!(c.nft_tokens_for_owner(acct(BIDDERS[0]), None, None)[0]["token_id"], kept);
    assert!(c.nft_tokens_for_owner(acct(SELLER), None, None).is_empty());
    at(SELLER, T0, 0);
    fails("NotHolder", || c.redeem(kept.clone()));
    at(BIDDERS[0], T0, 0);
    c.redeem(kept.clone());
    assert_eq!((owner_of(&c, &kept), c.get_asset(kept.clone()).unwrap()["redeemed"].clone()), (None, json!(true)));
    fails("AlreadyRedeemed", || c.redeem(kept.clone()));
}
