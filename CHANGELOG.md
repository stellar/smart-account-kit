# Changelog

## Unreleased

- **Breaking: shared-deployer wallet creation is relayer-only.**
  `createWallet()` and `credentials.deploy()` now return
  `relayerPayload: { func, auth }` for the shared default deployer;
  `signedTransaction` is optional and is returned only for custom
  `deployerSecret` deployments. Shared deployments require a configured
  relayer and never fall back to RPC. Remove `forceMethod: "rpc"` from
  shared-deployer flows; no config re-enables a direct-RPC shared deployment.
- **Token transfers are signed as direct token invocations** (`transfer` and
  `multiSigners.transfer`) instead of being wrapped in the account's
  `execute`, so `CallContract` rules scoped to the token (and their policies,
  e.g. spending limits) now match and enforce on transfers. Rules scoped to
  the account's own address no longer match transfers; `Default` rules are
  unaffected. New `buildDirectTokenTransfer` export for clients that build
  transfer authorizations themselves, and `transfer` now accepts a
  `resolveContextRuleIds` override like `multiSigners.transfer`.
- **Context-rule auto-resolution prefers a rule scoped to the invoked contract
  over a `Default` fallback** when both match the selected signers. Before
  this change, automatic resolution could select the `Default` rule instead,
  which bypassed the scoped rule's policies (e.g. a spending limit), because
  the account only enforces the rule selected at signing time.

## 0.4.2 — 2026-07-11

SDK-usage audit: the kit now leans on `@stellar/stellar-sdk` primitives where
it previously re-implemented them.

**Compatibility:** the `@stellar/stellar-sdk` peer requirement is now
`>=16.0.0` (was `>=15.1.0`). The kit targets Protocol 27 smart accounts, which
pre-16 SDKs cannot express (no V2 address credentials, no P27 auth preimages) —
the runtime feature-detection shims that papered over older SDKs are removed.
No other breaking changes.

- **Uses stellar-sdk primitives** instead of local re-implementations: auth
  preimages call the SDK's `buildAuthorizationEntryPreimage` directly (the
  manual fallback and Protocol 27 credential-shim casts are deleted), deployer
  signing uses `contract.basicNodeSigner`, `buildI128ScVal` delegates to
  `nativeToScVal`, and `BASE_FEE` is re-exported from the SDK (the local copy
  in `constants.ts` is removed; it remains importable from the package root).
- **Builder address validation is checksum-verified via `StrKey`.**
  `createDelegatedSigner`, `createExternalSigner`, and
  `createCallContractContext` previously accepted any 56-character
  `G...`/`C...` string, including ones with corrupted checksums. Error message
  text changed accordingly.

## 0.4.1 — 2026-07-11

Packaging fix plus a post-release API-surface audit. No breaking changes.

- **Fixed: the published package was unimportable from Node's native ESM loader.**
  `tsconfig` used `moduleResolution: "bundler"`, so `tsc` emitted extensionless
  relative imports (`from "./kit"`) that Node rejects with
  `ERR_UNSUPPORTED_DIR_IMPORT`. `0.4.0` therefore worked only under a bundler
  (Vite/webpack/esbuild) and crashed for any plain Node consumer (backends,
  scripts, tests) — a gap the Vite-based demo e2e never exercised. The build now
  targets `NodeNext` with explicit `.js` import extensions, and a Node-ESM import
  smoke test (`scripts/verify-esm.mjs`) runs as part of `pnpm build` so this
  cannot regress. Also added a `base64url` interop shim (`src/base64url.ts`) for
  the CommonJS package under NodeNext.
- **Verified the OpenZeppelin Relayer Channels integration live** on both testnet
  and mainnet (fee-bump and `func`+`auth` submission modes). In every case the
  relayer's channel account paid the fee and our accounts paid zero — previously
  only covered by a mocked unit test.
- **Added missing entry-point exports** that `0.4.0`'s docs promised but did not
  ship: type exports `SignOptions`, `SubmitOptions`, `SignAndSubmitOptions`,
  `ResolveContextRuleIds`, `SpendingLimitData`, `SpendingEntry`; value exports
  `signerToScVal`, `parseSignerScVal`, `buildI128ScVal`, `signFeePayer`,
  `resimulateAndAssemble`.
- **`kit.convertPolicyParams` return type tightened** from `unknown` to
  `xdr.ScVal` (runtime behavior unchanged), and its stale JSDoc ("returns the
  original params if conversion fails") corrected — it throws `ValidationError`.
- **`kit.buildPoliciesScVal` throws `WalletNotConnectedError`** when
  disconnected instead of a plain `Error` (same message).
- **`fundWallet`'s temp-account auth nonce is cryptographically random**
  (shared `randomAuthEntryNonce` helper) instead of `Date.now()`, matching the
  delegated-auth nonce fix from `0.4.0`.
- **Docs:** README `TransactionFailure` examples no longer reference the removed
  `result.code`; migration-guide corrections (bindings byte-identical to
  `0.3.0`, `@internal` Ed25519 helpers, residual plain-`Error` guard paths,
  minor logging changes, removed reference-worker REST endpoints without a
  Mercury equivalent).

## 0.4.0 — 2026-07-10

Ground-up audit and overhaul against the OpenZeppelin smart account contracts
([`stellar-contracts@1e513890`](https://github.com/OpenZeppelin/stellar-contracts/commit/1e513890ecf79833c9d6e7ef38a9358001c0b111),
the exact commit behind the Protocol 27 deployments). Breaking release; see
[`docs/migration-v0.4.0.md`](docs/migration-v0.4.0.md) for the complete
migration guide.

### SDK (`smart-account-kit@0.4.0`)

- **Full contract parity.** Every smart-account entry point is now wrapped:
  `kit.rules.count()`, `kit.signers.addBatch()`, `kit.signers.idOf()`,
  `kit.policies.idOf()`, and `kit.upgrade()`. `kit.wallet` remains as a raw
  escape hatch, but nothing is intentionally unwrapped anymore.
- **Typed policy clients.** `kit.policyClients` exposes threshold,
  weighted-threshold, and spending-limit clients with live getters
  (simulation) and setters routed through the account's `execute()` flow. The
  embedded base64 spec blobs are gone; conversion goes through the bindings
  spec.
- **Ed25519 signers end-to-end.** New `Ed25519Signer` signs the auth digest
  with a local keypair against the deployed Ed25519 verifier; configurable via
  `ed25519VerifierAddress`.
- **One signing pipeline.** The passkey, multi-signer, and funding flows share
  a single auth-digest/signature core
  (`auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())`),
  eliminating three divergent implementations.
- **Unified error model.** Everything throws typed errors except submission
  methods, which return a discriminated `TransactionResult`. Contract failure
  codes (3000–3016 smart account, 3110–3119 WebAuthn, 3200–3227 policies) are
  decoded into `ContractError` with enum names.
- **Constructor policies.** `defaultPolicies` is now honored — new wallets can
  deploy with policies installed via constructor args.
- **Client-side limit validation.** `MAX_SIGNERS=15`, `MAX_POLICIES=5`,
  `MAX_NAME_SIZE=20` bytes, `MAX_EXTERNAL_KEY_SIZE=256` enforced before
  submission with clear errors.
- **Config additions.** `deployerSecret`, `externalSignerStorage`,
  `ed25519VerifierAddress`; probe defaults single-sourced; indexer URL
  resolution via `IndexerClient.forNetwork`.
- **Dead code removed** across the SDK; test suite grew from 117 to 325+ tests
  with every runtime module covered, including auth-digest and WebAuthn
  signature vectors.

### Audit follow-up fixes

A verified code-review pass over the release branch. See
[`docs/migration-v0.4.0.md`](docs/migration-v0.4.0.md#audit-follow-up-fixes) for
details and upgrade notes.

- **Host-order `ScMap` sort.** Signer maps (weighted-threshold params and the
  auth-payload signer map) sort by the Soroban host's key order (element-wise
  byte comparison), not the length-major XDR encoding — fixing occasional
  `InvalidInput` rejections for two same-verifier signers with different-length
  key data.
- **`kit.credentials.deploy()` honors policies** (`options.policies ??
  config.defaultPolicies`), matching `createWallet`; previously it silently
  deployed with no constructor policies.
- **Constructor policies validate before the passkey ceremony** in
  `createWallet`, so bad configs no longer orphan a created passkey.
- **`TransactionFailure.code` removed** — branch on `result.error.code`.
- **Policy params accept numeric strings** for u32/i128 fields, matching the
  spec; out-of-range/non-numeric strings throw.
- **Custom policy conversion hard-fails** instead of shipping a `Void` ScVal.
- **Wallet cancellation heuristic narrowed** to specific user-action phrases, so
  extension crashes / allowlist rejections surface as errors instead of being
  swallowed as a silent `null`.
- **`fundWallet()`** guards on the exact testnet passphrase (Futurenet no longer
  slips through) and reads the temp account's real native balance instead of a
  fabricated 10,000 XLM default.
- **Update-path validation** (`updateName`/`updateExpiration`), an optional
  `existingSignerCount` pre-check on `addBatch`, cryptographically random
  delegated auth nonces, a loud warning when an unsignable Ed25519 signer is
  dropped, and reduced redundant context-rule enumeration on signing/connect.

### Bindings (`smart-account-kit-bindings@0.3.0`)

- Regenerated from the canonical deployed testnet WASM
  (`1b5f4534…`); `pnpm verify:bindings` now checks the checked-in bindings
  against that hash and fails on drift. `build.sh` no longer silently sources
  a stale local `demo/.env`.

### Indexer & relayer proxy

- **Mercury is now the default indexer.** `DEFAULT_INDEXER_URLS` (and
  `IndexerClient.forNetwork`) resolve to Mercury's hosted `smart-account-indexer`
  REST service — testnet `https://testnet.mercurydata.app/rest/smart-account-indexer`,
  mainnet `https://mainnet.mercurydata.app/rest/smart-account-indexer`. Mercury's
  read endpoints are public and cover live + historical activity for every
  smart-account-kit contract (global backfill, no per-contract catch-up), so
  discovery works **zero-config with no token**. `indexerAuthToken` is now
  optional (gated/admin operations or a provider that requires it).
- **Self-hosted indexer stack removed.** The bespoke Goldsky Turbo pipeline
  (`indexer/goldsky/`) and the reference Cloudflare Worker (`indexer/handler/`,
  including its optional bearer-token gate) are gone — too expensive to operate,
  and Mercury indexes the same events as a managed service. The prior stack
  remains in git history. `indexer/demo/` stays and now targets Mercury.
- **Relayer proxy moved to the repo top level** (`relayer-proxy/`, was
  `indexer/relayer-proxy/`), reflecting that transaction submission is a distinct
  concern from indexing. It keeps its first test suite (22 tests), submit-path
  dedup, and docs for `/fee-usage` and `/status`, plus a new standalone README.

### Demo

- Rebuilt on the new API: `App.tsx` decomposed into hooks + panels, rule
  builder modularized, Ed25519 signer flows, live policy inspection/editing
  via the typed policy clients, batch signer add, and an advanced upgrade
  path. The indexer demo reads policy state through the same clients.
