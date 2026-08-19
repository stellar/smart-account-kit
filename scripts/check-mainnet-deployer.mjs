#!/usr/bin/env node
/**
 * Verify the shared deterministic deployer's mainnet hardening.
 *
 * The deployer's key is public by design. On-chain configuration and an empty
 * balance provide its required controls. This script verifies those controls.
 *
 * Read-only. Exits non-zero if any invariant fails, so it can run in CI or cron.
 *
 *   node scripts/check-mainnet-deployer.mjs            # the shared deployer
 *   node scripts/check-mainnet-deployer.mjs G...        # any address
 *   node scripts/check-mainnet-deployer.mjs --json
 */
import { Keypair, hash } from "@stellar/stellar-sdk";
import { DEFAULT_DEPLOYER_SEED } from "../dist/constants.js";

const HORIZON = process.env.HORIZON_URL ?? "https://horizon.stellar.org";

const args = process.argv.slice(2);
const json = args.includes("--json");
const address =
  args.find((a) => a.startsWith("G")) ??
  Keypair.fromRawEd25519Seed(hash(Buffer.from(DEFAULT_DEPLOYER_SEED))).publicKey();

/**
 * Required geometry. The account must keep its identity configuration and a
 * minimal balance.
 */
const CHECKS = [
  {
    id: "auth_immutable",
    why: "blocks account_merge and freezes the auth flags",
    check: (a) => a.flags.auth_immutable === true,
    actual: (a) => String(a.flags.auth_immutable),
    expected: "true",
  },
  {
    id: "thresholds",
    why: "high=3 exceeds the master weight, so signers and thresholds cannot be changed",
    check: (a) =>
      a.thresholds.low_threshold === 1 &&
      a.thresholds.med_threshold === 2 &&
      a.thresholds.high_threshold === 3,
    actual: (a) =>
      `${a.thresholds.low_threshold}/${a.thresholds.med_threshold}/${a.thresholds.high_threshold}`,
    expected: "1/2/3",
  },
  {
    id: "sole_signer",
    why: "the shared identity must contain only its expected signer",
    check: (a) => a.signers.length === 1 && a.signers[0].key === a.account_id,
    actual: (a) => a.signers.map((s) => `${s.key.slice(0, 8)}…:${s.weight}`).join(","),
    expected: "the account itself, once",
  },
  {
    id: "master_weight",
    why: "weight 2 clears medium (authorize a deploy) but not high (change signers)",
    check: (a) => a.signers.some((s) => s.key === a.account_id && s.weight === 2),
    actual: (a) => String(a.signers.find((s) => s.key === a.account_id)?.weight),
    expected: "2",
  },
  {
    id: "balance_is_dust",
    why: "the public shared account must keep only a minimal balance",
    // Sponsored reserves put the true minimum at zero; dust is the reserve
    // left over from before sponsorship. Anything above this is someone
    // funding an account they should not fund.
    check: (a) => Number(native(a)) < 1,
    actual: (a) => `${native(a)} XLM`,
    expected: "< 1 XLM",
  },
  {
    id: "no_other_assets",
    why: "the shared deployer must not hold other assets",
    check: (a) => a.balances.filter((b) => b.asset_type !== "native").length === 0,
    actual: (a) =>
      String(a.balances.filter((b) => b.asset_type !== "native").length) + " non-native",
    expected: "none",
  },
];

const native = (a) =>
  a.balances.find((b) => b.asset_type === "native")?.balance ?? "0";

const res = await fetch(`${HORIZON}/accounts/${address}`);
if (!res.ok) {
  // A missing account is not automatically a failure: an unfunded deployer is
  // the safest possible state, and on a reset network it is the normal one.
  // It is only wrong if something then recreates it without hardening.
  const msg =
    res.status === 404
      ? `${address} does not exist on ${HORIZON}. Nothing to harden — but do not fund it.`
      : `Horizon ${res.status} for ${address}`;
  console.log(json ? JSON.stringify({ address, exists: false, note: msg }) : msg);
  process.exit(res.status === 404 ? 0 : 2);
}
const account = await res.json();

const results = CHECKS.map((c) => ({
  id: c.id,
  pass: c.check(account),
  expected: c.expected,
  actual: c.actual(account),
  why: c.why,
}));
const failed = results.filter((r) => !r.pass);

if (json) {
  console.log(JSON.stringify({ address, horizon: HORIZON, results, ok: !failed.length }, null, 2));
} else {
  console.log(`deployer ${address}`);
  console.log(`horizon  ${HORIZON}\n`);
  for (const r of results) {
    console.log(`${r.pass ? "ok  " : "FAIL"}  ${r.id.padEnd(16)} ${r.actual}`);
    if (!r.pass) console.log(`      expected ${r.expected} — ${r.why}`);
  }
  console.log(
    failed.length
      ? `\n${failed.length} invariant(s) failed. See docs/mainnet-hardening.md.`
      : "\nAll invariants hold."
  );
}

process.exit(failed.length ? 1 : 0);
