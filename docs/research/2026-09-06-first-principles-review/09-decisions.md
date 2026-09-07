# Decisions and open questions for Tyler

> Every "open question for Tyler" from the six area reviews, deduplicated and grouped. Each entry gives the context in a sentence or two, the options, a recommendation, and what it unblocks in [08-rewrite-blueprint.md](08-rewrite-blueprint.md). The first five gate everything else. Items in §F are facts nobody could verify from the sandbox and only you (or a live network) can settle.

## A. Trust and security model

**D1. Is the RPC meant to be trusted for *signing*?** Today every path signs whatever `simulateTransaction` returns (SEC-F1). If yes, that must be the headline of `SECURITY.md`; if no, intent-bound signing is the first item of the rewrite. *Options:* (a) trust the RPC and document it; (b) intent-bound `sign(entry, intent)` with byte-equal root invocation, no sub-invocations unless the intent allows, and a loudly named `signUnchecked` escape hatch. *Recommendation:* (b). It is ~40 lines, the deploy path already does it, and passkeys have no wallet UI in the loop so the SDK is the last line of defence. *Unblocks:* `auth/intent.ts`, `pipeline/authorize.ts`.

**D2. May the address derivation change to commit to the constructor?** `salt = sha256(credentialId)` lets anyone who learns a credential ID first squat the derived address; ~400 lines of provenance verification, the "occupied" state, and the relayer's constructor-shape check compensate (SEC-F2, SEC-F10, SVC-F6). *Options:* (a) keep the salt and keep the compensating layer (as a pure pipeline); (b) `salt = sha256(wasmHash ‖ xdr(constructorArgs))` — squatting requires deploying the victim's exact wallet; verification reduces to recomputing the address from the birth tx; the address is no longer a function of the credential ID alone. *Recommendation:* (b) for 1.0. v0.7.0 already requires a discovery source for fresh-device recovery, so nothing user-visible is lost; the one real cost is that two apps installing different constructor policies for the same passkey get different wallets, which is arguably correct. *Needs from you:* are there mainnet wallets whose recovery depends on the current derivation? *Unblocks:* `deploy/address.ts`, deletion of most of `verify/birth.ts`.

**D3. Birth verification: mandatory, or a `strict` mode over live-state verification?** v0.7.0 requires a verified `CreateContractV2` transaction on every fresh-device connect, which is why the indexer is required (SVC-F10/F11, SVC open Q1). Under D2(b) the address itself commits to the birth, and full live rule enumeration from ledger entries (SVC-F12) reveals every current signer and policy. *Options:* (a) strict only; (b) `mode: "live"` default (accepted code + live unexpired rule containing exactly this passkey + fresh assertion + present current policies) with `mode: "strict"` requiring the tx-hash proof. *Recommendation:* (b) if D2(b) is accepted, (a) otherwise. The residual threat strict mode addresses — a wallet at the derived address constructed by a malicious relayer whose extra control was later removed — is closed by D2(b). *Unblocks:* `passkey/wallet.ts` `connect()`, the `Discovery` interface being optional.

**D4. Is backend / agent (non-passkey) use a v1 requirement?** Connection is passkey-only today (API-F1, PAR-F4); the contract's headline use cases (backend automation, AI agents with constrained access) are unreachable. *Recommendation:* yes — model the general account at the core and make the fail-closed passkey wallet a profile. If yes, the analogue of ownership verification for non-passkey signers is "the signer's key is on a live, unexpired rule" (no birth check; the caller supplies the address). *Unblocks:* `SmartAccount.at(cfg, address, signers)`, the `/passkey` split, examples 04–05.

**D5. Should `send()` auto-resolve rule ids at all?** The contract lets the signer choose its rule (`context_rule_ids` are digest-bound), so a signer on both a policy-free `Default` rule and a policy-bearing scoped rule can always pick the weak one; the SDK's "prefer scoped over Default" only guards against *accidental* downgrade and is documented as contract behaviour, which it isn't (SEC-F12, PAR-F7, API open Q2). *Options:* (a) keep the heuristic; (b) auto only when exactly one candidate rule contains a usable signer, otherwise throw `RULE_AMBIGUOUS` with the plan attached and require `ruleIds`; (c) always explicit. *Recommendation:* (b), plus a prominent doc note that policies constrain a signer only when it has no policy-free rule for the same scope. *Unblocks:* `auth/plan.ts`.

**D6. Should a hosted relayer exist on mainnet, and should the repo ship a Cloudflare worker at all?** The OZ Channels model with per-IP minted keys is testnet-only; mainnet "proxies" are necessarily the integrator's own backend with their own key (SVC-F3, SVC open Q4). *Options:* (a) keep the worker, add a static-key path and per-wallet budgets; (b) ship a typed relay protocol + a ~60-line reference sponsor endpoint (example 06) and treat the worker as one deployment of it. *Recommendation:* (b), keeping the SDF testnet deployment as an instance. Also: should the sponsor enforce a per-wallet stroop budget in addition to per-IP (SEC-F20)? *Recommendation:* yes — wallets are the abuse unit.

**D7. WebAuthn hygiene: `userVerification: "required"` and `residentKey: "required"`?** The deployed verifier hard-requires UV; the SDK asks for "preferred" everywhere, so a PIN-less security key becomes a sole signer that can never sign (SEC-F4, PAR-F10, TEST-F3). Non-resident keys can never be recovered with `connect({prompt: true})`. *Recommendation:* both "required", rejecting at registration rather than at first signature; make non-resident an explicit opt-in with a warning. *Needs from you:* are there real users on non-UV authenticators today?

## B. Product scope and contract surface

**D8. Non-passkey and multi-signer births.** The contract constructor accepts any 1–15 signers of any kind plus 0–5 policies; the SDK and the relayer proxy hard-code exactly one WebAuthn signer (PAR-F4, SVC-F6, PAR open Q1). *Recommendation:* `SmartAccount.deployPayload({ signers, policies })` as the general primitive; `createPasskeyWallet(user)` as the one-liner; the sponsor validates WASM/deployer/fee, not shape. Note this interacts with D2: a multi-signer birth changes the derived address under either salt policy.

**D9. `Delegated(C…)` — nested smart accounts — in 1.0?** A contract signer needs a recursive `__check_auth` entry built by a second `SmartAccount` instance (PAR-F6, ARCH open Q3). *Recommendation:* design the `Signer` interface for it now (`DelegatedSigner.fromAccount`), ship it in 1.1 unless a concrete consumer (org → sub-account) exists for 1.0.

**D10. CAP-71 `AddressWithDelegates` entries.** stellar-sdk 16 can build them; the SDK rejects them in four places; OZ evaluated and rejected `delegate_account_auth` for the account (Slack, 2026-09-04). *Recommendation:* refuse with a typed `NOT_SUPPORTED` error and revisit only if the contract adopts it.

**D11. A second WASM profile / custom accounts.** `__constructor(signers, policies)`, `batch_add_signer` and `upgrade` are example-crate-only; any custom `SmartAccount` implementation lacks them (PAR-F11). *Options:* (a) document that only the example build is supported; (b) generate a per-hash profile and feature-gate wrappers. *Recommendation:* (b) — it falls out of generating bindings per WASM and costs little. *Needs from you:* is there any intent to accept a non-example account WASM in `acceptedWasmHashes`?

**D12. Delete the published `smart-account-kit-bindings` package?** It re-exports all of stellar-sdk, mutates `window.Buffer` at import, freezes generated types as public API, and needs ~470 lines of shell (ARCH-F16, TEST-F17, SVC-F16). *Recommendation:* yes — vendor the generated spec into `src/core/generated/` at build time; publish nothing separately. *Needs from you:* does anyone outside this repo consume `smart-account-kit-bindings`?

**D13. Ship the OZ contracts as a submodule (or the six WASMs by hash) and generate bindings/errors/events/limits for all six?** (PAR rec 1, PAR open Q4.) *Recommendation:* yes; it is what turns parity from a hand-maintained table into a build step and makes the conformance suite possible.

**D14. ESM-only, `Uint8Array` in public types, no `Buffer`?** (TEST open Q6, ARCH-F17/F19.) *Recommendation:* yes to all three; add the `default` export condition so `require(esm)` works on Node ≥22; document the Vite `buffer` note for consumers instead of shipping a polyfill side effect.

**D15. Should the SDK own the deployed policy addresses?** `policy.threshold(2)` with no address argument assumes the network's canonical threshold contract — a soft endorsement of specific deployments (API open Q3). *Recommendation:* yes, via the generated `networks.*` manifest, with the address always overridable; the manifest already records provenance (upstream commit, upload/deploy tx hashes).

## C. Infrastructure and distribution

**D16. Discovery: no default indexer, a minimal two-route spec, and the Mercury relationship.** Today every SDK instance on a known network sends users' credential IDs to Mercury unless the integrator opts out; the schema-2 contract is over-specified and mainnet doesn't serve it (SVC-F10/F11/F13/F14, SVC open Q3). *Recommendation:* no default URL (privacy); publish the two-route spec and a ~200-line reference implementation; keep `mercuryDiscovery` as an adapter if Mercury will serve the two routes. *Needs from you:* is Mercury willing, and does SDF want to run the reference service?

**D17. Who owns sessions — the SDK or the app?** The credential store today doubles as pending-deployment queue, verified-birth cache and session store, with a `sync` pass on every init; `credentials.deploy()` doesn't save a session while `createWallet()` does (API-F12, ARCH-F14, ARCH open Q2, API open Q5). *Options:* (a) SDK owns a state machine; (b) `connect()`/`create()` return values and the passkey profile offers `saveSession`/`restore` over a 3-method `KeyValueStorage`; pending deployments are a returned `DeployPayload` the app may persist and retry. *Recommendation:* (b).

**D18. Is a local-network container acceptable in PR CI?** The WASM-in-the-loop conformance suite is the only test that proves the SDK's bytes are what the contract verifies; it needs `stellar/quickstart` or `stellar-cli`'s local network (~60–90 s cached) (TEST open Q5, SVC open Q7). *Recommendation:* yes, as a merge gate; nightly-only if org policy forbids Docker in PR runners.

**D19. Release provenance and ownership.** Releases today are a laptop script that never commits or tags and publishes with `--no-git-checks`; no npm provenance (TEST-F16, TEST open Q8). *Recommendation:* tag-triggered workflow, `npm publish --provenance` under OIDC trusted publishing, Changesets for versions. *Needs from you:* org policy on who may cut a release, and whether the `stellar` npm scope should be used for 1.0.

**D20. Upstream asks.** (a) Would you accept upstreaming `compareScVal` into js-stellar-sdk so `Spec.nativeToScVal` sorts `Map` inputs in host order (ARCH-F20, ARCH open Q7)? (b) Should the P27 contract revision be asked for a rule-id enumerator or `next_id` getter (ARCH open Q1, SVC open Q5)? With ledger-entry enumeration (SVC-F12) the SDK no longer *needs* it, but a getter would make the read portable to non-RPC clients. *Recommendation:* file both; neither blocks the rewrite.

## D. Product stance the rewrite will encode unless you say otherwise

These are not questions so much as defaults the blueprint assumes; flag any you disagree with.

- The contract's nouns replace the SDK's ("wallet" → smart account; "credential" confined to the passkey module).
- Throw typed errors everywhere; no result unions; no `console.*` in library code.
- Root entry is isomorphic; browser code is behind `/passkey`; Node conveniences behind `/node`; the StellarWalletsKit adapter behind `/wallets` against a local interface (no jsr dependency).
- The credential store, event emitter, `fundWallet`, UI string formatters, `indexer/demo`, the browser audit shell scripts, `sync-version.js`/`src/version.ts`, and the bespoke publish scripts are deleted.
- `rules.list()` reads ledger entries and is exact; `count()` returns `{ active, nextId }`; the indexer is never consulted for signing.
- `send()` returns `{ hash, ledger, returnValue, events }` with all 25 contract events decodable.
- Signature lifetime defaults to a short window and is hard-clamped; an entry that already carries signatures keeps its expiration.
- The shared deployer is rejected as a signer at the type level.
- `execute` bypassing token-scoped rules, `Default` being a wildcard not a fallback, and spending-limit rules blocking every non-`transfer` token call are stated plainly in the policies guide.

## E. Questions about how much of the current product to keep

- **The demo.** Becomes `apps/console/` on the new API; the rule builder and signer picker are the only multi-signer UX anywhere and are worth keeping as the multisig example once their SDK workarounds disappear (API open Q6, SVC-F17/F18). Agree?
- **The custom-`deployerSecret` route** (signed-envelope deploy, `relayer.sendXdr`, `signFeePayer`) roughly doubles `deploy-ops.ts` and `tx-ops.ts`; under the `Sponsor` interface it becomes `keypairSponsor` and the `envelope` relay kind becomes optional (ARCH open Q5, SVC-F4). Keep the envelope route in the protocol?
- **Pending-deployment retry after reload.** Dropping the stored state machine (D17) means the app must persist the returned `DeployPayload` if it wants retry-after-reload. Acceptable?

## F. Facts that could not be verified offline

1. **Host `auth_contexts` ordering for nested invocation trees.** The SDK assumes pre-order DFS (`buildInvocationContextTypes`); the parity review confirmed this against `account_contract.rs::invocation_tree_to_auth_contexts` in `rs-soroban-env@main`, but no test exercises a mixed-rule-id nested tree end-to-end. The conformance suite should include one (SEC open Q1).
2. **Outer vs. inner hash for fee-bumped deploys.** Which hash does the OZ channels plugin return, and which does Mercury store in `creation_transaction_hash`? A mismatch makes a custom-deployer wallet unrecoverable on a fresh device (SEC-F19). Accept either and normalise to inner.
3. **Is the deployed relayer proxy running code from before `f190326` (2026-08-03)?** If the demo's sponsored path works in production today, the deployed worker predates the CORS change; if it doesn't, SVC-F1 is why (SVC open Q2).
4. **Were the digest golden vectors ever cross-checked against Rust?** Both `signers.test.ts` and `utils.test.ts` vectors appear to be captured from TypeScript output (TEST-F3d, TEST open Q3). They should be regenerated from the Rust side before the rewrite locks them in.
5. **Has anyone other than you run `scripts/browser-full-e2e-audit.sh` successfully?** (TEST open Q7.) The answer decides whether the Playwright rewrite is worth doing or the browser E2E should be dropped in favour of the WASM-in-the-loop suite.
6. **Real users on non-UV authenticators** (D7) and **mainnet wallets depending on the current address derivation** (D2).
