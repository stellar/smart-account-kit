# stellar-accounts v0.7.3 and v0.8.0 contract deployment — 2026-10-25

This manifest records the optimized smart-account contract set built from
[`OpenZeppelin/stellar-contracts@v0.7.3`](https://github.com/OpenZeppelin/stellar-contracts/tree/v0.7.3)
and [`OpenZeppelin/stellar-contracts@v0.8.0`](https://github.com/OpenZeppelin/stellar-contracts/tree/v0.8.0).
It extends [`deployments-protocol-27-2026-07-09.md`](deployments-protocol-27-2026-07-09.md).
The set was rehearsed on testnet, then deployed to testnet and mainnet.

## Build provenance

| | v0.7.3 | v0.8.0 |
|---|---|---|
| Upstream commit | `252b35fe1a39fc524499e97d43cfe4598247a4cd` | `ddc327eb92d63709436da3a8455f641c2d5476c5` |
| Rust/Cargo | `1.91.1` | `1.91.1` |
| `soroban-sdk` | `26.1.0` | `28.0.0` |
| Stellar CLI | `27.0.0` | `28.1.0` |

- Build target: `wasm32v1-none`
- Build flags: `stellar contract build --locked --optimize=true --package <package>`
- Build host: `aarch64-apple-darwin`
- JavaScript SDK used by the kit and the rehearsal scripts: `@stellar/stellar-sdk@16.3.0`

The account WASM is uploaded but not deployed as a singleton.
Each user wallet deploys its own account instance.

### v0.7.3

| Component | Cargo package | Optimized bytes | SHA-256 / network WASM hash | Same as 1e513890 |
|---|---|---:|---|---|
| Smart account | `multisig-account-example` | 42,984 | `203e2970d9fed24fb5fca2e0aeebb3c1e4648b76dd6601567178e6474c9fec6f` | No |
| WebAuthn verifier | `multisig-webauthn-verifier-example` | 12,105 | `e63a030d0f1a1481e36059a4837c433083b33e704c1f9625b7314795b6d72b76` | Yes |
| Ed25519 verifier | `multisig-ed25519-verifier-example` | 1,848 | `60e8798db610bdaf3370d39ebda56ee1dc2c15ce1c3a9e28b528bfa24a06b477` | Yes |
| Threshold policy | `multisig-threshold-policy-example` | 11,956 | `9c73d4810201c8becec8bedb88bad888ae7b53eb6a0dadb120ac2276527a37a8` | No |
| Weighted-threshold policy | `multisig-weighted-threshold-policy-example` | 14,683 | `13c8cfb9b94638e1cdaab2c825781a5554467d7643def2a5d51d98fd02ee499a` | No |
| Spending-limit policy | `multisig-spending-limit-policy-example` | 14,983 | `2f3a00fd045e93f19d9cfc5b76c84954f6f8cf2ab4c2bdd5f075f5be7a2df027` | No |

### v0.8.0

| Component | Cargo package | Optimized bytes | SHA-256 / network WASM hash | Same as 1e513890 |
|---|---|---:|---|---|
| Smart account | `multisig-account-example` | 48,273 | `c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1` | No |
| WebAuthn verifier | `multisig-webauthn-verifier-example` | 12,105 | `c373c9df31dc98831684786806399a0d5ca1095ebc392387fab2f54df998ba60` | No |
| Ed25519 verifier | `multisig-ed25519-verifier-example` | 1,848 | `0421953fa905fe42b684b3c4c19964e6551c64a5a32675c7c3c8c655380681f3` | No |
| Threshold policy | `multisig-threshold-policy-example` | 13,697 | `f72a11de6e2d5d2495d98fe61e04cd13544e64156a5a3be83ef8c2e403d14a94` | No |
| Weighted-threshold policy | `multisig-weighted-threshold-policy-example` | 16,448 | `79b4e299c39c9bfb7a64d03c896b510cee382770714ac9b2f00ee2c9df4c5d13` | No |
| Spending-limit policy | `multisig-spending-limit-policy-example` | 16,506 | `9bc17db0a804d6c82231a268c43bac1413650ea92cac0022e0d0a3b66ddc8189` | No |

v0.8.0 also adds `multisig-account-factory-example`.
This kit does not use it, so this set does not include it.

## Interface changes

The `Policy` and `Verifier` traits are identical at 1e513890, v0.7.3, and v0.8.0.
The account calls `verify`, `install`, `enforce`, and `uninstall` with the same arguments in all three builds.
The `ContextRule` struct is also identical.

v0.7.3 changes only the account code.
v0.7.3 is a release branch from an older commit (`3f81125`) with back-ported account fixes.
That is why its policy hashes differ from 1e513890.
Its spending-limit policy does not have the zero-amount guard that 1e513890 has.
Do not deploy the v0.7.3 policies.

v0.8.0 adds two enum variants that policies decode:

- `ContextRuleType::CreateContractExternalRef(Address, String)`
- `ContractExecutable::ExternalRef(ContractExecutableRef)`

A 1e513890 policy cannot decode these variants.
Its `install` call traps with `Error(Value, MissingValue)` on a `CreateContractExternalRef` rule.
`enforce` decodes the same types, so it is expected to fail on an auth context with an `ExternalRef` executable.
The rehearsal did not test that case.
The v0.8.0 spending-limit policy also lowers `MAX_HISTORY_ENTRIES` from 1000 to 815.
That cap now fits in one ledger entry.

The v0.8.0 verifier hashes change because of `soroban-sdk` 28.0.0 and Stellar CLI 28.1.0.
The Ed25519 verifier source does not change.
The WebAuthn verifier source changes only in one comment.

## Which contracts new wallets use

| Component | v0.7.3 wallets | v0.8.0 wallets |
|---|---|---|
| WebAuthn verifier | Existing 1e513890 contract | Existing 1e513890 contract |
| Ed25519 verifier | Existing 1e513890 contract | Existing 1e513890 contract |
| Threshold policy | Existing 1e513890 or v0.8.0 contract | v0.8.0 contract |
| Weighted-threshold policy | Existing 1e513890 or v0.8.0 contract | v0.8.0 contract |
| Spending-limit policy | Existing 1e513890 or v0.8.0 contract | v0.8.0 contract |

Keep the existing verifiers.
A verifier address is part of each External signer identity.
A new verifier address gives a different signer, and existing passkeys would not match it.

The v0.8.0 policies also work with `1b5f4534…` and `203e2970…` wallets.
Existing wallets keep the policies that their rules already reference.

## Testnet

Deployment source for the policy instances: `GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N`.

| Component | Contract ID | Upload transaction | Deploy transaction |
|---|---|---|---|
| Smart account v0.8.0 | Per-wallet | `208bd769dbfb1de10c03b9d2072ad2099eeab60e77a63a40cf2bf775ecca0983` | — |
| Smart account v0.7.3 | Per-wallet | `a98958140ec50d5a4caa3ba723660a59c988d47169e081a1694da244faed4171` | — |
| Threshold policy | `CAZ2WFUDXGX265LOEARFEOYYUL6F4BYWXZLGUAWZNJY3MRFPNLSZVS4S` | `6d1195788bb98a074f1ddc45f8276dba41a293f72c39a8e8939723c5fdd28fda` | `20b2b7f3683ca0446a1bc22e574b4a214b59424bf6d4f172e91456c89a4757be` |
| Weighted-threshold policy | `CDBYLFLUNPAYGE3AHZSMB4TFWECFCCHX6CJFMFO6HRPKK2W5PFU2LCKE` | `25b679a7376d27a153080f44325f6f2bfd6d251c18ace79dd6957b598845dd22` | `baa70d34cc5179d7fd72d238892215f96761ac3d0a40962ba7943cf80def5ee6` |
| Spending-limit policy | `CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5` | `8225500d20f8acfd0c96a1ec35e8db9fabd5641c0c93270bef719c4f5adf3501` | `5acd2b806eeb0c51b17cfaf363161886bd1f9fd9c1602310c52e6483537df1ff` |

The uploads came from other sources:

- `GCX4FBNSU7VE4ZNGXTPQ57Y4S24WJ3HTARZ73AMUA2BOA7AP2UFP2J3C` uploaded the v0.8.0 account WASM.
- `GBKLYTEMPHMBZ4EVJDBI7E7KVLQRVYDQ7E4J5L26UG5AUEU6SH6AQUFP` uploaded the v0.7.3 account WASM.
- The rehearsal source below uploaded the three policy WASM files with fee bumps.

The three instance deployments charged about 4.02 testnet XLM each.

The verifiers were not redeployed.
Testnet wallets keep `CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F` and `CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4`.

### Rehearsal

A rehearsal source deployed the same WASM files with the same salts first:
`GD6XZLLKQDAZUSTFITXGKZKXJWJWRLPJDFAF7GPY7EJDXLOJ63UUE5LE`.
These contracts are not defaults.

| Component | Rehearsal contract ID | Deploy transaction |
|---|---|---|
| Threshold policy | `CAVKBXMAZMYSH466KXEN5IBGJKPZNQ6BFKGCT745TFBHXGOB2KSUWBJD` | `d97484922b25159c54c84b1c33e6e9e0059e35b3a659b576a0dae913881e57de` |
| Weighted-threshold policy | `CCBR2ED7UMOWXP7MRGY2CRQOPICZ4QA6LOT35ZAIKVAIBXSFAPQHP57Q` | `234c60259c6c293ea731711d5c420a440b03609b9d31425569c019583811f32c` |
| Spending-limit policy | `CAUYXA4KULY7CYM6LE6WAKSPFA7UQPI22VP3MOTYNF5B3XQT7ERRBYC6` | `63bee7a21f287d9e3b4052e5902339456000aeeed13a12a15209debc9c4f6fde` |

Testnet resource fees exceeded the 32-bit transaction fee limit on 2026-10-25.
Each policy upload therefore used a fee bump.
The inner transaction fee was 0, and `sorobanData` carried the full resource fee.
The uploads charged 2,538.30, 3,356.01, and 3,109.06 testnet XLM.

### Rehearsal results

Each wallet had one Ed25519 External signer on its Default rule.
The script added a `CallContract(XLM SAC)` rule with a 5 XLM daily spending limit.
Ed25519 signers and a software P-256 WebAuthn signer did all authorization.

| Account build | Policy set | Wallet |
|---|---|---|
| v0.8.0 `c514d35e…` | 1e513890 | `CAEWGABC6UPLDOETOPJD36QD5WXQY27NQKJ7RQDAOEDL5EWKNNZYVHBR` |
| v0.7.3 `203e2970…` | 1e513890 | `CDIVZODHZOJLPM2TA2FR5N6XTBA6O2E4WGL6KT2BPGKGXYQHROF4OTV2` |
| v0.8.0 `c514d35e…` | v0.8.0 rehearsal | `CAUVFX7ECRRSDMSCRZ2MOQI4GXEXH6YX4UMDHUZ2YKFMVDYXCVJTIFV5` |
| v0.7.3 `203e2970…` | v0.8.0 rehearsal | `CCVBKLONYDYGPPJAECZKCM4RNBEMNN36SFS2WLXPZV33YVIBEVXJ2FSP` |
| 1e513890 `1b5f4534…` | v0.8.0 rehearsal | `CAFSTC73NOZ2PSPFY5HC6LDLISJUDPTJI44RAK4BOXDQTF24YNGAKBI7` |
| v0.8.0 `c514d35e…` | v0.8.0 canonical | `CC4MVWB4GU2M7HALDMBSIUEY5NDH6POS7AM7FUKPCMYFISTHLM7WJKKR` |

Every wallet passed these checks:

- An Ed25519 External signer sent 1 XLM through the existing Ed25519 verifier.
- A 2 XLM transfer under the spending limit passed.
- A transfer over the spending limit failed at simulation with `SpendingLimitExceeded` (#3221).
- A third party settled a payment that `signAuthEntryWithSigners` signed.
- A signature with the wrong digest scheme failed `__check_auth`.
- A WebAuthn External signer sent 1 XLM through the existing WebAuthn verifier.

On the v0.8.0 wallets, every 1e513890 policy failed to install on a `CreateContractExternalRef` rule.
The v0.8.0 threshold and weighted-threshold policies installed on that rule.
The v0.8.0 spending-limit policy rejected it with `OnlyCallContractAllowed` (#3227), as designed.

The run against the canonical testnet policies used these transactions:

| Step | Transaction |
|---|---|
| Deploy the wallet | `32814b2998ebfa62c9b00f55086956208f1ae77fc74086636146b531ca210308` |
| Ed25519 transfer, Default rule | `688b7578a943f18b3a40e1011d49daff8686bcb8744ddb74dc5a8367a29986bd` |
| Add the spending-limit rule | `4dfb396890e7e1fc837c6bc4474167a6b0e009abd5c37ef37ddeea2ca27f0061` |
| Transfer under the limit | `4ef2067b23b84708617544890260633a3e56234852323b2d06b838a06b8f59a2` |
| Third-party settlement | `0b5d9256b336a99ee03300b7102cdd8472ec08e6b94188eb8f968bcc2a9076e7` |
| Add the WebAuthn rule | `e8cda828b567619ccc3663d790698cd2cecb0fc0bf27c8ff25edc50ca38697d1` |
| WebAuthn transfer | `1d19b56823ed8182b87a150f457e741eea3f369a517746885cd60c332d0149f0` |

## Mainnet

Deployment source: `GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N`. A separate account, `GBDVX4VELCDSQ54KQJYTNHXAHFLBCA77ZY2USQBM4CSHTTV7DME7KALE`, supplied 150 XLM in two payments. Transaction `53b8ce46b67e9c17f416e837f128025b4437e6e6dafbb010157e0578c2c18291` sent 120 XLM. Transaction `d6c89132c8f2003e1a5f9c9831dc5d09e4fcc86df26b7bcfddaff57145f47944` sent 30 XLM. The funding account was not a contract deployment source.

| Component | Contract ID | Upload transaction | Deploy transaction |
|---|---|---|---|
| Smart account v0.8.0 | Per-wallet | `d6c71a90b3104649bf7e1811224ef84100310afc5109c012a5944e426bc99f00` | — |
| Smart account v0.7.3 | Per-wallet | `eb4181e0576ec924924b99ef464df70e7d32b6c1af538236b68305310da36e26` | — |
| Threshold policy | `CA5YFFXY2ZKR3676EYNKEH6T7QEMWVGGPV7J2POZ27FNHCQGFKD6AIEN` | `84a5fffb3febe13d65a7cfe748758a4f49bc1c8dbed6da58a1e396ffe7faaf8f` | `b44e667872ff433c2699ff259452d80571f9519b2278e1057bc1f68ed2c8204d` |
| Weighted-threshold policy | `CD4U2LCISSOJ4JL3OKQDD7F732D67BG3CGHIOSTPWKUNLCYKE4G4MFOT` | `6a592302b2afc10832dbdae7875010d92cad5f7df3813eda1d988dee6029af20` | `b81952d94ba3bda80605b1c39b71d555c954e81e041c00bf31f70f73cda32c66` |
| Spending-limit policy | `CDB2CVES2QMAL73US4EEAM43B4V3MBEP4K6I2UM7XZ25O4GGQE5CY3UG` | `a4f11de30ea1981ff7db73fdc23db060d42fa2ea41626d5cd192db40d1f6b329` | `cf81374d05c903f3115a71f553341f839ae1ff62cbada2b5cccc2478a6f0d165` |

The two account uploads charged 83.3093717 XLM after resource-fee refunds.
The three policy uploads charged 40.4646514 XLM.
The three instance deployments charged another 0.0534214 XLM.
The first policy upload attempt failed with `TxInsufficientFee` during surge pricing.
The retry used `--inclusion-fee 50000`.

The verifiers were not redeployed.
Mainnet wallets keep `CB7HENHJ7NF34I5FFXQK7D5I3WWQRGB5O5XO77D3NXMT7LM7LOKRQ5YR` and `CBOOZV2BK5OETGL4Q4KGEBESPRLJFN7DOFWDT7OZGLD7EQEZUVOWUEMC`.

## Deterministic deployment and verification

Reusable contract salts are the SHA-256 digest of:

```text
smart-account-kit:<full-upstream-commit>:<network>:<component-role>
```

- `<network>` is `testnet` or `mainnet`.
- `<component-role>` is `webauthn-verifier`, `ed25519-verifier`, `threshold-policy`, `weighted-threshold-policy`, or `spending-limit-policy`.
- The 2026-07-09 deploy transactions confirm these role names.
- This set uses the v0.8.0 commit `ddc327eb92d63709436da3a8455f641c2d5476c5`.

| Component | Testnet salt | Mainnet salt |
|---|---|---|
| Threshold policy | `fe953ee92bb5d060b9c0ca351c78a5c50d8085ecb6feec93ad3c131216e2be32` | `4199e81bb856750360bb81cba325d8a64cf08fe9a5f824570e30186b1fe5f8a3` |
| Weighted-threshold policy | `3f70eeadccd1f4f4938e2913905bacc93375c7486316c6e34e96e5f7f9fd68e4` | `cb302c4672cfec3f48981fdf4c582e590df68bb8bca2d3ef424ec918c381b8aa` |
| Spending-limit policy | `71b91de4270c592e1963ed0950cb3b255d72f42dca3d8f517be945ace23ec0b2` | `992db11c0d1d639275c1611905884a2145149b29ca3e5115843d4ac8cbd1cd57` |

Every policy contract ID matched its prediction from the deployment source and salt.
Every testnet and mainnet policy was fetched back with `stellar contract fetch --id ...`.
Each one was re-hashed with `stellar contract info hash --wasm ...`.
Every fetched hash matched the local optimized artifact above.
Both account WASMs were fetched by WASM hash from testnet and mainnet, and both matched.
