# Security Policy

## Security status

The SDK, demo, relayer proxy, and indexer integration have not received an independent third-party security audit.

Defects can cause unauthorized transactions, loss of access, or permanent asset loss.

The OpenZeppelin Stellar contracts have a [separate audit](https://www.openzeppelin.com/news/stellar-contracts-rc-v0.7.0-audit) with a different scope.
The deployed artifacts use a later source revision than that audit.

Tests and reviews reduce risk.
They do not prove that the software has no defects.

Do not store or control assets you cannot afford to lose.
Limit balances, signer permissions, policy allowances, and relayer permissions.
Monitor accounts and maintain recovery and authorized upgrade paths.

You use this software and related services at your own risk.
The software has no warranty under the terms in [`LICENSE`](./LICENSE).

## Supported versions

Only the latest npm releases receive security fixes.

The current [deployment manifest](./docs/deployments-protocol-27-2026-07-09.md) identifies the repository's integration artifacts.
Existing smart accounts do not upgrade automatically.
Review and authorize upgrades when contract code changes.

## Report a vulnerability privately

Do not open a public issue, pull request, discussion, or chat message for a suspected vulnerability.

Email `tyler@stellar.org` with the subject `smart-account-kit security report`.
If email is unsuitable, request a private channel without including sensitive details.

Include the affected version or commit, impact, reproduction steps, and a minimal proof of concept.
Do not include secrets or personal data.

Use local tests or isolated test accounts.
Do not test public user accounts or move assets that you do not own.

The maintainers will confirm receipt, investigate the report, prepare a fix, and coordinate disclosure with the reporter.
