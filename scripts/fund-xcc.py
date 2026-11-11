#!/usr/bin/env python3
"""Create and fund the XCC router sub-account `<hex(auction)>.aurora` for an Aurora contract address, from a NEAR
account, with the engine's `fund_xcc_sub_account` (borsh FundXccArgs { target: [u8;20], wnear_account_id: None }).
After this the contract's XCC promises need no wNEAR (attached_balance is 0).
Usage: scripts/fund-xcc.py <0xauction> <signer.testnet> [deposit NEAR=2.5] [engine=aurora]"""
import subprocess, sys, tempfile, os, re

addr = sys.argv[1].lower().removeprefix("0x")
signer = sys.argv[2]
deposit = sys.argv[3] if len(sys.argv) > 3 else "2.5"
engine = sys.argv[4] if len(sys.argv) > 4 else "aurora"
assert len(addr) == 40
with tempfile.NamedTemporaryFile(delete=False, suffix=".bin") as f:
    f.write(bytes.fromhex(addr) + b"\x00"); tmp = f.name
r = subprocess.run(["near", "contract", "call-function", "as-transaction", engine, "fund_xcc_sub_account", "file-args", tmp,
                    "prepaid-gas", "100 Tgas", "attached-deposit", f"{deposit} NEAR", "sign-as", signer, "network-config", "testnet",
                    "sign-with-legacy-keychain", "send"], capture_output=True, text=True)
os.unlink(tmp)
text = re.sub(r"\x1b\[[0-9;]*m", "", r.stdout + r.stderr)
tx = re.search(r"Transaction ID: (\S+)", text)
print(f"router: {addr}.{engine}\ntx: {tx.group(1) if tx else None}\nexit: {r.returncode}")
if r.returncode != 0 or not tx:
    print(text[-3000:]); sys.exit(1)
