//! Cross-language acceptance (spec 15 §12): the Rust solver reproduces protocol-vectors.json byte for byte.
use base64::Engine;
use maskbid_private_solver::*;
use rsa::pkcs8::DecodePrivateKey;
use rsa::RsaPrivateKey;
use serde_json::Value;

fn vectors() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/protocol/vectors/protocol-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("vectors file")).unwrap()
}
fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}
fn fixture() -> (Value, SettlementRequest, Manifest, RsaPrivateKey) {
    let v = vectors();
    let req: SettlementRequest = serde_json::from_value(v["request"].clone()).unwrap();
    let man: Manifest = serde_json::from_value(v["manifest"].clone()).unwrap();
    let key = RsaPrivateKey::from_pkcs8_pem(s(&v["testPrivateKeyPkcs8Pem"])).unwrap();
    (v, req, man, key)
}

#[test]
fn hashes_match_vectors() {
    let (v, req, _, _) = fixture();
    let spki = base64::engine::general_purpose::STANDARD.decode(s(&v["publicKeySpkiBase64"])).unwrap();
    assert_eq!(hex_lower(&key_id_of(&spki)), req.key_id, "keyId = sha256(spki)");
    let d = domain_of(&req).unwrap();
    let key_id = parse_h256(&req.key_id).unwrap();
    assert_eq!(hex_lower(&initial_digest(&d, &key_id)), s(&v["initialDigest"]));
    let mut digest = initial_digest(&d, &key_id);
    for (i, b) in v["bids"].as_array().unwrap().iter().enumerate() {
        let bidder = parse_addr(s(&b["bidder"])).unwrap();
        let envelope = parse_hex(s(&b["envelope"])).unwrap();
        assert_eq!(hex_lower(&aad_hash(&d, &bidder, &key_id)), s(&b["aad"]), "aad {i}");
        let c = bid_commitment(&d, &bidder, &key_id, &envelope);
        assert_eq!(hex_lower(&c), s(&b["commitment"]), "commitment {i}");
        digest = next_digest(&digest, i as u32, &bidder, &c);
        assert_eq!(hex_lower(&digest), s(&b["digestAfter"]), "digest {i}");
    }
    let rid = request_id_hash(&d, &parse_h256(&req.bid_digest).unwrap(), req.bid_count, req.attempt, &parse_h256(&req.config_hash).unwrap());
    assert_eq!(hex_lower(&rid), req.request_id);
}

#[test]
fn decrypts_fixture_envelopes() {
    let (v, req, _, key) = fixture();
    let d = domain_of(&req).unwrap();
    let key_id = parse_h256(&req.key_id).unwrap();
    for b in v["bids"].as_array().unwrap() {
        let bidder = parse_addr(s(&b["bidder"])).unwrap();
        let envelope = parse_hex(s(&b["envelope"])).unwrap();
        let amount = decrypt_bid(&key, &envelope, &d, &bidder, &key_id).expect("decrypts");
        assert_eq!(uint_to_string(&amount), s(&b["amountUnits"]));
        // wrong bidder in AAD/plaintext domain -> generic failure
        let other = parse_addr("0x9999999999999999999999999999999999999999").unwrap();
        assert!(decrypt_bid(&key, &envelope, &d, &other, &key_id).is_none());
    }
}

#[test]
fn result_is_byte_identical() {
    let (v, req, man, key) = fixture();
    let result = solve(&req, &man, &key).unwrap();
    let expected: SettlementResult = serde_json::from_value(v["result"].clone()).unwrap();
    assert_eq!(result, expected);
    // Canonical serializer order of spec 15 §10 (RESULT_FIELDS in packages/protocol/src/solver.ts), independent of serde's order.
    let order = ["protocolVersion", "chainId", "auctionContract", "auctionId", "requestId", "attempt", "bidDigest", "bidCount", "keyId",
        "solverCodeHash", "configHash", "outcome", "winner", "winningAmountUnits", "validBidCount", "invalidBidCount"];
    let expected_json = format!("{{{}}}", order.iter().map(|k| format!("\"{k}\":{}", v["result"][k])).collect::<Vec<_>>().join(","));
    assert_eq!(canonical_result(&result), expected_json);
    assert!(canonical_result(&result).len() < 850, "result must fit the 1 KiB resume payload with headroom");
}

#[test]
fn incomplete_or_tampered_sets_are_fatal_never_partial() {
    let (_, req, man, key) = fixture();
    let mut missing = man.clone();
    missing.bids.pop();
    assert_eq!(solve(&req, &missing, &key).unwrap_err().code, "MANIFEST_INCOMPLETE");
    let mut reordered = man.clone();
    reordered.bids.swap(0, 1);
    assert_eq!(solve(&req, &reordered, &key).unwrap_err().code, "MANIFEST_INCOMPLETE");
    let mut tampered = man.clone();
    tampered.bids[1].envelope = format!("0x{}ff", &tampered.bids[1].envelope[2..tampered.bids[1].envelope.len() - 2]);
    assert_eq!(solve(&req, &tampered, &key).unwrap_err().code, "COMMITMENT_MISMATCH");
    let mut wrong_req = req.clone();
    wrong_req.attempt = 2;
    assert_eq!(solve(&wrong_req, &man, &key).unwrap_err().code, "DOMAIN_MISMATCH");
}

#[test]
fn reserve_tie_and_no_sale_rules() {
    let (_, req, man, key) = fixture();
    // bids are 150 / 120 / 150: tie keeps the earliest index (bid 0)
    let r = solve(&req, &man, &key).unwrap();
    assert_eq!(r.winner, man.bids[0].bidder);
    assert_eq!(r.valid_bid_count, 3);
    let mut high_reserve = req.clone();
    high_reserve.reserve_units = "150000001".into();
    let r = solve(&high_reserve, &man, &key).unwrap();
    assert_eq!((r.outcome.as_str(), r.winner.as_str(), r.winning_amount_units.as_str(), r.valid_bid_count, r.invalid_bid_count), ("NO_SALE", ZERO_ADDRESS, "0", 0, 3));
    let mut mid_reserve = req.clone();
    mid_reserve.reserve_units = "130000000".into();
    let r = solve(&mid_reserve, &man, &key).unwrap();
    assert_eq!((r.valid_bid_count, r.invalid_bid_count), (2, 1));
}

#[test]
fn key_regeneration_is_deterministic_and_sealed_record_roundtrips() {
    let seed = [7u8; 32];
    let a = rsa_from_seed(&seed);
    let b = rsa_from_seed(&seed);
    assert_eq!(spki_der(&a), spki_der(&b));
    assert_ne!(spki_der(&a), spki_der(&rsa_from_seed(&[8u8; 32])));
    assert_eq!(spki_der(&a).len(), 294, "RSA-2048 SPKI DER");
    assert_eq!(open_record(&seal_record(&seed)), Some(seed));
    assert!(open_record(&[0u8; 33]).is_none());
    assert_eq!(sealing_aad(&[1; 32], &[2; 20], &[3; 32], &[4; 32]).len(), 116);
}
