# Smart Account Indexer

Discovery layer for smart account contracts on Stellar. It enables reverse lookups from a passkey credential (or signer address) to the smart account contracts a user can access, and supplies active context-rule state to the SDK.

The built-in provider is **[Mercury](https://mercurydata.app/)**. This repository does not contain an indexer service. Mercury or another provider must serve the schema-2 response below before credential discovery can succeed.

> [!IMPORTANT]
> Treat every discovery result as untrusted.
> Never present a discovery result as a wallet or deposit address.
> `SmartAccountKit` verifies immutable birth, current code, and live ownership.
> The SDK rejects a legacy response. An incomplete schema-2 response cannot connect.

> **History:** before v0.4.0 this directory also shipped a self-hosted reference stack (a Goldsky Turbo pipeline → PostgreSQL → Cloudflare Worker). That path was removed in v0.4.0 (too expensive to operate, and Mercury indexes the same events as a managed service). The old pipeline configs, SQL schema, and Worker live in git history if you need them.

## Why an indexer?

When a user authenticates with a passkey, the app needs to discover which smart account contracts that passkey signs for — without knowing any contract ID up front. The chain does not expose a reverse index, because:

1. A single passkey can be a signer on multiple smart accounts.
2. Passkeys added as secondary signers have no deterministic contract address.
3. Users need to discover their accounts without knowing contract IDs upfront.
4. The contract exposes individual rule lookups, but not a stable iterator over currently active rule IDs.

The SDK keeps a bounded low-ID on-chain fallback for fresh wallets and temporary indexer lag, but it cannot reconstruct arbitrary active IDs — an indexer is the reliable source.

## Endpoints

| Network | Base URL |
|---------|----------|
| Testnet | `https://testnet.mercurydata.app/rest/smart-account-indexer` |
| Mainnet | `https://mainnet.mercurydata.app/rest/smart-account-indexer` |

### Authentication

Mercury's `smart-account-indexer` read endpoints are public. The current lookup routes do not require a token.

An optional provider token can be supplied through `indexerAuthToken` or `VITE_INDEXER_AUTH_TOKEN`. The client sends it as `Authorization: Bearer <token>`. Never embed a privileged token or account credential in a browser application.

### Coverage

Mercury indexes signer events on both public networks.
Mercury testnet served schema 2 during validation on 2026-09-04.
Mercury mainnet still served the legacy response during that validation.
The SDK rejects the legacy mainnet response until Mercury completes its deployment.

## REST surface the SDK uses

The SDK's `IndexerClient` uses these public Mercury routes:

| Endpoint | Used for |
|----------|----------|
| `GET /` | Health check (`isHealthy()`) |
| `GET /api/lookup/:credentialId` | Reverse lookup by passkey credential ID (hex) — primary discovery path |
| `GET /api/lookup/address/:address` | Reverse lookup by G-address (Delegated signer) or C-address (External verifier) |
| `GET /api/contract/:contractId` | Active contract detail: summary + context rules with signers and policies |
| `GET /api/stats` | Aggregate indexer statistics |

`getContractDetails()` treats a `404` as "not indexed yet" and returns `null`. The SDK can then use its bounded on-chain rule probe. Any provider that serves these routes can replace Mercury through `indexerUrl`.

The credential route must return the complete schema below.

## Required credential lookup schema

`GET /api/lookup/:credentialId` must add these fields without removing summary data:

```json
{
  "schema": 2,
  "complete": true,
  "indexed_through_ledger": 123456,
  "credentialId": "0123abcd",
  "contracts": [
    {
      "contract_id": "C...",
      "birth_wasm_hash": "64 lowercase hex characters",
      "creation_transaction_hash": "64 lowercase hex characters",
      "creation_ledger": 123000,
      "current_wasm_hash": "64 lowercase hex characters",
      "derived_address": true,
      "collision": false,
      "incomplete": false,
      "context_rule_count": 1,
      "external_signer_count": 1,
      "delegated_signer_count": 0,
      "native_signer_count": 0,
      "first_seen_ledger": 123000,
      "last_seen_ledger": 123450,
      "context_rule_ids": [0]
    }
  ],
  "count": 1
}
```

The provider must follow these rules:

- Derive birth fields from the successful creation transaction.
- Confirm current code and live signer state through RPC.
- Return every candidate and deduplicate by `contract_id`.
- Set `collision` when the credential resolves to more than one contract.
- Set `incomplete` when any birth, current-code, signer, or RPC fact is unavailable.
- Set `complete` only after a finished scan through `indexed_through_ledger`.
- Keep `indexed_through_ledger` current with the network ledger at request time.
- Never rank or select an owner.
- Return `complete: false` after an RPC failure or partial scan.

The SDK treats every field as a claim.
It verifies the creation transaction through RPC or Horizon before connection.

## SDK Integration

```typescript
import { SmartAccountKit, IndexedDBStorage } from 'smart-account-kit';

const kit = new SmartAccountKit({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  accountWasmHash: '...',
  webauthnVerifierAddress: 'C...',
  storage: new IndexedDBStorage(),
  // indexerUrl defaults to Mercury for known networks; override for a custom provider.
  // indexerUrl: 'https://testnet.mercurydata.app/rest/smart-account-indexer',
  // indexerAuthToken: 'optional-provider-token', // sent as Authorization: Bearer <token>; not needed for Mercury
});

// Step 1: Request a passkey response for discovery.
// Wallet ownership is not verified until connectWallet succeeds.
const { credentialId } = await kit.authenticatePasskey();

// Step 2: Discover contracts via indexer
const contracts = await kit.discoverContractsByCredential(credentialId);

// Step 3: Display every result as an unverified candidate.
// Continue only after the user selects one.
const selected = contracts?.find((candidate) => userSelected(candidate.contract_id));
if (selected) {
  await kit.connectWallet({
    contractId: selected.contract_id,
    credentialId,
  });
}

// You can also use the indexer client directly:
if (kit.indexer) {
  const { contracts } = await kit.indexer.lookupByCredentialId(credentialIdHex);
  const details = await kit.indexer.getContractDetails('CABC...');
}
```

## Demo

The [`demo/`](./demo) directory is a standalone Vite app that gets a passkey response and shows unverified indexer candidates. It defaults to Mercury testnet. The demo does not connect to a wallet.

```bash
cd demo
pnpm install
pnpm dev
```

Configure it via `demo/.env` (see `demo/.env.example`): `VITE_INDEXER_URL`, and the optional `VITE_INDEXER_AUTH_TOKEN`.

### Test the REST API directly

```bash
INDEXER_URL=https://testnet.mercurydata.app/rest/smart-account-indexer

curl "$INDEXER_URL/"                                   # health
curl "$INDEXER_URL/api/stats"                          # stats
curl "$INDEXER_URL/api/lookup/<credential-id-hex>"     # lookup by credential
curl "$INDEXER_URL/api/contract/<contract-id>"         # contract detail

# A token is optional (public reads); pass one only when a provider requires it:
curl -H "Authorization: Bearer $INDEXER_TOKEN" "$INDEXER_URL/api/stats"
```

## Related

- [Relayer Proxy](../relayer-proxy) — fee-sponsored transaction submission via OpenZeppelin Relayer Channels (a separate concern from indexing).
- [Mercury](https://mercurydata.app/) — the hosted indexer provider.
