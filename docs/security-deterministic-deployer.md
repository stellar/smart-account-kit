# Deterministic deployer security model

This document defines the shared deployer controls and required integration rules.

## Scope and status

The shared deterministic deployer uses a published seed.
This design makes wallet addresses reproducible from a credential-derived salt.
The deployer is never a signer on the resulting smart account.
It cannot authorize wallet operations or move funds from a correctly deployed wallet.

The current SDK keeps the shared deployer sign-only.
It signs the `CreateContractV2` authorization entry.
It never supplies the transaction source, sequence, or fee.
It never signs the transaction envelope.

This repository has not undergone an independent security audit.
The underlying OpenZeppelin contracts have a separate audit with a different scope.
See the [root security status](../README.md#security-status).

## Required integration rules

- Never fund a shared deployer.
- Configure `relayerUrl` for automatic shared-deployer submission.
- Use `autoSubmit: false` for submission through a funded source that you control.
- Use `deployerSecret` only for a dedicated deployer that you control.
- Confirm manual deployment before you call `connectWallet()`.
- Treat derived addresses and discovery results as untrusted.
- Register a fresh passkey credential for each network.
- Do not derive a wallet address from a secondary credential.
- Do not display an unverified address as a deposit address.

A custom deployer changes every derived wallet address.
Keep the deployer configuration stable for discovery and recovery.

## Connection validation

`connectWithCredentials` verifies immutable wallet birth before connection.
It checks the successful `CreateContractV2` transaction against RPC or Horizon.
It checks the deployer, salt, birth WASM, constructor signer count, signer type, and policies.
It then checks current code and the exact live WebAuthn signer.
An untrusted candidate also requires a fresh WebAuthn assertion.

`acceptedBirthWasmHashes` controls code accepted at wallet birth.
Keep this list narrower than `acceptedWasmHashes`.
`acceptedWasmHashes` controls current wallet code after authorized upgrades.

The SDK retains confirmed birth data in credential storage.
It never treats address occupancy as deployment confirmation.
Pending, failed, occupied, and legacy predictions remain disconnected.

Fresh-device recovery accepts the immutable primary passkey only.
A verified local association keeps a secondary passkey usable on the same device.
The current contracts cannot prove a fresh device consented to a later signer addition.
The SDK therefore rejects fresh-device secondary recovery.

Do not auto-select one result from a multi-candidate discovery response.
Require the user to choose a candidate.
Show available provenance before the user accepts an address.

## Mainnet deployer controls

The current mainnet deployer uses on-chain controls and a minimal balance.
These controls protect its identity configuration.
They do not protect funds held by the deployer.

Run the read-only verification after each operational change:

```bash
node scripts/check-mainnet-deployer.mjs
node scripts/check-mainnet-deployer.mjs --json
```

See [`mainnet-hardening.md`](./mainnet-hardening.md) for the required values and response steps.

## Indexer requirement

Fresh-device recovery requires a complete schema-2 lookup response.
The response must include immutable birth metadata and a complete ledger position.
The SDK rejects legacy, malformed, incomplete, and duplicate claims.

The indexer supplies discovery claims only.
The SDK rechecks each immutable claim against RPC or Horizon.
See [`../indexer/README.md`](../indexer/README.md) for the exact response contract.

## Relevant release history

- `0.5.0` made the shared deployer sign-only.
- `0.5.1` preserved confirmed secondary credential associations.
- `0.6.0` added accepted code checks for untrusted connections.
- `0.6.1` required deployment confirmation for predicted addresses.
- `0.7.0` added immutable birth, current-code, live-signer, and fresh ownership checks.

Version `0.7.0` replaces address occupancy with immutable verification.
It does not replace an independent audit or an integrator review.

## Operational follow-ups

- Keep testnet shared deployers unfunded after network resets.
- Use a dedicated funded account for verifier, policy, and WASM deployment.
- Deploy schema 2 on every configured indexer before enabling fresh-device recovery.
- Keep `acceptedBirthWasmHashes` limited to constructor-compatible code.
- Keep the accepted code check after provenance validation exists.

Do not use current contract state as the only source of deployment provenance.
