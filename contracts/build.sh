#!/bin/bash
# Builds both contracts to dist/*.wasm and prints their SHA-256.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --target wasm32-unknown-unknown --release
mkdir -p dist
for c in maskbid mock_usdc; do
  cp "target/wasm32-unknown-unknown/release/$c.wasm" "dist/$c.wasm"
  echo "$(shasum -a 256 "dist/$c.wasm")  ($(stat -f%z "dist/$c.wasm") bytes)"
done
