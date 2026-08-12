#!/usr/bin/env bash
# Fund the drill wallets on the local ai-ctf chain, using anvil dev account 0.
#
#   scripts/fund-drill.sh                 # reads scripts/.funding-request.json
#   scripts/fund-drill.sh 0xADDR1 0xADDR2 # or pass addresses directly
#
# Overridable: ARENA_RPC, AMOUNT (e.g. AMOUNT=0.2ether).
set -euo pipefail

RPC="${ARENA_RPC:-http://127.0.0.1:8545}"
# Dev account 0 from the standard "test test ... junk" mnemonic. The ai-ctf
# Hardhat node and Anvil both give this account about 10000 ETH.
DEV_PRIVATE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
AMOUNT="${AMOUNT:-0.1ether}"
REQ="$(cd "$(dirname "$0")" && pwd)/.funding-request.json"

if ! command -v cast >/dev/null 2>&1; then
  echo "cast not found — install Foundry or add it to PATH" >&2; exit 1
fi

# Addresses: from args, else from the request file the drill wrote.
ADDRS=()
if [ "$#" -ge 2 ]; then
  ADDRS=("$1" "$2")
elif [ -f "$REQ" ]; then
  # bash 3.2 (macOS default) has no mapfile — word-split is safe for 0x addresses.
  ADDRS=( $(node -e "for (const e of require('$REQ').entries) console.log(e.address)") )
else
  echo "no addresses: pass two, or run demo-funding.ts first to write $REQ" >&2; exit 1
fi

if [ "${#ADDRS[@]}" -lt 1 ]; then echo "no addresses to fund" >&2; exit 1; fi

echo "→ rpc=$RPC · amount=$AMOUNT · payer=dev#0"
for a in "${ADDRS[@]}"; do
  echo "  send $AMOUNT → $a"
  cast send "$a" --value "$AMOUNT" --private-key "$DEV_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
done

# Automine puts each send in its own block; advance one more so the last
# funding tx clears head - confirmations(=1) and the watcher observes it.
# evm_mine works on both the ai-ctf Hardhat node and anvil (anvil_mine does not
# exist on Hardhat).
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
echo "✓ funded + mined a confirmation block"

for a in "${ADDRS[@]}"; do
  bal="$(cast from-wei "$(cast balance "$a" --rpc-url "$RPC")")"
  echo "  $a  ${bal} ETH"
done
