#!/usr/bin/env python3
"""Publish a wasm to FastFS (testnet) from a NEAR account: one `__fastdata_fastfs` call on the receiver account,
borsh FastfsData::Simple { relative_path, Some(FastfsFileContent { mime_type, content }) }.
Usage: scripts/fastfs-upload.py <wasm> <sender.testnet> [receiver=outlayer.testnet]
Prints the FastFS URL and SHA-256. The gas is intentionally tiny: the data is indexed from the transaction args."""
import hashlib, struct, subprocess, sys, tempfile, os

wasm, sender = sys.argv[1], sys.argv[2]
receiver = sys.argv[3] if len(sys.argv) > 3 else "outlayer.testnet"
content = open(wasm, "rb").read()
assert len(content) <= 1 << 20, "over 1 MiB: needs the chunked Partial variant"
sha = hashlib.sha256(content).hexdigest()
path = f"{sha}.wasm"
s = lambda t: struct.pack("<I", len(t)) + t
payload = b"\x00" + s(path.encode()) + b"\x01" + s(b"application/wasm") + s(content)
with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as f:
    f.write(payload); tmp = f.name
cmd = ["near", "contract", "call-function", "as-transaction", receiver, "__fastdata_fastfs", "file-args", tmp,
       "prepaid-gas", "1 Ggas", "attached-deposit", "0 NEAR", "sign-as", sender, "network-config", "testnet",
       "sign-with-legacy-keychain", "send"]
r = subprocess.run(cmd, capture_output=True, text=True)
os.unlink(tmp)
out = r.stdout + r.stderr
tx = next((l.split("Transaction ID:")[1].strip().split()[0] for l in out.splitlines() if "Transaction ID:" in l), None)
print(f"sha256: {sha}\ntx: {tx}\nurl: https://{sender}.fastfs.io/{receiver}/{path}\nalt: https://test.fastfs.io/{sender}/{receiver}/{path}")
if not tx:
    print(out[-3000:]); sys.exit(1)
