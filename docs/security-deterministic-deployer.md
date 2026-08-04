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

`createWallet()` and `credentials.deploy()` return
`relayerPayload: { func, auth }`. **Building** that payload requires nothing —
it only signs an authorization entry, spends no balance, consumes no sequence,
and confers no privilege (the deployer's key is public, so anyone can produce
the same signature). Callers running their own submission infrastructure can
therefore build with `autoSubmit: false` and submit through any funded source
they control.

**Submission** is what is constrained: the SDK's own auto-submit path goes
through the relayer, and a missing relayer, direct RPC, and relayer-to-RPC
fallback are all refused — because those would source or fund from the shared
deployer. A custom `deployerSecret` remains a separate, self-sourced path and
may return `signedTransaction`.

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
- **Across networks, that last point does not hold.** Deploying a wallet
  publishes its credential ID: it is stored on-chain in the signer entry, and
  `IndexerClient.getContractDetails` serves it from a keyless public endpoint
  (`src/indexer.ts`). The network passphrase is part of the address preimage but
  the credential ID is not network-scoped, so the same passkey maps to a
  different, not-yet-deployed address on every other network. Anyone can
  therefore read a testnet wallet's credential ID and occupy the matching
  mainnet address — no race, no leak, no access to the user. Register a fresh
  credential per network rather than reusing a passkey that already has a
  wallet deployed on another one.
- **Same-network, the "before deployment" framing also fails for secondary
  credentials.** Only a wallet's first credential salts its deploy, so
  `derive(credentialId_1)` is the wallet itself. Every signer added later
  publishes its credential ID on-chain, yet `derive(credentialId_2)` is a
  distinct address that is never legitimately deployed — and is therefore
  squattable indefinitely, with no race and no leak. A single-credential wallet
  has only the narrower leaked/reused-ID or delayed-deployment window; a
  multi-credential wallet has a permanently open one per secondary credential.
- The impact is griefing or a deposit sent to the wrong precomputed address,
  not control of a correctly deployed wallet. The deployer is never a wallet
  signer.
- `connectWithCredentials` resolves from stored credentials first and only falls
  back to derivation (`src/kit/wallet-ops.ts`), so a returning user with local
  state is not misbound by a squat. It then confirms the resolved address with
  an **instance-existence check only** — which a squatted contract passes. The
  sibling passkey-kit additionally verifies that the credential is a live signer
  on the wallet. Closing this properly needs the code-identity binding described
  next, not a signer check alone; it is a tracked follow-up.

A signer-set-equality check **alone is not a mitigation**. Arbitrary code at a
squatted address can implement `get_signer`, `get_signer_id`, `list`, or an
equivalent getter and return whatever the client expects. Any future mitigation
must first bind the accepted WASM/code identity independently, then validate
signer and policy state against that trusted code.

Binding that identity is cheap: the connect path already fetches the contract
instance ledger entry to test existence, so the executable WASM hash is in hand at
no extra round-trip. Comparing it against accepted hashes — an allowlist rather
than a single value, since a legitimately upgraded account runs different code —
is the sound form, and is what ships (see below).

It is a partial mitigation, not a cure, and the gap is wider than "must then also
be a real signer" would suggest: making the victim a real signer is free. This
`__constructor` accepts a signer **array** and a policy map, and the victim's key
material is public, so an account can be deployed running accepted code on which
the victim genuinely is a signer while authority rests elsewhere. Code identity
passes, and so does any signer-**presence** check.

The predicate that excludes this is signer **and policy** equality against
trusted local state, not presence. That is only available where trusted state
exists — which is the storage-first path already shipped, and precisely what a
fresh device lacks. So the allowlist hardens the derivation fallback against
lying code; it does not authenticate a derived address.

What defeats every check in this section is that each reads **current state**,
which at a squatted address the squatter wrote. The one class of check that
escapes that is deploy-time provenance — see the genesis-provenance follow-up
below, which is tracked as the mitigation that does close this path.

## Why code identity is bound before signer state

An address obtained from an indexer reverse lookup or from address derivation is
a **claim by an untrusted party**, not a fact. Neither the discovery signal nor
the on-chain state read back is self-authenticating: contract-emitted events are
unprivileged, and a contract controls its own storage, so code of the author's
choosing can present whatever state a client inspects.

So an account's signer state only means something **if the code that wrote it
enforced authorization**. Under arbitrary code it means nothing. This is
independent of the deployer key — it needs no derived address and no squatting,
and it is why a bare signer-presence check was never shipped here.

### What is enforced (since `0.6.0`)

`connectWithCredentials` checks the resolved account's executable against
`acceptedWasmHashes` whenever the address came from an untrusted source —
derivation, or an app-supplied `contractId` such as a discovery result. Defaults
to `[accountWasmHash]`. The check reuses the contract instance entry the path
already fetched for its existence probe, so it costs no extra round-trip. An
address resolved from trusted local storage is not checked, so a legitimately
upgraded account still opens for a returning user.

### What this does and does not cover

It removes the case that costs an attacker nothing — arbitrary code, deployed
once. It does not make a discovery result authoritative on its own: an attacker
willing to run accepted code and pay for a genuine, authorized signer addition can
still produce an account on which the victim really is a signer, and for a
secondary credential on a device with no local state that is not distinguishable
client-side from the real account.

Bound that residual in the flow rather than with another state check:

- Never auto-select from a multi-candidate reverse lookup.
  `discoverContractsByCredential` returns a list and forces an explicit choice —
  that is the correct shape; keep it.
- Surface provenance (genesis credential, code identity) at selection.
- Prefer recovery with the credential that created the account, which reduces to
  the derivation case that genesis provenance closes.
- Keep an unverified discovery result unauthenticated — never present it as a
  deposit address.

Until `0.5.1`, connecting or syncing **deleted a credential's stored wallet
mapping**, so storage-first resolution stopped protecting that credential on
every subsequent connect and a secondary credential fell back to derivation in
ordinary use. Fixed: a stored row is now discarded only when it is a pending
deployment — an empty `contractId`, or one equal to its own derived address —
so a secondary credential keeps its mapping. The WASM-hash binding above remains
the outstanding half.

Operational verification of the mainnet geometry below is scripted — see
[`mainnet-hardening.md`](./mainnet-hardening.md) and
`scripts/check-mainnet-deployer.mjs`, which exits non-zero on drift.

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

## Operational follow-ups (outside this change)

Open ops tasks, not SDK defects. The sign-only SDK works without them; they
reduce operational risk on testnet and on shared infrastructure.

- Harden the testnet deployers (`0/0/0` today) and make post-reset provisioning
  fail closed, so a network reset cannot recreate an unhardened `AccountEntry`
  that address authorization then depends on. The relayer proxy already refuses
  to Friendbot-fund a shared deployer.
- Sweep or retire the legacy passkey-kit testnet deployer listed above — its key
  is publicly derivable, so anyone can move its balance today.
- Source shared infrastructure deploys (verifier, policy, WASM upload) from a
  dedicated funded account rather than a shared deployer.
- **Verify genesis provenance on the connect path.** For an address reached by
  derivation, require that the contract's genesis signer set is exactly the
  credential derived from, and that its genesis policies are empty — both read
  from the constructor arguments of the creating transaction (equivalently the
  contract's first signer events), never from current state.

  This is the check that closes the derivation fallback, and it works where the
  state checks do not: every state read at a squatted address returns what the
  squatter wrote, whereas genesis is immutable history. It also needs no trusted
  local state — only the `credentialId` already in hand — which is why it covers
  the fresh-device case that signer-set equality cannot.

  An attacker cannot both pass it and hold authority. Genesis
  `[victim]` with empty policies leaves them with no key and no way to obtain one
  (`add_signer` and `upgrade` require wallet auth). Anything else — an extra
  constructor signer, or a policy granting them authority — is a detectable
  mismatch. The policy half is not optional here: this constructor takes a signer
  **array** and a policy **map**, so `signers: [victim]` with an attacker policy
  would pass a signers-only check while handing over control.

  Note the residual: it does not make derivation authoritative for a secondary
  credential, whose derived address no legitimate deploy occupies. It guarantees
  only that whatever sits there is not attacker-controlled — theft degrades to a
  duplicate wallet the victim solely controls.

  It also closes the **derivation path only**. An indexer-returned candidate is
  not at a derived address and has no expected genesis relationship to a
  secondary credential, so this check cannot validate one. See below.

- ~~Bind code identity on the connect path.~~ **Shipped in `0.6.0`** — see
  "Why code identity is bound before signer state" above.

  Implementation is indexer-side: this reads history, so RPC event retention will
  not cover older contracts. It is not blind trust in the indexer, since its
  answer names a transaction the client can fetch and verify.

  **Supersedes the previously tracked WASM-hash allowlist.** An allowlist binds
  code identity and is worth having against lying code, but it does not bind the
  constructor signer set or policy map, so it cannot authenticate an address on
  its own. Explicitly still **not** a bare signer-presence check — a squatted
  contract answers `get_signer_id` with whatever the client wants.
  *(The other half of this item — keeping a non-pending credential's stored
  mapping instead of deleting it — shipped in `0.5.1`.)*
