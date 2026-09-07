> Part of the smart-account-kit first-principles review (2026-09-06). Findings in this document are referenced across the collection as **ARCH-F<n>**. Start with [`01-executive-summary.md`](01-executive-summary.md); the consolidated list of every finding is in [`10-findings-register.md`](10-findings-register.md); the rewrite proposal is in [`08-rewrite-blueprint.md`](08-rewrite-blueprint.md).

# Architecture, code smells, simplicity, internal structure of `src/` — findings

## Coverage

Read fully (every line): `src/kit.ts`, all of `src/kit/*.ts` (auth-payload, context-rules, deploy-ops, fund-ops, indexer-ops, policies-ops, tx-ops, wallet-ops, wallet-provenance, webauthn-ops), all of `src/managers/*.ts` (+ `test-utils.ts`), `src/external-signers.ts`, `src/signers.ts`, `src/signer-utils.ts`, `src/utils.ts`, `src/builders.ts`, `src/policy-clients.ts`, `src/contract-types.ts`, `src/contract-errors.ts`, `src/errors.ts`, `src/events.ts`, `src/types.ts`, `src/index.ts`, `src/storage/*.ts`, `src/wallet-adapter.ts`, `src/indexer.ts`, `src/relayer.ts`, `src/validation.ts`, `src/constants.ts`, `src/base64url.ts`, `src/version.ts`, `tsconfig.json`, `package.json`, `packages/smart-account-kit-bindings/{package.json,src/index.ts}`.

Skimmed: `src/kit.test.ts` (to see how tests reach private state), `demo/src/hooks/useKit.ts`, `demo/vite.config.ts`, `scripts/verify-esm.mjs`, `CHANGELOG.md`. Grepped `demo/src` for SDK usage. Read the installed `@stellar/stellar-sdk@16.0.1` type declarations for `base/auth`, `contract/{client,assembled_transaction,spec,basic_node_signer,types}`, `bindings/`, and the generated XDR to check what the SDK re-implements.

Did not read: `relayer-proxy/`, `indexer/`, `docs/*.md`, the OZ Rust sources (other agents), the remaining `*.test.ts` bodies.

Numbers below come from scripted greps run against `main @ 1a0c0eb`; the import graph was extracted with a small Python script (regex over `import ... from`). I ran one ad-hoc vitest to confirm F13; the repo is unmodified.

Size baseline: `src/` non-test = 13,289 lines, **8,580 lines of code** after stripping comments/blank; tests = 8,191 lines.

## Summary

The SDK has *no* static import cycles (one type-only cycle `types ⇄ external-signers`) and is unusually clean on `any` (zero) and `as unknown as` (4). That is the good news. The structural problem is that the folder layering is fake: `kit.ts` (924 code LOC) exists almost entirely to build 15 different "deps bags" containing ~30 distinct closures that reach back into its own private state (`requireWallet`, `getContractId`, `setConnectedState`, `signAuthEntry`, `sendAndPoll`…) and hand them to `src/kit/*-ops.ts` and `src/managers/*`. On paper `kit → kit/* → utils`; at runtime `kit.sign → tx-ops.sign → deps.signAuthEntry → kit.signAuthEntry → webauthn-ops.signAuthEntry → deps.requireWallet → kit`. It is a ball of mud with dependency injection: the modules do not encapsulate anything, and tests have to construct `{ _contractId, _credentialId, ... } as unknown as SmartAccountKit` (9 times in `kit.test.ts`) to exercise them.

The second problem is re-implementation of `@stellar/stellar-sdk` v16: five hand-rolled "keypair signs an auth entry" blocks that are exactly `authorizeEntry()`, a `getAddressCredentials` clone, three separate read-only-simulation builders with three dummy source accounts, hand-encoded `Signer`/`AuthPayload` ScVals next to a generated `Spec` that can do the same, and a bindings package that `export * from "@stellar/stellar-sdk"` and mutates `window.Buffer` on import. The duck-typed `extractCreateContractWasmHash` (written to avoid depending on XDR accessor names) probes three accessor names, two of which do not exist, and **throws on every `CreateContractV2` auth entry** — so `CreateContract` context rules can never be auto-resolved (F13, verified).

Connection state has at least seven sources of truth (`_contractId`, `_credentialId`, `wallet`, `storage.session`, `StoredCredential.contractId/deploymentStatus`, `ExternalSignerManager`'s three maps, the wallet adapter's map) and two different functions named `setConnectedState` with different behaviour. The type system uses bare `string` for 140 identifier fields (hex-vs-base64url credential IDs, G-vs-C addresses, hashes), `number` for token amounts, and optional-everything bags like `SelectedSigner`.

The rewrite should: (1) delete the `SmartAccountKit` god object and the deps-bag pattern, replacing it with an immutable `SmartAccount` value (`contract.Client` + address + network) and a pure `authorize(tx, { account, signers, rules })` pipeline; (2) model signers as a single `Signer` interface (`identity` + `sign(digest)`) with WebAuthn/Ed25519/Delegated implementations in separate entry points; (3) lean on `authorizeEntry`, `Client.from`, `Spec`, `SAC_SPEC` from stellar-sdk and delete ~2,000 lines; (4) split into `core` (isomorphic), `webauthn` (browser), `node` (keypairs) packages/entry points; (5) brand identifier types. A from-scratch version with full contract parity is realistically **~3,000–3,500 code LOC** including the provenance verifier, versus 8,580 today.

## Findings

### ARCH-F1. The layering is inverted by closure injection — modules receive slices of `kit`'s private state   [severity: high]
- **Where:** `src/kit.ts:548-617` (manager wiring), `src/kit.ts:886-914`, `1027-1047`, `1059-1113`, `1158-1167`, `1197-1211`, `1235-1250`, `1272-1286`, `1547-1559`; `src/kit/tx-ops.ts:583-596`, `631-648`; `src/kit/wallet-ops.ts:53-90`, `197-211`, `307-339`; `src/kit/webauthn-ops.ts:43-53`; `src/managers/multi-signer-manager.ts:71-95`; `src/managers/credential-manager.ts:22-58`.
- **What:** `kit.ts` contains **61** arrow-function closures of the form `key: (…) => this.something(…)` and `157` lines that are pure `key: this.field` forwarding. There are **15** distinct `deps: { … }` parameter shapes in `src/kit/*.ts` plus 6 `*ManagerDeps` interfaces. Across them I count ~30 distinct callback names that reach back into the kit: `requireWallet` (35 references), `getContractId` (19), `getCredentialId`, `isConnected`, `setConnectedState`, `clearConnectedState`, `initializeWallet`, `createPasskey`, `signAuthEntry`, `sendAndPoll`, `hasSourceAccountAuth`, `shouldUseFeeSponsoring`, `calculateExpiration`, `signWithDeployer`, `submitDeploymentTx`, `buildDeployTransaction`, `fundWallet`, `deriveContractAddress`, `getRules`, `getContractDetailsFromIndexer`, `lookupWalletCandidates`, `readContextRule`, `authenticateCredential`, `connectWithCredentials`, `signResimulateAndPrepare`, `validateConstructorPolicies`, `getVerifiedCredential`, `getSmartAccount`, `encodeContextRule`, `execute`.
  Example of the runtime cycle: `kit.signAndSubmit` (kit.ts:1186) → `tx-ops.signAndSubmit` → `deps.signResimulateAndPrepare` → `kit.signResimulateAndPrepare` (1542) → `tx-ops.signResimulateAndPrepare` → `deps.signAuthEntry` → `kit.signAuthEntry` (1227) → `webauthn-ops.signAuthEntry` → `deps.requireWallet()` **twice** (webauthn-ops.ts:157 and :165) → `kit`.
  `MultiSignerManagerDeps` (multi-signer-manager.ts:71-95) has 15 fields including both `deployerKeypair` and `deployerPublicKey`.
- **Why it matters:** The folders suggest a layered design but every op module's real contract is "give me the parts of the kit I need". Nothing can be used without the kit; nothing can be reasoned about without reading the kit. Tests must forge the kit (`{ _contractId: "CABC", … } as unknown as SmartAccountKit`, `src/kit.test.ts:165-236`, 9 occurrences), i.e. they are coupled to private field names. Every new feature adds a closure in the constructor, a field in a `Deps` type, and a forwarding method — three edits for one behaviour.
- **Rewrite recommendation:** Replace the closure bags with **values**. An op needs three things: a network handle (`{ rpc, networkPassphrase }`), an account (`{ contractId, client }`), and a set of signers. Pass those as plain arguments; never pass "how to get the current contract id". See the proposed architecture below.

### ARCH-F2. `SmartAccountKit` is a god object; the minimal core is ~5 fields   [severity: high]
- **Where:** `src/kit.ts:223-1707` (35 fields, 41 methods; constructor is 204 lines, `kit.ts:415-618`).
- **What:** Classification of the 35 fields / 41 methods:

  | Category | Members |
  |---|---|
  | **Network config** (immutable, needed everywhere) | `rpcUrl`, `networkPassphrase`, `rpc`, `timeoutInSeconds`, `history` |
  | **Contract/code config** | `accountWasmHash`, `acceptedWasmHashes`, `acceptedBirthWasmHashes`, `webauthnVerifierAddress`, `ed25519VerifierAddress`, `defaultPolicies`, `probeRuleIds`, `signatureExpirationLedgers` |
  | **WebAuthn config** (browser only) | `rpId`, `allowedOrigins`, `rpName`, `webAuthn` |
  | **Persistence** | `storage`, `sessionExpiryMs`, (localStorage default for external signers, `kit.ts:536-538`) |
  | **Mutable connection state** | `_credentialId`, `_contractId`, `wallet` (public, mutable), plus `ConnectedContextRuleCache` created per call (`kit.ts:171-174`) |
  | **Deployer identity** | `deployerKeypair`, `usingSharedDeployer`, `deployerPublicKey` getter |
  | **Sub-object delegation** | `signers`, `rules`, `policies`, `credentials`, `events`, `multiSigners`, `externalSigners`, `indexer`, `relayer`, `policyClients` getter |
  | **Discovery** | `discoverContractsByCredential`, `discoverContractsByAddress`, `getContractDetailsFromIndexer`, `getActiveContractDetailsFromIndexer` (4 methods that are `if (!indexer) return null; return indexer.x()` — see `kit/indexer-ops.ts`) |
  | **Deployment** | `createWallet`, `createPasskey`, `buildDeployTransaction`, `submitDeploymentTx`, `signWithDeployer`, `fundWallet` |
  | **Connection** | `connectWallet`, `connectWithCredentials`, `authenticatePasskey`, `disconnect`, `requireWallet`, `initializeWallet`, `setConnectedState`, `clearConnectedState`, getters `credentialId`/`contractId`/`isConnected` |
  | **Signing/submission** | `sign`, `signAndSubmit`, `signAuthEntry`, `transfer`, `execute`, `executeAndSubmit`, `upgrade`, `signResimulateAndPrepare`, `resolveConnectedContextRuleIds`, `hasSourceAccountAuth`, `buildTokenTransfer`, `shouldUseFeeSponsoring`, `sendAndPoll`, `calculateExpiration` |
  | **Policy encoding utilities** (stateless; do not belong on an instance) | `convertPolicyParams`, `buildPoliciesScVal`, `policyClientDeps` |

  Eight of the 41 methods are one-line private forwarders whose only job is to re-pack `this` into a deps bag (`hasSourceAccountAuth`, `shouldUseFeeSponsoring`, `sendAndPoll`, `buildTokenTransfer`, `signWithDeployer`, `submitDeploymentTx`, `buildDeployTransaction`, `createPasskey`).
- **Why it matters:** The class conflates five lifetimes: app config (forever), network handle (forever), a user's session (until disconnect), a single operation's cache, and stateless codecs. `wallet?: SmartAccountClient` is public and mutable (`kit.ts:271`), so consumers can desync it from `_contractId`. `README.md:275` even documents `kit.wallet` as a "raw escape hatch".
- **Rewrite recommendation:** Minimal core is `Network = { rpc, networkPassphrase }` and `SmartAccount = { address, client: contract.Client, network }`. Everything else is either a function over those or a separate, optional object (`Session`, `Indexer`, `Relayer`, `WebAuthnAuthenticator`). Delete the class.

### ARCH-F3. `src/kit/` vs `src/managers/` vs root is organised by *who calls it*, not by *what it is*   [severity: medium]
- **Where:** `src/kit/*` (10 files), `src/managers/*` (5 + index), root (20 files).
- **What:** `src/kit/` is "functions kit.ts delegates to"; `src/managers/` is "classes kit.ts exposes as properties"; root is everything else. Consequences: auth-digest logic is split across `src/signers.ts:41-52` (`computeEntryAuthDigest`), `src/kit/auth-payload.ts` (`buildSignaturePayload`, `buildAuthDigest`, `readAuthPayload`, `writeAuthPayload`), and `src/kit/webauthn-ops.ts:120-209` (the WebAuthn signer that consumes them). Signer helpers live in four places: `src/signer-utils.ts`, `src/builders.ts:24-155` (constructors), `src/signers.ts` (`Ed25519Signer`), `src/external-signers.ts` (`ExternalSignerManager`). Context-rule *reading* is in `src/kit/context-rules.ts`, context-rule *writing* is in `src/managers/context-rule-manager.ts`, context-rule *validation* is in `src/validation.ts`. Token-amount math (`expandDecimal`, `tokenAmountToRawUnits`, `readTokenDecimals`) lives in `tx-ops.ts:213-377` between `sendAndPoll` and `buildDirectTokenTransfer`.
- **Why it matters:** A reader looking for "how is a Delegated signer authorized" has to visit `multi-signer-manager.ts:414-461`, `external-signers.ts:532-563`, `wallet-adapter.ts:263-289`, and `auth-payload.ts:116-132`.
- **Rewrite recommendation:** Organise by domain noun: `auth/` (digest, payload, rule resolution), `signers/` (webauthn, ed25519, delegated), `account/` (read/write rules/signers/policies via `contract.Client`), `deploy/`, `submit/` (rpc, relayer), `verify/` (provenance), `discovery/` (indexer), `session/` (storage). See layout below.

### ARCH-F4. Five hand-rolled "keypair signs an auth entry" blocks; stellar-sdk v16 ships `authorizeEntry`   [severity: high]
- **Where:** `src/kit/deploy-ops.ts:510-531`; `src/kit/fund-ops.ts:172-204` and `215-230`; `src/managers/multi-signer-manager.ts:196-231` (`signWalletAddressAuthEntry`) and `414-461` (delegated `__check_auth` entries); `src/external-signers.ts:532-563`. Helper trio `buildSignaturePreimage` / `buildAddressSignatureScVal` / `createAddressCredentials` / `randomAuthEntryNonce` in `src/kit/auth-payload.ts:22-35, 82-86, 116-132, 316-325`.
- **What:** Each site does: clone entry → set `signatureExpirationLedger` → `buildAuthorizationEntryPreimage` → `hash(preimage.toXDR())` → `keypair.sign` → wrap as `scvVec([scvMap({public_key, signature})])` → write into credentials. `@stellar/stellar-sdk@16` exports exactly this as `authorizeEntry(entry, signer: Keypair | SigningCallback, validUntilLedgerSeq, networkPassphrase, forAddress?)` (`lib/esm/base/auth.d.ts:117`) and `authorizeInvocation(...)` for building a fresh entry from an invocation (which is what `multi-signer-manager.ts:419-460` does by hand for delegated signers). `SigningCallback` accepts a wallet (returns `{signature, publicKey}`), so the `ExternalWalletAdapter.signAuthEntry` path fits too. `src/kit/auth-payload.ts:53-66` `getAddressCredentials` is a copy of the SDK's `getAddressCredentials` (`auth.d.ts:272`).
- **Why it matters:** ~180 lines of security-sensitive signing code that the SDK already maintains and tests, five chances for subtle divergence (e.g. `fund-ops.ts:165` uses `LEDGERS_PER_HOUR` expiry while `multi-signer-manager.ts:284` uses `AUTH_ENTRY_EXPIRATION_BUFFER = 100` ledgers for the same kind of entry).
- **Rewrite recommendation:** Delete all five; use `authorizeEntry` for G-address signers (Keypair or wallet callback) and `authorizeInvocation` for the delegated `__check_auth` entries. Keep only what is smart-account-specific: the `AuthPayload` codec and the digest formula.

### ARCH-F5. Three separate read-only simulation builders and three dummy source accounts   [severity: medium]
- **Where:** `src/kit/tx-ops.ts:216-254` (`TOKEN_READ_ACCOUNT`, `readOnlyTokenTx`); `src/kit/context-rules.ts:59-63, 181-224` (`READ_ONLY_SIM_ACCOUNT`, `readContextRuleFromRpc`); `src/policy-clients.ts:45-53, 88-118` (a second `READ_ONLY_SIM_ACCOUNT`, `simulateGetter`). Plus `src/kit/fund-ops.ts:147-153` and `tx-ops.ts:474-485` (`resimulateAndAssemble`) build `TransactionBuilder`s by hand.
- **What:** Three copies of "build an invokeHostFunction tx from a fixed account, simulate, decode `sim.result.retval`, map `sim.error` through `decodeContractError`". Two different deterministic seeds (`"smart-account-kit-context-rule-read"`, `"smart-account-kit-policy-read"`) and one literal `GAAAA…AWHF`. `contract.Client` / `AssembledTransaction.build` already do this (`isReadCall`, `.result`), and `context-rules.ts:322` already *has* the client call (`wallet.get_context_rule`) — the RPC path exists only to feed the legacy-shape shim (F15).
- **Rewrite recommendation:** One `simulateRead(network, contractId, fn, args): Promise<xdr.ScVal>` (≈25 lines) or, better, always go through a `contract.Client` built with `Client.from`/spec and read `.result`.

### ARCH-F6. Two near-identical `transfer()` implementations and three identical rule-resolver closures   [severity: medium]
- **Where:** `src/kit.ts:1313-1364` vs `src/managers/multi-signer-manager.ts:528-577` (validation → `resolveTokenAmount` → `buildDirectTokenTransfer` → submit; 40 lines each, differing only in the final call). `src/kit.ts:1151-1156`, `1190-1195`, `1352-1358` build the same `resolveContextRuleIds ?? ((entry) => this.resolveConnectedContextRuleIds(entry, options?.credentialId, ctxRuleCache))` closure three times (and `transfer` builds it then passes into `signAndSubmit`, which builds it again).
- **Why it matters:** The single-signer path and the multi-signer path are the same pipeline with a different signer set. Having two entry points (`kit.transfer` / `kit.multiSigners.transfer`, `kit.signAndSubmit` / `kit.multiSigners.operation`) and a `needsMultiSigner()` heuristic (`multi-signer-manager.ts:117-125`) that the demo must call to pick between them is the symptom.
- **Rewrite recommendation:** One `authorize(tx, { signers: Signer[] })`. A passkey-only wallet passes `[passkey]`; a 2-of-3 passes three. Delete `MultiSignerManager`, `SelectedSigner`, `buildSelectedSigners`, `needsMultiSigner`.

### ARCH-F7. `submitDeploymentTx` has two branches with a byte-identical 15-line catch block; `describeDeploymentBirth` duplicates `deploymentCreateArgs`   [severity: low]
- **Where:** `src/kit/deploy-ops.ts:324-338` ≡ `398-412`; `deploy-ops.ts:59-86` vs `88-107` (first 20 lines identical).
- **Rewrite recommendation:** In the rewrite the shared-deployer route (`{func, auth}` to relayer) is the *only* route for the default deployer and the custom-deployer route is a normal signed transaction; `DeployTransaction` as a union of two carriers (`deploy-ops.ts:37-39`) disappears. `describeDeploymentBirth` becomes a 10-line function over `xdr.CreateContractArgsV2`.

### ARCH-F8. Repeated hash/hex normalisation, address validation, credential-type switches   [severity: low]
- **Where:** `HASH_HEX` + `normalizeHash` defined twice (`src/indexer.ts:507-524`, `src/kit/wallet-provenance.ts:22-67`); `deriveContractAddress` (`src/utils.ts:157-176`) and `contractIdFromCreateV2` (`wallet-provenance.ts:83-99`) both compute a contract id from a preimage; `StrKey.isValidContract` inlined in `builders.ts:87, 200` (and `isValidEd25519PublicKey` at l.44) plus `validateAddress` in `utils.ts:52-71`; `credentials().switch().name as string` compared against string literals in four places (`fund-ops.ts:168`, `webauthn-ops.ts:131`, `multi-signer-manager.ts:203, 288`) and "ADDRESS_WITH_DELEGATES … not supported yet" thrown in four places.
- **Rewrite recommendation:** One `Hex32` brand + parser; one `contractIdFromPreimage`; one `credentialKind(entry)` helper — or, with `authorizeEntry`/`buildWithDelegatesEntry` from the SDK, no switch at all.

### ARCH-F9. Connected-guard and error-wrapping ceremony repeated per method   [severity: low]
- **Where:** `new WalletNotConnectedError` constructed in 9 places, 5 of them as `failedTransaction(new WalletNotConnectedError(...))` (e.g. `kit.ts:1321`, `tx-ops.ts:658`, `fund-ops.ts:93`, `multi-signer-manager.ts:243, 537`); `failedTransaction(wrapError(err, …))` catch-alls in 8 places; `requireWallet()` 35 references.
- **What:** Two conventions coexist: "throw typed error" (90 sites) and "return `{success:false, error}`" (submission methods), plus **59** untyped `throw new Error(...)` (e.g. `wallet-ops.ts:365, 369, 384`, `context-rules.ts:105, 150, 208, 390, 467, 491, 570`, `webauthn-ops.ts:133, 147, 152`). `types.ts:466-471` documents the split but the boundary is not principled (`kit.sign` throws, `kit.signAndSubmit` returns).
- **Rewrite recommendation:** If the account is a value you cannot call methods on it while "not connected"; the guard disappears. Pick one error convention (throw typed errors; let callers `try`), and delete `TransactionResult`'s failure branch — a submission that failed on-chain is an exception with a `hash` property.

### ARCH-F10. Dead error classes, error codes, event types, credential fields   [severity: low]
- **Where:** `src/errors.ts` — `WebAuthnError` (l.282), `SessionError` (l.346), `CredentialNotFoundError` (l.136) are exported and **never constructed**; codes `WALLET_ALREADY_EXISTS, WALLET_NOT_FOUND, CREDENTIAL_ALREADY_EXISTS, CREDENTIAL_INVALID, TRANSACTION_TIMEOUT, SIGNER_INVALID, STORAGE_READ_FAILED, STORAGE_WRITE_FAILED` are never referenced. `src/events.ts:17-39` declares 7 events; `credentialDeleted`, `transactionSigned`, `transactionSubmitted` are never emitted. `src/types.ts:57-123` `StoredCredential`: `deviceType` and `backedUp` are never written or read; `lastUsedAt` is written (`webauthn-ops.ts:207`, a storage round-trip on every signature) and never read; `deploymentTransactionHash` written 4× never read. `SmartAccountErrorCode.CONTRACT_ERROR = 10000` (`errors.ts:66`) exists because the SDK code space (`3001-3004` credential errors) collides with contract codes `3000-3016` (comment at `errors.ts:61-65`).
- **Rewrite recommendation:** Start the error enum from what is thrown. Drop the numeric code space; use `class X extends SmartAccountError` with a string `kind` discriminant, and carry raw contract codes on `ContractError` only.

### ARCH-F11. `types.ts` duplicates itself and the bindings   [severity: low]
- **Where:** `src/types.ts:517-524` `SubmitOptions` ≡ `537-547` `SubmissionOptions` (same single field). `src/contract-types.ts` hand-declares `SimpleThresholdAccountParams`, `WeightedThresholdAccountParams`, `SpendingLimitAccountParams`, `SpendingLimitData`, `SpendingEntry` which are contract structs whose generated bindings do not exist (only the account binding was generated). The `authenticatorSelection` literal type is inlined 5 times (`kit.ts:844-848, 926-930`, `wallet-ops.ts:63-67, 95-99`, `webauthn-ops.ts:59-63`); the policy-type union `"threshold" | "spending_limit" | "weighted_threshold"` 6 times; `{credentialId?, expiration?, contextRuleIds?}` 5 times; `ResolveContextRuleIds` is declared in `types.ts:497-500` and re-declared inline in `tx-ops.ts:50-53` and `multi-signer-manager.ts:65-68`.
- **Rewrite recommendation:** Generate bindings for the three policies and the two verifiers too (stellar-sdk v16 ships the generator under `lib/esm/bindings/`), so param/data structs come from specs. Name every option type once.

### ARCH-F12. Legacy shim for pre-`signer_ids` contract builds (≈130 lines) contradicts "no backward compat"   [severity: medium]
- **Where:** `src/kit/context-rules.ts:130-179` (`hydrateContextRuleIds`), `236-291` (`decodeContextRuleWithSpec` injecting empty `signer_ids`/`policy_ids` and bytewise-sorting the map), `299-310` (`rawSimulationRetval` duck-typing `AssembledTransaction`), `312-338` (`readContextRule` with two paths), `181-224` (`readContextRuleFromRpc`, which exists only because the bindings' `.result` fails on the old shape). `ContextRuleQueryClient` (l.36-42) makes `get_policy_id`, `get_signer_id`, `spec` all optional to accommodate test doubles.
- **What:** The doc comment at l.226-235 says "Wallets deployed from older account builds omit those fields". The pinned contract (`1e513890`) and the bindings both have `signer_ids`/`policy_ids`. `v0.7.0` fails closed on `acceptedWasmHashes`, so an "older build" can no longer connect anyway.
- **Rewrite recommendation:** Delete all of it. `readContextRule = (await client.get_context_rule({context_rule_id})).result`.

### ARCH-F13. `extractCreateContractWasmHash` is duck-typed against accessor names that do not exist, and throws on every `CreateContractV2` entry   [severity: high]
- **Where:** `src/kit/context-rules.ts:577-628`; called from `buildInvocationContextTypes` (l.87-121) → `resolveContextRuleIdsForEntry` (l.499-575) → `kit.resolveConnectedContextRuleIds` (kit.ts:1562) and `multi-signer-manager.ts:333`.
- **What:** The function casts `fn as unknown as { createContractHostFn?, createContractWithCtorHostFn?, createContractWithConstructorHostFn? }` and calls each that `typeof … === "function"`. In js-xdr every union arm accessor exists on the prototype, so `typeof fnAny.createContractHostFn === "function"` is always true and calling it on a V2 arm throws. The real V2 accessor is `createContractV2HostFn` (`@stellar/stellar-sdk/lib/esm/base/generated/curr.d.ts:13080`); the other two names never existed. Verified with a one-off vitest: building an entry with `sorobanAuthorizedFunctionTypeCreateContractV2HostFn` and calling `buildInvocationContextTypes` throws `TypeError: createContractHostFn not set`. No test in `context-rules.test.ts` covers `CreateContract`.
- **Why it matters:** Every contract deployment since Protocol 22 uses `CreateContractV2` (constructor support). A smart account that authorizes a deployment (the `CreateContract` context type the contract *does* support) cannot have its rule id auto-resolved by this SDK; `resolveContextRuleIdsForEntry` throws a `TypeError` before the "Provide contextRuleIds explicitly" hint is reached. This is a correctness bug caused directly by an architectural choice (duck-typing to avoid the typed XDR API).
- **Rewrite recommendation:** `switch (fn.switch())` on the three real arms (`contractFn`, `createContractHostFn`, `createContractV2HostFn`) and read `.executable().wasmHash()`. ~12 lines. Add a test for each arm.

### ARCH-F14. Mutable connection state with ≥7 sources of truth and two different `setConnectedState`s   [severity: high]
- **Where:** `src/kit.ts:267-271` (`_credentialId`, `_contractId`, `wallet`); `kit.ts:586-589` (a `setConnectedState` closure that sets the two ids **without** creating the client) vs `kit.ts:760-764` (the private method with the same name that also calls `initializeWallet`); `src/managers/credential-manager.ts:207-208` (calls both, and unlike `createWallet` never calls `storage.saveSession`, so a `credentials.deploy()`-connected wallet is not restorable on reload while a `createWallet()`-connected one is — compare `wallet-ops.ts:162-173`); `src/kit.ts:171-174` per-operation `ConnectedContextRuleCache`; `src/external-signers.ts:103-124` three in-memory maps (`keypairSigners`, `ed25519Signers`, `walletAdapter`) plus `restored` flag whose `restoreConnections()` (l.305) is never called by the kit or the demo; `src/wallet-adapter.ts:110` a fourth map; `src/types.ts:37-49` `StoredSession`; `StoredCredential.contractId` / `deploymentStatus` / `isPrimary` / `associationVerified`.
- **What:** The question "what am I connected to and who can sign for it?" is answered by: `kit.contractId` (may be set while `kit.wallet` is undefined via the l.586 closure), `kit.credentialId` (may differ from `options.credentialId` overrides accepted by `sign`/`signAuthEntry`), the storage session (may be expired), `externalSigners.getAll()` (excludes SWK wallets that were added as keypairs, `external-signers.ts:475`), and the on-chain rules. `disconnect()` clears three of these.
- **Why it matters:** State drift bugs are already visible (the session inconsistency above; `canSignFor` in `external-signers.ts:496` ignores Ed25519 signers so `buildSelectedSigners` has a separate `canSignEd25519` path). A rewrite as immutable values removes the class of bug.
- **Rewrite recommendation:** `connect()` returns a value: `{ account: SmartAccount, signer: WebAuthnSigner, credential }`. There is no `disconnect()` on the account — dropping the reference is disconnecting; session persistence is an optional `SessionStore.save(account.address, credentialId)` the app calls. Signers are an explicit array passed to `authorize`. No caches on objects; the rules snapshot is a local variable inside one `authorize` call.

### ARCH-F15. `ExternalSignerManager` conflates three unrelated signer kinds behind string-keyed maps   [severity: medium]
- **Where:** `src/external-signers.ts:101-565`; consumers `multi-signer-manager.ts:137-194, 255-277, 386-404`.
- **What:** Delegated-by-Keypair, Delegated-by-wallet, and External-Ed25519 are stored in three maps keyed by G-address / hex pubkey and exposed through `canSignFor`, `canSignEd25519`, `signAuthEntry(preimageXdr: string, address)`, `signEd25519Digest(keyData, digest)`. The result is a `type: "keypair" | "wallet" | "ed25519"` string enum on `ExternalSigner` (l.55-68) and a parallel `type: "passkey" | "wallet" | "ed25519"` on `SelectedSigner` (`types.ts:649-665`) with four mutually-exclusive optional fields. `signers.ts:58-66` already defines the right abstraction (`AuthDigestSigner { signer; signAuthDigest(digest) }`) but only `Ed25519Signer` implements it and nothing consumes the interface (grep: zero non-test consumers besides the class itself).
- **Rewrite recommendation:** Two interfaces cover every contract-permitted signer:
  ```ts
  interface ExternalSigner { readonly identity: Signer /* tag External */; sign(authDigest: Uint8Array): Promise<Uint8Array> }
  interface DelegatedSigner { readonly identity: Signer /* tag Delegated */; authorize(preimage: xdr.HashIdPreimage): Promise<Uint8Array> }
  ```
  `WebAuthnSigner`, `Ed25519Signer`, `KeypairDelegate`, `WalletDelegate` implement them. The manager, both `type` enums, `SelectedSigner`, and the `canSignFor*` family are deleted.

### ARCH-F16. `smart-account-kit-bindings`: `export *` of the whole stellar-sdk, a `window.Buffer` side effect, and a 25 KB base64 spec blob   [severity: medium]
- **Where:** `packages/smart-account-kit-bindings/src/index.ts:24-31` (`export * from "@stellar/stellar-sdk"; export * as contract …; export * as rpc …; if (typeof window !== "undefined") window.Buffer = window.Buffer || Buffer;`), `package.json` `dependencies: { buffer: "6.0.3" }`; `src/kit.ts:749-753, 1076-1080` are the only two runtime `new SmartAccountClient(...)`; neither `package.json` declares `"sideEffects": false`.
- **What:** The bindings package re-exports the entire SDK namespace and mutates a global at import time, so bundlers cannot tree-shake either package (no `sideEffects` field → everything is assumed effectful). The SDK uses the bindings for exactly three things: the `Client` class (2 sites), its `spec` (`nativeToScVal` at `kit.ts:1429`, `policies-ops.ts:210`, `funcResToNative` at `context-rules.ts:282`), and the `Signer`/`ContextRule`/`ContextRuleType`/`AuthPayload` types. Everything else in the 677-line file is re-wrapped: `SmartAccountError` map (l.97-163) is duplicated by `CONTRACT_ERROR_REGISTRY` (`contract-errors.ts:67-82`, with a test asserting sync); the `Client` interface's 15 methods are re-declared as structural subsets in `SignerManagerDeps` (`signer-manager.ts:20-27`), `ContextRuleManagerDeps` (`context-rule-manager.ts:19-33`), `PolicyManagerDeps` (`policy-manager.ts:14-27`), and `ContextRuleQueryClient` (`context-rules.ts:36-42`).
  stellar-sdk v16 offers `contract.Client.from({ contractId, rpcUrl, networkPassphrase })` (fetches the spec from the ledger, `contract/client.d.ts:61`) and `Client.fromWasmHash`, so a separate published bindings package is not required for runtime; it is required only for *types*, which can be generated into `src/generated/` at build time (`@stellar/stellar-sdk/lib/esm/bindings/` is the generator) and never published.
- **Rewrite recommendation:** Delete the published bindings package. Generate `src/generated/{smart-account,threshold,weighted-threshold,spending-limit,webauthn-verifier,ed25519-verifier}.ts` from the pinned WASMs in CI; import types from there; construct the client with the embedded spec (no network fetch) but without `export *` or the Buffer side effect. Add `"sideEffects": false`.

### ARCH-F17. Browser/Node coupling at the top of the import graph   [severity: medium]
- **Where:** `src/kit.ts:8-15` imports `startRegistration`/`startAuthentication` from `@simplewebauthn/browser` at module top level (only used as constructor defaults, l.468); `kit.ts:457-466` reads `globalThis.location`; `kit.ts:536-538` defaults to `localStorage`; `src/storage/localStorage.ts`, `storage/indexeddb.ts` are browser-only but re-exported from the root `index.ts:84-88`; `src/wallet-adapter.ts` (SWK, browser) exported from root; `src/utils.ts:26-28` derives a `Keypair` at module load; `Buffer.*` used 71 times across non-test `src` (56× `Buffer.from`); `tsconfig.json` `lib: ["ES2022","DOM"]` so DOM globals type-check everywhere; `src/kit/fund-ops.ts:105` and `relayer.ts:229`, `indexer.ts:457` assume global `fetch` (fine on Node ≥18, but not injectable for tests or custom transports).
- **What:** The CHANGELOG 0.6.2 entry ("Nonce encoding now uses DataView without Buffer BigInt accessors") records the class of bug this causes: `Buffer` is whatever polyfill the consumer's bundler injected. The demo has to alias `buffer` in `vite.config.ts:13-23`. The SDK cannot run in a Node server agent that wants Ed25519-only signing without pulling `@simplewebauthn/browser` into the graph (it is ESM-only and references `navigator`/`window` at call time, not import time, so it loads — but it is still 1 dependency and an entry-point tree that a Node consumer never needs).
  What is actually used from `@simplewebauthn/browser`: two functions, `startRegistration` and `startAuthentication`, which are thin wrappers over `navigator.credentials.create/get` with base64url ↔ ArrayBuffer conversion; and types. `src/utils.ts:189-292` (`extractPublicKeyFromAttestation`) and `wallet-provenance.ts:381-480` (`verifyFreshAssertion`) already parse the raw responses by hand.
- **Rewrite recommendation:** Three entry points in one package (`exports` map): `smart-account-kit` (core: isomorphic, `Uint8Array` only, no `Buffer`, no DOM types — `lib: ["ES2022"]`), `smart-account-kit/webauthn` (browser: `WebAuthnSigner`, `IndexedDbSessionStore`; call `navigator.credentials` directly, ~80 lines, drop `@simplewebauthn/browser`), `smart-account-kit/node` (`KeypairSigner`, `KeypairDelegate`, `FileSessionStore` if wanted). Inject `fetch`/`crypto` via `Network` options with global defaults.

### ARCH-F18. Dependencies: `base64url` npm package + a local shim; `@simplewebauthn/browser` for two functions; peer `>=16` without an upper bound   [severity: low]
- **Where:** `package.json:57-62`; `src/base64url.ts` (a type cast to work around the package's CJS/ESM typings); 25 call sites (`base64url.toBuffer` ×19, `.encode` ×4, callable ×2).
- **What:** `Buffer.from(s, "base64url")` / `.toString("base64url")` exist in Node ≥15.7 and in the `buffer@6` polyfill; in a `Uint8Array`-only core a 10-line `b64u.encode/decode` using `atob`/`btoa` (or `Uint8Array.fromBase64` where available) is enough. `@simplewebauthn/browser` is used for `startRegistration`/`startAuthentication` only (F17). `@stellar/stellar-sdk: ">=16.0.0"` as both dependency and peer with no ceiling means a v17 with changed `contract.Client` semantics resolves silently.
- **Rewrite recommendation:** Zero runtime deps besides `@stellar/stellar-sdk` (peer, `^16`). Delete `base64url` and `@simplewebauthn/browser`.

### ARCH-F19. Type quality: bare `string` for every identifier; `number` for token amounts; optional-everything bags   [severity: medium]
- **Where:** 140 occurrences of `credentialId|contractId|address|hash: string` across `types.ts`, `indexer.ts`, `kit/*`, `managers/*`. Credential IDs are base64url in `types.ts:41,58,418,444`, hex in `indexer.ts:95,275`, and "hex or base64url" in `kit.ts:662` with a heuristic converter `normalizeCredentialIdToHex` (`kit/indexer-ops.ts:47-58`) that guesses by regex (`/^[0-9a-fA-F]+$/` — a base64url id made of only hex characters is misclassified). `amount: number` in `kit.transfer` (kit.ts:1316) with a 70-line exact-decimal expander (`tx-ops.ts:294-364`) to survive `Number` formatting; `stroopsToXlm(): number` (`utils.ts:112`). `SelectedSigner` (`types.ts:649-665`) has one required discriminant and five optionals with no correlation. `PolicyConfig.installParams: unknown` (`types.ts:354`) accepts anything and fails at `convertPolicyParams`. `ContextRule.valid_until: Option<u32>` is normalised `null → undefined` in one place (`context-rules.ts:287-289`) but checked for both everywhere (`wallet-ops.ts:527-528`, `context-rules.ts:423-424`). Rule ids, signer ids, policy ids are all `number`. `upgrade(newWasmHash: string | Buffer)` (kit.ts:1406). The bindings' `Signer` tuple is already precisely typed (`readonly [string, Buffer]`) yet the SDK casts `signer.values[1] as Buffer` / `values[0] as string` in 15 places (`signer-utils.ts:10,27-30,42`, `builders.ts:443-494`, `multi-signer-manager.ts:145,170`, `context-rules.ts:455`).
- **Rewrite recommendation:**
  ```ts
  type ContractAddress = string & { readonly __brand: "C" };  type AccountAddress = string & { readonly __brand: "G" };
  type CredentialId = Uint8Array & { readonly __brand: "credentialId" };  // one canonical form; encode at the edges
  type Hash32 = Uint8Array & { readonly __brand: "hash32" };
  type RuleId = number & { readonly __brand: "ruleId" };
  type Stroops = bigint & { readonly __brand: "stroops" };   // transfer(amount: Stroops); helpers parseUnits(text, decimals)
  type SelectedSigner = { kind: "passkey"; credentialId: CredentialId } | { kind: "delegated"; address: AccountAddress } | { kind: "ed25519"; publicKey: Uint8Array }  // or, better, delete in favour of Signer objects
  type PolicyInstall = { kind: "threshold"; threshold: number } | { kind: "spendingLimit"; limit: Stroops; periodLedgers: number } | { kind: "weightedThreshold"; ... } | { kind: "custom"; address: ContractAddress; param: xdr.ScVal }
  ```

### ARCH-F20. Hand-rolled ScVal codecs next to the generated spec (and one that must stay)   [severity: low]
- **Where:** `src/kit/auth-payload.ts:99-114` (`buildWebAuthnSignatureBytes`), `141-192` (`readAuthPayload`), `265-290` (`writeAuthPayload`), `327-383` (`signerToScVal`/`parseSignerScVal`); `src/kit/policies-ops.ts:63-101` (three policy param encoders "byte-identical to the spec's encoding — see test"); `context-rules.ts:236-291` (map re-sorting).
- **What:** `Spec.nativeToScVal(value, ScSpecTypeDef)` and `Spec.funcResToNative` cover `Signer`, `AuthPayload`, `ContextRule`, and (with generated policy specs) the three param structs. The one thing the SDK does that stellar-sdk does **not**: `compareScVal` (`auth-payload.ts:212-263`) sorts map keys in Soroban host order. I checked `lib/esm/contract/spec.js:685-725` and `base/scval.js:228-244`: `Spec.nativeToScVal` emits `Map` entries in insertion order (no sort), and `scvSortedMap` sorts by `toString()` of the native key — wrong for `Vec` keys (the `Signer` enum). So `writeAuthPayload`/`encodeWeightedThresholdParams` genuinely need the custom comparator today.
- **Rewrite recommendation:** Keep `compareScVal` + a 5-line `sortedScMap(entries)`; encode everything else through the spec (`spec.nativeToScVal(signer, SIGNER_TYPE)`), then sort. File an upstream issue on js-stellar-sdk so `nativeToScVal` sorts host-order for `Map` inputs; when fixed, delete the comparator.

### ARCH-F21. `context-rules.ts` rule discovery is an RPC-heavy heuristic because the contract has no iterator   [severity: medium]
- **Where:** `src/kit/context-rules.ts:340-428` (`listContextRules`: indexer → probe ids 0..8 sequentially with 3-miss cutoff → read each → filter expired), `472-497`, `499-575` (three-tier matching: unique-by-type → exact signer set → subset-without-policies, preferring specific over Default).
- **What:** For one `signAndSubmit` with the connected passkey, `resolveConnectedContextRuleIds` (kit.ts:1562-1595) enumerates all rules (up to 9 simulations on the probe path plus one indexer call), finds the signer, then resolves per entry. `webauthn-ops.signAuthEntry` then reads the rule **again** via `findWebAuthnSignerInRules` (l.159-169) unless a `signer` was passed — and the single-signer path never passes it (`tx-ops.ts:554-560`), so every passkey signature costs at least one extra `get_context_rule` simulation. The BRIEF's own note ("A wallet cannot list its own rules without one [indexer]") is the root cause; the SDK compensates with `probeRuleIds` config (`types.ts:309-316`) that leaks into `ContextRuleManagerDeps` and `MultiSignerManagerDeps`.
- **Rewrite recommendation:** Make rule discovery an explicit, cached input: `const rules = await account.rules()` (indexer-or-probe strategy chosen once in `Network` options), then `authorize(tx, { signers, rules })`. The resolver becomes a pure function `selectRuleIds(entry, rules, signerIdentities): RuleId[]` that is trivially unit-testable and never touches the network. Push for `get_context_rule_ids()` in the OZ P27 revision (BRIEF says a revision removing the 15-rule limit is in progress — that is the moment to ask for an enumerator or an events-based canonical index).

### ARCH-F22. `no eslint`, but `eslint-disable` comments; casts that hide real types   [severity: nit]
- **Where:** `src/contract-errors.test.ts:106` has `// eslint-disable-next-line @typescript-eslint/no-explicit-any`; no `eslint.config.*`/`.eslintrc*` exists; `packages/smart-account-kit-bindings/src/index.ts:29` `//@ts-ignore`. `tx-ops.ts:497` and `multi-signer-manager.ts:512` cast `TransactionBuilder.fromXDR(...) as Transaction` (it can return `FeeBumpTransaction`; the cast hides the branch that `deploy-ops.ts:136-137` and `wallet-provenance.ts:262-263` handle correctly).
- **Rewrite recommendation:** Add `eslint` with `@typescript-eslint/no-unnecessary-type-assertion`, `no-explicit-any`, and `consistent-type-imports`; enable `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` (the `valid_until: null | undefined` dance in F19 goes away).

### ARCH-F23. Public surface is 3× what the only consumer uses   [severity: medium]
- **Where:** `src/index.ts` (188 code lines, ~120 named exports). The demo imports 30 of them; 100 are unused by the demo (list in coverage notes: every error class except `SmartAccountError`, all `Indexed*`/`Relayer*` response types, `signFeePayer`, `resimulateAndAssemble`, `buildDirectTokenTransfer`, `readTokenDecimals`, `tokenAmountToRawUnits`, all `validate*` except `validateContextRuleName`, `xlmToStroops`/`stroopsToXlm`, `getSignerKey`, `CONTRACT_ERROR_REGISTRY`, …). The "Compatibility helpers" (`builders.ts:428-499`: `truncateAddress`, `describeSignerType`, `formatSignerForDisplay`, `formatContextType`) are UI string formatters living in the SDK because the demo needs them.
- **Rewrite recommendation:** Export the domain API and the types it needs; nothing else. UI formatters go to the demo. Internal helpers (`signFeePayer`, `resimulateAndAssemble`) are exported today only because the multi-signer manager needed them across a file boundary — with one pipeline they are private.

## First-principles recommendations for the rewrite

### Design principles
1. **Values, not a session object.** `SmartAccount` is an immutable handle. Signers are explicit arguments. No `isConnected`.
2. **One authorization pipeline** for 1..n signers of any kind. Single-passkey is the n=1 case.
3. **Lean on stellar-sdk v16**: `contract.Client` + `Spec` for everything contract-shaped, `authorizeEntry`/`authorizeInvocation` for G-address signatures, `AssembledTransaction.signAuthEntries({ authorizeEntry })` as the hook, `buildWithDelegatesEntry` when CAP-71 delegates are wanted, `SAC_SPEC` for token calls.
4. **Isomorphic core** with `Uint8Array`, injected `fetch`/`crypto`; browser and node adapters at separate entry points.
5. **Branded identifiers**; parse at the boundary, never re-validate inside.
6. **Throw typed errors**; no `{success:false}` results.

### Module layout (one package, three entry points)

```
src/
  core/
    network.ts            Network { rpc, networkPassphrase, fetch?, timeout }            ~40
    ids.ts                brands + parse/encode (ContractAddress, AccountAddress,
                          CredentialId, Hash32, RuleId, Stroops)                          ~80
    errors.ts             SmartAccountError { kind }, ContractError { code, name }        ~60
    generated/            spec-generated types+Client for account, 3 policies,
                          2 verifiers (build-time, not published separately)              (generated)
  account/
    account.ts            SmartAccount.at(network, address) / .deploy(...) ;
                          rules(), rule(id), signerId(), policyId() ;
                          tx builders: addRule, removeRule, addSigner, batchAddSigners,
                          removeSigner, addPolicy, removePolicy, updateName,
                          updateValidUntil, execute, upgrade  (thin over generated Client) ~220
    rules.ts              selectRuleIds(entry, rules, identities): RuleId[] (pure)        ~90
    discovery.ts          RuleSource: indexer | probe(maxId, misses) ; listRules          ~90
  auth/
    digest.ts             signaturePayload, authDigest (P27 + rule ids)                   ~30
    payload.ts            AuthPayload read/write via spec + host-order sort               ~80
    scval-order.ts        compareScVal, sortedScMap (until upstreamed)                    ~60
    authorize.ts          authorize(tx, { account, signers, delegates, rules, expiration })
                          → signed AssembledTransaction; resimulate; fee-payer hook       ~160
  signers/
    types.ts              ExternalSigner, DelegatedSigner interfaces; identity helpers    ~50
    ed25519.ts            Ed25519Signer(keypair, verifier)  (isomorphic)                  ~40
    delegated.ts          KeypairDelegate, CallbackDelegate (wraps SigningCallback)       ~40
  policies/
    params.ts             PolicyInstall union → ScVal via generated specs                 ~80
    clients.ts            threshold/weighted/spendingLimit typed getters+setters
                          (generated Client + account.execute)                            ~120
  submit/
    rpc.ts                submit(network, tx) → { hash, ledger } ; poll                   ~60
    relayer.ts            RelayerClient.send({func, auth}) / sendXdr                      ~120
    fee-payer.ts          choose source: relayer placeholder | keypair ; shared-deployer
                          refusal                                                          ~50
  deploy/
    address.ts            deriveAddress(deployer, salt, network) ; DEFAULT_DEPLOYER        ~40
    deploy.ts             buildDeploy(network, { signer, policies, deployer }) →
                          { func, auth } | signed tx ; confirmDeployment                  ~150
  verify/
    provenance.ts         verifyBirth (RPC+Horizon), constructor checks                   ~250
    webauthn-assertion.ts verifyFreshAssertion (WebCrypto P-256)                          ~100
    connect.ts            connect(network, { credentialId | address, proof, policy }) →
                          { account, credential }  (fail-closed composition)              ~180
  discovery/
    indexer.ts            IndexerClient + schema-2 parsing                                ~200
  index.ts                core entry (everything above)                                    ~60
  webauthn/               entry "smart-account-kit/webauthn" (browser)
    authenticator.ts      navigator.credentials create/get, COSE→raw P-256, DER→compact   ~140
    signer.ts             WebAuthnSigner implements ExternalSigner                        ~60
    session.ts            IndexedDbSessionStore / LocalStorageSessionStore               ~120
    index.ts                                                                               ~20
  node/                   entry "smart-account-kit/node"
    index.ts              re-exports Ed25519Signer, KeypairDelegate, basicNodeSigner glue  ~20
```

Estimated **~2,900 code LOC** for full parity (every account method, all three policies, both verifiers, provenance verification, indexer, relayer, deploy), vs 8,580 today; realistically 3,000–3,500 after edge cases. Tests should shrink proportionally because pure functions (`selectRuleIds`, `authDigest`, `AuthPayload` codec, `verifyBirth`) test without forging a kit.

Dependency arrows (all one-way):
```
webauthn/ ─┐
node/     ─┼─▶ signers/types ─▶ auth/ ─▶ account/ ─▶ core/ (network, ids, errors, generated)
verify/   ─┘        ▲             ▲          ▲
discovery/ ─────────┘             │          │
submit/ ──────────────────────────┘          │
deploy/ ─────────────────────────────────────┘
policies/ ─▶ account/, core/
```
No module imports `auth/authorize` except entry points; `core/` imports nothing internal.

### Public types (sketch)

```ts
// core
interface Network { rpc: rpc.Server; networkPassphrase: string; timeoutInSeconds?: number }

// account
class SmartAccount {
  static at(network: Network, address: ContractAddress): SmartAccount;           // no I/O
  readonly address: ContractAddress; readonly network: Network; readonly client: GeneratedClient;
  rules(source?: RuleSource): Promise<ContextRule[]>;
  rule(id: RuleId): Promise<ContextRule>;
  // every write returns AssembledTransaction<T> from the generated client:
  addRule(r: NewContextRule): Promise<AssembledTransaction<ContextRule>>;
  addSigner(rule: RuleId, s: Signer): …; batchAddSigners(rule: RuleId, s: Signer[]): …;
  removeSigner(rule: RuleId, s: Signer | SignerId): …;
  addPolicy(rule: RuleId, p: PolicyInstall): …; removePolicy(rule: RuleId, p: ContractAddress | PolicyId): …;
  updateName(rule: RuleId, name: RuleName): …; updateValidUntil(rule: RuleId, ledger?: number): …;
  execute(target: ContractAddress, fn: string, args: xdr.ScVal[]): …;
  upgrade(wasm: Hash32): …;
  token(token: ContractAddress): TokenClient; // SAC_SPEC-backed; transfer(to, amount: Stroops) → AssembledTransaction
}

// signers
interface ExternalSigner  { readonly identity: Signer; sign(authDigest: Uint8Array): Promise<Uint8Array> }
interface DelegatedSigner { readonly identity: Signer; authorize(preimage: xdr.HashIdPreimage): Promise<Uint8Array> }

// auth
interface AuthorizeOptions {
  account: SmartAccount;
  signers: ReadonlyArray<ExternalSigner | DelegatedSigner>;
  rules?: ContextRule[] | ((entry) => RuleId[]);     // default: account.rules() then selectRuleIds
  expirationLedger?: number;
}
function authorize<T>(tx: AssembledTransaction<T>, o: AuthorizeOptions): Promise<AssembledTransaction<T>>;
function submit<T>(tx: AssembledTransaction<T>, via: { relayer: RelayerClient } | { feePayer: Keypair }): Promise<{ hash: string; ledger: number }>;

// deploy
function buildDeploy(network: Network, o: { signer: Signer; policies?: PolicyInstall[]; deployer?: Keypair; wasmHash: Hash32 }):
  Promise<{ address: ContractAddress; func: xdr.HostFunction; auth: xdr.SorobanAuthorizationEntry[] } | { address; tx: AssembledTransaction<null> }>;

// webauthn (browser)
class WebAuthnAuthenticator { constructor(o: { rpId: string; rpName: string; origins: string[] }); register(user): Promise<Credential>; assert(challenge, allow?): Promise<Assertion> }
class WebAuthnSigner implements ExternalSigner { constructor(auth: WebAuthnAuthenticator, verifier: ContractAddress, credential: Credential) }

// verify
function connect(network: Network, o: { credentialId?: CredentialId; address?: ContractAddress; proof?: Assertion; accepted: { wasm: Hash32[]; birthWasm: Hash32[] }; verifier: ContractAddress; indexer?: IndexerClient; history?: Horizon.Server }):
  Promise<{ account: SmartAccount; credential: VerifiedCredential }>;
```

Usage, single passkey:
```ts
const net = { rpc, networkPassphrase };
const { account, credential } = await connect(net, { credentialId, accepted, verifier, indexer });
const signer = new WebAuthnSigner(authenticator, verifier, credential);
const tx = await account.token(XLM).transfer(to, parseUnits("1.5", 7));
await submit(await authorize(tx, { account, signers: [signer] }), { relayer });
```
Usage, 2-of-3 (passkey + Ed25519 + Freighter):
```ts
await authorize(tx, { account, signers: [passkey, new Ed25519Signer(kp, ed25519Verifier), new CallbackDelegate(G, swk.signAuthEntry)] });
```

### Concrete deletions
- `SmartAccountKit` class, all `*Manager` classes, `ExternalSignerManager`, `SelectedSigner`, `MultiSignerOptions`, `ConnectedContextRuleCache`, every `Deps` interface.
- `src/kit/context-rules.ts:130-338` legacy shape shim and RPC read path; `577-628` duck-typed extractor.
- Five hand-rolled keypair signing blocks (F4), three read-only tx builders (F5), `getAddressCredentials` clone.
- `src/base64url.ts` + npm `base64url`; `@simplewebauthn/browser`.
- `TransactionResult` failure branch, `failedTransaction`, `simulationFailure`, `submissionFailure`, `wrapError`; unused error classes/codes; unused events (`events.ts` entirely — the app owns its state changes when the API returns values).
- `builders.ts:428-499` UI formatters; `LEDGERS_PER_*` re-exports; `version.ts` (read from `package.json` at build).
- `credentials` manager's `sync/syncAll/getPending/delete` state machine (`deploymentStatus: "pending"|"failed"|"deployed"|"occupied"`): replace with `VerifiedCredential` written only after `connect` or `deploy` succeeds; a pending passkey is just a `Credential` the app keeps.
- Published `smart-account-kit-bindings` package.
- `fundWallet` (testnet-only Friendbot dance, 194 LOC): move to the demo or `node/testnet.ts`.

## Open questions for Tyler

1. **Rule enumeration.** Is `get_context_rule_ids()` (or an iterator) on the table for the P27 contract revision? If yes, `discovery/`, the probe config, and the indexer dependency for *signing* all disappear; the indexer stays only for reverse lookup (credential → address). If no, should the SDK treat the indexer as required for signing and stop shipping the probe?
2. **Session semantics.** Does the SDK need to own sessions at all, or is `connect()` returning a verified value plus an optional `SessionStore` the app calls enough? The current `credentials.deploy()` path already skips session save (F14), so behaviour is inconsistent today.
3. **CAP-71 delegates.** `buildWithDelegatesEntry` is in stellar-sdk 16. The SDK rejects `AddressWithDelegates` entries in four places. Is "not supported yet" a product decision (OZ rejected `delegate_account_auth`) or a to-do?
4. **Bindings distribution.** Any consumer of `smart-account-kit-bindings` other than this repo? If none, delete the package and generate types at build time.
5. **Custom deployer route.** With the shared deployer being sign-only and relayer-required, is the custom-`deployerSecret` route (signed-envelope deploy, `relayer.sendXdr`, `signFeePayer`) still needed? It roughly doubles `deploy-ops.ts` and `tx-ops.ts`.
6. **Error convention.** Throw everywhere, or keep result objects for submissions? The demo currently branches on `result.success` in two places only.
7. **Host-order `ScMap` sorting.** Would you accept upstreaming `compareScVal` into js-stellar-sdk (`Spec.nativeToScVal` for `Map` values) so the kit can drop it?
