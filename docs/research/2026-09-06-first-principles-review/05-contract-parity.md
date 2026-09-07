> Part of the smart-account-kit first-principles review (2026-09-06). Findings in this document are referenced across the collection as **PAR-F<n>**. Start with [`01-executive-summary.md`](01-executive-summary.md); the consolidated list of every finding is in [`10-findings-register.md`](10-findings-register.md); the rewrite proposal is in [`08-rewrite-blueprint.md`](08-rewrite-blueprint.md).

# Contract parity — findings

## Coverage

**Read fully (OZ pinned `1e513890`, the deployed build):**
`packages/accounts/src/smart_account/mod.rs` (trait, `ExecutionEntryPoint`, constants, errors, all 11 events), `smart_account/storage.rs` (all 1432 lines: storage keys, `Signer`/`AuthPayload`/`ContextRule*` types, `get_validated_context_by_id`, `authenticate`, `do_check_auth`, `validate_no_canonical_duplicates`, every CRUD fn, `register_/deregister_signer/policy`), `policies/mod.rs`, `policies/simple_threshold.rs`, `policies/weighted_threshold.rs`, `policies/spending_limit.rs`, `verifiers/mod.rs`, `verifiers/webauthn.rs`, `verifiers/ed25519.rs`, `verifiers/utils/*`, `packages/accounts/README.md`, `packages/contract-utils/src/upgradeable/{mod,storage}.rs` (the `Upgradeable` trait the example uses), and all six deployed example crates under `examples/multisig-smart-account/*/src/contract.rs`.

**Diffed:** `git diff 1e513890..HEAD(6ea3075) -- packages/accounts examples/multisig-smart-account`. Non-test changes are: `MAX_HISTORY_ENTRIES` 1000 → 815 in `spending_limit.rs`, doc-only re-wording in `weighted_threshold.rs` (operation-ordering guidance), two extra re-exports in `smart_account/mod.rs`, comment re-wraps. **No interface, error, event, or limit changes to the account, policies, or verifiers.** The "P27 revision" items in the brief (no rule cap, IDs in events, batch signer adds) are already in `1e513890`; nothing further has landed on `main`.

**Verified against the Soroban host (fetched from `stellar/rs-soroban-env@main`):** `soroban-env-common/src/compare.rs`, `soroban-env-host/src/host/comparison.rs`, `host.rs::obj_cmp`, `host/metered_map.rs::from_map`, `builtin_contracts/account_contract.rs::invocation_tree_to_auth_contexts`. Used to check the SDK's ScMap key ordering and `auth_contexts` ordering claims.

**Read fully (SDK):** `packages/smart-account-kit-bindings/src/index.ts` (incl. decoding the embedded spec's event entries with a script), `src/contract-types.ts`, `src/contract-errors.ts` (+ test), `src/kit/auth-payload.ts`, `src/kit/context-rules.ts`, `src/kit/policies-ops.ts`, `src/policy-clients.ts`, `src/managers/{policy,context-rule,signer,multi-signer}-manager.ts`, `src/builders.ts`, `src/validation.ts`, `src/constants.ts`, `src/events.ts`, `src/signer-utils.ts`, `src/signers.ts`, `src/kit/deploy-ops.ts` (deploy half), `src/kit/wallet-provenance.ts` (constructor validation), `src/kit/wallet-ops.ts:470-590`, `src/kit/webauthn-ops.ts:120-209`, `src/kit/tx-ops.ts` (transfer/execute half), the public-method list of `src/kit.ts` and its `execute`/`upgrade`/`policyClients`/`convertPolicyParams` bodies, README sections on concepts, API, rules, policies, policy clients, validation; `indexer/README.md`; the CHANGELOG entry on host-order sorting.

**Skimmed:** rest of `src/kit.ts`, `src/kit/wallet-ops.ts`, `src/external-signers.ts`, `src/indexer.ts`, `src/types.ts`, demo usage of `kit.rules.add` / `kit.policies.add` / `policyClients`.

**Ran:** two node probes against the generated bindings' `Spec` (`execute` with raw args; `add_policy` with a plain object; `add_context_rule`/`__constructor` with a two-entry policies `Map`) to confirm encoding behaviour rather than infer it; `vitest` on `auth-payload.test.ts` and `contract-errors.test.ts` (41/41 pass).

**Not looked at:** `relayer-proxy/`, storage adapters, WebAuthn registration/attestation code, `wallet-adapter.ts`, the OZ test suites beyond the diff.

## Summary

The SDK's model of the *core* contract is mostly right where it counts: the `AuthPayload` wire shape, the `Signer` enum encoding, the auth-digest formula, the host-order `ScMap` sort in `compareScVal` (I verified it against the host's `Compare` impls), the pre-order `auth_contexts` alignment, `valid_until` inclusivity, and the four numeric limits all match Rust. The numeric error registry is complete and correct for all 45 codes. The "Full contract parity" claim in the README is true only at the level of "there is a wrapper per entry point": every account function has *a* method, and the three example policies have typed getters/setters.

The biggest problems are (1) two wrappers are wrapped-but-wrong — `rules.add`/`createWallet` hand an **unsorted** policies map to the host (fails for ≥2 policies depending on address order; confirmed with the spec), and `execute`/`policies.add` require pre-encoded `xdr.ScVal`s while the README and the manager's own docstring show raw values (confirmed to throw); (2) the SDK throws away everything the contract *returns and emits* — no event decoding for any of the 25 contract events, `TransactionSuccess` carries no return value, and `kit.events` is an unrelated lifecycle emitter; (3) the SDK narrows the contract far more than it admits: the account must be born with exactly one WebAuthn signer to connect at all, `Delegated` means "G-address" only, custom verifiers can be registered but never sign, `SelectedSigner.type` is a closed union, and rule discovery is capped at id 8 by an invented constant while the contract's own `get_context_rules_count` (which the SDK mis-documents as "monotonic") gives an exact stop condition. Several semantic docs are wrong (Default "fallback" precedence that the contract does not have; `count()` semantics; the stale `signer_ids` note). A rewrite should generate bindings, error tables, event decoders, and limits from the contract spec as a build step, model `Verifier`/`Policy` as plugin interfaces mirroring the Rust traits, and treat the example-crate-only entry points (`__constructor` shape, `batch_add_signer`, `upgrade`) as a declared "profile" of the deployed WASM rather than as "the contract".

---

## 1. Parity matrix

Status key: **full** = exposed with correct types/semantics; **partial** = exposed but narrowed or needs undocumented pre-encoding; **wrong** = wrapped but produces an invalid call in a reachable case; **missing** = no SDK path.

### 1a. `SmartAccount` trait (`mod.rs:136-475`) + `CustomAccountInterface`

| Contract entry point | SDK method(s) | Status | Notes |
|---|---|---|---|
| `get_context_rules_count()` | `kit.rules.count()` (`context-rule-manager.ts:112-115`) | full (mis-documented) | Contract returns the **live** rule count (`Count` is decremented in `remove_context_rule`, `storage.rs:882-884`); SDK docs/README call it "total rules ever created… a monotonic counter" (`context-rule-manager.ts:105-107`, `README.md:370`). See F8. |
| `get_context_rule(id)` | `kit.rules.get(id)` → `readContextRule` (`context-rules.ts:312-338`) | full | Carries a legacy shim that injects empty `signer_ids`/`policy_ids` and re-hydrates via N+1 `get_signer_id`/`get_policy_id` sims (`context-rules.ts:130-179, 236-291`). The canonical WASM `1b5f4534` (from `1e513890`) already returns both fields (`storage.rs:155-174`, bindings `index.ts:213-248`). README's note at `README.md:404-406` is stale. |
| `get_signer_id(signer)` | `kit.signers.idOf(signer)` (`signer-manager.ts:175-188`) | full | |
| `get_policy_id(policy)` | `kit.policies.idOf(addr)` (`policy-manager.ts:110-123`) | full | |
| `add_context_rule(type, name, valid_until, signers, policies)` | `kit.rules.add(type, name, signers, policies, validUntil?)` (`context-rule-manager.ts:82-102`) | **wrong** for ≥2 policies | `policies: Map<string, unknown>` is passed straight to the bindings; `Spec.nativeToScVal` does not sort Map entries and the host rejects an unsorted `ScMap` (`metered_map.rs:328-336`). Values must already be `xdr.ScVal` (the `unknown` type hides this). `currentLedger` is never passed so the past-`valid_until` pre-check is dead. See F1. |
| `update_context_rule_name(id, name)` | `kit.rules.updateName` | full | |
| `update_context_rule_valid_until(id, valid_until)` | `kit.rules.updateExpiration` | full | No current-ledger pre-check; no "you are expiring your only rule" guard. |
| `remove_context_rule(id)` | `kit.rules.remove` | full | Contract has **no** last-rule guard (`storage.rs:843-887`); neither does the SDK. See F12. |
| `add_signer(id, signer)` | `kit.signers.addPasskey` / `addDelegated` (`signer-manager.ts:57-137`) | partial | No generic `add(ruleId, signer)`; an Ed25519 or custom-verifier `External` signer can only be added via `addBatch` (an example-only entry point). `addDelegated` does no address validation. |
| `remove_signer(id, signer_id)` | `kit.signers.remove(ruleId, signer)` | full | Resolves the id via `get_signer_id`. |
| `add_policy(id, policy, install_param: Val)` | `kit.policies.add(ruleId, addr, installParams)` (`policy-manager.ts:66-72`) | partial / doc-wrong | `install_param` must be an `xdr.ScVal`; the method's own docstring example passes `createThresholdParams(2)` (`policy-manager.ts:40-52`) which throws `Received object … did not match the provided type` (verified). See F2. |
| `remove_policy(id, policy_id)` | `kit.policies.remove(ruleId, addr)` | full | |
| `__check_auth(payload, AuthPayload, contexts)` | `kit.signAuthEntry` (`webauthn-ops.ts:120-209`), `kit.multiSigners.*` (`multi-signer-manager.ts`) | partial | Passkey ✓, Ed25519 ✓, `Delegated(G…)` ✓ (nested `__check_auth(auth_digest)` entry, `multi-signer-manager.ts:414-461`). `Delegated(C…)` ✗, custom `External` verifiers ✗ (`SelectedSigner.type` is `"passkey"\|"wallet"\|"ed25519"`, `types.ts:654`), `CreateContract` contexts resolvable (`context-rules.ts:102-112`) but no builder produces one. See F5, F6. |

### 1b. Example-account extras (`examples/multisig-smart-account/account/src/contract.rs`)

| Contract entry point | SDK method(s) | Status | Notes |
|---|---|---|---|
| `__constructor(signers: Vec<Signer>, policies: Map<Address,Val>)` (`contract.rs:32-41`) — creates one `Default` rule named `"multisig"`, no expiry | `kit.createWallet` / `kit.credentials.deploy` → `buildDeployTransaction` (`deploy-ops.ts:415-463`) | partial + **wrong** for ≥2 policies | SDK hard-codes `signers: [oneWebAuthnSigner]` (`deploy-ops.ts:432-451`); `connectWallet` then **refuses** any account whose birth args are not exactly one WebAuthn signer for the configured verifier (`wallet-provenance.ts:131-155`). The contract accepts any signer mix, any policies (needs ≥1 of either). Policies `Map` is unsorted → same bug as `rules.add`. See F1, F4. |
| `batch_add_signer(id, signers)` (`contract.rs:43-47`) — **not in the trait** | `kit.signers.addBatch` (`signer-manager.ts:154-165`) | full | Nowhere documented as example-crate-only. See F11. |
| `execute(target, target_fn, target_args: Vec<Val>)` (`mod.rs:509-512`) | `kit.execute` / `kit.executeAndSubmit` (`kit.ts:1379-1391, 1477-1485`) | **wrong** as documented | `target_args` must be `xdr.ScVal[]`; README `kit.execute('CTARGET...', 'set_config', [owner, threshold])` (`README.md:261,265`) throws `invalid type scSpecTypeVal specified for string value` (verified). The policy clients work only because they pre-encode. See F2. |
| `upgrade(new_wasm_hash, _operator)` (`contract.rs:88-94`; `Upgradeable` trait `upgradeable/mod.rs:264`) | `kit.upgrade(hash)` (`kit.ts:1406-1420`) | full | `operator` is ignored by the contract (`_operator`, self-auth only); SDK passes the account id and says so. Correct. |

### 1c. Policies (deployed example crates)

`install`/`uninstall`/`enforce` are invoked only by the account (`storage.rs:692, 868-869, 510-515, 1137, 1193`) and each does `smart_account.require_auth()`; an SDK must not call them directly (it could via `execute`, which would corrupt state — install without registration). Marked n/a. **`can_enforce` does not exist in the pinned or main trait** (`policies/mod.rs:47-163`); OZ removed it in 0.7.0 (`packages/accounts/README.md:521-542`).

| Contract | Fn | SDK | Status |
|---|---|---|---|
| Threshold (`threshold-policy/src/contract.rs:62-78`) | `get_threshold(rule_id, account)` | `SimpleThresholdPolicyClient.getThreshold` | full |
| | `set_threshold(threshold, context_rule: ContextRule, account)` | `.setThreshold(n, rule)` via `execute` | full — takes full `ContextRule` because the contract validates against `context_rule.signers.len()` from the **caller-supplied** struct (`simple_threshold.rs:352-366`). |
| Weighted (`weighted-threshold-policy/src/contract.rs:44-76`) | `get_threshold` | `WeightedThresholdPolicyClient.getThreshold` | full |
| | `get_signer_weights(context_rule, account)` | `.getSignerWeights(rule)` | full |
| | `set_threshold(threshold, context_rule, account)` | `.setThreshold` | full |
| | `set_signer_weight(signer, weight, context_rule, account)` | `.setSignerWeight` | full |
| Spending limit (`spending-limit-policy/src/contract.rs:67-87`) | `get_spending_limit_data(rule_id, account)` | `SpendingLimitPolicyClient.getSpendingLimitData` | full (returns raw `scValToNative`; bigint/number typing is trusted, not checked) |
| | `set_spending_limit(limit, context_rule, account)` | `.setSpendingLimit` | full — note the contract has **no** `set_period_ledgers`; the period is immutable after install. SDK does not say so. |
| install params (`SimpleThresholdAccountParams`, `WeightedThresholdAccountParams`, `SpendingLimitAccountParams`) | `convertPolicyParams` (`policies-ops.ts:63-140`) | full | Hand-written encoders; byte-identical to spec encoding per its tests. Weighted signer map is host-sorted ✓. |

### 1d. Verifiers (deployed example crates)

| Contract | Fn | SDK | Status |
|---|---|---|---|
| WebAuthn (`webauthn-verifier/src/contract.rs:51-64`) | `verify(payload: Bytes, key_data: Bytes, sig_data: Bytes)` | — | missing (no client; not needed for signing, but usable for offline pre-flight of an assertion via simulation) |
| | `canonicalize_key(key_data) -> Bytes` / `batch_canonicalize_key` | — | missing — this is what the contract uses for `DuplicateSigner`; SDK could pre-check duplicates with it instead of raw-byte dedup (see §4.6). |
| Ed25519 (`ed25519-verifier/src/contract.rs:30-55`) | `verify(payload, key: BytesN<32>, sig: BytesN<64>)`, `canonicalize_key`, `batch_canonicalize_key` | — | missing |
| Wire format of `sig_data` | WebAuthn: XDR of `WebAuthnSigData{signature: BytesN<64>, authenticator_data, client_data}` (`webauthn.rs:92-101`) | `buildWebAuthnSignatureBytes` (`auth-payload.ts:99-114`) | full — struct → `ScMap` with symbol keys in byte order (`authenticator_data` < `client_data` < `signature`) ✓ |
| | Ed25519: raw 64 bytes | `Ed25519Signer.signAuthDigest` (`signers.ts:132-146`) | full |
| Key format | WebAuthn: 65-byte uncompressed P-256 + optional credential-id suffix (`webauthn.rs:373-377`); Ed25519: 32 bytes | `buildKeyData` (`utils.ts:138-148`), `createEd25519Signer` | full; SDK *requires* the credential-id suffix to recognise a passkey (`signer-utils.ts:5-17`, `wallet-provenance.ts:145-150`) — stricter than the contract, fine as a convention. |

### 1e. Read paths the contract does **not** offer

There is no on-chain iterator over active rule ids. The SDK compensates with indexer + a probe capped at `DEFAULT_MAX_PROBED_RULE_ID = 8` / 3 consecutive misses (`constants.ts:64-68`, `context-rules.ts:364-383`). See F8 for why this is worse than it needs to be.

---

## 2. Events matrix

The generated spec embeds all 11 account events with full topic/data shapes (I decoded them from `index.ts:642-653` — every one is `scSpecEventDataFormatMap`, first topic = snake_case name, `context_rule_id`/`signer_id`/`policy_id` in the topic list, everything else in the data map). The SDK decodes **none** of them. `kit.events` (`events.ts:18-39`) is an SDK-lifecycle emitter (`walletConnected`, `credentialCreated`, …) and has no relation to contract events — a naming collision a newcomer will trip on. `TransactionSuccess` is `{hash, ledger?}` only (`types.ts:457-463`), so the return values of `add_context_rule` (the new `ContextRule` incl. `id`), `add_signer`/`add_policy` (`u32` ids) are discarded after `signAndSubmit`; a caller has to re-discover the id via indexer/probe. The indexer (Mercury, `indexer/README.md`) is external and its event handling is out of this repo.

| Emitter | Event (`#[contractevent]`) | Topics | Data | SDK decode |
|---|---|---|---|---|
| account (`mod.rs:577-585`) | `ContextRuleAdded` | `["context_rule_added", context_rule_id]` | `{name, context_type, valid_until, signer_ids, policy_ids}` | ✗ |
| account (`627-632`) | `ContextRuleMetaUpdated` | `["context_rule_meta_updated", id]` | `{name, valid_until}` — one event for two different ops | ✗ |
| account (`661-664`) | `ContextRuleRemoved` | `["context_rule_removed", id]` | `{}` | ✗ |
| account (`684-688`) | `SignerAdded` | `["signer_added", rule_id]` | `{signer_id}` — **no `Signer` body** | ✗ |
| account (`709-713`) | `SignerRemoved` | `["signer_removed", rule_id]` | `{signer_id}` | ✗ |
| account (`734-738`) | `PolicyAdded` | `["policy_added", rule_id]` | `{policy_id}` | ✗ |
| account (`759-763`) | `PolicyRemoved` | `["policy_removed", rule_id]` | `{policy_id}` | ✗ |
| account (`784-788`) | `SignerRegistered` | `["signer_registered", signer_id]` | `{signer: Signer}` — only on **first** registration (`storage.rs:1235-1262`) | ✗ |
| account (`810-813`) | `SignerDeregistered` | `["signer_deregistered", signer_id]` | `{}` — only when refcount hits 0 | ✗ |
| account (`834-838`) | `PolicyRegistered` | `["policy_registered", policy_id]` | `{policy: Address}` | ✗ |
| account (`860-863`) | `PolicyDeregistered` | `["policy_deregistered", policy_id]` | `{}` | ✗ |
| simple_threshold (`59-94`) | `SimpleEnforced` | `["simple_enforced", smart_account]` | `{context: Context, context_rule_id, authenticated_signers}` | ✗ |
| | `SimpleInstalled` / `SimpleThresholdChanged` / `SimpleUninstalled` | `["simple_installed"\|"simple_threshold_changed"\|"simple_uninstalled", smart_account]` | `{context_rule_id, threshold}` / `{context_rule_id}` | ✗ |
| weighted_threshold (`75-123`) | `WeightedEnforced`, `WeightedInstalled` (`+signer_weights: Map<Signer,u32>`), `WeightedThresholdChanged`, `WeightedSignerWeightChanged` (`+signer, weight`), `WeightedUninstalled` | `[name, smart_account]` | as named | ✗ |
| spending_limit (`46-83`) | `SpendingLimitEnforced` (`{context, context_rule_id, amount, total_spent_in_period}`), `SpendingLimitInstalled`, `SpendingLimitChanged`, `SpendingLimitUninstalled` | `[name, smart_account]` | as named | ✗ |

**The "inconsistency in event management" (Mar-2026 note), as visible in the source:**
- Account events key by *id in the topic list* and put the entity in data; policy events key by *smart_account in the topic list* and put `context_rule_id` in data. An indexer needs two different filter shapes for "everything about rule N".
- `SignerAdded`/`ContextRuleAdded` carry only ids. The `Signer` bytes appear once, in `SignerRegistered`, and only if the signer was not already registered. An indexer must therefore maintain a per-account `signer_id → Signer` table for the account's whole life; a stateless "decode this tx's events" cannot tell you who was added.
- `remove_context_rule` emits `policy_deregistered*`, `signer_deregistered*`, **then** `context_rule_removed` (`storage.rs:862-886`), whereas add emits registrations first and `context_rule_added` last — symmetric, but note `PolicyRemoved` still fires when the policy's `uninstall` panics (via `try_uninstall`), with no policy-side `*Uninstalled` event (`policies/mod.rs:151-155`).
- `SpendingLimitEnforced` is **not** emitted for zero-amount transfers (early `return` at `spending_limit.rs:254-256`).
- `ContextRuleMetaUpdated` is shared by name and expiry updates; consumers cannot tell which changed without diffing.

---

## 3. Error matrix

Every variant in the five Rust enums has an entry in `CONTRACT_ERROR_REGISTRY` (`contract-errors.ts:63-119`) with the correct number, name, and family. No drift in codes: SmartAccount 3000,3002-3016 (3001 absent in Rust too), WebAuthn 3110-3119, SimpleThreshold 3200-3203, WeightedThreshold 3210-3214, SpendingLimit 3220-3227. OZ `main` adds none.

What *is* off:

- **Message-keyed error mapping.** `unwrapContractResult` (`contract-errors.ts:200-215`) identifies an `Err` by comparing its message with the registry text, because stellar-sdk's `parseError` throws away the code and keeps only the spec doc string (`assembled_transaction.js:431-438`, `client.js:60-65`). Only 7 of 16 SmartAccount registry messages equal the Rust doc strings (e.g. 3002 Rust "cannot be validated" vs SDK "could not be"; 3010 Rust "Too many signers in the context rule." vs SDK "…maximum of 15 signers."). The test pins only 3000/3006/3008 and says the rest "is deliberately paraphrased" (`contract-errors.test.ts:89-101`). So `unwrapContractResult` silently degrades to an untyped `Error` for 13 of 16 codes if any other call site ever routes through it. See F9.
- **3003 `ExternalVerificationFailed` is unreachable with the deployed verifiers.** Both `verify` impls return `true` or panic: `ed25519_verify` is a host fn that traps on a bad signature (`ed25519.rs:37-40`), `secp256r1_verify` likewise (`webauthn.rs:356`), and the WebAuthn wrapper uses `.expect(...)` for malformed `sig_data`/`key_data` (`webauthn-verifier/src/contract.rs:57-61`). A bad signature surfaces as a host `Error(Crypto, InvalidInput)` / `Error(WasmVm, …)`, which `decodeContractError`'s `Error\(Contract, #N\)` regex (`contract-errors.ts:124`) does not match → generic `SimulationError`. The registry text for 3003 is fine to keep, but the SDK has no typed path for the *actual* signature-failure error.
- **3119 `KeyDataInvalid`** is only raised from `canonicalize_key` (add/constructor time), never from `verify` (which `expect`s). Registry text ("was not a valid secp256r1 public key") is slightly misleading: the check is length ≥ 65 only (`webauthn.rs:373-377`), no curve check.
- Host-level errors the SDK will hit but does not type at all: unsorted `ScMap` → `Error(Object, InvalidInput)` (see F1); `Error(Auth, InvalidAction)` for a wrong/missing nested delegated entry; budget exhaustion in `spending_limit::enforce` above ~815 history entries (the reason OZ lowered `MAX_HISTORY_ENTRIES` on `main`).

---

## 4. Semantic modeling checks

### 4.1 "No policies ⇒ all signers; policies ⇒ defer" — exact semantics
Verified at `storage.rs:310-324`: `matched_signers = rule.signers ∩ payload.signers`; if `policies.is_empty()` then `matched.len() == rule.signers.len()` else pass `matched` to each policy. So:
- A rule with **both** signers and policies has **no** signer-quorum check of its own; the policies see the intersection and decide. With spending-limit as the only policy, the rule is effectively **1-of-N** (`spending_limit.rs:232-234` only requires non-empty). With threshold policy, M-of-N. With weighted, unknown signers weigh 0 (`weighted_threshold.rs:257-263`).
- All policies are AND-ed (`storage.rs:508-517`).
- Additionally every payload signer must belong to at least one *selected* rule across the entry's contexts, else `UnauthorizedSigner` (`storage.rs:483-503`). The SDK's README sentence (`README.md:41`) is correct but omits the "both" case and the extra-signer rule; the SDK's own rule resolution violates the latter (F7).

### 4.2 Context matching and precedence
`storage.rs:287-308`: the contract looks up **exactly** the rule id the payload names for each context (`storage.rs:473-481`), checks it is not expired, and requires `rule.type == Default || rule.type == derived(context)`. There is no iteration, no precedence, no "most specific wins" — that was removed in OZ 0.7.0 (`packages/accounts/README.md:544-546`). `Default` is not a fallback; it is a wildcard the caller may always choose.

The SDK's `resolveContextRuleIdsForEntry` (`context-rules.ts:499-575`) is therefore **pure client policy**: filter type-compatible rules → prefer non-Default (`514-517`) → exact signer-set match → subset match (no-policy rules only) → else throw. Two doc strings misstate this as contract behaviour: `builders.ts:168-169` ("Default rules apply to any operation that doesn't match a more specific… rule") and the intent comment at `context-rules.ts:510-513`. Consequence: a user holding the admin passkey that is on both a `Default` rule and a spending-limited `CallContract(token)` rule will *always* be routed to the limited rule for transfers and cannot exceed the limit without passing `contextRuleIds` by hand. That may be the desired product behaviour, but it must be documented as an SDK choice and be overridable per call (it is, via `resolveContextRuleIds`, but only on some methods).

`context_rule_ids` are bound into the digest (`storage.rs:492-495`) — SDK matches (`auth-payload.ts:88-97`). `auth_contexts` are the pre-order DFS of the entry's invocation tree (`account_contract.rs:126-139`) — SDK's `buildInvocationContextTypes` walks in the same order (`context-rules.ts:87-121`) ✓.

### 4.3 `valid_until`
Ledger **sequence**, **inclusive**: rejected iff `valid_until < e.ledger().sequence()` (`storage.rs:281-285`, same at add/update `650-654`, `783-787`). SDK: `validateValidUntil` rejects `< currentLedger` ✓ (`validation.ts:141`), `listContextRules` keeps `>= latestLedger` ✓ (`context-rules.ts:425`), `connectWallet` ✓ (`wallet-ops.ts:526-530`). But `kit.rules.add`/`updateExpiration` never pass `currentLedger`, so the past check only runs on-chain.

### 4.4 Limits
`MAX_SIGNERS=15`, `MAX_POLICIES=5`, `MAX_NAME_SIZE=20` (bytes), `MAX_EXTERNAL_KEY_SIZE=256` — `mod.rs:522-528` = `constants.ts:49-58` ✓. Contract-enforced constraints the SDK does **not** pre-validate:

| Constraint | Contract | SDK |
|---|---|---|
| Canonical duplicate signers in a rule/batch (WebAuthn: same 65-byte pubkey, different credential id) | `DuplicateSigner`, `storage.rs:543-583` | none; `signersEqual` is raw-bytes |
| Threshold `1 ≤ t ≤ rule.signers.len()` at install **and** at `set_threshold` (against caller-supplied rule) | `simple_threshold.rs:358` | builder checks `t ≥ 1` only (`builders.ts:277-293`) |
| Weighted: `Σ weights` must fit u32 (`MathOverflow` 3212); per-call `threshold ≤ Σ` ordering constraint | `weighted_threshold.rs:559-567, 368-373, 431-436` | builder sums in JS Number, no u32 cap; ordering documented in client docs only |
| Spending limit only on `CallContract` rules (`OnlyCallContractAllowed` 3227) | `spending_limit.rs:385-387` | none in `rules.add`/`policies.add` |
| Spending limit enforces only `fn_name == "transfer"` with `args[2]: i128 ≥ 0`; everything else on that rule → `NotAllowed` | `spending_limit.rs:240-301` | README states it (`README.md:591`) ✓; nothing warns that `approve`/`transfer_from`/`burn` are blocked under that rule |
| History cap 1000 (main: 815) | `spending_limit.rs:158, 272-274` | not modelled |
| WebAuthn `client_data ≤ 1024`, `authenticator_data ≥ 37`, flags UP & **UV** set, BE/BS consistent | `webauthn.rs:320-347` | no pre-check; SDK requests `userVerification: "preferred"` (`webauthn-ops.ts:181`, also `85,108`) — see F10 |
| `name` may be empty | `storage.rs:425-429` | SDK rejects empty (`validation.ts:33-38`) — stricter, harmless |
| Rule count unbounded (u32) | `storage.rs:698-700` | probe cap 8 (`constants.ts:65`) — F8 |
| At least one rule must remain for the account to be usable | **no guard** (`storage.rs:843-887`) | no guard — F12 |

### 4.5 Signer identity
Registry identity is `sha256(XDR(Signer))` — raw bytes (`storage.rs:230-234, 1231-1233`); payload↔rule matching is raw `Signer` equality (`storage.rs:313-314`). Canonicalisation (`verifier.batch_canonicalize_key`, strips the credential-id suffix for WebAuthn) is used **only** to reject duplicates at add time. SDK `signersEqual`/`getSignerKey` (`signer-utils.ts:19-44`) are raw → agree with the registry and with `__check_auth`. The SDK correctly fetches the stored signer bytes from the rule before signing (`findWebAuthnSignerInRules`, `context-rules.ts:441-470`) so the payload key matches exactly. Divergence only in the duplicate check (SDK would let you *try* to add a second credential for the same P-256 key; contract rejects). Note `getCredentialIdFromSigner` treats any `External` key longer than 65 bytes as a passkey regardless of verifier address (`signer-utils.ts:10-16`) — length heuristics instead of verifier identity.

### 4.6 Spending-limit policy vs SDK transfer
`kit.transfer` builds a **direct** `token.transfer(from=account, to, amount)` host function authorised by the account (`tx-ops.ts:194-222, 396-428`), so the single auth context is `Contract{token, "transfer", [from,to,amount]}` → `CallContract(token)` rule ✓ and `args[2]` is the amount ✓. Correct. Conversely `kit.execute(token, "transfer", …)` yields context `Contract{account, "execute", …}`, which only `Default`/`CallContract(account)` rules match — **token-scoped policies are bypassed by `execute`** by construction. The SDK never states this.

### 4.7 `execute`
`mod.rs:509-512`: `require_auth()` on self, then `invoke_contract`. Any `require_auth` of the account *inside* the target is satisfied by invoker auth (the account is the direct caller), so nothing more is needed — this is how the policy setters work. Sub-invocations requiring third-party auth need their own entries. The SDK wrapper is a pass-through; the arg-encoding problem is F2.

### 4.8 `upgrade`
Handled correctly; `operator` is dead in the example (`contract.rs:90`). One gap: after upgrade the SDK's `acceptedWasmHashes` allow-list must already contain the new hash or `connectWallet` will refuse the account the user just upgraded — a product/ops note, not a parity bug.

### 4.9 Constructor
Contract: any `Vec<Signer>` (0..15, canonical-unique) + any `Map<Address,Val>` (0..5), at least one of either; the verifier for each `External` signer must be callable at deploy (canonicalisation cross-call). SDK-only restrictions: exactly one signer, must be WebAuthn on the configured verifier (`deploy-ops.ts:432-451`, `wallet-provenance.ts:131-155`); default rule must live at id 0 for the primary credential (`wallet-ops.ts:515-517`). F4.

### 4.10 `AuthPayload` / `WebAuthnSigData` / host ordering
All verified:
- `AuthPayload` → `ScMap{context_rule_ids: Vec<u32>, signers: Map<Signer,Bytes>}`, keys in byte order ✓ (`auth-payload.ts:265-290`).
- `Signer` → `ScVec[Symbol(variant), …]` ✓ (`327-340`); `Delegated` signature bytes empty ✓ (contract ignores them, `storage.rs:353-356`); nested entry root = `account.__check_auth(BytesN<32> digest)` ✓ matches `require_auth_for_args((auth_digest,))` (`storage.rs:354-355`).
- `compareScVal` (`auth-payload.ts:212-263`) vs host: cross-type by `ScValType` discriminant = host's `obj_cmp` fallback (`host.rs:1229-1241`) and `Compare<ScVal>` (`comparison.rs:375`) ✓; `Bytes`/`String`/`Symbol` as slice `Ord` ✓ (`comparison.rs:65-67, 103-110`; small symbols compare by char iterator, `symbol.rs:195-198`); `Vec` element-wise then length ✓; `Address` via derived `Ord` = discriminant then key bytes, and XDR bytes preserve that ✓ (`comparison.rs:193`). The CHANGELOG's "host-order sort" claim holds.

---

## 5. What the contract permits that the SDK has no story for

1. **Accounts with no passkey** (Ed25519-only, Delegated-only, or policy-only default rule). Constructor accepts them; `createWallet` cannot produce them and `connectWallet` cannot connect to them (F4). This is exactly the backend-agent / custodial / multisig-treasury shape.
2. **`Delegated(C…)`** — another contract (e.g. a second smart account, a DAO) as a signer. `createDelegatedSigner` rejects non-G addresses (`builders.ts:42-55`); `signWalletAddressAuthEntry`/nested entry building assumes an ed25519 account (`multi-signer-manager.ts:225, 453`).
3. **Custom verifiers on the sign path.** `createExternalSigner` registers one; `AuthDigestSigner` (`signers.ts:58-66`) is exported but consumed nowhere (grep: only `index.ts:193`); the sign loop dispatches on the closed `SelectedSigner.type` (`types.ts:654`, `multi-signer-manager.ts:246-248, 346-397`).
4. **Custom policies** — install params only as raw `xdr.ScVal`, no `readState`/`preflight`/setter plumbing; `policyTypes` maps are threaded by address on every call (`policies-ops.ts:174-231`).
5. **`CreateContract` rules** — buildable (`createCreateContractContext`) and resolvable, but nothing constructs an account-authorised deploy (`create_contract` host fn with `from_address = account`), so a "deploy-scoped session key" is unusable end-to-end.
6. **Session keys with `valid_until`** — supported at the data level; no helper to make "24h session rule for dapp X with signer S and spending limit L" a one-liner, and `connectWallet` only tolerates expiry on the rule the connecting credential lives on.
7. **Pre-flight "will this authorise?"** — `can_enforce` no longer exists, and `__check_auth` cannot be simulated externally (host forbids direct calls, `auth.rs:3048-3052`). What *is* possible: mirror `enforce` client-side from the getters (threshold vs selected signers, weight sum, `cached_total_spent + amount ≤ limit` after window cleanup) before the biometric prompt. Not done today.
8. **Reading policy state generically** — the contract has no generic getter; the SDK has three hard-coded clients and no registry keyed by policy address/WASM hash.
9. **Return values and events** of admin calls (§2).
10. **Reachability of every rule** — the contract permits unbounded, sparse rule ids; the SDK can only see ids ≤ 8 without an indexer (F8).

---

## Findings

### PAR-F1. `rules.add` and `createWallet` send an unsorted policies `ScMap` — fails for ≥2 policies depending on address order   [severity: high]
- **Where:** `src/managers/context-rule-manager.ts:95-101`; `src/kit/deploy-ops.ts:443-451` (via `buildConstructorPolicies`, `src/kit/policies-ops.ts:151-172`); contrast `src/kit/wallet-provenance.ts:106-116` which *does* sort the expected map, and `src/kit/policies-ops.ts:226-228` where `buildPoliciesScVal` sorts but is not used by either path.
- **What:** Both paths hand a JS `Map<string, ScVal>` to the generated bindings. `Spec.nativeToScVal` emits map entries in insertion order (stellar-sdk `lib/esm/contract/spec.js:707-723`); the host rejects an `ScMap` whose keys are not in host order with `Error(Object, InvalidInput) "ScMap was not sorted by key"` (`metered_map.rs:328-336`). Probe with the checked-in spec: policies `[C(ff…), C(01…)]` → `sorted per host? false` for both `add_context_rule` and `__constructor`. The demo works around it by sorting itself — with `localeCompare` (`demo/src/components/ContextRuleBuilder.tsx:661-663`), the exact comparator `context-rules.ts:263-269` warns against.
- **Why it matters:** A documented feature (`README.md:379-388`, `defaultPolicies`) fails at simulation for roughly half of all two-policy address pairs, and the failure is a host error the registry cannot decode. It also proves the SDK's sorting knowledge lives in three places (`compareScVal`, `buildPoliciesScVal`, `expectedPoliciesScVal`) and is applied inconsistently.
- **Rewrite recommendation:** One `encodePolicies(Map) → ScVal` that host-sorts, used by every path; better, never let a raw JS `Map` reach the bindings — `rules.add` should take `PolicyInstall[]` and encode itself.

### PAR-F2. `execute()` and `policies.add()` are wrapped-but-wrong as documented: `Val`-typed args must be pre-encoded `xdr.ScVal`s   [severity: high]
- **Where:** `src/kit.ts:1379-1391`; `README.md:261,265`; `src/managers/policy-manager.ts:40-52, 66-72`; `src/execute.test.ts:25,53` (mocks the wallet, so never exercises encoding).
- **What:** `target_args: Vec<Val>` and `install_param: Val` are spec type `Val`; stellar-sdk's `nativeToScVal` only passes `xdr.ScVal` through for that type and throws for strings/numbers/objects (`spec.js:629-631, 764, 733-737`). Verified: `execute(..., ["G…", 2])` → `invalid type scSpecTypeVal specified for string value`; `add_policy(... install_param: {threshold: 2})` → `Received object … did not match the provided type`. The README's `kit.execute('CTARGET...', 'set_config', [owner, threshold])` and the `PolicyManager` docstring both do exactly that.
- **Why it matters:** The two "arbitrary call" entry points — the ones a first-principles SDK exists to make ergonomic — cannot be used from the docs. Policy setters only work because `policy-clients.ts` hand-encodes.
- **Rewrite recommendation:** `execute(target, fn, args: ScVal[] | ((spec) => ScVal[]))` with an optional target spec (`Contract.spec` from RPC `getContractSpec` or a user-supplied `Spec`) so args can be given natively and typed; `policies.add(ruleId, policy: PolicyInstall)` where `PolicyInstall` carries its own encoder (see plugin interface below).

### PAR-F3. The SDK decodes zero of the 25 contract events and drops all return values   [severity: medium]
- **Where:** `src/events.ts:18-39`; `src/types.ts:457-463`; bindings spec event entries at `packages/smart-account-kit-bindings/src/index.ts:642-653` (unused).
- **What:** See §2. After `signAndSubmit(rules.add(...))` the caller does not learn the new rule id; after `signers.addPasskey` not the signer id. `kit.events` is a lifecycle emitter with a name that implies otherwise.
- **Why it matters:** Indexer freshness is a known pain point (brief), yet the one authoritative, instant source of "what just changed" — the tx result's return value and `contractEvents` — is discarded. Any app wanting to update UI after an admin op must re-poll.
- **Rewrite recommendation:** Generate `decodeEvent(xdr.ContractEvent) → SmartAccountEvent | PolicyEvent` from the spec event entries (all 11 account events are in the spec; policy events need the policy specs, which are fetchable by WASM hash). `TransactionSuccess` gets `returnValue: T` (decoded through the method's spec) and `events: DecodedEvent[]`. Rename the lifecycle emitter (`kit.lifecycle` or `kit.on(...)`).

### PAR-F4. Birth/connect model is far narrower than the contract: exactly one WebAuthn signer, rule 0, configured verifier   [severity: medium]
- **Where:** `src/kit/deploy-ops.ts:432-451`; `src/kit/wallet-provenance.ts:131-155`; `src/kit/wallet-ops.ts:515-517, 544-549`; `src/builders.ts:42-55` (`Delegated` = G-address only); `README.md:41` ("`Delegated(G-address)`").
- **What:** The contract constructor accepts any 1..15 signers of any kind plus 0..5 policies (`contract.rs:32-41`, `storage.rs:632-707`); `Delegated` is any `Address`. The SDK refuses to *create* anything but a single-passkey account and refuses to *connect* to an account not born that way, and assumes the primary passkey lives on rule id 0.
- **Why it matters:** Backend agents (Ed25519-only), treasuries (multi-signer at birth), nested accounts (`Delegated(C…)`), and accounts created by the CLI or another SDK are all unreachable. The "fail-closed" design is good security posture for the *passkey wallet* product, but it is implemented as a global assumption rather than a profile.
- **Rewrite recommendation:** Split "account client" (connect to any `SmartAccount`-conformant contract; verify code hash + live rule containing *some* signer I can sign for) from "passkey wallet profile" (the stricter birth check). Constructor args become `{signers: Signer[], policies: PolicyInstall[]}` with the passkey profile supplying its one-signer default.

### PAR-F5. Custom verifiers can be registered but never sign; `AuthDigestSigner` is dead API   [severity: medium]
- **Where:** `src/signers.ts:58-66`; `src/index.ts:193`; `src/types.ts:649-665`; `src/managers/multi-signer-manager.ts:117-125, 137-194, 246-248, 385-404`.
- **What:** Signer classification is by shape heuristics (Delegated → wallet; `External` with keyData > 65 → passkey; else Ed25519 if a local key exists), never by verifier address. `SelectedSigner.type` is a closed union. Nothing calls `signAuthDigest` on an `AuthDigestSigner`.
- **Why it matters:** The verifier abstraction is the contract's whole extensibility story (`verifiers/mod.rs:53-174`); the SDK exposes only the registration half. A 65-byte WebAuthn key without a credential-id suffix (allowed by the verifier) is also misclassified as Ed25519.
- **Rewrite recommendation:** A `Verifier` plugin keyed by verifier contract address: `{ address, keyData(x) → Bytes, canonicalize(keyData) → Bytes, sign(authDigest) → Bytes, describe(keyData) }`; the sign loop iterates `rule.signers`, looks up the plugin by `signer.values[0]`, and asks it for bytes. Delegated signers get a sibling `AddressAuthorizer` plugin (G-address keypair / wallet adapter / another `SmartAccountClient` for `Delegated(C…)`).

### PAR-F6. `Delegated(C…)` and multi-context nested auth are unsupported   [severity: medium]
- **Where:** `src/managers/multi-signer-manager.ts:414-461` (builds a `sorobanCredentialsAddress` entry with an ed25519 `accountId()` signature).
- **What:** Contract `authenticate` does `addr.require_auth_for_args((auth_digest,))` for any `Address` (`storage.rs:353-356`); a contract signer would need its own `__check_auth` entry (recursive). SDK only handles G-addresses.
- **Why it matters:** Nested smart accounts (org → sub-account) are a first-class contract feature and the reason `__check_auth` is `SelfAllowed`-reentrant in the host.
- **Rewrite recommendation:** Treat the delegated entry builder as a plugin (F5); for `C…` recurse into another `SmartAccountClient` instance's signing path with root invocation `outer.__check_auth(digest)`.

### PAR-F7. Client-side rule resolution invents precedence and can select a rule the contract will reject   [severity: medium]
- **Where:** `src/kit/context-rules.ts:510-517, 553-567`; `src/builders.ts:165-170`; `src/managers/multi-signer-manager.ts:328-330, 346-404`.
- **What:** (a) "prefer scoped over Default" is SDK policy presented as contract semantics (§4.2). (b) The subset branch picks a no-policy rule whose signers ⊂ selected signers; every selected signer still signs the entry, so any extra signer trips `UnauthorizedSigner` (3016, `storage.rs:500-503`) unless it belongs to another selected rule in the same entry. (c) `getAvailableSigners` only reads `Default` rules (`multi-signer-manager.ts:100-115`), so signers that exist only on scoped rules are never offered.
- **Why it matters:** The digest binds `context_rule_ids`, so a wrong pick is a wasted biometric prompt plus an opaque 3002/3016 at submit.
- **Rewrite recommendation:** Make resolution explicit and pure: `planAuth(entry, rules, availableSigners) → { contextRuleIds, signersToUse } | Ambiguity`; prune `signersToUse` to ∪(selected rules' signers); surface ambiguity to the caller with the candidate list instead of a heuristic; document "Default is a wildcard, not a fallback".

### PAR-F8. Rule discovery is capped by an invented constant while `get_context_rules_count` (mis-documented) gives an exact stop condition   [severity: medium]
- **Where:** `src/constants.ts:64-68`; `src/kit/context-rules.ts:364-383`; `src/managers/context-rule-manager.ts:104-115`; `README.md:370`.
- **What:** Contract: `Count` = number of currently stored rules (inc. expired), decremented on remove (`storage.rs:212-214, 704, 882-884`); `NextId` is the monotonic one. SDK docs say `count()` is "total rules ever created… monotonic". The probe stops at id 8 / 3 misses, so an account that has rotated its admin rule a few times becomes invisible without Mercury.
- **Why it matters:** The brief calls indexer dependence the known pain point. Probing `id = 0, 1, …` until `found == count()` is complete whenever it terminates (ids are dense-ish in practice; a hard ceiling can stay as a safety valve). This is a strictly better on-chain fallback and needs no new contract surface.
- **Rewrite recommendation:** `listRules()`: read `count`, probe upward until `found == count` (bounded), then optionally reconcile with the indexer. Fix the docs.

### PAR-F9. Error identity by message string, not code   [severity: medium]
- **Where:** `src/contract-errors.ts:186-215`; `src/contract-errors.test.ts:89-101`.
- **What:** See §3. Works for the three codes that happen to be pinned; silently returns an untyped `Error` for the other 13 SmartAccount codes and all policy/verifier codes if they ever flow through a `.result` read.
- **Why it matters:** Fragile coupling to OZ doc-comment wording; a docstring edit upstream breaks typed errors with no test failure.
- **Rewrite recommendation:** Never read `AssembledTransaction.result` for error mapping. Parse the simulation/submission diagnostic for `Error(Contract, #N)` (already done in `decodeContractError`) and generate the registry (code → name → family → doc) from the spec's `errorCases()` at build time, with the account spec plus the five policy/verifier specs. Also add typed wrappers for the host error classes that this contract family actually produces (`Auth`, `Crypto`, `Object/InvalidInput`, budget).

### PAR-F10. WebAuthn assertions are requested with `userVerification: "preferred"` but the verifier requires UV   [severity: medium]
- **Where:** `src/kit/webauthn-ops.ts:181` (assertion), `:85,108` (registration/discovery); contract `webauthn.rs:217-221, 346`.
- **What:** `validate_user_verified_bit_set` panics with `VerifiedBitNotSet` (3117) when the UV flag is clear. "preferred" lets an authenticator skip UV (security keys without PIN, some platform authenticators under policy), producing a signature the contract will reject after the user already went through the ceremony. No client-side check of `authenticator_data[32] & 0x04` before submission either.
- **Why it matters:** Correctness/DX; the failure is post-prompt and surfaces as 3117 only if the diagnostic makes it back.
- **Rewrite recommendation:** `userVerification: "required"` on assertions; validate flags, `client_data.length ≤ 1024`, `authenticator_data.length ≥ 37` locally and fail fast with a typed error mirroring 3115-3118.

### PAR-F11. The SDK depends on example-crate-only entry points without saying so   [severity: low]
- **Where:** `src/managers/signer-manager.ts:154-165` (`batch_add_signer`), `src/kit.ts:1406-1420` (`upgrade`), constructor shape in `deploy-ops.ts:448-452`; README/docs contain no mention that these are not part of `SmartAccount` (`README.md:336`, `docs/migration-v0.4.0.md:198`).
- **What:** `batch_add_signer`, `upgrade(new_wasm_hash, operator)`, and `__constructor(signers, policies)` exist only in `multisig-account-example` (`contract.rs:32-47, 88-94`). Any other `SmartAccount` implementation (a custom account from the OZ README recipe) lacks them.
- **Why it matters:** Today it is coherent because `acceptedWasmHashes` are all example builds; the moment a second WASM profile is accepted, `addBatch`/`upgrade`/birth verification silently stop applying.
- **Rewrite recommendation:** Declare a "WASM profile" per accepted hash: `{ trait: SmartAccount, extras: ['batch_add_signer','upgrade'], constructor: (signers, policies) }`, generated from each WASM's spec; feature-gate wrappers on the profile.

### PAR-F12. No guard against bricking operations the contract allows   [severity: low]
- **Where:** `src/managers/context-rule-manager.ts:177-213`; contract `storage.rs:843-887` (no last-rule check), `782-811` (can expire the last rule), `990-1007` (last signer removable if a policy remains).
- **What:** Removing the last rule, expiring it, or reducing a threshold rule's signers below its threshold (`simple_threshold.rs:7-46`) all succeed on-chain and lock the account. The SDK pre-validates only the numeric limits.
- **Rewrite recommendation:** A `simulateLockout(plannedOp, rules, policyStates)` pre-check (pure, uses §5.7 mirror) with an explicit `force` escape hatch.

### PAR-F13. Stale/incorrect contract-semantics documentation   [severity: low]
- **Where:** `README.md:370, 404-406`; `src/managers/context-rule-manager.ts:105-107`; `src/builders.ts:168-169`; `src/policy-clients.ts` (no note that `period_ledgers` is immutable); README nowhere states that `execute` bypasses token-scoped policies (§4.6) or that a spending-limit rule blocks every non-`transfer` token call.
- **Rewrite recommendation:** Derive the "Concepts" section from the contract's own doc comments where possible; keep a short hand-written "semantics the SDK relies on" list with `storage.rs` line references and a CI check that those lines still say what we think (a golden-snippet test against the pinned submodule).

### PAR-F14. Verifier `canonicalize_key` unused for duplicate pre-check   [severity: nit]
- **Where:** `src/signer-utils.ts:19-44`; contract `storage.rs:543-583`.
- **What:** SDK could compute WebAuthn canonical keys locally (first 65 bytes) or call `batch_canonicalize_key` by simulation to reject a duplicate before the prompt/tx.

---

## First-principles recommendations for the rewrite

**1. Parity is a build artefact, not a table.** Pin the OZ commit as a submodule (or vendor the six optimized WASMs by hash) and generate, in one `pnpm gen` step: (a) TS bindings for the account **and** each policy and verifier (`stellar contract bindings typescript` per WASM — today only the account is generated); (b) `errors.ts` from every spec's `errorCases()` — code, variant, family, doc; (c) `events.ts` decoders from every spec's `ScSpecEntryEventV0` (topic-prefix → typed struct, with a `SignerRegistry` fold so `SignerAdded{signer_id}` can be joined to a `Signer`); (d) `limits.ts` from a tiny Rust→JSON exporter or a regex over `mod.rs` constants, with a CI diff. `scripts/bindings/verify.sh` already does (a) for one contract; extend it. Delete `CONTRACT_ERROR_REGISTRY`, `contract-types.ts`, the hand-written encoders in `policies-ops.ts`, and the `signer_ids` hydration shim.

**2. Mirror the Rust traits as plugin interfaces.**
```ts
interface Verifier {                       // ⇔ stellar_accounts::verifiers::Verifier
  readonly address: string;
  canonicalize(keyData: Uint8Array): Uint8Array;        // local mirror of canonicalize_key
  describe(keyData: Uint8Array): SignerDescription;     // replaces length heuristics
  sign?(authDigest: Uint8Array, keyData: Uint8Array): Promise<Uint8Array>; // sig_data bytes
}
interface Policy<Params, State> {          // ⇔ stellar_accounts::policies::Policy
  readonly address: string;
  encodeInstall(params: Params): xdr.ScVal;
  readState(rule: ContextRule, account: string): Promise<State>;
  preflight(ctx: Context, signers: Signer[], rule: ContextRule, state: State): Verdict; // mirror of enforce
  setters: Record<string, (...args) => { fn: string; args: xdr.ScVal[] }>;             // routed via execute
  decodeEvent?(ev: xdr.ContractEvent): PolicyEvent | null;
}
interface Authorizer {                     // Delegated(Address) — G keypair, wallet adapter, or nested SmartAccountClient
  canAuthorize(address: string): boolean;
  buildEntry(address: string, authDigest: Uint8Array, expiration: number): Promise<xdr.SorobanAuthorizationEntry>;
}
```
`kit.verifiers.register(...)`, `kit.policies.register(...)`, `kit.authorizers.register(...)`; ship WebAuthn/Ed25519 verifiers, the three example policies, and the G-address/wallet-adapter authorizers as the defaults. The signing loop becomes: for each account entry → `planAuth` (F7) → for each rule signer → look up plugin by `signer.values[0]` (verifier address) or by `Delegated` address → collect bytes / nested entries.

**3. Model the account, not the passkey wallet, at the core.** `SmartAccountClient` = bindings + `planAuth` + sign loop + typed results/events; it connects to any accepted WASM hash and any rule shape. `PasskeyWallet` = the fail-closed birth/ownership profile on top. `createAccount({signers, policies})` is general; `createPasskeyWallet(appName, user)` is the one-liner.

**4. Encode at the boundary, once.** Public APIs take typed values (`Signer`, `PolicyInstall`, `ContextRuleType`) and the SDK produces host-sorted `ScVal`s in exactly one module (`encode.ts` around `compareScVal`). No public method accepts `Map<string, unknown>` or `unknown` where an `ScVal` is required; `execute` takes `ScVal[]` or a `(spec) => ScVal[]` thunk.

**5. Return what the chain returns.** `TransactionSuccess<T> = { hash, ledger, returnValue: T, events: DecodedEvent[] }`. `rules.add` resolves to the new `ContextRule`; `signers.add` to `signer_id`.

**6. Replace the probe with the contract's counter.** F8. Keep the indexer for reverse lookup (credential → contracts), which the chain genuinely cannot answer.

**7. Pre-flight everything that is pure.** Limits (incl. canonical dupes, threshold ≤ signer count, u32 weight sums, `OnlyCallContract` for spending limits), lockout simulation (F12), policy `preflight` mirrors (§5.7), WebAuthn flag/length checks (F10) — all before a biometric prompt or a relayer round-trip.

**8. Profiles for example-only surface.** F11: `batch_add_signer`, `upgrade`, constructor shape are attributes of an accepted WASM hash, discovered from its spec, not assumed.

**9. Track OZ `main` mechanically.** The only pending behavioural delta is `MAX_HISTORY_ENTRIES 1000 → 815`; with (1) in place that is a one-line regen. Keep a `CONTRACTS_COMMIT` and a CI job that diffs `packages/accounts` + examples between the pinned and latest commits and fails on any change to `#[contracttrait]`, `#[contracterror]`, `#[contractevent]`, or `pub const` lines.

## Open questions for Tyler

1. Is single-passkey-at-birth a *product* invariant you want to keep for the wallet profile, or an accident of the deployer/address-derivation design (address = f(credentialId))? Multi-signer or Ed25519-only birth changes the address derivation story.
2. "Prefer scoped over Default" (F7): intended UX, or should the SDK refuse to auto-pick when both a policied scoped rule and an unpolicied Default rule match and let the app decide (e.g. "send within limit" vs "admin override")?
3. Will you accept a second WASM profile (custom account implementing `SmartAccount` without `batch_add_signer`/`upgrade`) in `acceptedWasmHashes`? That decides whether F11 is a doc fix or an architecture requirement.
4. Do you want the SDK to ship the OZ contracts as a submodule so bindings/errors/events/limits can be regenerated for all six WASMs in CI (recommendation 1), or keep pulling the account spec from the network only?
5. `Delegated(C…)`/nested accounts: in scope for the rewrite, or explicitly out (it needs recursive `__check_auth` entry building and a second client instance)?
6. Should `kit.events` be renamed (lifecycle) to free the name for decoded contract events, or would you rather expose decoded events only on `TransactionSuccess` and a `watch()` stream?
