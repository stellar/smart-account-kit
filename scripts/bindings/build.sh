#!/bin/bash

# Build Script for Smart Account Kit Bindings
#
# Generates TypeScript bindings from the configured smart-account target and builds the package.
#
# Prerequisites:
# - Stellar CLI installed (`stellar --version`)
#
# Configuration resolution order (never sources the local demo/.env, which may be
# stale or hold secrets):
#   1. Explicit environment variables / args (STELLAR_*, ACCOUNT_WASM*,
#      ACCOUNT_CONTRACT_ID, or their VITE_* equivalents) — these always win.
#   2. demo/.env.example (the committed, canonical example) for anything unset.
#   3. Otherwise: error.
#
# Use VITE_ACCOUNT_WASM_HASH for a deployed WASM; VITE_ACCOUNT_CONTRACT_ID targets
# a specific deployed instance; ACCOUNT_WASM points to a local optimized WASM.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
BINDINGS_DIR="$KIT_DIR/packages/smart-account-kit-bindings"
BINDINGS_README_TEMPLATE="$SCRIPT_DIR/README.template.md"
DEMO_ENV_EXAMPLE="$KIT_DIR/demo/.env.example"
EXISTING_BINDINGS_VERSION=$(node -p "require('$BINDINGS_DIR/package.json').version" 2>/dev/null || true)
CURRENT_VERSION="${BINDINGS_VERSION:-$EXISTING_BINDINGS_VERSION}"

if [ -z "$CURRENT_VERSION" ] || [ "$CURRENT_VERSION" = "0.0.0" ]; then
    echo "Error: set BINDINGS_VERSION when no released binding version can be preserved" >&2
    exit 1
fi

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Building smart-account-kit-bindings${NC}"
echo ""

# Resolution: explicit env vars win; fill any gaps from demo/.env.example (the
# committed example). The local demo/.env is intentionally NOT read.
CONFIG_SOURCE="explicit environment"
if [ -f "$DEMO_ENV_EXAMPLE" ]; then
    filled_from_example=false
    while IFS= read -r line || [ -n "$line" ]; do
        [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
        if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            # Only set variables that were not already provided explicitly.
            if [ -z "${!key:-}" ]; then
                export "$key=${BASH_REMATCH[2]}"
                filled_from_example=true
            fi
        fi
    done < "$DEMO_ENV_EXAMPLE"
    if [ "$filled_from_example" = true ]; then
        CONFIG_SOURCE="demo/.env.example (with explicit env overrides)"
    fi
fi

# Map VITE_ variables
STELLAR_RPC_URL="${STELLAR_RPC_URL:-${VITE_RPC_URL:-}}"
STELLAR_NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-${VITE_NETWORK_PASSPHRASE:-}}"
STELLAR_NETWORK="${STELLAR_NETWORK:-${VITE_NETWORK:-}}"
ACCOUNT_WASM_HASH="${ACCOUNT_WASM_HASH:-${VITE_ACCOUNT_WASM_HASH:-}}"
ACCOUNT_CONTRACT_ID="${ACCOUNT_CONTRACT_ID:-${VITE_ACCOUNT_CONTRACT_ID:-}}"
ACCOUNT_WASM="${ACCOUNT_WASM:-${VITE_ACCOUNT_WASM:-}}"

if [ -z "$STELLAR_NETWORK" ]; then
    case "$STELLAR_NETWORK_PASSPHRASE" in
        "Test SDF Network ; September 2015")
            STELLAR_NETWORK="testnet"
            ;;
        "Public Global Stellar Network ; September 2015")
            STELLAR_NETWORK="mainnet"
            ;;
    esac
fi

# Validate
if ! command -v stellar &> /dev/null; then
    echo -e "${RED}Error: stellar CLI not found${NC}"
    exit 1
fi

if [ -z "$ACCOUNT_WASM" ] && { [ -z "$STELLAR_RPC_URL" ] || [ -z "$STELLAR_NETWORK_PASSPHRASE" ]; }; then
    echo -e "${RED}Error: RPC URL or network passphrase not set (via env or demo/.env.example)${NC}"
    exit 1
fi

if [ -z "$ACCOUNT_WASM" ] && [ -z "$ACCOUNT_WASM_HASH" ] && [ -z "$ACCOUNT_CONTRACT_ID" ]; then
    echo -e "${RED}Error: local WASM, WASM hash, or contract ID must be configured${NC}"
    exit 1
fi

if [ -n "$ACCOUNT_WASM" ] && [ ! -f "$ACCOUNT_WASM" ]; then
    echo -e "${RED}Error: local WASM not found: $ACCOUNT_WASM${NC}"
    exit 1
fi

# Always announce exactly what we are binding against before generating.
echo -e "${BLUE}Binding against:${NC}"
if [ -n "$ACCOUNT_WASM" ]; then
    echo -e "  source:      local WASM ${GREEN}$ACCOUNT_WASM${NC}"
else
    echo -e "  network:     ${GREEN}${STELLAR_NETWORK:-$STELLAR_NETWORK_PASSPHRASE}${NC}"
    if [ -n "$ACCOUNT_WASM_HASH" ]; then
        echo -e "  wasm-hash:   ${GREEN}$ACCOUNT_WASM_HASH${NC}"
    else
        echo -e "  contract-id: ${GREEN}$ACCOUNT_CONTRACT_ID${NC}"
    fi
fi
echo -e "  config from: ${GREEN}$CONFIG_SOURCE${NC}"
echo ""

# Step 1: Generate bindings
echo -e "${YELLOW}Generating TypeScript bindings...${NC}"

STELLAR_CMD=(stellar contract bindings typescript)
if [ -n "$ACCOUNT_WASM" ]; then
    STELLAR_CMD+=(--wasm "$ACCOUNT_WASM")
else
    if [ -n "$STELLAR_NETWORK" ]; then
        STELLAR_CMD+=(--network "$STELLAR_NETWORK")
    else
        STELLAR_CMD+=(--rpc-url "$STELLAR_RPC_URL")
        STELLAR_CMD+=(--network-passphrase "$STELLAR_NETWORK_PASSPHRASE")
    fi

    if [ -n "$ACCOUNT_WASM_HASH" ]; then
        STELLAR_CMD+=(--wasm-hash "$ACCOUNT_WASM_HASH")
    else
        STELLAR_CMD+=(--contract-id "$ACCOUNT_CONTRACT_ID")
    fi
fi

STELLAR_CMD+=(--output-dir "$BINDINGS_DIR" --overwrite)
"${STELLAR_CMD[@]}"

# Stellar CLI generates a generic README. Restore the repository-maintained
# package guide so regeneration cannot reintroduce obsolete CLI/API examples.
cp "$BINDINGS_README_TEMPLATE" "$BINDINGS_DIR/README.md"

echo -e "${GREEN}Bindings generated${NC}"

# Step 2: Patch package.json for npm
echo -e "${YELLOW}Patching package.json...${NC}"

cd "$BINDINGS_DIR"

STELLAR_SDK_PEER=$(node -p "require('$KIT_DIR/package.json').peerDependencies['@stellar/stellar-sdk']")

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync('$KIT_DIR/package.json', 'utf8'));
pkg.version = '$CURRENT_VERSION';
pkg.description = 'TypeScript bindings for OpenZeppelin smart account contracts on Stellar';
pkg.main = 'dist/index.js';
pkg.module = 'dist/index.js';
pkg.types = 'dist/index.d.ts';
pkg.files = ['dist'];
pkg.author = 'OpenZeppelin';
pkg.license = 'MIT';
pkg.repository = { type: 'git', url: 'https://github.com/stellar/smart-account-kit' };
pkg.peerDependencies = { '@stellar/stellar-sdk': '$STELLAR_SDK_PEER' };
pkg.devDependencies = {
  ...(pkg.devDependencies || {}),
  typescript: rootPkg.devDependencies.typescript,
};
pkg.publishConfig = { registry: 'https://registry.npmjs.org/', access: 'public' };
if (pkg.dependencies && pkg.dependencies['@stellar/stellar-sdk']) {
    delete pkg.dependencies['@stellar/stellar-sdk'];
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# TypeScript 6 needs an explicit rootDir for the generated package layout.
node -e "
const fs = require('fs');
const path = 'tsconfig.json';
const source = fs.readFileSync(path, 'utf8');
const patched = source.replace(
  /\/\/ \"rootDir\": \"\.\/\",[^\n]*/,
  '\"rootDir\": \"./src\",'
);
if (patched === source) {
  throw new Error('Could not patch rootDir in generated tsconfig.json');
}
fs.writeFileSync(path, patched.endsWith('\\n') ? patched : patched + '\\n');
"

# Keep generated sources compatible with the repository's whitespace checks.
node -e "
const fs = require('fs');
const path = 'src/index.ts';
const source = fs.readFileSync(path, 'utf8');
fs.writeFileSync(path, source.replace(/[ \\t]+$/gm, ''));
"

# Step 3: Install and build
echo -e "${YELLOW}Building...${NC}"
cd "$KIT_DIR"
pnpm install
cd "$BINDINGS_DIR"
pnpm run build

echo ""
echo -e "${GREEN}smart-account-kit-bindings built (v$CURRENT_VERSION)${NC}"
