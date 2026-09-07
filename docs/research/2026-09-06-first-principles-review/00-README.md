# smart-account-kit — first-principles review (2026-09-06)

A research findings collection for `stellar/smart-account-kit`, produced at Tyler's request: analyze the SDK for code smells, security concerns, simplicity and completeness **as if rewriting from first principles**, with no regard for legacy or backwards compatibility, toward a world-class SDK that is secure, readable, simple, low-code/high-value, and exposes everything the underlying OpenZeppelin contracts permit.

## Documents

| # | File | What it is | Read when |
|---|---|---|---|
| 01 | [01-executive-summary.md](01-executive-summary.md) | The verdict, the numbers, the ten findings that matter most, cross-cutting themes, what to keep, the shape of the rewrite, quick fixes for `main` | First. ~10 minutes. |
| 09 | [09-decisions.md](09-decisions.md) | Twenty decisions only the author can make, each with options and a recommendation; plus facts that could not be verified offline | Second — the blueprint depends on these |
| 08 | [08-rewrite-blueprint.md](08-rewrite-blueprint.md) | The reconciled design: principles, full public API in TypeScript, module layout with LOC budget, trust model, contract-parity-as-build-step, service topology, test strategy, build order | Third — this is what gets implemented |
| 02 | [02-security.md](02-security.md) | Security audit of every trust-critical path, cross-checked against the contract and stellar-sdk internals; 21 findings + a "Checked and OK" list for audit prep | Before touching `auth/`, `verify/`, `deploy/`, `pipeline/` |
| 03 | [03-api-and-dx.md](03-api-and-dx.md) | Public surface inventory, config, vocabulary, error model, the five signing pipelines, policies, discovery, docs — with a proposed API and quick start | Before designing the public API |
| 04 | [04-architecture.md](04-architecture.md) | Dependency graph, the god object, duplication, dead code, state, stellar-sdk re-implementation, browser/Node coupling, types — with a module layout | Before laying out `src/` |
| 05 | [05-contract-parity.md](05-contract-parity.md) | Entry-point / event / error matrices against the Rust source; semantic checks (matching, precedence, limits, identity, spending limit, execute, constructor, host ordering); what the contract permits that the SDK has no story for | Before writing `gen`, `account/`, `policies/` |
| 06 | [06-tests-and-tooling.md](06-tests-and-tooling.md) | Test inventory and measured coverage, mutation check, E2E scripts, CI, packaging, dependencies, monorepo shape — with a test strategy and delete list | Before setting up `pnpm check` and CI |
| 07 | [07-services.md](07-services.md) | Relayer proxy threat model and bugs, SDK↔relayer protocol, indexer contract critique and the ledger-entry alternative, bindings package, the demo as product, deployment artefacts, service docs — with a topology and `examples/` plan | Before touching `relayer-proxy/`, `indexer/`, `packages/`, `demo/` |
| 10 | [10-findings-register.md](10-findings-register.md) | All 113 findings in one table, the 17 independently-confirmed clusters, and the "checked and OK" list | For tracking implementation |
| 11 | [11-verification-report.md](11-verification-report.md) | Independent spot-check of 22 citations and re-run of the empirical probes after synthesis (20 confirmed, 2 partially — corrections applied) | To calibrate trust in the citations |

Finding IDs are `<AREA>-F<n>` (SEC, API, ARCH, PAR, TEST, SVC) and are stable across the collection. Decision IDs are `D<n>`.

## Scope and method

**Reviewed:** `stellar/smart-account-kit` at `main@1a0c0eb` (v0.7.0 unreleased; the archived `kalepail/smart-account-kit` was checked and is a strict ancestor) — `src/`, `packages/smart-account-kit-bindings`, `relayer-proxy/`, `indexer/`, `demo/`, `scripts/`, `docs/`, CI and packaging. Cross-checked against OpenZeppelin `stellar-contracts@1e513890` (the commit the deployed Protocol 27 artefacts were built from — account trait and storage, three policies, two verifiers, and the six deployed example crates) and against OZ `main@6ea3075` (2026-09-04; only delta in scope: `MAX_HISTORY_ENTRIES 1000 → 815`). Where a claim depended on host behaviour, the relevant `rs-soroban-env` source (`compare.rs`, `comparison.rs`, `metered_map.rs`, `account_contract.rs`) was fetched and read. Where a claim depended on stellar-sdk behaviour, the installed `@stellar/stellar-sdk@16.0.1` was read.

**Context used:** the repo's own README, SECURITY, CHANGELOG, migration and deployment docs; Tyler's earlier critical review of OZ's smart-account documentation; the passkey-kit vs smart-account-kit comparison; the March 2026 OZ/SDF smart-account SDK scoping notes; the September 2026 OZ note on CAP-71.

**Six parallel reviews**, each reading its area's source in full (coverage stated at the top of every doc), running the suite (414/414 green, `tsc` clean), and executing probes where a claim could be tested rather than inferred: the unsorted-`ScMap` encoding, the `CreateContract` XDR accessor failure, the attestation-key fallback, the constructor policy ordering, the relayer preflight response, the strkey-vs-host order divergence, the `execute`/`add_policy` encoding errors, v8 coverage and `publint` on the packed tarball. During synthesis the top claims were spot-checked again against source (`tx-ops.ts`, `deploy-ops.ts`, `utils.ts`, `context-rules.ts`, `context-rule-manager.ts`, `webauthn-ops.ts`, `relayer-proxy/src/index.ts`, `relayer.ts`, and the contract's `storage.rs` for the storage-key layout and `Count` semantics).

**Not done:** no network access to the deployed relayer, Mercury, or public testnet from the sandbox (so findings about the *deployed* services are about the code as committed); no execution against a real `__check_auth` (which is itself finding TEST-F3); the jsr-only devDependency could not be installed (finding TEST-F14). The repo was not modified.

## How to use this

1. Read 01, then 09. Answer the decisions in 09 §A — D1 through D5 gate the rest.
2. Ship the quick fixes in 01 §8 on `main` regardless; each is verified and small.
3. Treat 08 as the implementation spec, amended by your answers. The build order in 08 §8 keeps every step shippable.
4. Use 10 as the tracking list; each row links to the full finding with `file:line` evidence and a rewrite recommendation.
