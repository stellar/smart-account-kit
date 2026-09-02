# Protocol 27 contract deployment — 2026-07-09

This manifest records the optimized smart-account contract set built from
[`OpenZeppelin/stellar-contracts@1e513890`](https://github.com/OpenZeppelin/stellar-contracts/commit/1e513890ecf79833c9d6e7ef38a9358001c0b111), rehearsed on testnet, and deployed to mainnet.

## Build provenance

- Upstream commit: `1e513890ecf79833c9d6e7ef38a9358001c0b111`
- Rust/Cargo: `1.91.1`
- `soroban-sdk`: `26.1.0`
- Stellar CLI: `27.0.0`
- Build target: `wasm32v1-none`
- Build flags: `stellar contract build --locked --optimize=true --package <package>`
- JavaScript SDK used by the kit and generated bindings: `@stellar/stellar-sdk@16.0.1`

The account WASM is uploaded but not deployed as a singleton. Each user wallet
deploys its own account instance with signer and policy constructor arguments.

| Component | Cargo package | Optimized bytes | SHA-256 / network WASM hash |
|---|---|---:|---|
| Smart account | `multisig-account-example` | 41,855 | `1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a` |
| WebAuthn verifier | `multisig-webauthn-verifier-example` | 12,105 | `e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76` |
| Ed25519 verifier | `multisig-ed25519-verifier-example` | 1,848 | `60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477` |
| Threshold policy | `multisig-threshold-policy-example` | 11,680 | `cb6c0bd9cd06abba05f924ff4157b41aa1dd3891803c7c93b3b158e20986e592` |
| Weighted-threshold policy | `multisig-weighted-threshold-policy-example` | 14,407 | `7565d0a585254be47001281baef5bbc5d539ccbe1c813196b3c45995a6c15b74` |
| Spending-limit policy | `multisig-spending-limit-policy-example` | 14,716 | `e41b563c4454f5a6742acfa6d44e1ece96d443bb5f40efddd6ed05180210219a` |

## Testnet

Deployment source: `GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N`.

| Component | Contract ID | Upload transaction | Deploy transaction |
|---|---|---|---|
| Smart account | Per-wallet | `889f0e2322a03d5b2e4894e7d782c83a72259e5c9a04bc62295b538d4b16e263` | — |
| WebAuthn verifier | `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` | `d10974e3f8495b1d8afeafc7f429c9327e482742cc986f158d64de163ac63ae9` | `b497f83d53017d57f653c1a8ce401c929132964c1972629bedbe157a63f9ab26` |
| Ed25519 verifier | `CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4` | `84dedc318d79662a09f4e3d06bcc6035762d9a5d2d6ed6d6cfb4a6ca12ba3c84` | `61b8d937970999fafd2d768b0a278e91875a3456255a13c8f19c6de84a5b0abe` |
| Threshold policy | `CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG` | `b07479130b28e28cc20ace62b7876e677031dccf7adc1e5e82d692a1adb735fe` | `91efc8526edcefc2fb38d41c3e04fa769b4aa40f0cd4a2b692f5c341d2536426` |
| Weighted-threshold policy | `CCMZ6X4KM3RC7HXWCZDTH7CMWIJXFPN6HLGKJBM63MCOW2AJ2V5W7YXY` | `01bd841bd9b89f603c296db5399b15fc0c4a07f0d2cf7fb210fafa79236ddde3` | `83ed13b6b9fd163dcea6614cbf6842376082d4a4cca73a73c752b61443062444` |
| Spending-limit policy | `CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G` | `6bb44a445d2a622b32b29f19de65a6e742f3e8d5998bcb2475eb9d7891eac154` | `1fe0363caf86b062e27e1c50ea66349aef298bf4ac6926d66f403224731d1743` |

A browser-driven WebAuthn smoke test deployed and funded a fresh account.
It then completed an authenticated XLM transfer.

## Mainnet

Deployment source: `GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N`. A separate account supplied 120 XLM in transaction `c1d701a753d7bd7efc33bc8ce0f736f5cd065873daa8f174fbf60716bafb11ea`. It was not a contract deployment source.

| Component | Contract ID | Upload transaction | Deploy transaction |
|---|---|---|---|
| Smart account | Per-wallet | `c6c7461f09a4cf9109d53ba4dee4c09b8794ee0fab03e58519847705bba75eaa` | — |
| WebAuthn verifier | `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` | `609c3004ed549bebcad362c9202c9e3df6cda3feb5220f7b0abddf9699db3308` | `a393b4af653adae18d8df5549d031f5c2bfaf064efc8e08d557a66425dc1a246` |
| Ed25519 verifier | `CBOOZV2BK5OETGL4Q4KGEBESPRLJFN7DOFWDT7OZGLD7EQEZUVOWUEMC` | `9d3b6fc12075b16b8ac6177da589a0c938ef2298a95d38a03d6bb1a930434f6a` | `42b17b213b18602447753976bf4b724c2982755f3d21021b3c05ef7e1b2735d5` |
| Threshold policy | `CCEJBH26V7REDWKKAV5TYF3M7NF2OZBELBK2DZTVX3BRNEPVCOAZXJUF` | `0924011abf4652efee26bf27c6402e24522d33819d9229f24d166a6b516157fa` | `a452c350fd3cd4f672ea43f513d73220a64d4b698e50a14390c6fb278147ec53` |
| Weighted-threshold policy | `CDY6CPMPVGQ6GI5UG4BK2HHTQF5ASFYTV23CLFUZJB43DSKZVD5HN4UT` | `6d88893bb51dfa5c981ea1cba3c2f6f3cb053b683f117ea2f8c76e48b6cb8b26` | `93439d62cbe26b41e582a605f2f04b18c0b552055755f3747163685bb1d77e69` |
| Spending-limit policy | `CBCGTERZ6W2M6SMKVKQDTNKWFQXEPXEQO6ZCEKNZHT3QMA4X7Z2IYUS4` | `f385236c54e670a2bbb708a72d6341e1f08391275759108b18b1ffea09cec912` | `7a6aa0cd1ae15e8e6d4dc83971fea0f5e69ddffec0e5b0d367a8c7cd2e94eda9` |

Mainnet uploads charged 90.6817757 XLM after resource-fee refunds.
The five instance deployments charged another 0.0915088 XLM.

## Deterministic deployment and verification

Reusable contract salts are the SHA-256 digest of:

```text
smart-account-kit:<full-upstream-commit>:<network>:<component-role>
```

Every reusable testnet and mainnet contract was fetched back with
`stellar contract fetch --id ...` and re-hashed with
`stellar contract info hash --wasm ...`. Every fetched hash matched the local
optimized artifact above. The mainnet account WASM was also fetched directly by
its WASM hash and matched.
