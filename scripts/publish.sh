#!/bin/bash

# Publish Script for Smart Account Kit SDK
#
# Fetches current version from npm, bumps it, builds, and publishes.
# Syncs local bindings version to npm for correct workspace:* resolution.
#
# Options:
#   --minor     Bump minor version (default is patch)
#   --major     Bump major version
#   --version   Publish an exact SDK version
#   --bindings-version  Use an exact bindings version for workspace resolution
#   --otp       npm OTP for 2FA
#   --dry-run   Show what would happen without publishing

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT_DIR="$(dirname "$SCRIPT_DIR")"
BINDINGS_DIR="$KIT_DIR/packages/smart-account-kit-bindings"

# Parse args
BUMP_TYPE="patch"
OTP=""
DRY_RUN=false
EXACT_VERSION=""
BINDINGS_VERSION_OVERRIDE=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --minor) BUMP_TYPE="minor"; shift ;;
        --major) BUMP_TYPE="major"; shift ;;
        --version) EXACT_VERSION="$2"; shift 2 ;;
        --bindings-version) BINDINGS_VERSION_OVERRIDE="$2"; shift 2 ;;
        --otp) OTP="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Publishing smart-account-kit${NC}"
echo ""

if [ -n "$EXACT_VERSION" ] && [ "$BUMP_TYPE" != "patch" ]; then
    echo -e "${RED}Error: --version cannot be combined with --minor or --major${NC}"
    exit 1
fi

if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    echo -e "${RED}Error: Working tree is not clean. Commit or stash every change before publishing.${NC}"
    exit 1
fi

# Check npm auth
NPM_USER=$(npm whoami 2>/dev/null || echo "")
if [ -z "$NPM_USER" ]; then
    echo -e "${RED}Error: Not logged in to npm. Run: npm login${NC}"
    exit 1
fi
echo -e "Logged in as: ${GREEN}$NPM_USER${NC}"

# Get current npm versions
SDK_NPM_VERSION=$(npm view smart-account-kit version 2>/dev/null || echo "0.0.0")
BINDINGS_NPM_VERSION=$(npm view smart-account-kit-bindings version 2>/dev/null || echo "0.0.0")

echo -e "Current npm SDK version: ${YELLOW}$SDK_NPM_VERSION${NC}"
echo -e "Current npm bindings version: ${YELLOW}$BINDINGS_NPM_VERSION${NC}"

if [ -n "$EXACT_VERSION" ]; then
    NEW_VERSION="$EXACT_VERSION"
else
    # Bump SDK version
    IFS='.' read -r MAJOR MINOR PATCH <<< "$SDK_NPM_VERSION"
    case $BUMP_TYPE in
        patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
        minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
        major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
    esac
fi

if [ -n "$BINDINGS_VERSION_OVERRIDE" ]; then
    BINDINGS_RELEASE_VERSION="$BINDINGS_VERSION_OVERRIDE"
else
    BINDINGS_RELEASE_VERSION="$BINDINGS_NPM_VERSION"
fi

if [ -n "$EXACT_VERSION" ]; then
    echo -e "SDK version: ${GREEN}$NEW_VERSION${NC} (explicit)"
else
    echo -e "New SDK version: ${GREEN}$NEW_VERSION${NC} ($BUMP_TYPE)"
fi
echo -e "Bindings version for publish resolution: ${GREEN}$BINDINGS_RELEASE_VERSION${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[dry-run] Would publish smart-account-kit@$NEW_VERSION${NC}"
    echo -e "${YELLOW}[dry-run] Bindings dependency would resolve to: $BINDINGS_RELEASE_VERSION${NC}"
    exit 0
fi

# Sync local bindings version to npm (for workspace:* resolution)
echo -e "${YELLOW}Syncing bindings version to npm...${NC}"
cd "$BINDINGS_DIR"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$BINDINGS_RELEASE_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Update SDK version
echo -e "${YELLOW}Setting SDK version...${NC}"
cd "$KIT_DIR"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Regenerate src/version.ts from the version just written. Without this the
# published VERSION constant silently keeps the previous release's value.
echo -e "${YELLOW}Syncing src/version.ts...${NC}"
node "$SCRIPT_DIR/sync-version.js"

# Build
echo -e "${YELLOW}Building...${NC}"
"$SCRIPT_DIR/build.sh"

# Publish
echo ""
echo -e "${YELLOW}Publishing...${NC}"
cd "$KIT_DIR"

PUBLISH_FLAGS="--access public --no-git-checks --ignore-scripts"
if [ -n "$OTP" ]; then
    PUBLISH_FLAGS="$PUBLISH_FLAGS --otp $OTP"
fi

pnpm publish $PUBLISH_FLAGS

echo ""
echo -e "${GREEN}Published smart-account-kit@$NEW_VERSION${NC}"
