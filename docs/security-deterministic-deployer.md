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

`connectWithCredentials` checks untrusted addresses against `acceptedWasmHashes`.
The default list contains `accountWasmHash`.
Add each approved hash when a wallet upgrade changes its code.

The code check confirms an accepted executable.
It does not prove the intended deployment provenance.
It also does not prove the expected initial signer and policy configuration.

The SDK trusts a stored secondary association only when local state identifies it as confirmed.
Pending, failed, primary, and deterministic deployment predictions remain untrusted.
Version `0.6.1` keeps these predictions disconnected until deployment confirmation.

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

## Relevant release history

- `0.5.0` made the shared deployer sign-only.
- `0.5.1` preserved confirmed secondary credential associations.
- `0.6.0` added accepted code checks for untrusted connections.
- `0.6.1` required deployment confirmation for predicted addresses.

These fixes reduce known risks.
They do not replace an independent audit or an integrator review.

## Operational follow-ups

- Keep testnet shared deployers unfunded after network resets.
- Use a dedicated funded account for verifier, policy, and WASM deployment.
- Add deployment-provenance validation for derived addresses.
- Validate the initial signer and policy configuration from immutable transaction history.
- Keep the accepted code check after provenance validation exists.

Do not use current contract state as the only source of deployment provenance.
