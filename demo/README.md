# Smart Account Kit Demo

A basic Vite + React frontend application for testing the Smart Account Kit SDK with WebAuthn passkey authentication on Stellar.

> [!WARNING]
> This demo is test software and has not undergone an independent security audit.
> Do not use it as a production wallet.
> Use mainnet only with assets you accept losing.
> Report suspected vulnerabilities through the [project security policy](../SECURITY.md).

## Features

- **Wallet Creation**: Create a new smart wallet with a passkey as the primary signer
- **Wallet Connection**: Connect to an existing wallet using stored or discoverable passkeys
- **Contract Discovery**: Automatically discover smart accounts via indexer when connecting, with a fallback to the derived contract ID path if no indexed match is found
- **Context Rule Management**: Create, view, and edit context rules with signers and policies (with a live rules-count readout)
- **Multi-Signer Support**: Add passkey, delegated (G-address), and Ed25519 signers to context rules; batch-add signers when editing a rule
- **Ed25519 Signers**: Register a local Ed25519 keypair as an `External` signer via the configured verifier and sign multi-sig transactions with it (in-memory keys only)
- **Policy Support**: Configure threshold, spending limit, and weighted threshold policies; inspect and edit live policy params (thresholds, per-signer weights, spending limits) through the typed policy clients (`kit.policyClients.*`)
- **External Wallet Integration**: Connect Freighter or other Stellar wallets for delegated signing
- **Token Transfer**: Build and sign XLM transfer transactions with multi-signer support
- **Advanced**: Contract WASM upgrade (`kit.upgrade`) behind a collapsed Advanced section

## Demo Defaults

The checked-in `.env.example` shows the current default deployment set used by the demo. Your local `.env` can override any of these values:

| Contract | Default value |
|----------|---------------|
| **Smart Account WASM Hash** | `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a` |
| **WebAuthn Verifier** | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` |
| **Ed25519 Verifier** | `CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4` |
| **Native XLM Token** | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| **Threshold Policy** | `CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG` |
| **Spending Limit Policy** | `CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G` |
| **Weighted Threshold Policy** | `CCMZ6X4KM3RC7HXWCZDTH7CMWIJXFPN6HLGKJBM63MCOW2AJ2V5W7YXY` |

The demo does not pin a default smart-account contract ID. Smart accounts are deployed per wallet from the uploaded WASM hash because deployment requires constructor args for `signers` and `policies`. If you need to regenerate bindings from a specific deployed instance for debugging, you can set `VITE_ACCOUNT_CONTRACT_ID` locally in `.env`.

### Uploaded WASM Hashes

These are the current checked-in testnet artifacts corresponding to the deployed contracts above:

| Contract | Uploaded WASM hash |
|----------|--------------------|
| **Smart Account** | `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a` |
| **WebAuthn Verifier** | `e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76` |
| **Ed25519 Verifier** | `60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477` |
| **Threshold Policy** | `cb6c0bd9cd06abba05f924ff4157b41aa1dd3891803c7c93b3b158e20986e592` |
| **Spending Limit Policy** | `e41b563c4454f5a6742acfa6d44e1ece96d443bb5f40efddd6ed05180210219a` |
| **Weighted Threshold Policy** | `7565d0a585254be47001281baef5bbc5d539ccbe1c813196b3c45995a6c15b74` |

## Setup

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev
```

Open `http://localhost:5173` in your browser.

The demo comes pre-configured with testnet contracts. To customize, copy `.env.example` to `.env` and edit as needed. For mainnet, start from `.env.mainnet.example`. Leave `VITE_WEIGHTED_THRESHOLD_POLICY_ADDRESS` blank if you do not want the weighted-threshold policy in the UI.

Transactions (transfers and rule/policy operations) are **fee-sponsored by default**: `VITE_RELAYER_URL` points at the deployed testnet [relayer-proxy](../relayer-proxy), which submits them through the OpenZeppelin Relayer Channels service so the relayer's channel accounts pay the network fees and your smart wallet pays none. A "Fees Sponsored" badge appears in the config panel when it is active. Set `VITE_RELAYER_URL=""` to disable it and submit directly over RPC instead, or point it at your own proxy. (Wallet *deployment* always uses direct RPC.)

The SDK auto-configures its hosted indexer for Stellar testnet and mainnet when you use a known network passphrase. Set `VITE_INDEXER_URL` to use a wire-compatible provider such as Mercury, and set `VITE_INDEXER_AUTH_TOKEN` when that provider expects `Authorization: Bearer <token>`. Because Vite embeds `VITE_*` values in the browser bundle, only use public or tightly scoped tokens; privileged/admin credentials belong behind a server.

This demo ships with testnet defaults, so a mainnet run also needs mainnet RPC and contract env values. Start from `.env.mainnet.example` to keep the network, WASM, verifier, policy, and indexer settings aligned.

## Agent-Browser Passkey Testing

This repo includes a helper for enabling a Chromium virtual authenticator on a live `agent-browser` session, so passkey flows can be smoke-tested without switching away from `agent-browser`.

```bash
# 1. Start the demo and open it with agent-browser
pnpm --filter smart-account-kit-demo exec vite --host 127.0.0.1 --port 5173
agent-browser --session demo-passkey open http://127.0.0.1:5173

# 2. Run your agent-browser steps while the helper keeps a virtual authenticator attached
pnpm agent-browser:webauthn run --session demo-passkey -- \
  bash -lc 'agent-browser --session demo-passkey snapshot -i && \
    agent-browser --session demo-passkey click @e8'
```

The helper attaches to the current page target over Chrome DevTools Protocol, keeps the virtual authenticator alive while the wrapped command runs, and removes it automatically afterward.

## Usage

### Creating a New Wallet

1. Enter a username (optional)
2. Click "Create Wallet"
3. Follow the browser prompt to create a passkey
4. The wallet contract is deployed to testnet automatically
5. Wait for confirmation (typically 5-10 seconds)

### Connecting to an Existing Wallet

1. Click "Connect Existing"
2. Select a passkey from the browser prompt
3. Your wallet will be connected

### Adding Signers to a Rule

1. Connect to a wallet first
2. In "Context Rules (On-Chain)", click "+ Add Rule" (or "Edit Rule" on an existing rule)
3. In the Signers section, pick an add mode:
   - **New Passkey**: create a fresh passkey signer (follow the browser prompt)
   - **Connected Wallet** / **Manual G-Address**: add a Delegated (G-address) signer
   - **Ed25519 Key**: register a local Ed25519 keypair as an `External` signer
4. Save the rule; multi-signer rules prompt you to choose which signers sign
5. Wait for confirmation to see the change on-chain

### Managing Policy Params

1. Expand a context rule with a policy attached
2. Click the policy's "manage" button to read its live params
3. Edit the threshold, per-signer weight, or spending limit and apply the change
   (routed through the smart account's `execute()` and signed like any operation)

### Transferring Tokens

1. Connect to a wallet first
2. Fund the wallet with testnet XLM using "Fund Wallet (Testnet)"
3. Enter a recipient address (G... or C...)
4. Enter the amount in XLM
5. Click "Send Transfer"
6. Authenticate with your passkey when prompted
7. The transaction is signed and submitted automatically
8. Wait for confirmation to verify the transfer succeeded

## Architecture

```
demo/
├── src/
│   ├── App.tsx           # Slim orchestrator: wires hooks to panels
│   ├── main.tsx          # Entry point with Buffer polyfill
│   ├── config.ts         # CONFIG + KNOWN_POLICIES + storage-name helper
│   ├── types.ts          # Shared UI types (LogEntry, LogFn)
│   ├── constants.ts      # UI constants
│   ├── styles.css        # Application styles
│   ├── hooks/
│   │   ├── useLog.ts             # Activity-log state
│   │   ├── useKit.ts             # SmartAccountKit init + config + pending creds
│   │   ├── useExternalWallets.ts # External / Ed25519 signer management
│   │   ├── useWalletSession.ts   # Connect/create/fund/transfer/deploy lifecycle
│   │   └── useMultiSignerSubmit.ts # Shared multi-signer sign+submit helper
│   ├── utils/
│   │   ├── sdk.ts               # Re-exported SDK display/validation utils
│   │   ├── expiration.ts        # Ledger <-> days conversion
│   │   └── tx.ts               # TransactionResult -> simple {success,error}
│   └── components/
│       ├── index.ts                # Component exports
│       ├── ConfigPanel.tsx         # Config card
│       ├── ExternalWalletsPanel.tsx# External wallet connections
│       ├── PendingCredentialsPanel.tsx # Pending deployments
│       ├── WalletPanel.tsx         # Wallet status + create/connect/fund
│       ├── TransferPanel.tsx       # XLM transfer form
│       ├── ActivityLog.tsx         # Activity log
│       ├── ContractPickerModal.tsx # Multi-account picker
│       ├── AdvancedPanel.tsx       # Contract upgrade (advanced)
│       ├── ActiveSignerDisplay.tsx # Shows currently active signer
│       ├── ContextRulesPanel.tsx   # On-chain context rules + rules count
│       ├── ContextRuleBuilder.tsx  # Modal for creating/editing rules
│       ├── PolicyInspector.tsx     # Live policy get/set via policy clients
│       ├── SignerPicker.tsx        # Multi-signer selection modal
│       └── rule-builder/
│           ├── types.ts            # Rule-builder form types
│           ├── policyParams.ts     # Install-param build + policy-client reads
│           └── PolicyConfigList.tsx# Policy params editor
├── index.html            # HTML template
├── vite.config.ts        # Vite configuration
└── package.json          # Dependencies
```

## Notes

- Credentials stored in IndexedDB (persists across sessions)
- WebAuthn requires HTTPS in production (localhost works for development)
- Transactions auto-submit to Stellar testnet and wait for confirmation
- Contract addresses configurable via `.env` (see `.env.example`)
- Contract discovery prefers the indexer and falls back to the derived contract ID path when no indexed match is found
