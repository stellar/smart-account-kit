# Smart Account Kit

TypeScript SDK for deploying and managing OpenZeppelin smart account contracts on Stellar with WebAuthn passkey authentication.

## Features

- **Passkey authentication** — create and manage smart wallets secured by WebAuthn passkeys (secp256r1)
- **Multiple signer types** — passkeys, Ed25519 keys, and delegated Stellar accounts (G-addresses), all end-to-end
- **Context rules** — fine-grained, per-operation authorization with an auth digest that binds the rules it was signed under
- **Typed policy clients** — first-class read/write clients for the threshold, weighted-threshold, and spending-limit example policies
- **Constructor policies** — install policies on a wallet's default rule at creation time
- **Full contract parity** — every smart-account entry point is wrapped ergonomically (`kit.wallet` stays as a raw escape hatch)
- **Typed errors + on-chain decoding** — structured error classes, plus decoding of `Error(Contract, #NNNN)` diagnostics into named `ContractError`s
- **Client-side validation** — contract limits (signers, policies, name size, expiry) are checked before submission
- **Fee sponsoring** — optional relayer proxy for gasless transactions
- **Storage adapters** — flexible credential storage (IndexedDB, localStorage, memory, custom)

> **Upgrading from 0.3.0?** See the [v0.4.0 migration guide](docs/migration-v0.4.0.md) for the full list of breaking changes.

## Concepts

The kit is a client for the OpenZeppelin [`stellar-contracts`](https://github.com/OpenZeppelin/stellar-contracts) smart-account contract. A few concepts recur throughout the API.

- **Smart account** — a contract wallet. Every mutating entry point self-authorizes (`require_auth` on the account's own address), so account operations are authorized by the account's signers rather than by an external transaction source.
- **Context rules** — the account's authorization policy. Each rule has a **context type** — `Default` (matches any operation), `CallContract(address)` (a specific target contract), or `CreateContract(wasmHash)` (deploying a specific WASM) — a set of **signers**, a set of **policies**, and an optional `valid_until` expiry. A rule with no policies requires **all** its signers to authenticate; a rule with policies defers to those policies.
- **Signers** — an on-chain `Signer` is either `Delegated(G-address)` (native Stellar `require_auth`) or `External(verifier, keyData)` (a verifier contract validates a signature). Passkeys are `External` signers against the WebAuthn verifier; Ed25519 keys are `External` signers against the Ed25519 verifier.
- **Policies** — contracts that enforce additional constraints during authorization (e.g. N-of-M threshold, weighted voting, spending limits). Policies are multi-tenant: their state is keyed by `(smart_account, context_rule_id)`.
- **Auth digest** — every signer authenticates the same Protocol 27 digest, which binds the context rule ids the signature is valid under (defeating rule-downgrade attacks):

  ```text
  signature_payload = sha256(P27 auth preimage)
  auth_digest       = sha256(signature_payload ++ context_rule_ids.to_xdr())
  ```

  Signers never sign the raw payload — they sign `auth_digest`. The SDK computes and binds this for you.

## Installation

```bash
pnpm add smart-account-kit
```

## Quick Start

```typescript
import { SmartAccountKit, IndexedDBStorage } from 'smart-account-kit';

// Initialize the SDK
const kit = new SmartAccountKit({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  accountWasmHash: 'YOUR_ACCOUNT_WASM_HASH',
  webauthnVerifierAddress: 'CWEBAUTHN_VERIFIER_ADDRESS',
  relayerUrl: 'https://my-relayer-proxy.example.com',
  storage: new IndexedDBStorage(),
});

// On page load — silent restore from stored session
const restored = await kit.connectWallet();
if (!restored) {
  // No stored session; show a connect/create button
}

// User clicks "Create Wallet"
const { contractId, credentialId } = await kit.createWallet('My App', 'user@example.com', {
  autoSubmit: true,
});

// User clicks "Connect Wallet" — prompts for passkey selection
await kit.connectWallet({ prompt: true });

// Sign and submit a transaction (returns a discriminated result, does not throw
// on expected on-chain failures)
const result = await kit.transfer('CTOKEN...', 'GRECIPIENT...', 100);
if (result.success) {
  console.log('Transaction hash:', result.hash);
} else {
  console.error(`Failed [${result.error.code}]:`, result.error.message);
}
```

The current Protocol 27 testnet/mainnet deployed contract IDs and WASM hashes are recorded in [`docs/deployments-protocol-27-2026-07-09.md`](docs/deployments-protocol-27-2026-07-09.md); ready-to-use testnet defaults live in `demo/.env.example`.

## Configuration

### SmartAccountKit options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `rpcUrl` | `string` | Yes | Stellar RPC URL |
| `networkPassphrase` | `string` | Yes | Network passphrase |
| `accountWasmHash` | `string` | Yes | Smart account WASM hash for deployment |
| `acceptedWasmHashes` | `string[]` | No | Code identities accepted when connecting to an account resolved from an untrusted source (derivation, or a discovery result). Defaults to `[accountWasmHash]`. Add each hash as upgrades roll out — see [security notes](./docs/security-deterministic-deployer.md) |
| `webauthnVerifierAddress` | `string` | Yes | Deployed WebAuthn verifier contract address |
| `ed25519VerifierAddress` | `string` | No | Deployed Ed25519 verifier — required only for Ed25519 external signers |
| `defaultPolicies` | `PolicyConfig[]` | No | Constructor policies installed on the default rule of newly created wallets |
| `timeoutInSeconds` | `number` | No | Transaction timeout (default: 30) |
| `signatureExpirationLedgers` | `number` | No | Signature lifetime from the current ledger (default: 720, ~1 hour) |
| `storage` | `StorageAdapter` | No | Credential storage adapter (default: in-memory) |
| `deployerSecret` | `string` | No | Secret key (`S...`) of a deployer you control, which then sources and pays for its own deployments. Defaults to a deterministic well-known keypair whose secret is **publicly derivable** and which is sign-only — see below |
| `externalSignerStorage` | `WalletStorage` | No | Persistence store for external-wallet connections (default: `localStorage` when available) |
| `rpId` | `string` | No | WebAuthn relying party ID (domain) |
| `rpName` | `string` | No | WebAuthn relying party name (default: `"Smart Account"`) |
| `webAuthn` | `object` | No | Custom WebAuthn implementation, primarily for testing |
| `sessionExpiryMs` | `number` | No | Stored-session lifetime (default: 7 days) |
| `externalWallet` | `ExternalWalletAdapter` | No | Wallet adapter for delegated/multi-signer flows |
| `indexerUrl` | `string \| false` | No | Custom indexer base URL, or `false` to disable indexing |
| `indexerAuthToken` | `string` | No | Provider token sent as `Authorization: Bearer <token>` (not needed for Mercury's public reads) |
| `contextRuleProbe` | `object` | No | Bounded on-chain fallback for active-rule discovery |
| `relayerUrl` | `string` | No | Relayer proxy URL for fee sponsoring |

#### Deployer keypair

The deployer salts wallet deployment (the contract address is derived from it). By default it is a **deterministic keypair derived from a fixed, well-known seed** (`DEFAULT_DEPLOYER_SEED`), which makes smart-account addresses reproducible across clients from a credential ID alone. The deployer **never controls the smart account** — it is not a signer on the deployed wallet.

> ⚠️ **The default deployer's secret key is publicly derivable from this package's source, and the account is shared across every default-configured integrator.** It must **never** be used as a fee source on a network carrying real value: anyone can read the seed, reconstruct the key, and spend the account's balance. Do not fund it on mainnet, and never follow any prompt to "fund the deployer" for the shared default account.
>
> Because of this, the shared deployer is **sign-only**: it signs the CreateContractV2 authorization entry, while a relayer/channel account supplies the transaction source, sequence, and fees. Choose one of:
> - **Fee sponsoring:** set `relayerUrl`. The SDK submits `{ func, auth }`; the shared deployer never signs an envelope or supplies sequence/fees.
> - **Submit it yourself:** call `createWallet(..., { autoSubmit: false })` and submit the returned `relayerPayload: { func, auth }` through any funded source you control. Building it needs no relayer — signing an auth entry spends nothing and confers no privilege, since the deployer's key is public. The kit remains disconnected until you confirm submission and call `connectWallet()`.
> - **Dedicated deployer:** set `deployerSecret` to a key you control. It becomes the fee payer. *Note: a custom deployer changes the derived contract addresses, so a wallet created with one deployer cannot be re-derived with another.*

The shared default deployer accounts are, by design, **on-chain hardened** on mainnet: `auth_immutable` is set and thresholds/weights prevent `accountMerge` and signer changes. This bounds takeover, not balance: any XLM held by the sponsored-reserve account remains sweepable. A third party can also set its sequence to `INT64_MAX`, but the current SDK never uses the shared account as an envelope source, so that no longer blocks deployments. **Do not fund it.** See [`docs/security-deterministic-deployer.md`](docs/security-deterministic-deployer.md) for the exact guarantees and residual risks.

### Fee sponsoring

Configure a relayer URL to enable gasless transactions. The SDK posts `{ func, auth }` for invokeHostFunction flows and shared-deployer deployments; custom-deployer deployments use `{ xdr }`.

```typescript
const kit = new SmartAccountKit({
  // ... other config
  relayerUrl: 'https://my-relayer-proxy.example.com',
});

// Transactions automatically use the relayer when configured
await kit.transfer(tokenContract, recipient, amount);

// Bypass the relayer for a specific operation
await kit.transfer(tokenContract, recipient, amount, { forceMethod: 'rpc' });
```

### Storage adapters

```typescript
import {
  IndexedDBStorage,    // Recommended for web apps
  LocalStorageAdapter, // Simple fallback
  MemoryStorage,       // For testing / SSR
} from 'smart-account-kit';

const storage = new IndexedDBStorage();

// Or implement your own
class MyStorage implements StorageAdapter {
  async save(credential: StoredCredential): Promise<void> { /* ... */ }
  async get(credentialId: string): Promise<StoredCredential | null> { /* ... */ }
  async saveSession(session: StoredSession): Promise<void> { /* ... */ }
  async getSession(): Promise<StoredSession | null> { /* ... */ }
  // ... other StorageAdapter methods
}
```

## API Reference

### SmartAccountKit

The main SDK client class.

```typescript
import { SmartAccountKit } from 'smart-account-kit';
```

#### Core methods

| Method | Description |
|--------|-------------|
| `constructor(config: SmartAccountConfig)` | Initialize the SDK |
| `createWallet(appName, userName, options?)` | Create + deploy a new smart wallet with a passkey |
| `connectWallet(options?)` | Connect to an existing wallet |
| `disconnect()` | Disconnect and clear stored session |
| `authenticatePasskey()` | Authenticate with a passkey without connecting |
| `discoverContractsByCredential(credentialId)` | Find contracts by credential ID via the indexer |
| `discoverContractsByAddress(address)` | Find contracts by G/C-address via the indexer |
| `sign(transaction, options?)` | Sign auth entries only (prefer `signAndSubmit`) |
| `signAndSubmit(transaction, options?)` | Sign, re-simulate, and submit (recommended) |
| `signAuthEntry(authEntry, options?)` | Sign a single auth entry (low-level) |
| `execute(target, targetFn, targetArgs)` | Build a smart-account-mediated contract call |
| `executeAndSubmit(target, targetFn, targetArgs, options?)` | Build + sign + submit a smart-account-mediated call |
| `upgrade(newWasmHash)` | Build an upgrade transaction (32-byte hex string or `Buffer`) |
| `fundWallet(nativeTokenContract, options?)` | Fund the wallet via Friendbot (testnet only) |
| `transfer(tokenContract, recipient, amount, options?)` | Passkey token transfer (signed as a direct token invocation, so token-scoped context rules and their policies apply) |
| `getContractDetailsFromIndexer(contractId)` | Get contract details from the indexer |
| `convertPolicyParams(policyType, params)` | Convert native policy params to an `xdr.ScVal` |
| `buildPoliciesScVal(policies, policyTypes)` | Build a sorted policies `Map` as an `xdr.ScVal` |

Submission methods (`transfer`, `signAndSubmit`, `executeAndSubmit`, `fundWallet`, `createWallet`'s deploy step, `multiSigners.*`) return a [`TransactionResult`](#transaction-results--error-handling) and do **not** throw for expected on-chain/relayer failures. Everything else throws typed errors.

#### Wallet lifecycle

`createWallet()` creates deployment artifacts for a new smart account tied to a freshly generated passkey. With `autoSubmit: true`, it connects only after deployment succeeds. With manual submission, confirm the transaction and call `connectWallet()`. `connectWallet()` restores or prompts into an existing wallet, `authenticatePasskey()` gives you passkey auth without connecting, and `disconnect()` only clears session state.

For transactions, `signAndSubmit()` is the default for smart-account auth flows and the canonical way to submit an assembled transaction returned by any of the sub-managers (`kit.rules.*`, `kit.signers.*`, `kit.policies.*`, `kit.upgrade`, and the policy clients). `executeAndSubmit()` is the one-shot path for arbitrary smart-account-mediated contract calls, and `sign()` / `signAuthEntry()` remain available when you need to inspect or compose around signed auth entries directly.

#### Sub-manager properties

| Property | Type | Description |
|----------|------|-------------|
| `kit.signers` | `SignerManager` | Manage signers on rules |
| `kit.rules` | `ContextRuleManager` | CRUD for context rules |
| `kit.policies` | `PolicyManager` | Manage policies on rules |
| `kit.credentials` | `CredentialManager` | Credential lifecycle |
| `kit.multiSigners` | `MultiSignerManager` | Multi-signer flows |
| `kit.externalSigners` | `ExternalSignerManager` | G-address and Ed25519 signers |
| `kit.policyClients` | accessor | Typed clients for the example policies |
| `kit.indexer` | `IndexerClient \| null` | Indexer client for contract discovery |
| `kit.relayer` | `RelayerClient \| null` | Relayer client (when configured) |
| `kit.events` | `SmartAccountEventEmitter` | Event subscription |

#### Usage examples

```typescript
// Create a new wallet
const { contractId, credentialId } = await kit.createWallet('My App', 'user@example.com', {
  autoSubmit: true,          // Deploy immediately
  autoFund: true,            // Fund via Friendbot (testnet only)
  nativeTokenContract: 'CDLZFC3...',
});

// Connect to an existing wallet
await kit.connectWallet();                        // Silent restore from session
await kit.connectWallet({ prompt: true });        // Prompt user to select a passkey
await kit.connectWallet({ fresh: true });         // Ignore session, always prompt
await kit.connectWallet({ credentialId: '...' }); // Connect with a specific credential
await kit.connectWallet({ contractId: 'C...' });  // Connect with a specific contract

// Transfer tokens (passkey-signed)
const result = await kit.transfer('CTOKEN...', 'GRECIPIENT...', 100);

// Build an arbitrary smart-account-mediated call
const tx = await kit.execute('CTARGET...', 'set_config', [owner, threshold]);
const execResult = await kit.signAndSubmit(tx);

// Or build + sign + submit in one step
const oneShot = await kit.executeAndSubmit('CTARGET...', 'set_config', [owner, threshold]);

// Upgrade the account's WASM (self-authorized)
const upgradeTx = await kit.upgrade('1b5f4534...'); // 32-byte hex or Buffer
await kit.signAndSubmit(upgradeTx);

// Disconnect
await kit.disconnect();
```

#### `kit.wallet` raw escape hatch

The generated contract client is available as `kit.wallet` after connection. The SDK now wraps **every** contract entry point ergonomically — there are no intentionally-unwrapped methods — so you should rarely need `kit.wallet`. Reach for it only when you want exact contract parity or a code path the SDK does not model. Prefer the wrappers, which add signer resolution, auth-digest binding, re-simulation, and submission handling.

## Transaction Results & Error Handling

Submission methods return a discriminated union on `success`; they never throw for expected on-chain/relayer failures. All other SDK methods throw typed errors directly.

```typescript
import type { TransactionResult } from 'smart-account-kit';

const result = await kit.transfer('CTOKEN...', 'GRECIPIENT...', 100);

if (result.success) {
  // TransactionSuccess: { success: true; hash: string; ledger?: number }
  console.log('Hash:', result.hash, 'Ledger:', result.ledger);
} else {
  // TransactionFailure: { success: false; error: SmartAccountError; hash? }
  console.error(`[${result.error.code}] ${result.error.message}`);
}
```

When a failure carries an on-chain contract code (surfaced in a diagnostic as `Error(Contract, #NNNN)`), `error` is a typed [`ContractError`](#error-classes) with the decoded enum name:

```typescript
import { ContractError } from 'smart-account-kit';

if (!result.success && result.error instanceof ContractError) {
  console.log(result.error.contractCode);       // 3010
  console.log(result.error.contractErrorName);  // "TooManySigners"
  console.log(result.error.family);             // "SmartAccount"
}
```

You can also decode diagnostics directly:

```typescript
import {
  decodeContractError,      // (diagnostic) => ContractError | null
  contractErrorFromCode,    // (code, context?) => ContractError | null
  CONTRACT_ERROR_REGISTRY,  // Record<number, ContractErrorInfo>
} from 'smart-account-kit';

const err = decodeContractError('HostError: Error(Contract, #3221)');
// err.contractErrorName === "SpendingLimitExceeded"
```

`CONTRACT_ERROR_REGISTRY` covers every known contract code: SmartAccount (3000–3016), WebAuthn verifier (3110–3119), SimpleThreshold (3200–3203), WeightedThreshold (3210–3214), and SpendingLimit (3220–3227).

---

### Sub-Managers

#### SignerManager (`kit.signers`)

Manage signers on context rules. Each mutating method returns an `AssembledTransaction` (or, for `addPasskey`, an object containing one); submit it with `kit.signAndSubmit(tx)` — or `kit.multiSigners.operation(tx, selected)` when the rule needs multiple signers.

| Method | Description |
|--------|-------------|
| `addPasskey(contextRuleId, appName, userName, options?)` | Create a passkey and add it as an External signer |
| `addDelegated(contextRuleId, address)` | Add a G-address (Delegated) signer |
| `addBatch(contextRuleId, signers)` | Add multiple signers in one transaction (`batch_add_signer`) |
| `idOf(signer)` | Resolve a signer's stable on-chain ID (`get_signer_id`) |
| `remove(contextRuleId, signer)` | Remove a signer (resolves its ID internally) |

```typescript
// Add a new passkey signer
const { credentialId, transaction } = await kit.signers.addPasskey(
  0,               // Context rule ID
  'My App',
  'Recovery Key',
  { nickname: 'Backup Key' }
);
await kit.signAndSubmit(transaction);

// Add a delegated (Stellar account) signer
const delegatedTx = await kit.signers.addDelegated(0, 'GABC...');
await kit.signAndSubmit(delegatedTx);

// Add several signers at once
const batchTx = await kit.signers.addBatch(0, [signerA, signerB]);
await kit.signAndSubmit(batchTx);

// Remove a signer by value
const removeTx = await kit.signers.remove(0, signer);
await kit.signAndSubmit(removeTx);
```

#### ContextRuleManager (`kit.rules`)

Manage context rules.

| Method | Description |
|--------|-------------|
| `add(contextType, name, signers, policies, validUntil?)` | Create a rule |
| `count()` | Total rules ever created (`get_context_rules_count`, a monotonic counter) |
| `get(contextRuleId)` | Read a single rule directly from chain |
| `list()` | List active rules via indexer discovery + bounded on-chain fallback |
| `getAll(contextRuleType)` | Active rules of a given type via the same discovery path |
| `remove(contextRuleId)` | Delete a rule |
| `updateName(contextRuleId, name)` | Update a rule's name |
| `updateExpiration(contextRuleId, validUntil?)` | Set or clear a rule's expiration ledger |

```typescript
import { createDefaultContext, createThresholdParams } from 'smart-account-kit';

// Add a new context rule (name, signers, policies map, optional expiry)
const params = kit.convertPolicyParams('threshold', createThresholdParams(2));
const addTx = await kit.rules.add(
  createDefaultContext(),
  'Primary Signers',
  [passkeySigner, delegatedSigner],
  new Map([[thresholdPolicyAddress, params]]),
);
await kit.signAndSubmit(addTx);

// Read a specific rule directly from chain
const { result: rule } = await kit.rules.get(0);

// Active-rule discovery (indexer preferred, on-chain probe fallback)
const rules = await kit.rules.list();
const defaults = await kit.rules.getAll(createDefaultContext());

// Update / remove
await kit.signAndSubmit(await kit.rules.updateName(0, 'New Name'));
await kit.signAndSubmit(await kit.rules.updateExpiration(0, expirationLedger));
await kit.signAndSubmit(await kit.rules.remove(1));
```

`kit.rules.get()` reads a specific rule directly from the contract. `kit.rules.list()` and `kit.rules.getAll()` prefer indexer-provided active IDs, then probe IDs `0`–`8` on-chain by default, stopping after three consecutive misses. Configure that bounded fallback with `contextRuleProbe`, or disable it with `{ enabled: false }`. Because the contract exposes individual lookups but no iterator over active IDs after deletions, an indexer remains the reliable source for sparse or higher-numbered rules.

> **Note on `signer_ids` / `policy_ids`:** the deployed contract's `get_context_rule` omits the aligned `signer_ids`/`policy_ids` vectors. The SDK hydrates them via `get_signer_id`/`get_policy_id`, so those getters must be reachable to read a rule with populated ids; a read-only client without them yields empty id vectors.

#### PolicyManager (`kit.policies`)

Manage policies on context rules.

| Method | Description |
|--------|-------------|
| `add(contextRuleId, policyAddress, installParams)` | Add a policy to a rule (`installParams` is an `xdr.ScVal`) |
| `idOf(policyAddress)` | Resolve a policy's stable on-chain ID (`get_policy_id`) |
| `remove(contextRuleId, policyAddress)` | Remove a policy (resolves its ID internally) |

```typescript
import { createSpendingLimitParams, LEDGERS_PER_DAY } from 'smart-account-kit';

// Convert native params to an ScVal, then add the policy
const params = kit.convertPolicyParams('spending_limit', createSpendingLimitParams(
  1_000_000_000n, // limit in stroops
  LEDGERS_PER_DAY // rolling period (~17,280 ledgers)
));
const addTx = await kit.policies.add(0, spendingLimitPolicyAddress, params);
await kit.signAndSubmit(addTx);

// Remove a policy
const removeTx = await kit.policies.remove(0, spendingLimitPolicyAddress);
await kit.signAndSubmit(removeTx);
```

`kit.policies.add()` takes an `xdr.ScVal`. Use `kit.convertPolicyParams(type, params)` to build one for the example policies, or pass a raw `xdr.ScVal` for a custom policy. See [Typed Policy Clients](#typed-policy-clients-kitpolicyclients) for reading/updating installed policies.

#### CredentialManager (`kit.credentials`)

Manage stored credentials (pending deployments).

| Method | Description |
|--------|-------------|
| `getAll()` | All stored credentials |
| `getForWallet()` | Credentials for the current wallet |
| `getPending()` | Pending/failed deployments |
| `create(options?)` | Create a new local pending credential |
| `save(credential)` | Save a credential to storage |
| `deploy(credentialId, options?)` | Deploy a pending credential |
| `sync(credentialId)` | Reconcile one credential against on-chain state |
| `syncAll()` | Reconcile all credentials; returns `{ deployed, pending, failed }` |
| `delete(credentialId)` | Delete a pending (never-deployed) credential |

```typescript
const all = await kit.credentials.getAll();
const pending = await kit.credentials.getPending();

// Deploy a pending credential
const { contractId, submitResult } = await kit.credentials.deploy('credential-id', {
  autoSubmit: true,
});

// Reconcile local state with chain (deployed credentials are removed from storage)
const { deployed, pending: stillPending, failed } = await kit.credentials.syncAll();

// Delete a pending credential (throws if it is actually deployed on-chain)
await kit.credentials.delete('credential-id');
```

#### MultiSignerManager (`kit.multiSigners`)

Multi-signer transaction flows, coordinating passkeys, Ed25519 keys, and delegated wallets.

| Method | Description |
|--------|-------------|
| `getAvailableSigners()` | Collect unique signers from the account's default rules |
| `needsMultiSigner(signers)` | Whether a signer set requires the multi-signer path |
| `buildSelectedSigners(signers, activeCredentialId?)` | Build a `SelectedSigner[]` from on-chain signers you can sign for |
| `operation(assembledTx, selectedSigners, options?)` | Submit any assembled transaction with the selected signers |
| `transfer(tokenContract, recipient, amount, selectedSigners, options?)` | Multi-signer token transfer (signed as a direct token invocation, so token-scoped context rules and their policies apply) |

```typescript
// Collect the account's signers and pick the ones we can sign for
const signers = await kit.multiSigners.getAvailableSigners();
const selected = kit.multiSigners.buildSelectedSigners(signers, kit.credentialId);

// Multi-signer transfer
const result = await kit.multiSigners.transfer('CTOKEN...', 'GRECIPIENT...', 100, selected);

// Or submit any assembled transaction with multiple signers
const tx = await kit.rules.add(/* ... */);
await kit.multiSigners.operation(tx, selected, {
  // Pin the auth context explicitly when a tx can match more than one rule
  resolveContextRuleIds: (entry, index) => [0],
});
```

The single-signer `kit.transfer()` / `kit.signAndSubmit()` convenience path is **passkey-only** by design. Any Ed25519 or delegated signer, or more than one signer, must go through `kit.multiSigners`.

---

### Ed25519 & External Signers

`kit.externalSigners` manages signers that are held client-side: raw Stellar keypairs (Delegated G-address signers), Ed25519 external signers, and connected external wallets. Keypair and Ed25519 signers are stored **in memory only** and are never persisted; wallet connections can be persisted for auto-restore.

| Method | Description |
|--------|-------------|
| `addFromSecret(secretKey)` | Add a Delegated G-address signer from a secret key (memory only) |
| `addEd25519FromSecret(secretKey, verifier?)` | Add an Ed25519 External signer (memory only) |
| `addFromWallet()` | Connect through the configured external wallet adapter |
| `restoreConnections()` | Restore persisted wallet connections |
| `canSignFor(address)` | Whether a keypair/wallet can sign for a G-address |
| `getAll()` | List all registered external signers |
| `remove(address)` | Remove a signer |
| `removeAll()` | Disconnect and remove all external signers |

```typescript
// Delegated (G-address) signer
kit.externalSigners.addFromSecret('S...');

// Multi-signer operations then use it automatically
const available = kit.externalSigners.canSignFor('GABC...');
```

#### Ed25519 signers (end-to-end)

Ed25519 keys authenticate as `External(ed25519Verifier, publicKey)` signers that sign the auth digest directly. Configure the verifier once, register a local keypair, add it to a rule, then sign through `kit.multiSigners`.

```typescript
import { createEd25519Signer } from 'smart-account-kit';

const kit = new SmartAccountKit({
  // ... other config
  ed25519VerifierAddress: 'CAAVTMC...', // deployed Ed25519 verifier
});

// 1. Register a local Ed25519 signer (uses the SDK-configured verifier)
const { address, publicKey } = kit.externalSigners.addEd25519FromSecret('S...');

// 2. Add it as a signer on a context rule
const ed25519Signer = createEd25519Signer(
  kit.ed25519VerifierAddress!,
  Buffer.from(publicKey, 'hex') // 32-byte key data
);
await kit.signAndSubmit(await kit.signers.addBatch(0, [ed25519Signer]));

// 3. Sign with it via the multi-signer path
const signers = await kit.multiSigners.getAvailableSigners();
const selected = kit.multiSigners.buildSelectedSigners(signers, kit.credentialId);
const result = await kit.multiSigners.transfer('CTOKEN...', 'GRECIPIENT...', 10, selected);
```

The lower-level `Ed25519Signer` class and the shared `computeEntryAuthDigest` helper are exported for advanced flows:

```typescript
import { Ed25519Signer, computeEntryAuthDigest } from 'smart-account-kit';
import type { AuthDigestSigner } from 'smart-account-kit';

const signer = Ed25519Signer.fromSecret('S...', ed25519VerifierAddress);
signer.publicKey; // 32-byte Buffer
signer.address;   // G-address form
```

---

### Typed Policy Clients (`kit.policyClients`)

First-class read/write clients for the three example policies. **Getters** read on-chain state via simulation; **setters** return an `AssembledTransaction` routed through the account's `execute()` (so they carry the account's authorization) and take the **full `ContextRule` struct**, matching the deployed contract signatures.

```typescript
// Simple threshold
const threshold = kit.policyClients.threshold(policyAddress);
const current = await threshold.getThreshold(ruleId);
const { result: rule } = await kit.rules.get(ruleId);
await kit.signAndSubmit(await threshold.setThreshold(3, rule));

// Weighted threshold — order matters when reconfiguring: raise weights before
// raising the threshold; lower the threshold before lowering/zeroing weights.
const weighted = kit.policyClients.weighted(policyAddress);
const total = await weighted.getThreshold(ruleId);
const weights = await weighted.getSignerWeights(rule);      // Map<Signer, number>
await kit.signAndSubmit(await weighted.setSignerWeight(signer, 100, rule));
await kit.signAndSubmit(await weighted.setThreshold(150, rule));

// Spending limit
const spending = kit.policyClients.spendingLimit(policyAddress);
const data = await spending.getSpendingLimitData(ruleId);  // SpendingLimitData
await kit.signAndSubmit(await spending.setSpendingLimit(2_000_000_000n, rule));
```

> ⚠️ **Signer-set divergence caveat.** Threshold and weighted-threshold policies are **not** auto-notified when a context rule's signer set changes. After adding or removing signers on a rule, call `setThreshold` / `setSignerWeight` to keep the policy consistent with the rule — otherwise authorization for that rule may break. The spending-limit policy only applies to `CallContract` rules and enforces on `transfer` calls (`amount = args[2]`) — attach it to a rule scoped to the token contract; since transfers are signed as direct token invocations, that rule matches them.

> ⚠️ **Weighted-threshold ordering caveat.** The weighted-threshold contract enforces `threshold <= total signer weight` on **every individual** `set_threshold` / `set_signer_weight` call ([stellar-contracts#761](https://github.com/OpenZeppelin/stellar-contracts/issues/761)). When adding weight and raising the threshold, call `setSignerWeight` first; when removing a signer or reducing weight, call `setThreshold` first to lower the threshold. Calls in the wrong order revert with `InvalidThreshold`.

---

### Constructor Policies

`defaultPolicies` installs policies on a new wallet's default context rule at creation time (via the contract `__constructor`). Provide a `PolicyConfig` with a `type` and **native** `installParams` — the SDK converts them for you. A per-call `policies` option on `createWallet()` overrides `defaultPolicies`.

```typescript
import { createThresholdParams } from 'smart-account-kit';

const kit = new SmartAccountKit({
  // ... other config
  defaultPolicies: [
    {
      address: thresholdPolicyAddress,
      type: 'threshold',                     // "threshold" | "spending_limit" | "weighted_threshold" | "custom"
      installParams: createThresholdParams(2), // native params; SDK encodes them
    },
  ],
});

// Per-call override (installs only this policy on the new wallet)
await kit.createWallet('My App', 'user@example.com', {
  autoSubmit: true,
  policies: [{ address: spendingLimitPolicyAddress, type: 'spending_limit', installParams }],
});
```

For `"custom"` (or omitted-type) policies, `installParams` must already be an `xdr.ScVal`. Constructor policies take native params (SDK-converted); `kit.policies.add()` on a live wallet takes a pre-built `xdr.ScVal` — see [PolicyManager](#policymanager-kitpolicies).

---

### Client-Side Validation

The SDK validates contract limits **before** submitting, turning opaque on-chain failures into clear `ValidationError`s. `kit.rules.add`, `kit.signers.add*`, and `kit.signers.addBatch` run these checks automatically; the functions and constants are also exported for your own pre-flight checks.

```typescript
import {
  validateContextRule,
  validateContextRuleName,
  validateSigner,
  validateSigners,
  validatePolicyCount,
  validateExternalKeySize,
  validateValidUntil,
  // Limits mirroring the deployed contract
  MAX_SIGNERS,          // 15
  MAX_POLICIES,         // 5
  MAX_NAME_SIZE,        // 20 (UTF-8 bytes)
  MAX_EXTERNAL_KEY_SIZE, // 256 (bytes)
} from 'smart-account-kit';

validateContextRule({ name, signers, policyCount: policies.size, validUntil });
```

Violations (a name over 20 bytes, more than 15 signers, more than 5 policies, a `valid_until` already in the past, or a rule with neither signers nor policies) throw `ValidationError` before any network call.

---

### Types

```typescript
// Configuration
import type { SmartAccountConfig, PolicyConfig } from 'smart-account-kit';

// Credentials & sessions
import type {
  StoredCredential,
  StoredSession,
  CredentialDeploymentStatus, // "pending" | "failed"
  StorageAdapter,
} from 'smart-account-kit';

// Results & options
import type {
  CreateWalletResult,
  ConnectWalletResult,
  TransactionResult,   // TransactionSuccess | TransactionFailure
  TransactionSuccess,
  TransactionFailure,
  SubmissionOptions,
  SubmissionMethod,    // "relayer" | "rpc"
  SignOptions,
  SubmitOptions,
  SignAndSubmitOptions,
  ResolveContextRuleIds,
} from 'smart-account-kit';

// External wallet & multi-signer
import type {
  ExternalWalletAdapter,
  ConnectedWallet,
  SelectedSigner,      // type: "passkey" | "wallet" | "ed25519"
  ExternalSigner,
  WalletStorage,
} from 'smart-account-kit';

// Contract types (re-exported from the generated bindings)
import type {
  ContractSigner,                  // on-chain Signer (alias)
  ContextRule,
  ContextRuleType,
  AuthPayload,
  WebAuthnSigData,
  SimpleThresholdAccountParams,
  WeightedThresholdAccountParams,
  SpendingLimitAccountParams,
  SpendingLimitData,               // via SpendingLimitPolicyClient.getSpendingLimitData
} from 'smart-account-kit';
```

---

### Builder Functions

#### Signer builders

```typescript
import {
  createDelegatedSigner,  // (publicKey: string) — Stellar account (G-address) signer
  createExternalSigner,   // (verifierAddress, keyData) — custom verifier signer
  createWebAuthnSigner,   // (verifierAddress, publicKey, credentialId) — passkey signer
  createEd25519Signer,    // (verifierAddress, publicKey /* 32 bytes */) — Ed25519 signer
} from 'smart-account-kit';

const delegated = createDelegatedSigner('GABC...');
const passkey = createWebAuthnSigner(webauthnVerifierAddress, publicKey, credentialId);
const ed25519 = createEd25519Signer(ed25519VerifierAddress, publicKeyBytes);
```

#### Context rule type builders

```typescript
import {
  createDefaultContext,         // () — matches any operation
  createCallContractContext,    // (contractAddress) — a specific contract call
  createCreateContractContext,  // (wasmHash) — a specific contract deployment
} from 'smart-account-kit';

const context = createCallContractContext('CCONTRACT...');
```

#### Policy parameter builders

```typescript
import {
  createThresholdParams,          // (threshold)
  createWeightedThresholdParams,  // (threshold, Map<Signer, weight>)
  createSpendingLimitParams,      // (spendingLimit: bigint | number, periodLedgers)
  LEDGERS_PER_HOUR,               // 720
  LEDGERS_PER_DAY,                // 17,280
  LEDGERS_PER_WEEK,               // 120,960
} from 'smart-account-kit';

// 2-of-N threshold
const thresholdParams = createThresholdParams(2);

// 1000 XLM per day (limit in stroops, period in ledgers)
const spendingParams = createSpendingLimitParams(1000n * 10_000_000n, LEDGERS_PER_DAY);

// Weighted voting
const weights = new Map([[adminSigner, 100], [userSigner, 50]]);
const weightedParams = createWeightedThresholdParams(100, weights);
```

These builders return the **native** param shapes used by `defaultPolicies` and consumed by `kit.convertPolicyParams(type, params)`.

#### Signer helper functions

```typescript
import {
  getCredentialIdFromSigner,  // extract a passkey credential ID from a Signer
  signersEqual,               // compare two signers
  getSignerKey,               // stable dedup key for a signer
  collectUniqueSigners,       // dedup a signer array
  // Display helpers
  truncateAddress,
  describeSignerType,
  formatSignerForDisplay,
  formatContextType,
} from 'smart-account-kit';
```

---

### Constants

```typescript
import {
  WEBAUTHN_TIMEOUT_MS,    // 60000
  BASE_FEE,               // "100"
  STROOPS_PER_XLM,        // 10,000,000
  FRIENDBOT_RESERVE_XLM,  // 5
  // Contract limits (mirror the deployed contract)
  MAX_SIGNERS,            // 15
  MAX_POLICIES,           // 5
  MAX_NAME_SIZE,          // 20 (UTF-8 bytes)
  MAX_EXTERNAL_KEY_SIZE,  // 256 (bytes)
  ED25519_PUBLIC_KEY_SIZE, // 32
  ED25519_SIGNATURE_SIZE,  // 64
} from 'smart-account-kit';
```

---

### Error Classes

```typescript
import {
  SmartAccountError,        // Base error (has .code and .context)
  SmartAccountErrorCode,    // Error codes enum
  WalletNotConnectedError,  // No wallet connected
  CredentialNotFoundError,  // Credential not found in storage
  SignerNotFoundError,      // Signer not registered on-chain
  PolicyNotFoundError,      // Policy not found on a context rule
  SimulationError,          // Simulation failed
  SubmissionError,          // Submission failed
  ValidationError,          // Input / limit validation failed
  WebAuthnError,            // WebAuthn operation failed
  SessionError,             // Session management error
  ContractError,            // Decoded on-chain contract failure (see below)
  wrapError,                // Wrap an unknown error as a SmartAccountError
} from 'smart-account-kit';

// Contract error decoding
import {
  decodeContractError,
  contractErrorFromCode,
  CONTRACT_ERROR_REGISTRY,
} from 'smart-account-kit';
import type { ContractErrorFamily, ContractErrorInfo } from 'smart-account-kit';
```

Methods that do not return a `TransactionResult` throw these directly:

```typescript
try {
  await kit.rules.add(/* invalid name > 20 bytes */);
} catch (error) {
  if (error instanceof ValidationError) {
    // Client-side limit violation, caught before submission
  }
}
```

Submission methods surface the same error types inside a `TransactionFailure` (`result.error`), decoding on-chain codes into `ContractError` — see [Transaction Results & Error Handling](#transaction-results--error-handling).

---

### Event System

```typescript
import { SmartAccountEventEmitter } from 'smart-account-kit';
import type { SmartAccountEventMap, SmartAccountEvent, EventListener } from 'smart-account-kit';
```

| Event | Payload |
|-------|---------|
| `walletConnected` | `{ contractId, credentialId }` after a confirmed deployment or a validated connection |
| `walletDisconnected` | `{ contractId }` |
| `credentialCreated` | `{ credential }` |
| `credentialDeleted` | `{ credentialId }` |
| `sessionExpired` | `{ contractId, credentialId }` |
| `transactionSigned` | `{ contractId, credentialId? }` |
| `transactionSubmitted` | `{ hash, success }` |

```typescript
kit.events.on('walletConnected', ({ contractId }) => {
  console.log('Connected to:', contractId);
});

kit.events.on('transactionSubmitted', ({ hash, success }) => {
  console.log('Transaction:', hash, success ? 'succeeded' : 'failed');
});

const unsubscribe = kit.events.on('walletConnected', handler);
kit.events.once('walletConnected', handler);
unsubscribe();
```

A listener that throws never interrupts the others; its error is routed to `console.error` by default (configurable via `kit.events.setErrorHandler`).

---

### Wallet Adapters

```typescript
import { SmartAccountKit, StellarWalletsKitAdapter } from 'smart-account-kit';
import { Networks } from '@stellar/stellar-sdk';
import type { StellarWalletsKitAdapterConfig } from 'smart-account-kit';

const adapter = new StellarWalletsKitAdapter({
  network: Networks.TESTNET,
  onConnectionChange: (connected) => console.log('Wallet connection changed:', connected),
});
await adapter.init();

const kit = new SmartAccountKit({
  /* required config */
  externalWallet: adapter,
});

// Connect through the configured adapter
await kit.externalSigners.addFromWallet();
```

---

### Relayer Client

The SDK includes a relayer client for fee-sponsored transaction submission via a relayer proxy.

```typescript
import { RelayerClient, RelayerErrorCodes } from 'smart-account-kit';
import type { RelayerResponse, RelayerSendOptions, RelayerErrorCode } from 'smart-account-kit';
```

#### Via SmartAccountKit (recommended)

```typescript
const kit = new SmartAccountKit({
  // ... other config
  relayerUrl: 'https://my-relayer-proxy.example.com',
});

// Transactions automatically use the relayer when configured
await kit.transfer(tokenContract, recipient, amount);

// Bypass the relayer for a specific operation
await kit.transfer(tokenContract, recipient, amount, { forceMethod: 'rpc' });

// Access the relayer client directly
const { relayerPayload } = await kit.createWallet('My App', 'user@example.com');
if (kit.relayer && relayerPayload) {
  const result = await kit.relayer.send(relayerPayload.func, relayerPayload.auth);
}
```

#### Directly

```typescript
const relayer = new RelayerClient('https://my-relayer-proxy.example.com');

// Submit func + auth for fee sponsoring
const result = await relayer.send(funcXdr, authXdrs);

// Or submit a signed transaction for fee-bumping
const xdrResult = await relayer.sendXdr(signedTransaction);

if (result.success) {
  console.log('Transaction hash:', result.hash);
} else {
  console.error('Failed:', result.error, result.errorCode);
}
```

---

### Indexer Client

The SDK includes an indexer client for reverse lookups from signer credentials to smart account contracts. As of v0.4.0 the built-in default provider is **[Mercury](https://mercurydata.app)**, a hosted managed indexer. Its read endpoints are public and cover both live and historical activity for every smart-account-kit contract (a global backfill means there is no per-contract catch-up step), so discovery works **zero-config with no token**. Point `indexerUrl` at any wire-compatible provider to override.

| Network | Built-in default (Mercury) |
|---------|----------------------------|
| Testnet | `https://testnet.mercurydata.app/rest/smart-account-indexer` |
| Mainnet | `https://mainnet.mercurydata.app/rest/smart-account-indexer` |

```typescript
import { IndexerClient, IndexerError, DEFAULT_INDEXER_URLS } from 'smart-account-kit';
import type {
  IndexerConfig,
  IndexedContractSummary,
  IndexedSigner,
  IndexedPolicy,
  IndexedContextRule,
  CredentialLookupResponse,
  AddressLookupResponse,
  ContractDetailsResponse,
  IndexerStatsResponse,
} from 'smart-account-kit';
```

#### Via SmartAccountKit (recommended)

```typescript
const kit = new SmartAccountKit({
  /* required config */
  // indexerUrl defaults to Mercury for known networks — override for a custom provider:
  // indexerUrl: 'https://testnet.mercurydata.app/rest/smart-account-indexer',
  // indexerAuthToken: 'optional-token', // not needed for Mercury's public reads
});

const credentialContracts = await kit.discoverContractsByCredential(credentialId);
const addressContracts = await kit.discoverContractsByAddress('GABC...');
const details = await kit.getContractDetailsFromIndexer('CABC...');

if (kit.indexer) {
  const stats = await kit.indexer.getStats();
  const healthy = await kit.indexer.isHealthy();
}
```

`indexerAuthToken` is optional (Mercury's read endpoints are public); supply one only for gated/admin operations or a provider that requires it. When set, it (and `authToken` on a directly-constructed client) is sent on every request as `Authorization: Bearer <token>`. Browser bundles expose their environment variables to users, so only embed public or tightly scoped tokens there; keep privileged and catch-up/admin credentials server-side.

#### Directly

```typescript
const indexer = IndexerClient.forNetwork('Test SDF Network ; September 2015');

const custom = new IndexerClient({
  baseUrl: 'https://testnet.mercurydata.app/rest/smart-account-indexer',
  timeout: 10000,
  authToken: 'your-indexer-token',
});

const { contracts } = await custom.lookupByCredentialId(credentialIdHex);
const { contracts: byAddress } = await custom.lookupByAddress('GABC...');
const details = await custom.getContractDetails('CABC...');
```

---

### Re-exported Types

```typescript
import type { AssembledTransaction } from 'smart-account-kit';
```

## Building from Source

### Prerequisites

- Node.js >= 22
- pnpm >= 10 (`corepack enable`)
- Stellar CLI ([installation guide](https://developers.stellar.org/docs/tools/cli/install-cli))

### Setup

```bash
git clone https://github.com/stellar/smart-account-kit
cd smart-account-kit

# Configure demo environment (has testnet defaults)
cp demo/.env.example demo/.env
# Edit demo/.env if needed

pnpm install

# Build the checked-in bindings and SDK
pnpm build:all
```

### Environment configuration

`pnpm build:all` builds the checked-in bindings and SDK; it does not regenerate bindings. Run `pnpm build:bindings` explicitly when the smart-account contract interface changes. That command resolves the binding source from explicit env/args first (`ACCOUNT_WASM=/path/to/optimized-contract.wasm` for a local artifact), falling back to `demo/.env.example`, and prints the source and hash it binds against.

The optimized Protocol 27 testnet/mainnet artifact hashes, deployed contract IDs, and transaction provenance are recorded in [`docs/deployments-protocol-27-2026-07-09.md`](docs/deployments-protocol-27-2026-07-09.md).

Key variables in `demo/.env`:

- `VITE_RPC_URL` — Stellar RPC endpoint
- `VITE_NETWORK_PASSPHRASE` — network passphrase
- `VITE_ACCOUNT_WASM_HASH` — smart account contract WASM hash
- `VITE_ACCOUNT_CONTRACT_ID` — optional contract ID for regenerating bindings from a deployed instance
- `VITE_WEBAUTHN_VERIFIER_ADDRESS` — deployed WebAuthn verifier contract
- `VITE_ED25519_VERIFIER_ADDRESS` — deployed Ed25519 verifier contract
- `VITE_NATIVE_TOKEN_CONTRACT` — native XLM SAC contract used by the demo
- `VITE_THRESHOLD_POLICY_ADDRESS` — deployed threshold policy contract
- `VITE_SPENDING_LIMIT_POLICY_ADDRESS` — deployed spending-limit policy contract
- `VITE_WEIGHTED_THRESHOLD_POLICY_ADDRESS` — deployed weighted-threshold policy contract
- `VITE_INDEXER_URL` — optional wire-compatible indexer endpoint override
- `VITE_INDEXER_AUTH_TOKEN` — optional provider token for the indexer (not needed for Mercury's public reads)
- `VITE_RELAYER_URL` — optional relayer proxy URL for fee-sponsored transactions

### Verifying bindings

The checked-in bindings must stay byte-compatible with the canonical deployed WASM. `pnpm verify:bindings` regenerates the bindings from the canonical testnet WASM hash recorded in the deployments doc, diffs the result against `packages/smart-account-kit-bindings/src/index.ts`, and exits nonzero on any drift. If richer descriptions are wanted, fix them on the **contract** side (redeploy, then regenerate) — do not hand-edit the generated bindings, which re-introduces drift.

### Getting contract WASM hashes

The Smart Account Kit uses contracts from [OpenZeppelin's stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts). You can:

1. **Use pre-deployed testnet contracts** (recommended for development). `demo/.env.example` includes the current uploaded smart-account WASM hash plus the deployed verifier and policy addresses. The default setup intentionally uses the smart-account WASM hash instead of a fixed contract ID because smart-account deployment requires constructor args (`signers` and `policies`).
2. **Deploy your own contracts** — clone [stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts), build and deploy, and use the resulting WASM hashes or contract IDs.

### Build commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build the checked-in bindings, then the SDK |
| `pnpm build:all` | Run the repository build wrapper (same generated-artifact assumptions as `pnpm build`) |
| `pnpm build:bindings` | Regenerate and build bindings from explicit env / `ACCOUNT_WASM` / `demo/.env.example` |
| `pnpm verify:bindings` | Regenerate from the canonical WASM hash and diff against the checked-in bindings (nonzero on drift) |
| `pnpm build:demo` | Build the SDK and demo application |
| `pnpm build:watch` | Watch mode for SDK development |
| `pnpm test --run` | Run the test suite once |
| `pnpm clean` | Remove build artifacts |

### Publishing

Publish `smart-account-kit-bindings` before `smart-account-kit`, because the SDK package resolves its workspace dependency to the published bindings version. The exact authenticated dry-run, publish, and verification commands are in [`docs/releasing.md`](docs/releasing.md).

## Documentation

- [Changelog](CHANGELOG.md) — release history
- [v0.4.0 migration guide](docs/migration-v0.4.0.md) — breaking changes from 0.3.0
- [Protocol 27 deployments](docs/deployments-protocol-27-2026-07-09.md) — testnet/mainnet contract IDs and WASM hashes
- [Releasing](docs/releasing.md) — npm publish flow

## Related

- [OpenZeppelin stellar-contracts](https://github.com/OpenZeppelin/stellar-contracts) — the smart account contracts this SDK interacts with
- [Demo Application](./demo) — interactive demo for testing the SDK
- [Indexer](./indexer) — backend service for contract discovery

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) for details.
