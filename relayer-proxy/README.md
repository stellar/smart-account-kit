# Smart Account Relayer Proxy

Cloudflare Worker that proxies transaction submission to the [OpenZeppelin Relayer Channels](https://docs.openzeppelin.com/relayer) service, so frontend apps can submit **fee-sponsored** Stellar transactions without exposing a Relayer API key.

> [!CAUTION]
> **Unaudited reference service.**
> This proxy has not received an independent third-party security audit.
> Defects or bad configuration can spend the relayer balance or interrupt submission.
> Review every allowlist and limit before deployment.
> Limit the fee balance and spending capacity to an acceptable loss.
> Report suspected vulnerabilities through the [project security policy](../SECURITY.md).

This is a **separate concern from the [indexer](../indexer)**: the indexer answers discovery/read queries (which contracts a passkey signs for), while the relayer proxy submits transactions. They are deployed and operated independently.

It wraps the official [`@openzeppelin/relayer-plugin-channels`](https://www.npmjs.com/package/@openzeppelin/relayer-plugin-channels) `ChannelsClient` and validates the SDK's wallet calls, shared-deployer `{func,auth}` deployments, and signed dedicated-deployer deployment envelopes before forwarding them.

## Features

- Fail-closed wallet contract/function, direct token-transfer, deployer, WASM, credential, auth-root, and resource-fee validation before any API key is read or minted.
- Explicit CORS origins and atomic global/per-IP rate limits through a Durable Object.
- **Per-IP API key model**: the proxy mints one Relayer API key per client IP (via the Relayer's public `/gen` endpoint) and stores it in the `API_KEYS` KV namespace under `api-key:<ip>`, persisted indefinitely.
- Relayer's usage limits reset every 24 hours on their side — no need to regenerate keys.
- On testnet, if a channel account is missing after a network reset, the proxy funds it via Friendbot and retries for up to 5 minutes. The shared deterministic deployer is never funded.

## API Endpoints

**Health Check**
```
GET /
```

**Submit Transaction**
```
POST /
Body: { "func": "base64-encoded-func", "auth": ["base64-auth-entry", ...] }
Body: { "xdr": "base64-signed-transaction-envelope" }
```
`func` submissions may contain an allowlisted wallet invocation with address-bound V2 credentials or an allowlisted direct token transfer. They may also contain one `createContractV2` function with one matching legacy V1 deploy authorization entry. A deployment must contain one External WebAuthn signer and a credential-derived salt.

Signed `xdr` accepts one source-signed dedicated-deployer `createContractV2` operation. Its source must equal its preimage deployer. The shared deterministic deployer cannot be an XDR source.

These checks constrain relayer spending. They do not prove wallet ownership. The SDK performs wallet-birth, code, signer, and passkey verification before connection.

**Status**
```
GET /status
```
Return the resolved client IP, network, and whether an API key has been minted for that IP.

## Deployment

```bash
cd relayer-proxy
pnpm install

# Create KV namespace
wrangler kv namespace create API_KEYS
# Update wrangler.toml with your KV namespace ID

# Deploy (testnet)
wrangler deploy

```

The proxy keeps its non-secret runtime config in `wrangler.toml`: exact browser origins, deployer addresses, account WASM hashes, explicit wallet IDs/functions, token IDs, RPC URL, resource-fee ceiling, and global/per-IP rate limits. Empty allowlists reject requests. `.dev.vars.example` contains local overrides. The committed KV namespace ID is a Cloudflare resource identifier, not a secret.

## Tests

```bash
pnpm --filter smart-account-relayer-proxy test
```

## SDK Integration

```typescript
const kit = new SmartAccountKit({
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  accountWasmHash: '...',
  webauthnVerifierAddress: 'C...',
  // Submit fee-sponsored transactions through this proxy:
  relayerUrl: 'https://smart-account-relayer-proxy.your-domain.workers.dev',
});

// Wallet operations and deployment use the Relayer when configured.
const result = await kit.signAndSubmit(transaction);
```
