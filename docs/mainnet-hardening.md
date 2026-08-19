# Mainnet hardening — the shared deployer

The shared deterministic deployer's key is public by design.
This design makes a wallet address reproducible from a credential ID.
Its controls depend on on-chain configuration and an empty balance.

Everything below is about the mainnet account. Testnet is deliberately out of
scope — it holds nothing of value and gets reset.

## Verify

```bash
node scripts/check-mainnet-deployer.mjs           # exits 1 if any invariant fails
node scripts/check-mainnet-deployer.mjs --json    # for CI
```

Run it after any operational change, and on a schedule if you want drift
detection. It is read-only and needs no keys.

## The invariants, and why each one

| Invariant | Value | Why |
|---|---|---|
| `auth_immutable` | `true` | Blocks `account_merge` and freezes the authorization flags. |
| Thresholds | `1 / 2 / 3` | High (3) exceeds the master weight (2), so no one can add a signer, change a threshold, or set options. |
| Signers | itself, once | The shared identity must not have another signer. |
| Master weight | `2` | Clears medium — which is what lets it authorize a deployment — but not high. |
| Native balance | dust (`< 1 XLM`) | The key is public. Any larger balance is unsafe. |
| Other assets | none | The deployer must not hold asset balances. |

Sponsored reserves keep the account's true minimum balance at zero, so the dust
is a leftover, not a requirement.

## What this does and does not buy

**Does:** protects the identity configuration. The account cannot be merged, its
signers cannot be changed, and its thresholds cannot be raised or lowered. The
derived-address namespace therefore cannot be seized.

**Does not:** protect a balance. The deployer must remain unfunded.

> **Never fund this account.**
> Since `smart-account-kit@0.5.0`, the SDK does not use it as a source or fee payer.
> Configure `relayerUrl` or use a dedicated `deployerSecret` instead.

## If a check fails

1. **Balance is non-dust.** Move the remaining balance to an account you control.
   Find and stop the funding source.
2. **Thresholds or flags drifted.** With `auth_immutable` set this should be
   impossible; if it happened, the flag was not set when you thought. Re-harden
   immediately and treat the derived namespace as suspect until you have
   confirmed no unexpected wallets were deployed.
3. **An extra signer appears.** Treat the identity as untrusted and start the migration plan.
4. **The account does not exist.** This is the safest state, not a failure. Do
   not create it. Address derivation does not require the account to exist —
   only authorizing a deployment does, and that is the relayer's job.

## Rotation

Do not rotate the deployer. Its address is an input to every derived wallet
address, so changing it moves every wallet and breaks credential-only recovery.
If the controls fail, use a planned migration.

See [`security-deterministic-deployer.md`](./security-deterministic-deployer.md)
for the security model and required integration rules.
