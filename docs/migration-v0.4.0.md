# Migrating to `smart-account-kit` v0.4.0

This release is an OpenZeppelin-parity overhaul of the SDK. It has **no backwards-compatibility layer** — every breaking change below is a clean cut from `0.3.0`. The public API is realigned around a unified error model, a unified signing pipeline (with end-to-end Ed25519 support), typed policy clients, full contract parity, and client-side validation.

The deployed contract surface is unchanged from `0.3.0` (the bindings were regenerated from the same canonical Protocol 27 testnet WASM hash `1b5f4534…785a` and verified byte-identical to the `0.3.0` checked-in copy). All the changes below are on the SDK side.

## 0.5.0: shared-deployer deployment

Shared-default-deployer deployments are now sign-only. The deployer signs the
CreateContractV2 Soroban authorization entry; a separate account supplies the
transaction envelope source, sequence, and fees. The SDK's auto-submit path uses
the relayer for that, but building the payload requires no relayer at all — see
below.

This changes the manual-submission result from `createWallet()` and
`credentials.deploy()`:

```ts
const result = await kit.createWallet(appName, userName, { autoSubmit: false });

if (result.relayerPayload) {
  // Shared default deployer. A relayer is one way to submit this; any funded
  // source you control works, because the payload is just a signed auth entry.
  await kit.relayer!.send(
    result.relayerPayload.func,
    result.relayerPayload.auth
  );
} else {
  // Custom deployerSecret only.
  await kit.relayer!.sendXdr(result.signedTransaction!);
}
```

- `relayerPayload: { func, auth }` is returned for the shared deployer.
- `signedTransaction` is now optional and is present only for a custom
  `deployerSecret` that still self-sources its deployment envelope.
- Shared deploys with `autoSubmit: true` fail when no relayer is configured.
  They never use direct RPC or fall back to it after relayer failure.
- With `autoSubmit: false` **no relayer is required**: you get
  `relayerPayload: { func, auth }` and may submit it yourself, sourcing and
  paying from any funded account. Signing the auth entry costs nothing and the
  shared deployer is never the source.
- Remove `forceMethod: "rpc"` from shared deployment calls — there is no config
  that re-enables a direct-RPC shared deployment.

The deterministic address tuple is unchanged: the shared deployer remains the
CreateContractV2 `FromAddress`, and the credential-derived salt is unchanged.
Existing derived wallet addresses therefore do not move.

## Contents

- [Results & error handling](#results--error-handling)
- [Errors](#errors)
- [Signers & Ed25519](#signers--ed25519)
- [Configuration](#configuration)
- [Policy clients](#policy-clients)
- [Client-side validation](#client-side-validation)
- [Kit methods](#kit-methods)
- [Removed exports](#removed-exports)
- [Bindings & build pipeline](#bindings--build-pipeline)
- [Indexer (Mercury)](#indexer-mercury)

---

## Results & error handling

**`TransactionResult` is now a discriminated union on `success`.** This is the highest-impact change: narrow on `result.success` before reading `.error` or `.hash`.

```ts
// Before (0.3.0): { success: boolean; hash: string; error?: string; ledger? }
const result = await kit.transfer(token, to, 100);
if (result.success) {
  console.log(result.hash);
} else {
  console.error(result.error); // string
}

// After (0.4.0)
const result = await kit.transfer(token, to, 100);
if (result.success) {
  // TransactionSuccess: { success: true; hash: string; ledger? }
  console.log(result.hash, result.ledger);
} else {
  // TransactionFailure: { success: false; error: SmartAccountError; hash? }
  console.error(`[${result.error.code}] ${result.error.message}`);
}
```

Key differences:

- `error` is now a **typed `SmartAccountError`** (a `ContractError` when an on-chain code was decoded), not a string.
- Success results have **no** `error` field.
- Branch on **`result.error.code`** (there is no top-level `result.code` mirror).
- `hash` is now **optional on failure** (present only when one was assigned before the failure).
- New type exports: `TransactionSuccess`, `TransactionFailure`.

**Which methods return this vs. throw.** Every submission method — `transfer`, `signAndSubmit`, `executeAndSubmit`, `fundWallet`, `createWallet`'s deploy step, `multiSigners.*`, and credential deployment — returns a `TransactionResult`. **Everything else now throws typed errors** instead of returning failure objects or plain `Error`s. (A handful of low-level guard paths still throw plain `Error` — e.g. `credentials.deploy()` with no stored credential, `externalSigners.addFromWallet()` with no adapter configured, and adapter not-initialized guards. Treat any thrown value as a failure; `instanceof SmartAccountError` narrows the typed ones.)

## Errors

New error classes and behaviors:

- **`ContractError`** (extends `SmartAccountError`) — carries `contractCode` (e.g. `3010`), `contractErrorName` (e.g. `"TooManySigners"`), and `family`.
- **`PolicyNotFoundError`** — thrown when a policy is not found on a context rule.
- **New decoding API:** `decodeContractError(diagnostic)`, `contractErrorFromCode(code)`, `CONTRACT_ERROR_REGISTRY`, and types `ContractErrorFamily` / `ContractErrorInfo`. Covers SmartAccount `3000–3016`, WebAuthn `3110–3119`, SimpleThreshold `3200–3203`, WeightedThreshold `3210–3214`, and SpendingLimit `3220–3227`.
- **`SmartAccountErrorCode`** gains `CONTRACT_ERROR` (`10000`) and `POLICY_NOT_FOUND` (`6003`).
- **`ValidationError`** code union widened to include `INVALID_CONFIG` / `MISSING_CONFIG`.
- **`SignerNotFoundError`** constructor gained an optional 2nd `hint` argument.

**Behavior changes — methods that used to return failures or plain `Error`s now throw typed errors:**

| Situation | Now throws |
|---|---|
| Operation requires a connected wallet | `WalletNotConnectedError` |
| Invalid secret key | `ValidationError` |
| Missing signer | `SignerNotFoundError` |
| Missing policy | `PolicyNotFoundError` |
| Required-config validation | `ValidationError` |
| Bad policy params (`convertPolicyParams`) | `ValidationError` (was `console.warn` + returning unconverted params) |

`StellarWalletsKitAdapter.connect()` now throws on a genuine failure (it still returns `null` on user-cancel/dismiss).

## Signers & Ed25519

Ed25519 external signers are now supported end-to-end (builders, signing, multi-signer submission).

New exports:

- `Ed25519Signer`, `computeEntryAuthDigest`, and the `AuthDigestSigner` type.
- Constants `ED25519_PUBLIC_KEY_SIZE` (32) and `ED25519_SIGNATURE_SIZE` (64).

Widened types:

- `SelectedSigner.type` is now `"passkey" | "wallet" | "ed25519"` (added `ed25519`), with a new `ed25519PublicKey` field.
- `ExternalSigner` (from `getAll()`) gains `type: "ed25519"` plus `verifierAddress` / `publicKey` fields.

`ExternalSignerManager`:

- Constructor gained a 4th argument (`ed25519VerifierAddress`).
- New methods: `addEd25519FromSecret(secret, verifier?)` is the primary API; `canSignEd25519`, `getEd25519Signer`, and `signEd25519Digest` also exist but are `@internal` helpers used by the kit's multi-signer flow.

Also newly exported for advanced flows: `signerToScVal` / `parseSignerScVal` (auth-payload), and `buildI128ScVal`, `signFeePayer`, `resimulateAndAssemble` (tx-ops). *(Importable from the package entry point as of `0.4.1` — `0.4.0` defined these but did not re-export them.)*

> Ed25519 signing goes through `kit.multiSigners` (build a `SelectedSigner` of type `"ed25519"` via `buildSelectedSigners`). `kit.transfer`'s single-signer convenience path stays passkey-only by design.

See the [Ed25519 & External Signers](../README.md#ed25519--external-signers) section of the README for the full flow.

## Configuration

`SmartAccountConfig` gains several fields:

- **`ed25519VerifierAddress?: string`** — needed for Ed25519 external signers.
- **`deployerSecret?: string`** — custom fee payer. The default is a deterministic keypair derived from a fixed well-known seed. **Overriding it changes the derived contract addresses** (documented tradeoff — the default makes addresses reproducible from a credential ID alone).
- **`externalSignerStorage?: WalletStorage`** — external-signer persistence store (default: `localStorage`). Separate from the credential `StorageAdapter`.

Behavior:

- **`defaultPolicies` is now honored.** It was previously silently ignored/dead. It is now applied to the new wallet's default context rule via the contract `__constructor`.
- **`PolicyConfig` gains an optional `type`** (`"threshold" | "spending_limit" | "weighted_threshold" | "custom"`), required so install params can be encoded. `"custom"` policies must supply an `xdr.ScVal`.
- **`createWallet` gains `options.policies`** — a per-call override of `defaultPolicies`.

## Policy clients

New typed clients for the three example policies, via `kit.policyClients`:

```ts
kit.policyClients.threshold(address);      // SimpleThresholdPolicyClient
kit.policyClients.weighted(address);       // WeightedThresholdPolicyClient
kit.policyClients.spendingLimit(address);  // SpendingLimitPolicyClient
```

New exports: `SimpleThresholdPolicyClient`, `WeightedThresholdPolicyClient`, `SpendingLimitPolicyClient`, and the `PolicyClientDeps` type; plus contract types `SpendingLimitData` / `SpendingEntry` *(importable as of `0.4.1`)*.

- **Getters** (`getThreshold`, `getSignerWeights`, `getSpendingLimitData`) read on-chain state via simulation.
- **Setters** (`setThreshold`, `setSignerWeight`, `setSpendingLimit`) return an `AssembledTransaction` routed through the smart account's `execute()`, and take the **full `ContextRule` struct** (not just the id).

> ⚠️ **Signer-set divergence caveat.** Threshold policies are **not** auto-notified when a rule's signer set changes. Call `setThreshold` / `setSignerWeight` around add/remove-signer operations, or authorization may break.

## Client-side validation

New module validating deployed-contract limits before submission (throwing `ValidationError` instead of letting an opaque on-chain failure surface).

- Constants: `MAX_SIGNERS` (15), `MAX_POLICIES` (5), `MAX_NAME_SIZE` (20 UTF-8 **bytes**), `MAX_EXTERNAL_KEY_SIZE` (256).
- Functions: `validateContextRule`, `validateContextRuleName`, `validateSigner`, `validateSigners`, `validatePolicyCount`, `validateExternalKeySize`, `validateValidUntil`.

`kit.rules.add`, `kit.signers.add*`, and `kit.signers.addBatch` now throw `ValidationError` **before** submitting on a limit violation (name > 20 bytes, > 15 signers, > 5 policies, past `valid_until`, or a rule with no signers and no policies).

## Kit methods

Full contract parity — every entry point is now wrapped. **The README's "intentionally unwrapped raw methods" section is gone** because there are no longer any intentionally-unwrapped methods. `kit.wallet` remains available as a raw escape hatch.

New methods:

| New wrapper | Contract entry point |
|---|---|
| `kit.upgrade(newWasmHash)` | `upgrade` (32-byte hash; the contract ignores the `operator` arg) |
| `kit.rules.count()` | `get_context_rules_count` |
| `kit.signers.addBatch(ruleId, signers)` | `batch_add_signer` |
| `kit.signers.idOf(signer)` | `get_signer_id` |
| `kit.policies.idOf(address)` | `get_policy_id` |

Shared option types are now used across `sign` / `signAndSubmit` / `executeAndSubmit` / `transfer` / `fundWallet`: new type exports `SignOptions`, `SubmitOptions`, `SignAndSubmitOptions`, and `ResolveContextRuleIds` *(importable as of `0.4.1`)*.

`convertPolicyParams` signature is `(policyType, params)` and returns an `xdr.ScVal` (the kit method's declared return type was `unknown` in `0.4.0`; tightened to `xdr.ScVal` in `0.4.1`); `buildPoliciesScVal` is `(policies, policyTypes)`. Both now throw `ValidationError` on bad input rather than silently returning unconverted params.

## Removed exports

The following were removed in this release (they were dead or never meant to be public):

- `validateNotEmpty`
- `signerMatchesCredential`
- `signerMatchesAddress`

(`extractPubkeyFromKeyData`, `extractCredentialIdFromKeyData`, `simulateHostFunction`, and `decodeContextRuleResultXdr` were never part of the public API.)

## Bindings & build pipeline

- **`packages/smart-account-kit-bindings/src/index.ts` was regenerated** from the canonical deployed testnet WASM hash (`1b5f4534…785a`) and verified **byte-identical to the `0.3.0` checked-in copy** — the deployed contract surface did not change. (Description-byte drift that crept in during the release branch was regenerated away; function names, args, return types, and ScVal encoding were never affected.)
- **New `pnpm verify:bindings`** (`scripts/bindings/verify.sh`) regenerates from the canonical WASM hash, diffs against the checked-in bindings, and exits nonzero on drift.
- `build.sh` no longer silently sources local `demo/.env`. It prefers explicit env/args, falls back to `demo/.env.example`, and prints the source and hash it binds against.

### Two implementation notes worth knowing

1. **`get_context_rule` id hydration.** The deployed contract's `get_context_rule` omits the aligned `signer_ids`/`policy_ids` fields, so the generated bindings spec cannot decode them directly. The SDK injects empty id vectors and hydrates the real ids via `get_signer_id`/`get_policy_id`. Reading a rule with populated ids therefore depends on those getters being reachable; a read-only client without them yields empty `signer_ids`/`policy_ids`.
2. **Do not hand-edit bindings.** They are regenerated from the canonical WASM. If richer descriptions are wanted, fix them on the contract side (redeploy) and regenerate — hand-editing re-introduces drift that `pnpm verify:bindings` will flag.

---

## Indexer (Mercury)

The default indexer provider changed to **[Mercury](https://mercurydata.app)**, a hosted managed service. This is a config-default change, not an API change — `IndexerClient`, `kit.indexer`, and the discovery methods are unchanged.

- **New default endpoints** (`DEFAULT_INDEXER_URLS` / `IndexerClient.forNetwork`):

  | Network | Default URL |
  |---|---|
  | Testnet | `https://testnet.mercurydata.app/rest/smart-account-indexer` |
  | Mainnet | `https://mainnet.mercurydata.app/rest/smart-account-indexer` |

- **Zero-config, no token.** Mercury's read endpoints are public and cover both live and historical activity for every smart-account-kit contract (a global backfill means there is no per-contract catch-up step). If you were relying on the built-in defaults, discovery keeps working with no changes. `indexerAuthToken` remains optional in the config type (it already was in `0.3.0`) and is now typically **unnecessary** — supply one only for gated/admin operations or a provider that requires it.
- **Action required only if you pinned the old default.** The previous defaults pointed at the SDF-ecosystem reference Cloudflare Workers (`https://smart-account-indexer[-mainnet].sdf-ecosystem.workers.dev`). Those are **decommissioned**. If you hard-coded either URL in `indexerUrl`, drop it (to use the Mercury default) or point it at your own wire-compatible provider.
- **Self-hosted reference stack removed.** The bespoke Goldsky Turbo pipeline (`indexer/goldsky/`) and the reference Cloudflare Worker (`indexer/handler/`, including its optional `INDEXER_AUTH_TOKEN` bearer gate) were removed — too expensive to operate, and Mercury indexes the same events as a managed service. The prior stack lives in git history if you want to self-host. The lookup demo (`indexer/demo/`) stays and now defaults to Mercury.
- **Two reference-worker REST endpoints have no Mercury equivalent.** The removed worker also served `GET /api/credentials` (paginated credential listing) and `GET /api/contract/:id/signers`; Mercury returns 404 for both. The SDK's `IndexerClient` never used them, so nothing in the kit is affected — but if you called either endpoint directly, you'll need to source that data elsewhere (e.g. `kit.signers.getAll()` on-chain for signers, or self-host the old worker from git history).
- **Relayer proxy moved to the repo top level.** `indexer/relayer-proxy/` → `relayer-proxy/`, reflecting that fee-sponsored transaction submission is a distinct concern from indexing. Its Worker code, `relayerUrl` wiring, and REST surface are unchanged; only the source path moved.

---

## Review follow-up fixes

A verified code-review pass over the 0.4.0 branch applied the following behavior changes. They are folded into the 0.4.0 release (no compatibility layer).

**Correctness / behavior changes you may notice:**

- **`TransactionFailure.code` removed.** The convenience mirror is gone; branch on `result.error.code`. (See [Results & error handling](#results--error-handling).)
- **Policy params accept numeric strings.** `threshold`, `period_ledgers` (u32) and `spending_limit` (i128) now accept decimal numeric strings (e.g. `spending_limit: "1000000"`) in addition to `number`/`bigint`, matching the generated spec. Out-of-range or non-numeric strings throw a `ValidationError`.
- **`kit.credentials.deploy()` honors policies.** It now installs `options.policies ?? config.defaultPolicies` as constructor policies — the same behavior as `createWallet`. Previously `deploy()` silently deployed with no constructor policies even when `defaultPolicies` was configured. (The contract address is unchanged; constructor args are not part of the address preimage.)
- **Constructor policies validate before the passkey ceremony.** `createWallet` now converts/validates constructor policies up front, so an invalid policy config throws before a WebAuthn passkey is created (no orphaned pending credential).
- **Wallet-cancellation detection narrowed.** `StellarWalletsKitAdapter.connect()` only treats specific user-action phrases (`"user rejected"`, `"user denied"`, `"user cancel"`, `"modal closed"`, `"user closed"`, `"dismiss"`, `"user did not"`) as a cancellation (→ returns `null`). Infrastructure failures that merely contained `"closed"`/`"rejected"` (e.g. `"message port closed"`, allowlist rejections) now correctly **throw** instead of being swallowed as a silent cancellation. If you relied on `connect()` returning `null` for such errors, wrap the call in `try/catch`.
- **`fundWallet()` is testnet-only by exact passphrase.** The guard is now `networkPassphrase === Networks.TESTNET` (Futurenet's passphrase also contains `"Test"` and previously slipped through). It also reads the temp account's **real** native balance (via the account ledger entry) instead of falling back to a fabricated 10,000 XLM default.
- **Weighted-threshold / auth signer maps sort in host order.** The signer-map key sort now matches the Soroban host's `ScMap` ordering (element-wise byte comparison), fixing occasional `InvalidInput` rejections for wallets with two same-verifier signers whose key data differs in length. No API change.
- **Custom policy conversion never ships `Void`.** `buildPoliciesScVal` throws a `ValidationError` when a custom policy's params can't be converted, instead of silently sending an empty ScVal.

**Additive (non-breaking):**

- **`kit.signers.addBatch(ruleId, signers, { existingSignerCount })`.** Optional `existingSignerCount` pre-checks the batch against the rule-level `MAX_SIGNERS` limit (existing + new). Omitted → only the new batch size is checked (the contract still enforces the total at simulation).
- **`updateName` / `updateExpiration` validate inputs.** `kit.rules.updateName` now runs `validateContextRuleName` and `kit.rules.updateExpiration` runs `validateValidUntil`, matching `add`.
- **Delegated auth-entry nonces are cryptographically random** (`i64`) instead of `Date.now()`, avoiding nonce collisions between delegated entries built in the same millisecond.
- **Under-signable Ed25519 signers are surfaced.** `multiSigners.buildSelectedSigners` logs a warning when it drops an Ed25519 External signer with no matching local key (memory-only keys are gone after reload). Re-import via `kit.externalSigners.addEd25519FromSecret()`.

**Other behavior changes (minor, mostly logging):**

- **Event listener errors are logged by default.** `SmartAccountEventEmitter` now routes listener exceptions to `console.error` unless you set your own handler via `setErrorHandler`; `0.3.0` silently swallowed them. Existing apps may see new console output.
- **Corrupt stored data is logged.** `LocalStorageAdapter` now `console.error`s when stored credentials/session JSON fails to parse, instead of silently returning empty.
- **`StellarWalletsKitAdapter.init()` throws typed.** Missing configuration now throws `SmartAccountError` (`MISSING_CONFIG`) instead of a plain `Error`.
- **`createWallet` auto-fund misconfiguration is typed.** A missing `nativeTokenContract` with `autoFund` now surfaces as a `TransactionFailure` carrying a `ValidationError` (previously a string error).
- **Context-rule decoding rewritten** on top of the generated bindings spec (`funcResToNative`) plus `decodeContractError`. Intent is behavior-preserving, but error messages/types for malformed reads differ from `0.3.0`'s hand-rolled decoder.

---

See the [README](../README.md) for the full v0.4.0 API reference, and [`deployments-protocol-27-2026-07-09.md`](deployments-protocol-27-2026-07-09.md) for the deployed contract IDs and WASM hashes.
