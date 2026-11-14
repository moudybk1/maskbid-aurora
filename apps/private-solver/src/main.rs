//! OutLayer guest entry point. Modes (stdin JSON -> stdout JSON):
//!   INIT_KEY      generate an RSA-OAEP-2048 key, seal its seed with the host key `auction_keys`
//!                 (bound to this exact wasm build and the predecessor that called OutLayer), return SPKI + sealed blob.
//!   SOLVE         open the sealed seed, regenerate the key, validate the complete manifest, rank, return the result.
//!   UNSEAL_PROBE  report only whether a sealed blob opens here (never returns key material). Used for the G-02 negatives.
//! The trusted caller comes from the host (`NEAR_PREDECESSOR_ID`), never from the input.
use base64::Engine;
use maskbid_private_solver::*;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use zeroize::Zeroize;

/// Embedded `outlayer.manifest` custom section: covered by the wasm SHA-256 the adapter pins.
#[cfg(all(target_arch = "wasm32", not(feature = "probe")))]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");
#[cfg(all(target_arch = "wasm32", feature = "probe"))]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.probe.json").len()] = *include_bytes!("../manifest.probe.json");

/// The only account that may run this build: the MaskBid contract, which calls OutLayer itself.
/// Must match manifest.json `callers.contract.only`.
const PINNED_CALLER: &str = "maskbid-v2.testnet";
const KEY_PATH: &str = "auction_keys";
const MAX_INPUT_BYTES: usize = 128 * 1024;

#[cfg(target_arch = "wasm32")]
mod host {
    wit_bindgen::generate!({ world: "encryption-keys-host", path: "wit" });
    pub use outlayer::encryption_keys::api::{decrypt, encrypt};
}
#[cfg(not(target_arch = "wasm32"))]
mod host {
    // Native builds exist for `cargo test` of the pure library only; sealing needs the TEE host.
    pub fn encrypt(_: &str, _: Option<&str>, _: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
        Err("sealing requires the OutLayer host".into())
    }
    pub fn decrypt(_: &str, _: Option<&str>, _: &[u8], _: &[u8]) -> Result<Vec<u8>, String> {
        Err("sealing requires the OutLayer host".into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    mode: String,
    key_request_id: String,
    owner: String,
    #[serde(default)]
    solver_code_hash: Option<String>,
    #[serde(default)]
    config_hash: Option<String>,
    #[serde(default)]
    sealed_blob: Option<String>,
    #[serde(default)]
    key_id: Option<String>,
    #[serde(default)]
    request: Option<SettlementRequest>,
    #[serde(default)]
    manifest: Option<Manifest>,
}

fn emit(bytes: &[u8]) -> ! {
    let mut out = std::io::stdout();
    let _ = out.write_all(bytes);
    let _ = out.flush();
    std::process::exit(0)
}
fn emit_json(v: Value) -> ! {
    emit(v.to_string().as_bytes())
}
fn fatal(code: &str, request_id: &str, retryable: bool, detail: &str) -> ! {
    emit_json(json!({ "fatal": { "code": code, "requestId": request_id, "retryable": retryable, "detail": detail } }))
}
fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}
fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

fn main() {
    let mut raw = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut raw);
    if raw.len() > MAX_INPUT_BYTES {
        fatal("MANIFEST_UNAVAILABLE", "", false, "input exceeds 128 KiB");
    }
    let input: Input = match serde_json::from_slice(&raw) {
        Ok(i) => i,
        Err(_) => fatal("RUNTIME_FAILURE", "", false, "input is not the expected JSON"),
    };
    // Trusted caller: the account that called OutLayer, as reported by the host for this run (never the input).
    // The manifest's `callers.contract.only` already refuses other callers before this code runs; this is the in-code check.
    if !cfg!(feature = "probe") {
        match std::env::var("NEAR_PREDECESSOR_ID") {
            Ok(p) if p == PINNED_CALLER => {}
            Ok(_) => fatal("RUNTIME_FAILURE", "", false, "caller is not the pinned contract"),
            Err(_) if cfg!(target_arch = "wasm32") => fatal("RUNTIME_FAILURE", "", false, "no predecessor context"),
            Err(_) => {}
        }
    }
    let Some(key_request_id) = parse_h256(&input.key_request_id) else { fatal("RUNTIME_FAILURE", "", false, "keyRequestId") };
    let Some(owner) = parse_addr(&input.owner) else { fatal("RUNTIME_FAILURE", "", false, "owner") };
    let h256 = |v: &Option<String>, what: &str| -> H256 {
        match v.as_deref().and_then(parse_h256) {
            Some(h) => h,
            None => fatal("RUNTIME_FAILURE", "", false, what),
        }
    };

    match input.mode.as_str() {
        "INIT_KEY" => {
            let aad = sealing_aad(&key_request_id, &owner, &h256(&input.solver_code_hash, "solverCodeHash"), &h256(&input.config_hash, "configHash"));
            let mut seed = [0u8; 32];
            OsRng.fill_bytes(&mut seed); // host CSPRNG (wasi:random)
            let key = rsa_from_seed(&seed);
            let spki = spki_der(&key);
            let mut record = seal_record(&seed);
            seed.zeroize();
            let sealed = host::encrypt(KEY_PATH, None, &record, &aad);
            record.zeroize();
            drop(key);
            match sealed {
                Ok(blob) => emit_json(json!({ "keyId": hex_lower(&key_id_of(&spki)), "spki": b64(&spki), "sealedBlob": b64(&blob) })),
                Err(e) => fatal("KEY_UNAVAILABLE", "", true, &format!("seal: {e}")),
            }
        }
        "SOLVE" | "UNSEAL_PROBE" => {
            let probe = input.mode == "UNSEAL_PROBE";
            let (code_hash, config_hash, rid, expected_key_id) = if probe {
                (h256(&input.solver_code_hash, "solverCodeHash"), h256(&input.config_hash, "configHash"), String::new(), input.key_id.as_deref().and_then(parse_h256))
            } else {
                let Some(r) = input.request.as_ref() else { fatal("RUNTIME_FAILURE", "", false, "request") };
                (h256(&Some(r.solver_code_hash.clone()), "solverCodeHash"), h256(&Some(r.config_hash.clone()), "configHash"), r.request_id.clone(), parse_h256(&r.key_id))
            };
            let Some(blob) = input.sealed_blob.as_deref().and_then(unb64) else { fatal("KEY_UNAVAILABLE", &rid, false, "sealedBlob") };
            let aad = sealing_aad(&key_request_id, &owner, &code_hash, &config_hash);
            let opened = host::decrypt(KEY_PATH, None, &blob, &aad);
            if probe {
                let key_matches = opened.as_ref().ok().and_then(|r| open_record(r)).map(|s| {
                    let k = rsa_from_seed(&s);
                    Some(key_id_of(&spki_der(&k))) == expected_key_id
                });
                emit_json(json!({ "mode": "UNSEAL_PROBE", "unsealed": opened.is_ok(), "keyIdMatches": key_matches }));
            }
            let mut record = match opened {
                Ok(r) => r,
                Err(_) => fatal("KEY_UNAVAILABLE", &rid, false, "sealed key does not open for this code and caller"),
            };
            let Some(mut seed) = open_record(&record) else { fatal("KEY_UNAVAILABLE", &rid, false, "sealed record version") };
            record.zeroize();
            let key = rsa_from_seed(&seed);
            seed.zeroize();
            if Some(key_id_of(&spki_der(&key))) != expected_key_id {
                fatal("KEY_UNAVAILABLE", &rid, false, "regenerated key does not match request keyId");
            }
            let (Some(request), Some(manifest)) = (input.request.as_ref(), input.manifest.as_ref()) else {
                fatal("MANIFEST_UNAVAILABLE", &rid, true, "manifest missing")
            };
            match solve(request, manifest, &key) {
                Ok(result) => emit(canonical_result(&result).as_bytes()),
                Err(f) => emit_json(json!({ "fatal": f })),
            }
        }
        _ => fatal("RUNTIME_FAILURE", "", false, "unknown mode"),
    }
}
