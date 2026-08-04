# Mainnet hardening — the shared deployer

The shared deterministic deployer's secret is publicly derivable. That is the
design: it is what makes a wallet address reproducible from a credential ID
alone, by any client, with no server. Its safety therefore comes entirely from
**on-chain configuration and an empty balance**, never from secrecy.

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
| `auth_immutable` | `true` | Blocks `account_merge` and freezes the auth flags. Without it the account can be merged away by anyone. |
| Thresholds | `1 / 2 / 3` | High (3) exceeds the master weight (2), so no one can add a signer, change a threshold, or set options. |
| Signers | itself, once | A second signer on a shared identity is someone else's key. |
| Master weight | `2` | Clears medium — which is what lets it authorize a deployment — but not high. |
| Native balance | dust (`< 1 XLM`) | The secret is public. Any real balance is spendable by anyone, immediately. |
| Other assets | none | A trustline balance is exactly as spendable as XLM here. |

Sponsored reserves keep the account's true minimum balance at zero, so the dust
is a leftover, not a requirement.

## What this does and does not buy

**Does:** prevents takeover of the identity. The account cannot be merged, its
signers cannot be changed, and its thresholds cannot be raised or lowered. The
derived-address namespace therefore cannot be seized.

**Does not:** protect a balance. A weight-2 master key still clears the medium
threshold, so it can authorize a payment out. That is not a flaw to be fixed —
it is the same capability that lets the account authorize `create_contract`, and
removing it would break deployment. **The mitigation is that the account holds
nothing.**

> **Never fund this account.** Not on mainnet, not "just enough for fees", not
> temporarily. As of `smart-account-kit@0.5.0` the SDK never uses it as a
> transaction source or fee payer, and no configuration re-enables that, so it
> has no reason to hold a balance. If you find yourself wanting to fund it,
> configure a `relayerUrl` or set your own `deployerSecret` instead.

## If a check fails

1. **Balance is non-dust.** Assume it is already gone; anyone can sweep it. Move
   what remains to an account you control, then find what funded it — an old SDK
   version, a misconfigured integrator, or a manual "fix" — and stop that.
2. **Thresholds or flags drifted.** With `auth_immutable` set this should be
   impossible; if it happened, the flag was not set when you thought. Re-harden
   immediately and treat the derived namespace as suspect until you have
   confirmed no unexpected wallets were deployed.
3. **An extra signer appears.** Same as above, and more urgent — someone else can
   now authorize deployments under this identity.
4. **The account does not exist.** This is the safest state, not a failure. Do
   not create it. Address derivation does not require the account to exist —
   only authorizing a deployment does, and that is the relayer's job.

## Rotation

Do not rotate the deployer. Its address is an input to every derived wallet
address, so changing it moves every wallet and breaks credential-only recovery —
the property the whole design exists to provide. If the identity is ever
genuinely compromised in a way hardening cannot contain, that is a migration,
not a key rotation, and it needs its own plan.

See [`security-deterministic-deployer.md`](./security-deterministic-deployer.md)
for the threat model, the accepted residuals, and the deployer inventory.
