#!/bin/bash

# Build Script for Smart Account Kit Bindings
#
# Generates TypeScript bindings from the configured smart-account target and builds the package.
#
# Prerequisites:
# - pnpm + @stellar/stellar-sdk installed (uses stellar-contract-bindings-typescript)
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
        "Test SDF Future Network ; October 2022")
            STELLAR_NETWORK="futurenet"
            ;;
        "Standalone Network ; February 2017")
            STELLAR_NETWORK="localnet"
            ;;
    esac
fi

# Validate
if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}Error: pnpm not found${NC}" >&2
    exit 1
fi

if [ -z "$ACCOUNT_WASM" ] && [ -z "$STELLAR_RPC_URL" ]; then
    echo -e "${RED}Error: RPC URL not set (via env or demo/.env.example)${NC}" >&2
    exit 1
fi

if [ -z "$ACCOUNT_WASM" ] && [ -z "$STELLAR_NETWORK" ]; then
    echo -e "${RED}Error: network not set or passphrase not recognized (set STELLAR_NETWORK or a known STELLAR_NETWORK_PASSPHRASE)${NC}" >&2
    exit 1
fi

if [ -z "$ACCOUNT_WASM" ] && [ -z "$ACCOUNT_WASM_HASH" ] && [ -z "$ACCOUNT_CONTRACT_ID" ]; then
    echo -e "${RED}Error: local WASM, WASM hash, or contract ID must be configured${NC}" >&2
    exit 1
fi

if [ -n "$ACCOUNT_WASM" ] && [ ! -f "$ACCOUNT_WASM" ]; then
    echo -e "${RED}Error: local WASM not found: $ACCOUNT_WASM${NC}" >&2
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

# Step 1: Generate bindings into a staging directory so failed RPC/generator
# runs never clobber the checked-in package.
echo -e "${YELLOW}Generating TypeScript bindings...${NC}"

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT
OUT_DIR="$STAGE_DIR/out"

GEN_CMD=(pnpm --dir "$KIT_DIR" exec stellar-contract-bindings-typescript)
if [ -n "$ACCOUNT_WASM" ]; then
    GEN_CMD+=(--wasm "$ACCOUNT_WASM")
else
    if [ -n "$STELLAR_RPC_URL" ]; then
        GEN_CMD+=(--rpc-url "$STELLAR_RPC_URL")
    fi
    if [ -n "$STELLAR_NETWORK" ]; then
        GEN_CMD+=(--network "$STELLAR_NETWORK")
    fi

    if [ -n "$ACCOUNT_WASM_HASH" ]; then
        GEN_CMD+=(--wasm-hash "$ACCOUNT_WASM_HASH")
    else
        GEN_CMD+=(--contract-id "$ACCOUNT_CONTRACT_ID")
    fi
fi

GEN_CMD+=(--output-dir "$OUT_DIR" --overwrite)
"${GEN_CMD[@]}"

# Generator writes a generic README. Restore the repository-maintained
# package guide so regeneration cannot reintroduce obsolete CLI/API examples.
cp "$BINDINGS_README_TEMPLATE" "$OUT_DIR/README.md"

echo -e "${GREEN}Bindings generated${NC}"

# Step 2: Patch staged package.json, tsconfig.json, and sources before replacing
echo -e "${YELLOW}Patching package.json...${NC}"

cd "$OUT_DIR"

# The kit lists the SDK only in `dependencies`, so pnpm gives the kit and the
# bindings their own SDK copy when an app installs another major version.
STELLAR_SDK_PEER=$(node -p "require('$KIT_DIR/package.json').dependencies['@stellar/stellar-sdk']")

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const rootPkg = JSON.parse(fs.readFileSync('$KIT_DIR/package.json', 'utf8'));
pkg.name = 'smart-account-kit-bindings';
pkg.version = '$CURRENT_VERSION';
pkg.description = 'TypeScript bindings for OpenZeppelin smart account contracts on Stellar';
pkg.exports = './dist/index.js';
pkg.typings = './dist/index.d.ts';
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
if (pkg.dependencies) {
  delete pkg.dependencies['@stellar/stellar-sdk'];
  delete pkg.dependencies['buffer'];
  if (Object.keys(pkg.dependencies).length === 0) {
    delete pkg.dependencies;
  }
}
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# TypeScript 6 needs an explicit rootDir for the generated package layout.
node -e "
const fs = require('fs');
const path = 'tsconfig.json';
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
cfg.compilerOptions = {
  ...(cfg.compilerOptions || {}),
  rootDir: './src',
};
fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
"

# Keep generated sources compatible with the repository's whitespace checks and
# emit a companion type alias when the SDK bindings generator references an
# error map value (`SmartAccountError`) in a type position (`Result<null, SmartAccountError>`).
node -e "
const fs = require('fs');
const path = require('path');
for (const file of fs.readdirSync('src')) {
  if (!file.endsWith('.ts')) continue;
  const full = path.join('src', file);
  let source = fs.readFileSync(full, 'utf8').replace(/[ \\t]+$/gm, '');
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

# Replace checked-in package contents only after generation and patching succeed.
mkdir -p "$BINDINGS_DIR"
rm -rf "$BINDINGS_DIR/src"
cp -R "$OUT_DIR/src" "$BINDINGS_DIR/src"
cp "$OUT_DIR/package.json" "$BINDINGS_DIR/package.json"
cp "$OUT_DIR/tsconfig.json" "$BINDINGS_DIR/tsconfig.json"
cp "$OUT_DIR/README.md" "$BINDINGS_DIR/README.md"

# Step 3: Install and build
echo -e "${YELLOW}Building...${NC}"
cd "$KIT_DIR"
pnpm install
cd "$BINDINGS_DIR"
pnpm run build

echo ""
echo -e "${GREEN}smart-account-kit-bindings built (v$CURRENT_VERSION)${NC}"
