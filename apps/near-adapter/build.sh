#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --target wasm32-unknown-unknown --release
mkdir -p dist
cp target/wasm32-unknown-unknown/release/maskbid_near_adapter.wasm dist/maskbid-near-adapter.wasm
echo "wasm: dist/maskbid-near-adapter.wasm ($(stat -f%z dist/maskbid-near-adapter.wasm) bytes)"
shasum -a 256 dist/maskbid-near-adapter.wasm
