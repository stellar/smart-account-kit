# Smart Account Indexer

Discovery layer for smart account contracts on Stellar. It enables reverse lookups from a passkey credential (or signer address) to the smart account contracts a user can access, and supplies active context-rule state to the SDK.

As of v0.4.0 the indexer is **[Mercury](https://mercurydata.app/)** — a hosted, managed provider. There is nothing to deploy: the SDK points at Mercury's `smart-account-indexer` REST service by default.

> [!IMPORTANT]
> Treat every discovery result as untrusted.
> Check the contract code before connecting or showing a deposit address.
> `SmartAccountKit` performs the code check through `acceptedWasmHashes`.
> This check does not prove deployment provenance.

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

Mercury's `smart-account-indexer` **read endpoints are public** — no token is required for the lookups the SDK performs. The SDK's default configuration therefore works zero-config against Mercury.

An optional provider token can be supplied via `indexerAuthToken` (SDK) / `VITE_INDEXER_AUTH_TOKEN` (demo); it is sent as `Authorization: Bearer <token>`. None is needed for Mercury today — its indexer read routes are anonymous and do not evaluate a token. When Mercury ships its gated tier, the credential will be a scoped publishable key for the indexer surface, not a Mercury account JWT; never embed a Mercury account JWT (or any other privileged credential) in a browser app.

### Coverage

Mercury indexes every smart-account-kit contract's events live, and a global historical backfill means past activity is indexed too — there is no per-contract admin/catch-up step. (Verified: anonymous lookups return contracts spanning historical and recent ledgers.)

## REST surface the SDK uses

The SDK's `IndexerClient` depends on these routes (all served by Mercury, all public):

| Endpoint | Used for |
|----------|----------|
| `GET /` | Health check (`isHealthy()`) |
| `GET /api/lookup/:credentialId` | Reverse lookup by passkey credential ID (hex) — primary discovery path |
| `GET /api/lookup/address/:address` | Reverse lookup by G-address (Delegated signer) or C-address (External verifier) |
| `GET /api/contract/:contractId` | Active contract detail: summary + context rules with signers and policies |
| `GET /api/stats` | Aggregate indexer statistics |

`getContractDetails()` treats a `404` as "not indexed yet" and returns `null`, so the SDK can fall back to its on-chain probe. Any wire-compatible provider that serves these five routes can be used instead of Mercury by overriding `indexerUrl`.

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

// Step 1: Authenticate with passkey (prompts user to select)
const { credentialId } = await kit.authenticatePasskey();

// Step 2: Discover contracts via indexer
const contracts = await kit.discoverContractsByCredential(credentialId);

// Step 3: Connect to selected contract
if (contracts && contracts.length > 0) {
  await kit.connectWallet({
    contractId: contracts[0].contract_id,
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

The [`demo/`](./demo) directory is a standalone Vite app that authenticates a passkey and looks up its smart account contracts against the indexer. It defaults to Mercury testnet.

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
