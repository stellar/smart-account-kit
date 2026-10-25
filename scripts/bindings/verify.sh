#!/bin/bash

# Bindings Parity Verification
#
# Regenerates the TypeScript bindings from the canonical testnet WASM hash and
# diffs them against the checked-in packages/smart-account-kit-bindings/src/index.ts.
# Exits non-zero on any drift so CI/pre-publish can catch stale bindings.
#
# Overridable via env: ACCOUNT_WASM_HASH, STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
BINDINGS_DIR="$KIT_DIR/packages/smart-account-kit-bindings"
CHECKED_IN="$BINDINGS_DIR/src/index.ts"

# Canonical testnet WASM hash for the multisig-account-example, built from
# OpenZeppelin/stellar-contracts v0.8.0 (Rust 1.91.1, Stellar CLI 28.1.0,
# `stellar contract build --locked --optimize=true`). The bindings target the
# newest account surface; older builds expose a subset of it.
CANONICAL_WASM_HASH="${ACCOUNT_WASM_HASH:-c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

if ! command -v stellar &> /dev/null; then
    echo -e "${RED}Error: stellar CLI not found${NC}" >&2
    exit 1
fi

if [ ! -f "$CHECKED_IN" ]; then
    echo -e "${RED}Error: checked-in bindings not found: $CHECKED_IN${NC}" >&2
    exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
# The stellar CLI validates the --output-dir basename as an npm package name
# (lowercase only), so generate into a fixed lowercase subdirectory.
OUT_DIR="$TMP_DIR/smart-account-kit-bindings"

echo -e "${BLUE}Verifying bindings parity${NC}"
echo -e "  wasm-hash:   ${GREEN}$CANONICAL_WASM_HASH${NC}"
echo -e "  network:     ${GREEN}$PASSPHRASE${NC}"
echo ""

echo -e "${YELLOW}Regenerating bindings from the canonical WASM hash...${NC}"
stellar contract bindings typescript \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$PASSPHRASE" \
    --wasm-hash "$CANONICAL_WASM_HASH" \
    --output-dir "$OUT_DIR" \
    --overwrite

# Apply the same post-processing build.sh does (strip trailing whitespace) so the
# diff compares like with like.
node -e "
const fs = require('fs');
const p = '$OUT_DIR/src/index.ts';
fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/[ \\t]+\$/gm, ''));
"

if diff -u "$CHECKED_IN" "$OUT_DIR/src/index.ts"; then
    echo ""
    echo -e "${GREEN}Bindings are in parity with the canonical WASM hash.${NC}"
else
    echo ""
    echo -e "${RED}DRIFT: checked-in bindings differ from the canonical WASM hash.${NC}" >&2
    echo -e "${RED}Regenerate with scripts/bindings/build.sh, review the diff, and commit.${NC}" >&2
    exit 1
fi
