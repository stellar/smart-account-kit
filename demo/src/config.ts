/**
 * Demo configuration.
 *
 * Reads deployment addresses from Vite env vars with testnet defaults so the
 * demo works out of the box. Copy `.env.example` to `.env` to override.
 */
import { Networks } from "@stellar/stellar-sdk";

export type PolicyType =
  | "threshold"
  | "spending_limit"
  | "weighted_threshold"
  | "custom";

/** A known, deployed policy contract that can be attached to context rules. */
export interface KnownPolicy {
  type: PolicyType;
  name: string;
  description: string;
  address: string;
}

/** stellar-accounts v0.8.0 account build. New demo wallets deploy it. */
const V080_ACCOUNT_WASM_HASH =
  "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";
/** stellar-accounts v0.7.3: the 1e513890 build plus the GHSA-jpg9-m7w4-c7wc fix. */
const V073_ACCOUNT_WASM_HASH =
  "203e2970d9fed24fb5fca2e0aeebb3c1e4648b76dd6601567178e6474c9fec6f";
/** stellar-contracts@1e513890 account build, the demo default before v0.8.0. */
const LEGACY_ACCOUNT_WASM_HASH =
  "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a";

/**
 * Code a connected wallet may run. A wallet born on `1b5f4534…` can upgrade to
 * either newer build, so all three stay accepted.
 */
export const ACCEPTED_WASM_HASHES: readonly string[] = [
  V080_ACCOUNT_WASM_HASH,
  V073_ACCOUNT_WASM_HASH,
  LEGACY_ACCOUNT_WASM_HASH,
];

/**
 * Code accepted at wallet birth: the current default and the previous one.
 * The demo never deployed `203e2970…`, so no demo wallet was born on it.
 */
export const ACCEPTED_BIRTH_WASM_HASHES: readonly string[] = [
  V080_ACCOUNT_WASM_HASH,
  LEGACY_ACCOUNT_WASM_HASH,
];

/**
 * Add the deploy hash to an accepted list, so a hash set in the config panel
 * can still connect the wallets it deploys.
 */
export function withAccountWasmHash(
  hashes: readonly string[],
  accountWasmHash: string
): string[] {
  const normalized = accountWasmHash.toLowerCase();
  return hashes.includes(normalized) ? [...hashes] : [normalized, ...hashes];
}

export const CONFIG = {
  rpcUrl: import.meta.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET,
  accountWasmHash: import.meta.env.VITE_ACCOUNT_WASM_HASH || V080_ACCOUNT_WASM_HASH,
  webauthnVerifierAddress:
    import.meta.env.VITE_WEBAUTHN_VERIFIER_ADDRESS ||
    "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F",
  nativeTokenContract:
    import.meta.env.VITE_NATIVE_TOKEN_CONTRACT ||
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  ed25519VerifierAddress:
    import.meta.env.VITE_ED25519_VERIFIER_ADDRESS ||
    "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4",
  // Contract discovery (optional; known networks have built-in defaults)
  indexerUrl: import.meta.env.VITE_INDEXER_URL || undefined,
  indexerAuthToken: import.meta.env.VITE_INDEXER_AUTH_TOKEN || undefined,
  // Relayer fee sponsoring is on by default through the testnet proxy.
  // The shared default deployer is sign-only. Clearing this URL makes direct
  // submission fail unless the application supplies a funded deployerSecret.
  // Every non-testnet configuration must supply a matching relayer URL.
  relayerUrl:
    import.meta.env.VITE_RELAYER_URL ??
    "https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev",
} as const;

/** All candidate policy contracts (before filtering by configured address). */
const ALL_POLICIES: KnownPolicy[] = [
  {
    type: "threshold",
    name: "Threshold (M-of-N)",
    description: "Requires M signatures out of N total signers",
    address:
      import.meta.env.VITE_THRESHOLD_POLICY_ADDRESS ||
      "CAZ2WFUDXGX265LOEARFEOYYUL6F4BYWXZLGUAWZNJY3MRFPNLSZVS4S",
  },
  {
    type: "spending_limit",
    name: "Spending Limit",
    description: "Limits spending to a maximum amount per time period",
    address:
      import.meta.env.VITE_SPENDING_LIMIT_POLICY_ADDRESS ||
      "CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5",
  },
  {
    type: "weighted_threshold",
    name: "Weighted Threshold",
    description:
      "Requires minimum total weight from signers with different voting weights",
    address: import.meta.env.VITE_WEIGHTED_THRESHOLD_POLICY_ADDRESS || "",
  },
];

/** Known policy contracts, filtered to those with a configured address. */
export const KNOWN_POLICIES: KnownPolicy[] = ALL_POLICIES.filter((policy) =>
  Boolean(policy.address)
);

/**
 * The stellar-contracts@1e513890 policies (testnet and mainnet). Rules created
 * before the v0.8.0 default still use them. The demo reads and labels them,
 * but does not offer them for new rules.
 */
const LEGACY_POLICIES: KnownPolicy[] = [
  ["threshold", "CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG"],
  ["threshold", "CCEJBH26V7REDWKKAV5TYF3M7NF2OZBELBK2DZTVX3BRNEPVCOAZXJUF"],
  ["spending_limit", "CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G"],
  ["spending_limit", "CBCGTERZ6W2M6SMKVKQDTNKWFQXEPXEQO6ZCEKNZHT3QMA4X7Z2IYUS4"],
  ["weighted_threshold", "CCMZ6X4KM3RC7HXWCZDTH7CMWIJXFPN6HLGKJBM63MCOW2AJ2V5W7YXY"],
  ["weighted_threshold", "CDY6CPMPVGQ6GI5UG4BK2HHTQF5ASFYTV23CLFUZJB43DSKZVD5HN4UT"],
].map(([type, address]) => {
  const current = ALL_POLICIES.find((policy) => policy.type === type)!;
  return {
    ...current,
    name: `${current.name} (1e513890)`,
    address,
  };
});

/**
 * Every policy contract the demo can read: the configured ones first, then the
 * 1e513890 deployments that existing rules reference.
 */
export const RECOGNIZED_POLICIES: KnownPolicy[] = [
  ...KNOWN_POLICIES,
  ...LEGACY_POLICIES.filter(
    (legacy) => !KNOWN_POLICIES.some((policy) => policy.address === legacy.address)
  ),
];

/** Whether the weighted-threshold policy is configured/visible in the UI. */
export const WEIGHTED_THRESHOLD_ENABLED = Boolean(
  import.meta.env.VITE_WEIGHTED_THRESHOLD_POLICY_ADDRESS?.trim()
);

/**
 * Build a stable IndexedDB store name namespaced by network + deployment so
 * switching config does not mix credentials across contract surfaces.
 *
 * Wallet addresses depend on the deployer and the credential, not on the
 * account WASM. The accepted account builds therefore share one store. It
 * keeps the `1b5f4534…` name, so credentials saved before the v0.8.0 default
 * stay visible.
 */
export function buildDemoStorageName(
  networkPassphrase: string,
  accountWasmHash: string,
  webauthnVerifierAddress: string
): string {
  const networkKey = networkPassphrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const storageWasmHash = ACCEPTED_WASM_HASHES.includes(accountWasmHash.toLowerCase())
    ? LEGACY_ACCOUNT_WASM_HASH
    : accountWasmHash;

  return [
    "smart-account-kit-demo",
    networkKey,
    storageWasmHash.slice(0, 16),
    webauthnVerifierAddress.slice(0, 16).toLowerCase(),
  ].join(":");
}
