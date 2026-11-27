#!/bin/bash

# Bindings Parity Verification
#
# Regenerates the TypeScript bindings from the canonical testnet WASM hash and
# diffs them against the checked-in packages/smart-account-kit-bindings/src/.
# Exits non-zero on any drift so CI/pre-publish can catch stale bindings.
#
# Overridable via env: ACCOUNT_WASM_HASH, STELLAR_RPC_URL, STELLAR_NETWORK, STELLAR_NETWORK_PASSPHRASE.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
BINDINGS_DIR="$KIT_DIR/packages/smart-account-kit-bindings"
CHECKED_IN_DIR="$BINDINGS_DIR/src"

# Canonical testnet WASM hash for the multisig-account-example, built from
# OpenZeppelin/stellar-contracts v0.8.0 (Rust 1.91.1, Stellar CLI 28.1.0,
# `stellar contract build --locked --optimize=true`). The bindings target the
# newest account surface; older builds expose a subset of it.
CANONICAL_WASM_HASH="${ACCOUNT_WASM_HASH:-c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK="${STELLAR_NETWORK:-}"
if [ -z "$NETWORK" ] && [ -n "${STELLAR_NETWORK_PASSPHRASE:-}" ]; then
    case "$STELLAR_NETWORK_PASSPHRASE" in
        "Test SDF Network ; September 2015")
            NETWORK="testnet"
            ;;
        "Public Global Stellar Network ; September 2015")
            NETWORK="mainnet"
            ;;
        "Test SDF Future Network ; October 2022")
            NETWORK="futurenet"
            ;;
        "Standalone Network ; February 2017")
            NETWORK="localnet"
            ;;
        *)
            echo "Error: unrecognized STELLAR_NETWORK_PASSPHRASE (set STELLAR_NETWORK explicitly)" >&2
            exit 1
            ;;
    esac
fi
NETWORK="${NETWORK:-testnet}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}Error: pnpm not found${NC}" >&2
    exit 1
fi

if [ ! -d "$CHECKED_IN_DIR" ]; then
    echo -e "${RED}Error: checked-in bindings directory not found: $CHECKED_IN_DIR${NC}" >&2
    exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
OUT_DIR="$TMP_DIR/smart-account-kit-bindings"

echo -e "${BLUE}Verifying bindings parity${NC}"
echo -e "  wasm-hash:   ${GREEN}$CANONICAL_WASM_HASH${NC}"
echo -e "  network:     ${GREEN}$NETWORK${NC}"
echo ""

echo -e "${YELLOW}Regenerating bindings from the canonical WASM hash...${NC}"
pnpm --dir "$KIT_DIR" exec stellar-contract-bindings-typescript \
    --rpc-url "$RPC_URL" \
    --network "$NETWORK" \
    --wasm-hash "$CANONICAL_WASM_HASH" \
    --output-dir "$OUT_DIR" \
    --overwrite

# Apply the same post-processing build.sh does (strip trailing whitespace,
# ensure a trailing newline, and emit the companion SmartAccountError type alias
# if the generator omitted it) so the diff compares like with like.
node -e "
const fs = require('fs');
const path = require('path');
const dir = '$OUT_DIR/src';
for (const file of fs.readdirSync(dir)) {
  if (!file.endsWith('.ts')) continue;
  const full = path.join(dir, file);
  let source = fs.readFileSync(full, 'utf8').replace(/[ \\t]+\$/gm, '');
  if (
    file === 'types.ts' &&
    /export const SmartAccountError\\s*=/.test(source) &&
    !/export type SmartAccountError\\b/.test(source)
  ) {
    source = source.replace(
      /(export const SmartAccountError = \\{[\\s\\S]*?\\n\\})/,
      '\$1 as const;\\nexport type SmartAccountError = (typeof SmartAccountError)[keyof typeof SmartAccountError];'
    );
  }
  fs.writeFileSync(full, source.endsWith('\n') ? source : source + '\n');
}
"

if diff -ru "$CHECKED_IN_DIR" "$OUT_DIR/src"; then
    echo ""
    echo -e "${GREEN}Bindings are in parity with the canonical WASM hash.${NC}"
else
    echo ""
    echo -e "${RED}DRIFT: checked-in bindings differ from the canonical WASM hash.${NC}" >&2
    echo -e "${RED}Regenerate with scripts/bindings/build.sh, review the diff, and commit.${NC}" >&2
    exit 1
fi
