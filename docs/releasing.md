# Releasing the npm packages

The repository publishes two packages. Release them in this order so the SDK can resolve its workspace dependency to a version that already exists on npm:

1. `smart-account-kit-bindings`
2. `smart-account-kit`

The two packages are versioned independently.
The checked-in `package.json` files define the release targets.
Use `npm view` as the source of truth for published versions.

## Prerequisites

- Node.js 22 or newer
- pnpm 10 or newer
- Stellar CLI 27 or newer when regenerating bindings
- npm publish access to both packages
- A clean tracked Git worktree; both release scripts stop if tracked changes are present

Authenticate and confirm the current registry state:

```bash
npm login
npm whoami
npm view smart-account-kit-bindings version
npm view smart-account-kit version
```

## Regenerate bindings from the optimized contract

Regenerate whenever the smart-account contract interface changes. From the `smart-account-kit` repository, with `stellar-contracts` checked out as a sibling directory:

```bash
CONTRACTS=../stellar-contracts

(
  cd "$CONTRACTS"
  stellar contract build \
    --locked \
    --optimize=true \
    --package multisig-account-example
)

ACCOUNT_WASM="$CONTRACTS/target/wasm32v1-none/release/multisig_account_example.wasm" \
BINDINGS_VERSION=$(node -p "require('./packages/smart-account-kit-bindings/package.json').version") \
pnpm build:bindings
```

Stellar CLI 27 writes the optimized output to the standard `.wasm` path shown above; the build summary confirms the optimized and original sizes. `build:bindings` prefers explicit env/args (`ACCOUNT_WASM` here), falls back to `demo/.env.example`, and prints the source and hash it binds against.

Review and commit regenerated sources before publishing. The generation script preserves the requested binding version and installs the repository's maintained package README after the Stellar CLI generator runs.

Confirm the regenerated bindings match the canonical deployed WASM before committing:

```bash
pnpm verify:bindings
```

`verify:bindings` regenerates from the canonical testnet WASM hash recorded in [`deployments-protocol-27-2026-07-09.md`](deployments-protocol-27-2026-07-09.md), diffs against the checked-in `packages/smart-account-kit-bindings/src/index.ts`, and exits nonzero on drift. Never hand-edit the generated bindings to resolve drift — fix it on the contract side and regenerate.

## Validate

```bash
pnpm install --frozen-lockfile
pnpm test --run
pnpm verify:bindings
pnpm build
pnpm --filter smart-account-kit-demo build
pnpm --filter indexer-demo build
git diff --check
git status --short
```

Commit any intended changes before continuing. Uncommitted tracked changes cause the release scripts to exit.

## Authenticated dry run

The dry-run mode verifies npm authentication, reads the live registry versions, and shows the intended publish versions. It does not build or upload a package.

```bash
BINDINGS_VERSION=$(node -p "require('./packages/smart-account-kit-bindings/package.json').version")
SDK_VERSION=$(node -p "require('./package.json').version")
pnpm release:bindings --version "$BINDINGS_VERSION" --dry-run
pnpm release --version "$SDK_VERSION" --bindings-version "$BINDINGS_VERSION" --dry-run
```

Do not insert an extra `--` after the pnpm script name; pnpm forwards it to these shell scripts as an argument.

## Publish and verify

```bash
BINDINGS_VERSION=$(node -p "require('./packages/smart-account-kit-bindings/package.json').version")
SDK_VERSION=$(node -p "require('./package.json').version")
pnpm release:bindings --version "$BINDINGS_VERSION"
npm view "smart-account-kit-bindings@$BINDINGS_VERSION" version

pnpm release --version "$SDK_VERSION" --bindings-version "$BINDINGS_VERSION"
npm view "smart-account-kit@$SDK_VERSION" version
npm view "smart-account-kit@$SDK_VERSION" dependencies
```

If npm requires a one-time password, append `--otp <fresh-code>` to each `pnpm release...` command. Use a fresh code for the second publish if the first one expires.

The scripts intentionally use exact versions here. A second attempt after a successful publish will fail because npm package versions are immutable; check `npm view` before retrying.
