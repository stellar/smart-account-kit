# Migrating to `smart-account-kit` v0.7.0

Version `0.7.0` makes wallet connection fail closed.
It verifies wallet creation, current code, live signer state, and fresh passkey ownership.

This release does not change or deploy a smart contract.
It does not change `smart-account-kit-bindings@0.4.0`.
It requires SDK, indexer, demo, and relayer-proxy updates.

## Before you update

1. Add the schema-2 credential lookup response described in [`../indexer/README.md`](../indexer/README.md).
2. Add every approved current wallet hash to `acceptedWasmHashes`.
3. Keep `acceptedBirthWasmHashes` limited to approved constructor-compatible code.
4. Confirm that browser origins and `rpId` match your WebAuthn deployment.
   Set `allowedOrigins` explicitly when no browser location is available.
5. Update interfaces that assume a successful deployment removes its credential record.

Fresh-device recovery stays unavailable until the configured indexer returns a complete schema-2 response.
The SDK rejects legacy credential lookup responses.

## Connection changes

Every `connectWallet()` path now checks:

- A successful immutable `CreateContractV2` transaction.
- The expected deployer, credential-derived salt, birth WASM, signer, and constructor policies.
- A current wallet WASM hash in `acceptedWasmHashes`.
- One exact live signer on the expected context rule.
- A context rule that has not expired at the current network ledger.
- An indexer ledger position at or above the ledger recorded before lookup.
- A fresh WebAuthn assertion for an untrusted candidate.

Stored sessions no longer bypass these checks.
The SDK clears a stored session when verification fails.

```typescript
const kit = new SmartAccountKit({
  rpcUrl,
  networkPassphrase,
  accountWasmHash: originalBirthHash,
  acceptedBirthWasmHashes: [originalBirthHash],
  acceptedWasmHashes: [originalBirthHash, approvedUpgradeHash],
  webauthnVerifierAddress,
  storage: new IndexedDBStorage(),
});
```

`acceptedBirthWasmHashes` and `acceptedWasmHashes` have different purposes.
The first list verifies immutable creation code.
The second list verifies current code after an authorized upgrade.

Known public networks use official Horizon services when creation history is outside RPC retention.
Set `horizonUrl` for another network.
Set `horizonUrl: false` only if you accept recovery failure outside RPC retention.

## Fresh-device recovery

Fresh-device recovery accepts only the immutable primary passkey.
A secondary passkey remains usable when local storage contains its verified association.
The current contract history cannot prove fresh-device consent for a later signer addition.

Always show every discovery result as an unverified candidate.
Require the user to select a candidate.
Do not show a candidate as a deposit address before `connectWallet()` succeeds.

## Credential storage changes

Successful deployment records now remain in credential storage.
They contain the verified wallet-birth metadata used by later connections.

`CredentialDeploymentStatus` now contains four values:

- `pending`
- `failed`
- `deployed`
- `occupied`

`occupied` means that the predicted address exists without verified local birth data.
`credentials.sync()` returns `false` for this state.
`credentials.getPending()` includes this state for user review.

Do not delete or rewrite a verified `deployed` record.
Do not treat address occupancy as deployment confirmation.

## New connection errors

The package exports these error classes:

- `WalletCodeNotAcceptedError`
- `WalletProvenanceError`
- `WalletOwnershipError`
- `WalletAmbiguousError`

Handle these errors as a closed connection.
Do not continue with a candidate address after one of these errors.

## Relayer proxy

Deploy the updated relayer proxy with the SDK release.
The deployment route now accepts only the SDK constructor shape.
It requires one External WebAuthn signer and a credential-derived salt.

This proxy check limits invalid deployment traffic.
It does not replace SDK wallet-birth or ownership verification.

## Release versions

- Publish `smart-account-kit@0.7.0`.
- Keep `smart-account-kit-bindings@0.4.0` unless generated bindings change.
- Do not deploy new contract artifacts for this release.

See [`../CHANGELOG.md`](../CHANGELOG.md) for the complete release list.
