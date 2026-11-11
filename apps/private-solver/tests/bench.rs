//! Native solver benchmark, driven by `node scripts/bench.mjs` (fixtures are generated there). Ignored by default.
use maskbid_private_solver::*;
use rsa::pkcs8::DecodePrivateKey;
use rsa::RsaPrivateKey;
use serde_json::{json, Value};
use std::time::Instant;

fn stats(mut ms: Vec<f64>) -> Value {
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |p: f64| ms[((p * ms.len() as f64).ceil() as usize).clamp(1, ms.len()) - 1];
    json!({ "samples": ms.len(), "p50_ms": (at(0.5) * 100.0).round() / 100.0, "p95_ms": (at(0.95) * 100.0).round() / 100.0 })
}

#[test]
#[ignore]
fn bench() {
    let dir = std::env::var("BENCH_DIR").expect("BENCH_DIR");
    let samples: usize = std::env::var("BENCH_SAMPLES").ok().and_then(|s| s.parse().ok()).unwrap_or(20);
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../packages/protocol/vectors/protocol-vectors.json")).unwrap()).unwrap();
    let key = RsaPrivateKey::from_pkcs8_pem(vectors["testPrivateKeyPkcs8Pem"].as_str().unwrap()).unwrap();
    let mut out = serde_json::Map::new();
    for n in [1, 3, 32] {
        let f: Value = serde_json::from_str(&std::fs::read_to_string(format!("{dir}/bench-{n}.json")).unwrap()).unwrap();
        let req: SettlementRequest = serde_json::from_value(f["request"].clone()).unwrap();
        let man: Manifest = serde_json::from_value(f["manifest"].clone()).unwrap();
        let r = solve(&req, &man, &key).ok().expect("solves");
        assert_eq!(r.winning_amount_units, (100_000_000u64 + (n as u64 - 1) * 1_000_000).to_string());
        let t: Vec<f64> = (0..samples).map(|_| { let t0 = Instant::now(); solve(&req, &man, &key).ok().unwrap(); t0.elapsed().as_secs_f64() * 1e3 }).collect();
        out.insert(format!("solve_{n}_bids"), stats(t));
    }
    let keygen: Vec<f64> = (0..samples.min(10)).map(|i| { let mut seed = [0u8; 32]; seed[0] = i as u8 + 1; let t0 = Instant::now(); let k = rsa_from_seed(&seed); let _ = spki_der(&k); t0.elapsed().as_secs_f64() * 1e3 }).collect();
    out.insert("keygen_rsa2048_from_seed".into(), stats(keygen));
    std::fs::write(format!("{dir}/rust.json"), Value::Object(out).to_string()).unwrap();
}
