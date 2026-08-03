# Deterministic deployer security model

The shared deterministic deployer is intentional. Its published seed makes a
wallet address reproducible from the network, deployer address, and
credential-derived salt. The deployer is never a signer on the resulting smart
account and cannot authorize wallet operations or move wallet funds.

## Status: sign-only is implemented

The current SDK enforces this invariant for the shared default deployer:

> The shared deployer may derive an address and sign the CreateContractV2
> Soroban authorization entry. It never supplies a transaction-envelope source,
> sequence, or fee and never signs the transaction envelope.

Shared deployments therefore require a relayer. `createWallet()` and
`credentials.deploy()` return `relayerPayload: { func, auth }`; a missing
relayer, direct RPC, and relayer-to-RPC fallback are refused. A custom
`deployerSecret` remains a separate, self-sourced path and may return
`signedTransaction`.

This path is implemented and testnet-verified:

- smart-account-kit transaction
  `1de0c40e61504ecfcb630e2ef5ac033c18df157da781a6d4c6a16a7c6fc33f08`
- passkey-kit transaction
  `60e51c9c14c9c3f664c0f69c56179e9a677cd3e9137e74fb6a4ed1a176c63869`

In each validation, a separate funded account supplied the envelope source and
fee, the shared deployer signed only address authorization, and the deployed
contract matched the deterministically derived address.

## We deliberately do not self-brick

We will not set the current shared deployer's sequence to `INT64_MAX`. Published
SDK versions still read or source its account sequence, and self-bricking would
retroactively break those clients. The current SDK does not read that sequence
or use the account as an envelope source, so a third party setting it to
`INT64_MAX` is a non-event for new shared deployments. Deliberately doing the
same thing ourselves would add effectively no protection while breaking old
clients.

No on-chain self-brick is part of this remediation.

## What `INT64_MAX` does and does not mean

Setting an account's sequence to `INT64_MAX` prevents that account from being
the **transaction-envelope source**, because it cannot supply a valid next
sequence number. That is the complete protection supplied by the sequence
brick. It does **not**:

- protect the account's balance;
- stop another account's envelope from naming it as an operation source, with
  its normal signer and threshold checks; or
- affect Soroban address authorization, which uses address credentials,
  signer weight/policy, and an authorization nonce rather than the classic
  account sequence.

The publicly derivable key can therefore still authorize classic operations
whose threshold it meets, including a payment sourced from the deployer. Never
fund a shared deployer.

The current mainnet smart-account-kit and passkey-kit deployers use
`auth_immutable`, thresholds `1/2/3`, and a single signer of weight `2`. This
blocks high-threshold signer changes and account merge, but it does not protect
the balance from medium-threshold payments. These controls bound takeover; the
SDK's sign-only architecture removes the shared sequence and balance from its
deployment path.

## Accepted residual: address squatting

The contract address does not bind the wallet WASM hash or constructor signer
set. Anyone who learns a credential ID before its intended deployment can use
the public deployer key to place arbitrary code at the derived address first.

This is an accepted, documented residual:

- Stellar does not expose a public transaction mempool that reveals a pending
  credential ID.
- A normal WebAuthn registration does not publish its credential ID before the
  client deploys, and a new registration creates a fresh credential.
- The realistic window is a leaked/reused ID or a delayed/failed deployment.
- The impact is griefing or a deposit sent to the wrong precomputed address,
  not control of a correctly deployed wallet. The deployer is never a wallet
  signer.

A signer-set-equality check **alone is not a mitigation**. Arbitrary code at a
squatted address can implement `get_signer`, `list`, or an equivalent getter and
return whatever signer set the client expects. Any future mitigation must first
bind the accepted WASM/code identity independently, then validate signer and
policy state against that trusted code.

## Deployer inventory

| Generation | Derivation | Address | State / action |
|---|---|---|---|
| Current smart-account-kit | `sha256("openzeppelin-smart-account-kit")` seed | `GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N` | Shared sign-only identity; do not fund or rotate. |
| Current passkey-kit | `sha256("kalepail")` seed | `GC2C7AWLS2FMFTQAHW3IBUB4ZXVP4E37XNLEF2IK7IVXBB6CMEPCSXFO` | Shared sign-only identity; do not fund or rotate. |
| Legacy passkey-kit mainnet, before `23597d8` | `sha256(mainnet network passphrase)` seed | `GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7` | Locked: master weight `0`; cannot sign. |
| Legacy passkey-kit testnet, before `23597d8` | `sha256(testnet network passphrase)` seed | `GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H` | Still live: thresholds `0/0/0`, master weight `1`, holding about 13,067 XLM plus TUSDC. Harden or retire this testnet account. |

Changing a deployer changes the address preimage for every wallet derived from
it. Keep legacy identities in discovery/migration logic; do not rotate a
deployer as a fee-management shortcut.
