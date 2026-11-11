#!/bin/bash
# Builds the OutLayer guest (wasm32-wasip2 component), checks the embedded manifest and imports,
# and prints the SHA-256 that becomes SOLVER_CODE_HASH / the WasmUrl hash.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
mkdir -p dist
if [ "${1:-}" = "probe" ]; then
  cargo build --target wasm32-wasip2 --release --features probe
  WASM=dist/maskbid-private-solver-probe.wasm
else
  cargo build --target wasm32-wasip2 --release
  WASM=dist/maskbid-private-solver.wasm
fi
cp target/wasm32-wasip2/release/maskbid-private-solver.wasm "$WASM"
grep -qa 'outlayer.manifest' "$WASM" || { echo "ERROR: outlayer.manifest section missing"; exit 1; }
grep -qa '"path": "auction_keys"' "$WASM" || { echo "ERROR: auction_keys key not declared"; exit 1; }
if command -v wasm-tools >/dev/null; then
  IMPORTS=$(wasm-tools component wit "$WASM" | grep -E '^\s*import ' || true)
  echo "$IMPORTS"
  grep -q 'outlayer:encryption-keys/api' <<<"$IMPORTS" || { echo "ERROR: does not import outlayer:encryption-keys"; exit 1; }
  FOREIGN=$(grep -vE 'wasi:|outlayer:encryption-keys/api' <<<"$IMPORTS" || true)
  [ -z "$FOREIGN" ] || { echo "ERROR: unexpected imports (a direct WasmUrl run refuses near:storage etc):"; echo "$FOREIGN"; exit 1; }
fi
SHA=$(shasum -a 256 "$WASM" | cut -d' ' -f1)
if [ "${1:-}" = "probe" ]; then echo "$SHA" > dist/SHA256.probe; grep -qa '"callers"' "$WASM" && { echo "ERROR: probe must not carry a callers gate"; exit 1; }; else echo "$SHA" > dist/SHA256; grep -qa '"callers"' "$WASM" || { echo "ERROR: callers gate missing"; exit 1; }; fi
echo "wasm: $WASM ($(stat -f%z "$WASM") bytes)"
echo "SOLVER_CODE_HASH=0x$SHA"
