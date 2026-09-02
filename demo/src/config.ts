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

export const CONFIG = {
  rpcUrl: import.meta.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET,
  accountWasmHash:
    import.meta.env.VITE_ACCOUNT_WASM_HASH ||
    "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a",
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
      "CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG",
  },
  {
    type: "spending_limit",
    name: "Spending Limit",
    description: "Limits spending to a maximum amount per time period",
    address:
      import.meta.env.VITE_SPENDING_LIMIT_POLICY_ADDRESS ||
      "CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G",
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

/** Whether the weighted-threshold policy is configured/visible in the UI. */
export const WEIGHTED_THRESHOLD_ENABLED = Boolean(
  import.meta.env.VITE_WEIGHTED_THRESHOLD_POLICY_ADDRESS?.trim()
);

/**
 * Build a stable IndexedDB store name namespaced by network + deployment so
 * switching config does not mix credentials across contract surfaces.
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

  return [
    "smart-account-kit-demo",
    networkKey,
    accountWasmHash.slice(0, 16),
    webauthnVerifierAddress.slice(0, 16).toLowerCase(),
  ].join(":");
}
