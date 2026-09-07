> Part of the smart-account-kit first-principles review (2026-09-06). Findings in this document are referenced across the collection as **API-F<n>**. Start with [`01-executive-summary.md`](01-executive-summary.md); the consolidated list of every finding is in [`10-findings-register.md`](10-findings-register.md); the rewrite proposal is in [`08-rewrite-blueprint.md`](08-rewrite-blueprint.md).

# Public API surface & developer experience — findings

## Coverage

**Read fully:** `src/index.ts`, `src/types.ts`, `src/kit.ts` (all 1707 lines), `src/managers/{signer,context-rule,policy,credential,multi-signer}-manager.ts`, `src/external-signers.ts`, `src/policy-clients.ts`, `src/builders.ts`, `src/signer-utils.ts`, `src/signers.ts`, `src/errors.ts`, `src/contract-errors.ts`, `src/events.ts`, `src/validation.ts`, `src/contract-types.ts`, `src/constants.ts`, `src/kit/tx-ops.ts`, `src/kit/policies-ops.ts`, `src/kit/context-rules.ts`, `src/kit/webauthn-ops.ts`, `src/kit/wallet-ops.ts` (lines 1–420 and 550–653), `README.md` (all 1129 lines), `docs/migration-v0.4.0.md`, `docs/migration-v0.7.0.md`, `docs/deployments-protocol-27-2026-07-09.md`, `package.json`, `tsconfig.json`. Demo: `hooks/useWalletSession.ts`, `hooks/useKit.ts`, `hooks/useMultiSignerSubmit.ts`, `hooks/useExternalWallets.ts`, `utils/sdk.ts`, `utils/tx.ts`, `utils/policyLiveParams.ts`, `config.ts`, `components/TransferPanel.tsx`, `components/ContextRuleBuilder.tsx`, `components/rule-builder/{policyParams,types}.ts`, first 120 lines of `components/SignerPicker.tsx`. `/home/claude/work/context/oz-smart-account-docs-review.md` lines 1–1957 fully, remainder grepped for the SDK/lifecycle sections.

**Skimmed / grepped only:** `src/kit/wallet-provenance.ts` (only the `allowedOrigins` path), `src/kit/deploy-ops.ts` (only `buildDeployTransaction`), `src/kit/fund-ops.ts` (call-site grep), `src/indexer.ts` / `src/relayer.ts` / `src/wallet-adapter.ts` (export lists only), `src/storage/index.ts`, `src/kit/auth-payload.ts` (only `compareScVal`), `packages/smart-account-kit-bindings/src/index.ts` (method list, `ContextRule`, `Signer`), `@stellar/stellar-sdk` `contract/spec.js` (map encoding only), OZ pinned `storage.rs` (`ContextRule` struct only).

**Did not look at:** test files (beyond names/counts), `relayer-proxy/`, `indexer/`, `CHANGELOG.md`, `SECURITY.md`, `docs/security-deterministic-deployer.md`, `docs/mainnet-hardening.md`, `scripts/`, storage adapter implementations.

**Ran:** a Node ESM import + construct smoke test against `dist/` (works; see F1). Did not run the vitest suite or `tsc`.

## Summary

The SDK does hard, correct things — P27 auth-digest binding, re-simulation, delegated nested auth, fail-closed connection — and wraps every contract entry point. But the public surface is the accretion history of the demo, not a designed API: 151 named exports (89 runtime, 62 type-only — verified by TS AST count and `Object.keys(import('dist/index.js'))`), 24 config options, at least seven distinct "signer" types, three or four error-reporting models, and three independently-implemented sign→resimulate→submit pipelines (`sign`, `signAndSubmit`, `multiSigners.operation`) that read auth entries from different places. The single biggest structural problem is that *connection is a passkey ceremony*: `_contractId` can only be set by a WebAuthn flow (`kit.ts:760-764`, `wallet-ops.ts:369`), so a backend or agent holding an Ed25519 key cannot use the kit at all, and every non-passkey signer is bolted on through `kit.multiSigners` + `kit.externalSigners` + `SelectedSigner`. The demo — the only consumer — has to write a router hook (`useMultiSignerSubmit`) to decide which pipeline to call, re-implement policy-param staging, hand-sort a policy map with a comparator the SDK's own comments forbid, and re-verify wallet shape after `connectWallet` already verified it. Docs are long (1129-line README) but not runnable, and several claims are stale relative to source. The rewrite should: (1) make `Signer` one interface with three implementations and make connection signer-agnostic; (2) collapse to one `account.send(tx, { signers?, ruleId? })` pipeline; (3) ship network constants so config is `{ network: 'testnet' }`; (4) throw one typed error everywhere; (5) make policies first-class values (`threshold(2)`) accepted directly by `rules.add`; (6) cut the export list to ~25 names and put browser-only code behind a `/passkey` subpath.

## Findings

### API-F1. Connection is passkey-only; the SDK is unusable from Node/agents/backends   [severity: high]
- **Where:** `src/kit/wallet-ops.ts:365-369` (`Could not determine credential ID`), `src/kit.ts:760-764` (`setConnectedState` — the only writer of `_contractId`), `src/kit.ts:1017-1048` (`connectWallet` options are all credential-centric), `src/managers/multi-signer-manager.ts:240-244` (`operation` requires `getContractId()`), `src/kit.ts:8-11` (top-level `@simplewebauthn/browser` import), `package.json:83` (hard dependency), `tsconfig.json` (`lib: ["ES2022","DOM"]`).
- **What:** `import('smart-account-kit')` and `new SmartAccountKit(...)` succeed in Node 22 (verified), but every path that sets the connected contract goes through a WebAuthn ceremony: `createWallet`, `connectWallet` (all four option shapes end in `connectWithCredentials`, which throws without a `credentialId`), and `credentials.deploy`. There is no `connect({ contractId, signer: ed25519 })`. `multiSigners.operation()` — the only entry point that can sign with Ed25519/Delegated — refuses to run unless `isConnected`, which only a passkey can make true. A backend that owns an `External(ed25519Verifier, pk)` signer on rule 3 can build transactions with the raw bindings but cannot sign or submit through the kit. `authenticatePasskey()` and `createWallet()` in Node throw `Error: WebAuthn is not supported in this browser` (verified) — a plain `Error`, not `WebAuthnError`.
- **Why it matters:** Tyler's stated target includes agentic/backend use, and the OZ README's own headline use cases are "backend automation with recurring payments" and "AI agents with constrained access" (docs review, "What Works Well" §3). Those are exactly the callers this SDK cannot serve. It also means the Ed25519 signer type — which the README calls "end-to-end" (README:22, 525-551) — is end-to-end only as a *co-signer next to a passkey*.
- **Rewrite recommendation:** Connection takes signers, not credentials: `SmartAccount.connect(cfg, { contractId, signers: Signer[] })`. Passkey discovery/verification becomes a browser-only helper (`smart-account-kit/passkey`) that *produces* a `PasskeySigner` and a contract id; the fail-closed birth/ownership checks stay, but as the passkey helper's job. Move `@simplewebauthn/browser` behind that subpath so the root entry has no DOM assumptions; drop `DOM` from the root `lib`.

### API-F2. Three separate signing pipelines read auth entries from three different places   [severity: high]
- **Where:** `src/kit/tx-ops.ts:583-629` (`sign` → `AssembledTransaction.signAuthEntries`, matches entries by XDR equality against `transaction.simulationData.result.auth`), `src/kit/tx-ops.ts:631-702` (`signAndSubmit` → loops `simData.result.auth` directly, never calls `sign`), `src/managers/multi-signer-manager.ts:485-526` (`operation` → reads `assembledTx.built.operations[0].auth`), `src/managers/multi-signer-manager.ts:233-483` (`submitWithSelectedSigners`, a third full implementation of sign + resimulate + submit), `src/kit/fund-ops.ts:155-250` (fourth: own simulate/resimulate/sign for Friendbot), `src/kit/deploy-ops.ts` (fifth: deployment).
- **What:** The lifecycle is build (`AssembledTransaction`) → sign auth entries → re-simulate → assemble → fee-pay → submit → poll. There are three public entry points into it and they do not share a spine:
  | Path | Signs with | Reads auth from | Resimulates | Who calls it |
  |---|---|---|---|---|
  | `kit.sign(tx)` | passkey only | `simulationData.result.auth` via `signAuthEntries` | **no** | nobody in demo |
  | `kit.signAndSubmit(tx)` | passkey only | `simulationData.result.auth` | yes | demo single-signer |
  | `kit.transfer` / `executeAndSubmit` | passkey only | via `signAndSubmit` | yes | demo |
  | `kit.multiSigners.operation(tx, selected)` | passkey + ed25519 + delegated | `built.operations[0].auth` | yes | demo multi |
  | `kit.multiSigners.transfer(...)` | same | via `operation` | yes | demo multi |
  | `kit.fundWallet` | temp keypair | own simulation | yes | demo |
  | `kit.signAuthEntry(entry)` | passkey only | n/a | n/a | internal + multi |
  `kit.sign()` returns a transaction that is "NOT ready for direct submission" (`kit.ts:1145`) and the JSDoc examples in `context-rule-manager.ts:65` and `policy-manager.ts:51` show `await tx.signAndSend()` — which would submit an under-resourced, unsigned-by-fee-payer envelope. The `ConnectedContextRuleCache` memo (`kit.ts:171-174`) exists because the passkey path enumerates rules per entry; the multi path resolves rule ids separately (`multi-signer-manager.ts:331-344`) and does not use the cache.
- **Why it matters:** Every fix (expiration handling, ADDRESS_WITH_DELEGATES support, resource bumping, the rule-id cache) has to land in three places. The consumer must know which of five methods to call based on *who is signing*, which is the SDK's job (see F3).
- **Rewrite recommendation:** One internal function `prepare(tx, { signers, ruleIds?, expiration? })` → `Transaction`, and one public `account.send(tx, opts)` = `prepare` + `submit`. `sign`, `signAndSubmit`, `executeAndSubmit`, `multiSigners.operation`, `multiSigners.transfer` all collapse into `send`. Keep `account.prepare()` public for "give me the signed envelope" (agents, offline multi-party). Auth entries always come from one place (the simulation result), delegated entries are appended in the same loop. `fundWallet` becomes a testnet dev-tool under `smart-account-kit/testnet` using the same `send`.

### API-F3. The passkey-only vs `multiSigners` split is an accident of history, and it pushes routing onto the consumer   [severity: high]
- **Where:** README:496 ("passkey-only by design"), `src/managers/multi-signer-manager.ts:117-125` (`needsMultiSigner`), `:137-194` (`buildSelectedSigners`), `src/types.ts:649-665` (`SelectedSigner` with `signer?: unknown`), `src/managers/multi-signer-manager.ts:361-367` (runtime error if `signer` is missing), `demo/src/hooks/useMultiSignerSubmit.ts:26-54`, `demo/src/hooks/useWalletSession.ts:405-410` (`if (allSigners.length > 1)` → open picker), `demo/src/components/ContextRuleBuilder.tsx:155-169, 737-745`.
- **What:** The "single-signer path" is not single-signer, it is *single-passkey*. A rule with one Ed25519 signer, or one Delegated signer, must go through `multiSigners` with a `SelectedSigner[]`. `needsMultiSigner()` is a public method whose only purpose is to tell the caller which SDK method to call next. The demo therefore has a dedicated hook (`useMultiSignerSubmit`) whose entire body is "if `needsMultiSigner` then `multiSigners.operation` else `signAndSubmit`", plus a second heuristic in `useWalletSession` (`allSigners.length > 1`) that disagrees with the first (it counts signers across *all* rules, not the rule that will match). `SelectedSigner` is a tagged bag where `type: "wallet"` means Delegated and `signer` is typed `unknown` but is required at runtime for wallet signers — so hand-building one is a trap and `buildSelectedSigners` is mandatory, which in turn drops signers it can't sign for with a `console.warn` (`:185-189`).
- **Why it matters:** This is the single most visible DX cost: two entry points for one operation, three signer descriptor types to translate between (`ContractSigner` → `SelectedSigner` → internal), and the consumer owning the decision the SDK has all the data to make.
- **Rewrite recommendation:** One `Signer` interface (`{ key: ContractSigner; kind; sign(input) }`) with `PasskeySigner`, `Ed25519Signer`, `DelegatedSigner` (keypair or wallet-adapter backed). The account session holds `signers: Signer[]`. `send()` resolves the rule, intersects the rule's signer set with the session's signers, and signs with all of them. `needsMultiSigner`, `buildSelectedSigners`, `getAvailableSigners`, `SelectedSigner`, `ExternalSigner`, `ExternalSignerManager`, `MultiSignerManager` all disappear. "Which signers can I use for this tx?" becomes `account.signersFor(tx)` — a query, not a routing decision.

### API-F4. `rules.add` and constructor deploy do not sort the policies map; the demo re-sorts with a comparator the SDK itself forbids   [severity: high]
- **Where:** `src/managers/context-rule-manager.ts:82-102` (`add` passes `policies: Map<string, unknown>` straight to the binding), `src/kit/deploy-ops.ts:443-451` (`buildConstructorPolicies` → `Map`, unsorted), `node_modules/@stellar/stellar-sdk/lib/esm/contract/spec.js:706-723` (spec `nativeToScVal` for `Map` iterates insertion order, no sort), `src/kit/policies-ops.ts:174-231` (`buildPoliciesScVal` *does* sort via `compareScVal` — zero internal consumers; `grep` shows only the `kit.buildPoliciesScVal` re-export), `src/kit/context-rules.ts:263-269` (comment: "Use a bytewise comparison, NOT localeCompare"), `demo/src/components/ContextRuleBuilder.tsx:653-663` (`.sort(([a], [b]) => a.localeCompare(b))` — "Soroban requires sorted keys").
- **What:** Soroban rejects unsorted `ScMap`s. The generated spec does not sort. `rules.add` and the deploy path hand the spec an insertion-ordered `Map`, so any rule or wallet with two or more policies whose insertion order differs from host order fails at simulation. The SDK contains the correct sorter (`compareScVal`, used in `buildPoliciesScVal` and weighted-threshold encoding) but `rules.add`'s signature (`Map<string, unknown>`) cannot accept the `xdr.ScVal` that `buildPoliciesScVal` returns. The demo discovered the failure and works around it with `localeCompare` on the strkey — but strkey base32 order is not byte order (`'2'..'7'` sort before `'A'..'Z'` in ASCII yet encode higher values), and the SDK's own comments warn against locale collation. I did not construct a concrete failing pair of the deployed policy addresses; the correctness agent may want to.
- **Why it matters:** Correctness (latent failures for multi-policy rules) and DX (the right helper exists but is unreachable from the method that needs it; the consumer re-implemented it wrong).
- **Rewrite recommendation:** `rules.add({ policies: PolicyInstall[] })` takes an *array* of typed policy values (see F5) and the SDK encodes and sorts internally with `compareScVal`. Delete `buildPoliciesScVal` and `convertPolicyParams` from the public surface.

### API-F5. Six ways to say "threshold policy with N=2", and two of the documented ones are wrong   [severity: medium]
- **Where:** `src/builders.ts:277-293` (`createThresholdParams(2)` → `{threshold: 2}`), `src/kit.ts:1684-1689` (`kit.convertPolicyParams("threshold", {...})` → `xdr.ScVal`), `src/kit.ts:1701-1706` (`kit.buildPoliciesScVal(Map, Map)`), `src/types.ts:341-355` (`PolicyConfig { address, type?, installParams: unknown }` for constructor only), `src/managers/policy-manager.ts:66-72` (`policies.add(ruleId, addr, installParams: unknown)` — README:414 says it must be an `xdr.ScVal`), `src/policy-clients.ts:155-164` (`setThreshold(threshold, contextRule: ContextRule)` — takes the full struct), `src/managers/context-rule-manager.ts:56-66` (JSDoc passes native `thresholdParams` into `rules.add` and calls `tx.signAndSend()`), `src/managers/policy-manager.ts:40-52` (JSDoc passes `createThresholdParams(2)` directly to `policies.add` then `tx.signAndSend()`), `demo/src/components/rule-builder/policyParams.ts:62-133` (demo's own `buildNativePolicyParams` + `encodePolicyInstallParam`), `demo/src/components/rule-builder/types.ts:38-58` (demo's `SelectedPolicy` form model with per-type fields).
- **What:** Constructor policies take native params + `type` and the SDK encodes; `policies.add` takes a pre-encoded `ScVal`; `rules.add` takes a `Map<string, unknown>` that must contain `ScVal`s (README:382-387) but the manager's own JSDoc shows native objects — which the spec would encode as an `scvMap` with *string* keys, not the symbol-keyed struct the policy expects. The policy clients' setters require the caller to first `rules.get(id)` and pass the whole `ContextRule` because the deployed contract signature takes it (`policy-clients.ts:11-12`); the client could do that read itself. The demo ends up with its own two-layer model (`SelectedPolicy` form → native → `convertPolicyParams` → `ScVal` → `Map` → sort).
- **Why it matters:** Policies are the feature that makes smart accounts interesting (Tyler's OZ review Priority 1 step 3 is "add a second signer with a threshold policy"). Today that step needs four imports and knowledge of ScVal encoding rules.
- **Rewrite recommendation:** One value type: `type PolicyInstall = { address: string; params: xdr.ScVal }` produced by typed constructors bound to the network's deployed addresses: `policies.threshold(2)`, `policies.weightedThreshold(150, [[signer, 100], [signer2, 50]])`, `policies.spendingLimit({ token, limit: "100", per: "1d" })`, `policies.custom(address, scVal)`. `rules.add({ ..., policies: [threshold(2)] })`, `policies.add(ruleId, threshold(2))`, `SmartAccount.create({ policies: [threshold(2)] })` all accept the same thing. Policy clients take `ruleId` and read the rule internally: `account.policies.threshold().set(ruleId, 3)`.

### API-F6. Config: 24 options, 8 of them are per-network constants the SDK already knows   [severity: medium]
- **Where:** `src/types.ts:132-335` (`SmartAccountConfig`: `rpcUrl, networkPassphrase, accountWasmHash, acceptedWasmHashes, acceptedBirthWasmHashes, horizonUrl, allowedOrigins, webauthnVerifierAddress, ed25519VerifierAddress, defaultPolicies, timeoutInSeconds, signatureExpirationLedgers, storage, deployerSecret, externalSignerStorage, rpId, rpName, webAuthn, sessionExpiryMs, externalWallet, indexerUrl, indexerAuthToken, contextRuleProbe, relayerUrl`), `src/kit.ts:426-429` (four required), `src/kit.ts:472-482` (Horizon defaulted per network), `src/kit.ts:503` (indexer defaulted per network), `docs/deployments-protocol-27-2026-07-09.md:28-58` (every testnet/mainnet address and hash), `demo/src/config.ts:23-41` (demo hard-codes all of them), README:59-72 (quick start with `'YOUR_ACCOUNT_WASM_HASH'` / `'CWEBAUTHN_VERIFIER_ADDRESS'` placeholders).
- **What:** Horizon and indexer URLs are derived from `networkPassphrase`, but `rpcUrl`, `accountWasmHash`, `webauthnVerifierAddress`, `ed25519VerifierAddress`, and the three policy addresses are not — even though the SDK ships bindings generated from exactly one WASM hash and the deployments doc pins all of them. `deployerSecret` conflates two things: the address-salt identity (must be the shared key for deterministic addresses) and the fee payer (must *not* be the shared key). `storage` and `externalSignerStorage` are two persistence interfaces (`StorageAdapter`, 10 methods; `WalletStorage`, 3 methods). `webAuthn` is labelled "for testing" but is actually the platform seam that would let Node/React-Native callers inject a WebAuthn implementation. `contextRuleProbe` is a tuning knob for a workaround (F10).
- **Why it matters:** The README quick start cannot run as written; a new integrator must find `demo/.env.example` (README:98) and copy six values. Every option is a decision the integrator must make and a place to make a mistake (e.g. mismatched verifier vs WASM hash, which the demo then guards against in `ensureCurrentWalletShape`).
- **Rewrite recommendation:**
  ```ts
  interface NetworkConfig {
    passphrase: string; rpcUrl: string; horizonUrl?: string; indexerUrl?: string;
    accountWasmHash: string; acceptedWasmHashes?: string[];
    verifiers: { webauthn: string; ed25519: string };
    policies: { threshold: string; weightedThreshold: string; spendingLimit: string };
    deployer: string;  // shared salt identity G-address
  }
  interface Config {
    network: "testnet" | "mainnet" | NetworkConfig;          // required
    submit?: { relayerUrl: string } | { feePayer: Keypair } | ((tx: Transaction) => Promise<string>);
    storage?: KeyValueStorage;                               // one interface: get/set/delete
    passkey?: { rpId?: string; rpName?: string; origins?: string[]; provider?: WebAuthnProvider };
    defaults?: { txTimeoutSec?: number; sigExpiryLedgers?: number; sessionTtlMs?: number };
    indexer?: { url?: string | false; token?: string };
  }
  ```
  Export `networks.testnet` / `networks.mainnet` as data. Quick start becomes `new SmartAccount({ network: "testnet", submit: { relayerUrl } })`.

### API-F7. Vocabulary is inconsistent with the contract and with itself; "wallet" means three things   [severity: medium]
- **Where:** `src/kit.ts:271` (`public wallet?: SmartAccountClient` — the raw generated client), `src/kit.ts:839, 1017, 1119, 1268` (`createWallet`, `connectWallet`, `disconnect`, `fundWallet` — the smart account), `src/external-signers.ts:40-44` (`WalletStorage` — persistence for *external* G-address wallet connections), `src/types.ts:556-640` (`ConnectedWallet`, `ExternalWalletAdapter` — Freighter etc.), `src/types.ts:654` (`SelectedSigner.type: "wallet"` = Delegated), `src/external-signers.ts:59` (`ExternalSigner.type: "keypair" | "wallet" | "ed25519"` — `keypair` and `ed25519` are both Ed25519 keypairs; the first is `Delegated(G)`, the second `External(verifier, pk)`), `src/kit.ts:675, 696, 714` (`discoverContractsBy…`, `getContractDetailsFromIndexer` — "contract"), `src/index.ts:68` (`Signer as ContractSigner`), `src/errors.ts:120-218` (`WalletNotConnectedError`, `WalletProvenanceError`, …), `demo/src` (13 files import types from `smart-account-kit-bindings` directly rather than the kit's re-exports).
- **What:** The contract's nouns are *smart account*, *context rule*, *signer*, *policy*, *verifier*. The SDK uses *wallet* (smart account), *wallet* (external G-address signer's app), *wallet* (raw bindings client), *contract* (smart account, in indexer methods), *credential* (a passkey, and also the storage record). Signer concepts on the public surface: `ContractSigner` (bindings), `SelectedSigner`, `ExternalSigner`, `AuthDigestSigner`, `Ed25519Signer`, `IndexedSigner`, `StoredCredential`, plus three managers named `signers`, `externalSigners`, `multiSigners`. The demo added `SignerEntry` and `SignerEntryInfo` (`rule-builder/types.ts:16-33, 62-73`) because none of the seven fit a form. `createExternalSigner` (builders) creates an on-chain identity; `kit.externalSigners.addFromSecret` registers a Delegated signing key — same word, unrelated things.
- **Why it matters:** Tyler's own review of OZ's docs flags "Context vs ContextRule confusion" and "the verifier–signer relationship" as the places newcomers struggle. The SDK adds a second layer of ambiguity on top.
- **Rewrite recommendation:** Adopt the contract's nouns verbatim. `SmartAccount` (class), `account.address`, `account.raw` (bindings client), `Rule`, `Signer` (one interface; on-chain identity is `signer.key`), `Policy`. Delete "wallet" except in `WalletAdapter` for Freighter-style apps. `contractId` → `address`. `credential` survives only inside the passkey module.

### API-F8. Four error models: typed throws, plain `Error` throws, result unions, and swallow-and-warn   [severity: medium]
- **Where:** counts over non-test `src/`: 94 typed throws, 59 `throw new Error(` (e.g. `credential-manager.ts:178, 225, 291`, `signer-manager.ts:66-68`, `external-signers.ts:274-277`, `context-rules.ts:390-392, 467-469, 491-496, 570-573`, `webauthn-ops.ts:133-135, 147, 152-154, 200`, `multi-signer-manager.ts:205-207`), 41 `failedTransaction`/`submissionFailure` returns, 5 real `console.warn`/`console.error` call sites (20 `console.*` mentions if JSDoc examples are counted). `src/managers/multi-signer-manager.ts:100-115` (`getAvailableSigners` catches everything, `console.warn`s, returns `[]`). `src/types.ts:454-484` (`TransactionResult` union), README:217, 281 ("`multiSigners.*` return a `TransactionResult`" — false for `getAvailableSigners`, `needsMultiSigner`, `buildSelectedSigners`). `src/errors.ts:12-67` (numeric `SmartAccountErrorCode` enum with a `CONTRACT_ERROR = 10000` sentinel to dodge the contract's 3xxx range). `src/contract-errors.ts:200-215` (`unwrapContractResult` maps a rust `Err` back to a code by *string-matching the doc message*). `demo/src/utils/tx.ts:28-32` (`toSimpleResult` — demo immediately flattens the union to `{success, error?: string}`), `demo/src/hooks/useWalletSession.ts:430, 469` (`throw new Error(result.error.message)` — demo converts results back into throws).
- **What:** The README's rule (README:217, 281) — "submission methods return `TransactionResult`, everything else throws typed errors" — is not what the code does: `kit.transfer` returns a failure for validation errors (`kit.ts:1325-1334`) that `rules.add` would throw for; `execute()` throws `WalletNotConnectedError` (`kit.ts:1384`) while `signAndSubmit` returns it (`tx-ops.ts:657-659`); 59 sites throw untyped `Error`. The demo's first act on every result is to convert it back into an exception.
- **Why it matters:** Consumers cannot write one `catch`. Untyped `Error`s defeat the `SmartAccountErrorCode` scheme. Message-matching in `unwrapContractResult` is fragile against any bindings regen.
- **Rewrite recommendation:** Throw, always. One `SmartAccountError` with `code: SmartAccountErrorCode` as a *string union* (`"NOT_CONNECTED" | "RULE_NOT_FOUND" | …`), `cause`, and optional `hash` on submission errors. `ContractError extends SmartAccountError` keeps `contractCode`/`name`/`family`. `send()` returns `{ hash, ledger }`. Decode contract errors from the simulation diagnostic (the code is there) rather than the doc string. No `console.*` in library code; expose a `logger` option if `onLog` (`MultiSignerOptions.onLog`) is wanted.

### API-F9. Surface area: 151 exports, roughly a third are implementation leaks or demo conveniences   [severity: medium]
- **Where:** `src/index.ts` (whole file). Inventory by category (runtime / type):
  | Category | Exports | Load-bearing | Leaks / incidental |
  |---|---|---|---|
  | Client + managers | 1 / 6 | `SmartAccountKit` | manager *types* only exist because `kit.x` is typed; fine |
  | Config/results/options | 0 / 16 | `Config`, `TransactionResult` | `SubmitOptions` ≡ `SubmissionOptions` (`types.ts:517-524, 537-547`, identical shape); `ResolveContextRuleIds` |
  | Signer things | 3 / 6 | one `Signer` | `ExternalSignerManager`, `AuthDigestSigner`, `computeEntryAuthDigest`, `SelectedSigner`, `ExternalSigner`, `WalletStorage` |
  | Contract types | 0 / 9 | `Signer`, `Rule`, `RuleScope` | `AuthPayload`, `WebAuthnSigData`, `*AccountParams`, `SpendingEntry` |
  | Storage | 3 | 1 interface + 3 impls | fine, move to `/storage` |
  | Constants | 10 (+3 ledger) | `LEDGERS_PER_*` maybe | `WEBAUTHN_TIMEOUT_MS`, `FRIENDBOT_RESERVE_XLM`, `STROOPS_PER_XLM`, `ED25519_*_SIZE`, `MAX_*` (needed only if validation is public), `BASE_FEE` re-export |
  | Validation | 7 | 0 (internal) | all 7 — the demo uses one (`validateContextRuleName`) |
  | Errors | 17 / 2 | ~6 | 11 subclasses whose only difference is `name`; `wrapError`; `CONTRACT_ERROR_REGISTRY`, `contractErrorFromCode` |
  | Utils | 5 | 0 | `xlmToStroops`, `stroopsToXlm`, `validateAddress`, `validateAmount`, `generateChallenge` |
  | Builders | 13 | `signer.*`, `scope.*`, `policy.*` (3 namespaces) | `truncateAddress`, `describeSignerType`, `formatSignerForDisplay`, `formatContextType` (UI helpers), `createExternalSigner` |
  | Signer utils | 4 | `signersEqual` maybe | `getCredentialIdFromSigner`, `getSignerKey`, `collectUniqueSigners` |
  | Advanced tx | 9 | 0 | `signerToScVal`, `parseSignerScVal`, `buildDirectTokenTransfer`, `buildI128ScVal`, `readTokenDecimals`, `resolveTokenAmount`, `tokenAmountToRawUnits`, `signFeePayer`, `resimulateAndAssemble` — all exported "for advanced flows" (`index.ts:195`); `signFeePayer` takes a `deps` bag |
  | Policy clients | 3 / 1 | via `account.policies.*` | `PolicyClientDeps` (a DI bag: `index.ts:213`), `CONTEXT_RULE_SPEC_TYPE` (not exported but public on `policy-clients.ts:281`) |
  | Events | 1 / 3 | see F12 | |
  | Indexer | 3 / 12 | `IndexerClient` maybe | 12 wire-format types, `DEFAULT_INDEXER_URLS` |
  | Relayer | 2 / 3 | 0 (internal to `submit`) | all |
  | Wallet adapter | 1 / 1 | `WalletAdapter` interface | impl belongs in a separate package (peer dep on SWK already optional) |
- **What:** 89 runtime + 62 type-only exports (151; the per-category table above was compiled by hand and undercounts slightly). The demo imports 23 distinct names from the kit (multi-line import grep; a handful more come via `smart-account-kit-bindings`); the rest are exported because a test, an earlier demo, or a "might be useful" instinct needed them (`docs/migration-v0.4.0.md:142` documents adding `buildI128ScVal`, `signFeePayer`, `resimulateAndAssemble` to the entry point in 0.4.1). `kit.buildPoliciesScVal` has zero consumers anywhere in the repo.
- **Why it matters:** Every export is API you cannot rename. DI-bag types (`PolicyClientDeps`) and pipeline internals (`resimulateAndAssemble`) on the public surface freeze the architecture the rewrite wants to change.
- **Rewrite recommendation:** Root entry ≈ 25 names: `SmartAccount`, `networks`, `Ed25519Signer`, `DelegatedSigner`, `Signer` (type), `Rule`/`RuleScope`/`PolicyInstall` (types), `scope.{default,call,create}`, `policy.{threshold,weightedThreshold,spendingLimit,custom}`, `SmartAccountError`, `ContractError`, `SmartAccountErrorCode` (type), `Config`/`NetworkConfig` (types), `Receipt`, `AssembledTransaction` (re-export), `LEDGERS_PER_*`. Subpaths: `/passkey` (`PasskeySigner`, discovery, verification), `/storage`, `/wallets` (SWK adapter), `/testnet` (friendbot), `/internal` (unstable, for the demo's inspector). Everything else is deleted or private.

### API-F10. Rules discovery is presented as complete when it is best-effort, and signer discovery only looks at `Default` rules   [severity: medium]
- **Where:** `src/kit/context-rules.ts:340-428` (`listContextRules`: indexer ids ∪ probe 0..`maxRuleId`, stop after N misses), `:385-393` (throws a plain `Error` if nothing is discovered), `src/constants.ts:66-70` (probe defaults 8 / 3), `src/managers/context-rule-manager.ts:139-149` (`list()` returns `ContextRule[]` with no completeness signal), `:124-134` (`get()` returns `{ result: rule }` — a vestigial wrapper), `src/managers/multi-signer-manager.ts:100-115` (`getAvailableSigners` reads only `{tag:"Default"}` rules), `src/kit/context-rules.ts:499-575` (`resolveContextRuleIdsForEntry` depends on the same list; throws "Unable to resolve a unique context rule … Provide contextRuleIds explicitly"), README:404 (honest paragraph, but only in prose), `demo/src/hooks/useWalletSession.ts:62-115` (demo calls `getContractDetailsFromIndexer` *and* `rules.list()` and cross-checks them).
- **What:** The contract has `get_context_rules_count` (monotonic) and `get_context_rule(id)` but no active-id iterator, so the SDK needs the indexer or a bounded probe. `rules.list()` returns a plain array: a rule at id 12 on a wallet with no indexer coverage silently does not exist, and `send()` will then fail to auto-resolve rule ids for any context that rule would have matched. `getAvailableSigners()` ignores `CallContract`/`CreateContract` rules entirely, so a session key scoped to a DEX is never offered to the signer picker. `rules.get()` wraps the rule in `{ result }` for no reason (the README example destructures it: README:392).
- **Why it matters:** This is the "hosted indexer: close to required" pain point from the brief. The SDK should make the limitation legible in the type system rather than in a README paragraph, and should let the caller side-step it by naming the rule.
- **Rewrite recommendation:** `rules.list(): Promise<{ rules: Rule[]; complete: boolean; source: "indexer" | "probe" | "both" }>`; `rules.get(id): Promise<Rule>`; `rules.count()` stays. `send(tx, { ruleId })` always accepted and *recommended* in docs for anything but the default rule; auto-resolution is the fallback, not the primary. `account.signersFor(tx)` scans all rules that match the tx's contexts. Keep the probe but expose it as `rules.probe({ from, to })` so the caller controls the range instead of a config knob.

### API-F11. Docs: not runnable, several stale claims, and none of the three documents Tyler asked OZ for   [severity: medium]
- **Where and what (each verified against source):**
  1. README:59-96 quick start uses placeholder hash/addresses and a placeholder relayer; cannot run. Real values are in `demo/config.ts:23-41` and `docs/deployments-…md`.
  2. README:404-406 says "the deployed contract's `get_context_rule` omits the aligned `signer_ids`/`policy_ids` vectors". Source says the opposite: `src/kit/context-rules.ts:229-231` ("The canonical Protocol 27 build … returns the aligned `signer_ids`/`policy_ids` fields and decodes directly. Wallets deployed from older account builds omit those fields"), and the pinned contract struct has them (`stellar-contracts-pinned/packages/accounts/src/smart_account/storage.rs:155-174`).
  3. README:217, 281: "`multiSigners.*` return a `TransactionResult`" — three of five `multiSigners` methods do not (F8).
  4. `docs/migration-v0.4.0.md:245` tells readers to use `kit.signers.getAll()`; no such method exists (`signer-manager.ts` has `addPasskey/addDelegated/addBatch/idOf/remove`).
  5. `src/managers/context-rule-manager.ts:56-66` and `src/managers/policy-manager.ts:40-52` JSDoc (typedoc source) end with `await tx.signAndSend()` — bypasses WebAuthn signing and re-simulation; the rules example also passes native params where an `ScVal` is required (F5).
  6. README:858-862 documents `credentialDeleted`, `transactionSigned`, `transactionSubmitted` events; none is ever emitted (grep of `emit("` in non-test `src/`: only `credentialCreated`, `sessionExpired`, `walletConnected`, `walletDisconnected`).
  7. README:336 `addBatch(contextRuleId, signers)` omits the `options.existingSignerCount` argument that exists in code (`signer-manager.ts:154-158`) and that the migration doc documents.
  8. `appName` must be supplied in three places (`createWallet(appName, …)` `kit.ts:839`, `signers.addPasskey(ruleId, appName, …)` `signer-manager.ts:57`, `credentials.create({appName})` `credential-manager.ts:101`) and each time it overrides `config.rpName` (`webauthn-ops.ts:76`). The README never says which wins.
  9. Missing entirely — measured against Tyler's own OZ critique: a runnable "hello world" (Gap 1, Priority 1); a transaction-lifecycle page mapping build→simulate→rule-id→sign→resimulate→submit onto SDK calls (Priority 3 — the code comments in `kit.ts:1132-1146, 1172-1185` are the closest thing); an error reference with causes and resolutions (Priority 4 — `CONTRACT_ERROR_REGISTRY` has messages, no causes); a Node/agent example (impossible today, F1); an `examples/` directory; generated typedoc. The README is ~35% import-list dumps (lines 653-703, 707-775, 779-829, 849-852, 906-913, 967-983) that a typedoc would render better.
- **Why it matters:** The bar Tyler set for OZ ("teaches you how to build the lock, but not how to use the key") applies here in reverse: the README lists every key and never shows a door opening end-to-end.
- **Rewrite recommendation:** README ≤ 250 lines: what it is, a runnable 20-line quick start with real testnet constants, the lifecycle diagram, the three signer kinds, one policy example, link to typedoc and `examples/{browser-passkey,node-ed25519-agent,multisig-2-of-3,session-key-spending-limit}`. Generate reference docs from JSDoc and test the JSDoc examples (a doctest-style vitest that compiles README snippets).

### API-F12. Events, two storage interfaces, and the credential state machine are not earning their complexity   [severity: low]
- **Where:** `src/events.ts:18-39` (7 events; 4 emitted; `demo/src` uses `kit.events` zero times), `src/types.ts:370-405` (`StorageAdapter`, 10 methods; SDK never calls `clear()`), `src/external-signers.ts:40-44` (`WalletStorage`, 3 methods), `src/types.ts:27-31, 95-122` (`CredentialDeploymentStatus` 4 states; `StoredCredential` 19 fields), `src/managers/credential-manager.ts:223-278` (`sync`/`syncAll` state reconciliation), `src/types.ts:37-49` (`StoredSession` — exactly one session).
- **What:** The event emitter exists so a UI can react to connection changes, but the only UI mirrors state by hand (`useWalletSession.ts:179-194` `applyConnection`). The credential store doubles as the *pending deployment* queue (`pending|failed|occupied`), the *verified birth* cache, and the *session* store, with a `sync` pass on every kit init (`useKit.ts:85`). Two storage interfaces exist because external-wallet persistence was added later.
- **Why it matters:** Size and surface; it also leaks into the public `StoredCredential` type that every custom storage implementer must reproduce.
- **Rewrite recommendation:** One `KeyValueStorage { get(k); set(k, v); delete(k) }` (localStorage-shaped, easy to back with IndexedDB/AsyncStorage/Redis); the SDK owns the schema under it. Drop events; expose `account.on("change", …)` only if a real consumer asks. Pending deployments become a returned value (`SmartAccount.create()` returns the deploy payload; retry is `SmartAccount.deploy(payload)`), not a stored state machine.

### API-F13. The SDK-blessed way to add a second passkey is not composable, so the demo uses a path that loses the passkey's association   [severity: medium]
- **Where:** `src/managers/signer-manager.ts:57-119` (`addPasskey`: creates passkey, stores a record with `associationVerified: true` and birth data, returns an `add_signer` tx for one rule; requires a locally verified primary), `demo/src/components/ContextRuleBuilder.tsx:335-367` (demo instead calls `kit.credentials.create()` — a *pending primary* record with `contractId: ""`, `credential-manager.ts:114-123`), `:502-513, 665` (builds the signer via `createWebAuthnSigner` and adds it in `rules.add`/`signers.addBatch`), `:673-679` (then `kit.credentials.delete()` on success — "Cleaned up pending passkey"), `src/managers/credential-manager.ts:283-295` + `:223-255` (`delete` → `sync` → derived address not on chain → record deleted), `src/kit/wallet-ops.ts:354-361` (`connectWallet({credentialId})` with no stored record derives the *primary* address for that credential → not found), `docs/migration-v0.7.0.md:59-60` ("A secondary passkey remains usable when local storage contains its verified association").
- **What:** `signers.addPasskey` is the only API that records a secondary passkey's association, but it (a) can only target an existing rule, (b) can only add one signer, (c) cannot participate in a new rule or a batch. The demo's rule builder needs all three, so it uses `credentials.create` + builders, and then deletes the record — which the v0.7.0 model says is the one thing that keeps the secondary passkey connectable. The SDK offered a correct-but-rigid API and a flexible-but-wrong one.
- **Why it matters:** DX shaped a data-loss bug in the reference consumer.
- **Rewrite recommendation:** Separate *creating a signer* from *installing it*: `const pk = await PasskeySigner.register({ user })` returns a `Signer`; installing it anywhere (`rules.add`, `signers.add`, `create`) is what records the association, done by `send()` on success. No "pending credential" concept.

### API-F14. Small API paper-cuts (grouped)   [severity: low]
- `createWallet(appName, userName, options)` — positional strings where `rp.name` already lives in config (`kit.ts:839-841`, `webauthn-ops.ts:76`).
- `transfer(token, to, amount: number)` (`kit.ts:1313-1318`) — `number` for money; the code then does exact decimal-string arithmetic to compensate (`tx-ops.ts:294-364`). Accept `bigint | string`.
- `execute(target, targetFn, targetArgs: unknown[])` (`kit.ts:1379-1391`) — the bindings' `Vec<Val>` accepts `ScVal`s or natives with guessed types; nothing in the signature says which.
- `rules.add(contextType, name, signers, policies, validUntil?)` — five positional args (`context-rule-manager.ts:82-88`); `updateExpiration(id, validUntil?)` where `undefined` means "clear" (`:207-213`).
- `signers.addDelegated(ruleId, publicKey)` but no `signers.add(ruleId, signer)` for a single Ed25519 signer — you must call `addBatch(ruleId, [signer])` (`signer-manager.ts:124-165`).
- `SelectedSigner.signer?: unknown` (`types.ts:664`) is always a `ContractSigner` and is required at runtime.
- `SubmitOptions` and `SubmissionOptions` are the same type under two names (`types.ts:517-547`).
- `kit.policyClients` is a getter that allocates three closures per access (`kit.ts:1448-1461`).
- `WeightedThresholdPolicyClient.getSignerWeights` returns `Map<ContractSigner, number>` keyed by *object identity* (`policy-clients.ts:186-194, 269-278`) — `map.get(mySigner)` never hits; consumers must iterate and `signersEqual`.

## First-principles recommendations for the rewrite

### Principles
1. **The contract's vocabulary is the SDK's vocabulary.** `SmartAccount`, `Rule`, `Signer`, `Policy`, `Verifier`. No "wallet", no "credential" outside the passkey module.
2. **A signer is a value, not a mode.** One interface, three implementations, no `multiSigners`.
3. **Connection is signer-agnostic.** Passkey discovery/verification is a browser helper that yields a signer + address.
4. **One pipeline.** Everything mutating returns an `AssembledTransaction`; `account.send()` is the only thing that signs and submits.
5. **Throw typed errors. Return receipts.**
6. **Config is a network name.** Deployed constants ship in the package.
7. **Browser code is a subpath.** Root entry is isomorphic; `/passkey` needs a DOM.

### Proposed public API (root entry)

```ts
// ---------- config ----------
export interface NetworkConfig {
  passphrase: string; rpcUrl: string; horizonUrl?: string; indexerUrl?: string;
  accountWasmHash: string; acceptedWasmHashes?: string[];
  verifiers: { webauthn: string; ed25519: string };
  policies: { threshold: string; weightedThreshold: string; spendingLimit: string };
  deployer: string;                     // shared salt identity (G-address)
}
export const networks: { testnet: NetworkConfig; mainnet: NetworkConfig };

export type Submit =
  | { relayerUrl: string }
  | { feePayer: Keypair }
  | ((tx: Transaction) => Promise<string /* hash */>);

export interface Config {
  network: "testnet" | "mainnet" | NetworkConfig;
  submit?: Submit;                      // default: throws on first send with a clear message
  storage?: KeyValueStorage;            // default: memory
  passkey?: { rpId?: string; rpName?: string; origins?: string[]; provider?: WebAuthnProvider };
  defaults?: { txTimeoutSec?: number; sigExpiryLedgers?: number; sessionTtlMs?: number };
  indexer?: { url?: string | false; token?: string };
}
export interface KeyValueStorage { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void>; }

// ---------- signers ----------
export type SignerKey = { tag: "Delegated"; values: [string] } | { tag: "External"; values: [string, Buffer] }; // = bindings Signer
export interface SignInput { authDigest: Buffer; entry: xdr.SorobanAuthorizationEntry; expiration: number; ruleIds: number[]; }
export type Signature = { bytes: Buffer } | { delegatedEntry: xdr.SorobanAuthorizationEntry };
export interface Signer {
  readonly key: SignerKey;
  readonly kind: "passkey" | "ed25519" | "delegated";
  sign(input: SignInput): Promise<Signature>;
}
export class Ed25519Signer implements Signer { static fromSecret(s: string, verifier?: string): Ed25519Signer; static fromKeypair(kp: Keypair, verifier?: string): Ed25519Signer; }
export class DelegatedSigner implements Signer { static fromKeypair(kp: Keypair): DelegatedSigner; static fromWallet(adapter: WalletAdapter, address: string): DelegatedSigner; }
// PasskeySigner lives in "smart-account-kit/passkey"

// ---------- rules & policies ----------
export type RuleScope = { kind: "default" } | { kind: "call"; contract: string } | { kind: "create"; wasmHash: Buffer };
export const scope: { default(): RuleScope; call(contract: string): RuleScope; create(wasmHash: string | Buffer): RuleScope };
export interface PolicyInstall { address: string; params: xdr.ScVal }
export const policy: {
  threshold(n: number, address?: string): PolicyInstall;
  weightedThreshold(threshold: number, weights: Array<[Signer | SignerKey, number]>, address?: string): PolicyInstall;
  spendingLimit(opts: { limit: bigint | string; periodLedgers: number }, address?: string): PolicyInstall;
  custom(address: string, params: xdr.ScVal): PolicyInstall;
};
export interface Rule { id: number; name: string; scope: RuleScope; signers: SignerKey[]; signerIds: number[]; policies: string[]; policyIds: number[]; validUntil?: number; }
export interface RuleSpec { scope: RuleScope; name: string; signers: Array<Signer | SignerKey>; policies?: PolicyInstall[]; validUntil?: number; }

// ---------- account ----------
export interface Receipt { hash: string; ledger: number }
export interface SendOptions { signers?: Signer[]; ruleId?: number | ((entry, i) => number); expiration?: number; submit?: Submit }

export class SmartAccount {
  static create(cfg: Config, opts: { signer: Signer; policies?: PolicyInstall[]; name?: string }): Promise<SmartAccount>;
  static connect(cfg: Config, opts: { address: string; signers: Signer[] }): Promise<SmartAccount>;
  static restore(cfg: Config, signers?: Signer[]): Promise<SmartAccount | null>;   // from storage session
  static deployPayload(cfg: Config, signer: Signer, policies?: PolicyInstall[]): Promise<{ address: string; func: string; auth: string[] }>;

  readonly address: string;
  readonly network: NetworkConfig;
  readonly signers: readonly Signer[];
  readonly raw: BindingsClient;          // generated client, escape hatch

  send<T>(tx: AssembledTransaction<T>, opts?: SendOptions): Promise<Receipt>;
  prepare<T>(tx: AssembledTransaction<T>, opts?: SendOptions): Promise<Transaction>;  // signed + assembled, not sent
  signersFor<T>(tx: AssembledTransaction<T>): Promise<{ ruleId: number; usable: Signer[]; required: SignerKey[] }[]>;

  transfer(token: string, to: string, amount: bigint | string, opts?: SendOptions): Promise<Receipt>;
  call(target: string, fn: string, args: xdr.ScVal[]): Promise<AssembledTransaction<unknown>>;   // account.execute
  upgrade(wasmHash: string | Buffer): Promise<AssembledTransaction<null>>;

  rules: {
    list(): Promise<{ rules: Rule[]; complete: boolean; source: "indexer" | "probe" | "both" }>;
    get(id: number): Promise<Rule>;
    count(): Promise<number>;
    add(spec: RuleSpec): Promise<AssembledTransaction<Rule>>;
    remove(id: number): Promise<AssembledTransaction<null>>;
    rename(id: number, name: string): Promise<AssembledTransaction<Rule>>;
    setValidUntil(id: number, ledger: number | null): Promise<AssembledTransaction<Rule>>;
  };
  signers: {
    add(ruleId: number, ...signers: Array<Signer | SignerKey>): Promise<AssembledTransaction<unknown>>;   // add_signer or batch_add_signer
    remove(ruleId: number, signer: Signer | SignerKey): Promise<AssembledTransaction<null>>;
    idOf(signer: Signer | SignerKey): Promise<number>;
  };
  policies: {
    add(ruleId: number, install: PolicyInstall): Promise<AssembledTransaction<number>>;
    remove(ruleId: number, address: string): Promise<AssembledTransaction<null>>;
    idOf(address: string): Promise<number>;
    threshold(address?: string): { get(ruleId): Promise<number>; set(ruleId, n): Promise<AssembledTransaction<unknown>> };
    weightedThreshold(address?: string): { get(ruleId); weights(ruleId): Promise<Array<[SignerKey, number]>>; set(ruleId, n); setWeight(ruleId, signer, w) };
    spendingLimit(address?: string): { get(ruleId): Promise<SpendingLimitData>; set(ruleId, limit) };
  };
  disconnect(): Promise<void>;
}

// ---------- errors ----------
export type SmartAccountErrorCode = "NOT_CONNECTED" | "INVALID_INPUT" | "RULE_NOT_FOUND" | "SIGNER_NOT_FOUND" | "POLICY_NOT_FOUND"
  | "RULE_AMBIGUOUS" | "SIMULATION_FAILED" | "SUBMISSION_FAILED" | "TIMEOUT" | "WEBAUTHN" | "PROVENANCE" | "OWNERSHIP" | "CONTRACT";
export class SmartAccountError extends Error { code: SmartAccountErrorCode; hash?: string; cause?: unknown; context?: Record<string, unknown> }
export class ContractError extends SmartAccountError { contractCode: number; name: string; family: string }
```

Subpaths: `smart-account-kit/passkey` → `PasskeySigner.register({ user, ... })`, `PasskeySigner.authenticate()`, `discover(cfg, signer)` (indexer candidates + fail-closed verification returning `{ address }`), `verifyOwnership(...)`. `smart-account-kit/storage` → `memoryStorage()`, `localStorage()`, `indexedDb()`. `smart-account-kit/wallets` → `StellarWalletsKitAdapter`. `smart-account-kit/testnet` → `fund(account)`.

### Quick start (browser, passkey)

```ts
import { SmartAccount, Ed25519Signer, scope, policy } from "smart-account-kit";
import { PasskeySigner, discover } from "smart-account-kit/passkey";

const cfg = { network: "testnet", submit: { relayerUrl: "https://relayer.example" } } as const;

// create: one passkey, deploy, connect
const passkey = await PasskeySigner.register({ user: "alice@example.com" });
let account = await SmartAccount.create(cfg, { signer: passkey });

// later: reconnect (session) or rediscover (fresh device)
account = (await SmartAccount.restore(cfg))
  ?? await (async () => { const pk = await PasskeySigner.authenticate(); const { address } = await discover(cfg, pk); return SmartAccount.connect(cfg, { address, signers: [pk] }); })();

// transfer 10 XLM
await account.transfer(XLM, "GRECIPIENT…", "10");

// add a 2-of-2 rule: passkey + a backup ed25519 key, guarded by a threshold policy
const backup = Ed25519Signer.fromSecret("S…");
await account.send(await account.rules.add({ scope: scope.default(), name: "2-of-2", signers: [passkey, backup], policies: [policy.threshold(2)] }));

// multi-sign: the session now holds both signers; send() resolves rule 1 and signs with both
account = await SmartAccount.connect(cfg, { address: account.address, signers: [passkey, backup] });
await account.transfer(XLM, "GRECIPIENT…", "5", { ruleId: 1 });
```

Node/agent variant is the same file without the passkey import: `SmartAccount.connect(cfg, { address, signers: [Ed25519Signer.fromSecret(process.env.KEY)] })`.

### Module layout
```
src/
  index.ts            # ~25 exports
  account.ts          # SmartAccount (create/connect/send/prepare + rules/signers/policies namespaces)
  pipeline.ts         # simulate → resolve rules → sign → resimulate → assemble → submit (one file)
  signers/{types,ed25519,delegated}.ts
  rules.ts            # decode/hydrate/list/probe/resolve
  policies.ts         # PolicyInstall constructors + typed clients + encoding/sorting
  errors.ts           # SmartAccountError, ContractError, registry
  networks.ts         # testnet/mainnet constants
  submit.ts           # relayer / feePayer / custom
  passkey/            # subpath: register, authenticate, discover, verify (browser)
  storage/            # subpath
  wallets/            # subpath
```

### What to delete outright
`MultiSignerManager`, `ExternalSignerManager`, `CredentialManager` (replaced by session store), `SmartAccountEventEmitter`, `SelectedSigner`, `ExternalSigner`, `AuthDigestSigner`, `PolicyConfig`, `StoredCredential` (internal), `convertPolicyParams`, `buildPoliciesScVal`, `createThresholdParams`/`createWeightedThresholdParams`/`createSpendingLimitParams` (become `policy.*`), `createDelegatedSigner`/`createExternalSigner`/`createWebAuthnSigner`/`createEd25519Signer` (become signer classes), all seven `validate*` exports (internal), the four display helpers, `signFeePayer`/`resimulateAndAssemble`/`buildI128ScVal`/`readTokenDecimals`/`resolveTokenAmount`/`tokenAmountToRawUnits`/`buildDirectTokenTransfer`/`signerToScVal`/`parseSignerScVal`/`computeEntryAuthDigest` (internal), `PolicyClientDeps`, `RelayerClient`/`IndexerClient` as public classes (internal to `submit`/`rules`; expose `account.indexer` read-only if the demo's inspector needs it), `SubmitOptions`/`SubmissionOptions`/`SignOptions`/`SignAndSubmitOptions` (one `SendOptions`), 11 error subclasses (keep `SmartAccountError` + `ContractError`), `wrapError`.

## Open questions for Tyler

1. **Is backend/agent use a v1 requirement?** F1 assumes yes. If so, the fail-closed connection model (birth verification, fresh WebAuthn assertion) needs a defined analogue for non-passkey signers — is "signer key present on a live, unexpired rule" sufficient, or do agents also need birth verification?
2. **Should `send()` auto-resolve rule ids at all?** Explicit `ruleId` is safer and matches OZ v0.7's intent ("every client must explicitly supply the rule ID"). Auto-resolution is convenient for the single-default-rule case; is that convenience worth keeping the heuristic in `resolveContextRuleIdsForEntry` (`context-rules.ts:499-575`)?
3. **Do you want the SDK to own deployed policy addresses?** `policy.threshold(2)` with no address argument assumes the network's canonical threshold policy. That's a soft endorsement of specific contracts.
4. **Is the relayer wire format (`{func, auth}`) stable enough to be the *only* fee-sponsoring shape**, or should `submit` also accept a generic "sign this envelope" callback for integrators with their own channel accounts?
5. **Should the pending-deployment queue survive?** F12 proposes removing it in favour of returning the deploy payload. That drops retry-after-reload for a half-created wallet unless the app stores the payload itself.
6. **How much of the demo should become `examples/`?** The rule builder and signer picker are the only places multi-signer UX exists; if the SDK API changes as proposed, most of their SDK-workaround code disappears and what remains is a good multisig example.
7. **F4 (policy map ordering):** should I hand this to the correctness agent to construct a failing address pair, or is "the SDK must sort with `compareScVal` in `rules.add` and deploy" enough to act on?
