# Smart Account Kit Migration to `stellar-contracts` v0.7.0-rc.2

> **Historical migration record.** The hashes and addresses below describe the v0.7.0-rc.2 testnet migration and are not the current deployment defaults. For the current Protocol 27 testnet and mainnet artifacts, use [`deployments-protocol-27-2026-07-09.md`](deployments-protocol-27-2026-07-09.md).

## Historical Scope

At the time of this migration, the repository targeted the regenerated smart-account contract surface from the following uploaded testnet WASM set:

- Smart account WASM hash: `3e51f5b222dec74650f0b33367acb42a41ce497f72639230463070e666abba2c`
- WebAuthn verifier WASM hash: `d84af9e7c31afece287fee8276ef7d6a64b236d596c043594c003e0f4032d1c7`
- Ed25519 verifier WASM hash: `e88b7989f8c5e69d6a72cda8419844ef2753ab249fef422f31436c5c32e28623`
- Threshold policy WASM hash: `5c87cedc0e485152a084c4b5435bdec88e41304a4316e82e37a84910715639f6`
- Spending-limit policy WASM hash: `eca96954a8e76e366e74fbc95eced11666c939e130a5cc302b8363622e931018`
- WebAuthn verifier: `CATPTBRWVMH5ZCIKO5HN2F4FMPXVZEXC56RKGHRXCM7EEZGGXK7PICEH`
- Ed25519 verifier: `CAIKK32K3BZJYTWVTXHZFPIEEDBR6YCVTGPABH4UQUQ4XFA3OLYXG27G`
- Threshold policy: `CDDQLFG7CV74QHWPSP6NZIPNBR2PPCMTUVYCJF4P3ONDYHODRFGR7LWC`
- Spending-limit policy: `CBYLPYZGLQ6JVY2IQ5P23QLQPR3KAMMKMZLNWG6RUUKJDNYGPLVHK7U4`

There is intentionally no checked-in smart-account contract ID in the default config. Smart-account deployment is parameterized and requires constructor args for `signers` and `policies`, so the repo defaults to the uploaded smart-account WASM hash.

This is a clean-cut migration. The SDK no longer preserves the legacy `Signatures` tuple flow or the removed `get_context_rules(...)` contract method.

## Implemented Changes

### Generated bindings

- Regenerated `packages/smart-account-kit-bindings` from the uploaded smart-account WASM hash.
- Switched the SDK to the generated `AuthPayload`, `get_context_rules_count`, `get_signer_id`, `get_policy_id`, `add_signer -> u32`, and `add_policy -> u32` contract surface.

### Signing flow

- Replaced the old signature tuple encoding with explicit `AuthPayload` encoding.
- Bound `context_rule_ids` into the signed digest:
  - `auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())`
- Added shared helpers for:
  - `AuthPayload` read/write
  - WebAuthn signature byte encoding
  - context-rule resolution from auth invocations

### Rule discovery

- Replaced `get_context_rules(type)` usage with SDK-side enumeration over:
  - `get_context_rules_count()`
  - `get_context_rule(id)`
- Added `kit.rules.list()` for listing all active rules.
- Kept `kit.rules.getAll(contextType)` as a filtered SDK helper that returns an array directly.

### Signer and policy APIs

- Updated signer removal to resolve the signer ID from the current rule and remove by ID.
- Updated policy removal to resolve the policy ID from the current rule and remove by ID.
- Updated add/remove manager typings to reflect `add_signer` and `add_policy` returning IDs.

### Multi-signer flow

- Updated the multi-signer execution flow to write `AuthPayload` instead of the legacy tuple wrapper.
- Delegated signer auth entries now sign the bound `auth_digest`, not the raw `signature_payload`.
- Consolidated multi-signer transfer and generic operation signing onto one shared manager-owned execution path so the SDK no longer carries parallel implementations of the same auth assembly logic.

### Repo/docs/demo

- Refreshed `demo/.env.example` to the supplied testnet contract hashes and addresses.
- Updated README examples for:
  - `AuthPayload`
  - `kit.rules.list()`
  - direct `getAll(...)` array return
  - ID-backed signer/policy removal

## State at Migration Completion

At migration completion, the SDK matched that regenerated contract surface. The signing flow used `AuthPayload`, and indexer-backed discovery supplied active rule IDs. Some raw contract methods still remained on `kit.wallet` at that time. Version `0.4.0` later added wrappers for every entry point and a bounded on-chain rule probe.

Any future cleanup should be treated as normal product work rather than migration debt.
