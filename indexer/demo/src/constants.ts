/**
 * Constants for Indexer Demo
 */

// ============================================================================
// Network Configuration
// ============================================================================

/** Default hosted indexer URL for the checked-in demo (Mercury testnet). Override via env or UI for mainnet. */
export const DEFAULT_INDEXER_URL = "https://testnet.mercurydata.app/rest/smart-account-indexer";

/** Default RPC URL for the checked-in demo (testnet). Override via env or UI for mainnet. */
export const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";

/** Default Stellar network passphrase for the checked-in demo (testnet). */
export const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Default smart-account WASM hash used by the checked-in demo (stellar-accounts v0.8.0). */
export const DEFAULT_ACCOUNT_WASM_HASH =
  "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1";

/** Default WebAuthn verifier used by the checked-in demo. */
export const DEFAULT_WEBAUTHN_VERIFIER_ADDRESS =
  "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F";

// ============================================================================
// Known Policy Contracts (testnet)
// ============================================================================
// Used to read live policy params via the SDK's typed policy clients. Contracts
// using different policy addresses fall back to the indexer's install_params.

/** Default simple-threshold policy contract (testnet, stellar-accounts v0.8.0). */
export const DEFAULT_THRESHOLD_POLICY_ADDRESS =
  "CAZ2WFUDXGX265LOEARFEOYYUL6F4BYWXZLGUAWZNJY3MRFPNLSZVS4S";

/** Default spending-limit policy contract (testnet, stellar-accounts v0.8.0). */
export const DEFAULT_SPENDING_LIMIT_POLICY_ADDRESS =
  "CC3CEYQAP6NPNFIYSWL5MVZRCPJZGWX4XO7WDEJOUVGO2FZX5OONYPA5";

/** Default weighted-threshold policy contract (testnet, stellar-accounts v0.8.0). */
export const DEFAULT_WEIGHTED_THRESHOLD_POLICY_ADDRESS =
  "CDBYLFLUNPAYGE3AHZSMB4TFWECFCCHX6CJFMFO6HRPKK2W5PFU2LCKE";

/**
 * Other deployed policy contracts that the demo reads: the stellar-accounts
 * v0.8.0 mainnet policies, and the stellar-contracts@1e513890 policies (testnet
 * and mainnet) that rules created before the v0.8.0 defaults still use.
 */
export const OTHER_POLICY_ADDRESSES = {
  threshold: [
    "CA5YFFXY2ZKR3676EYNKEH6T7QEMWVGGPV7J2POZ27FNHCQGFKD6AIEN", // v0.8.0 mainnet
    "CB3FATQKCIRIQOCYRUPCQ2KREQ7T4RPKS7EAEOZWPEPUKWEDRVROBCEG", // 1e513890 testnet
    "CCEJBH26V7REDWKKAV5TYF3M7NF2OZBELBK2DZTVX3BRNEPVCOAZXJUF", // 1e513890 mainnet
  ],
  spending_limit: [
    "CDB2CVES2QMAL73US4EEAM43B4V3MBEP4K6I2UM7XZ25O4GGQE5CY3UG", // v0.8.0 mainnet
    "CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G", // 1e513890 testnet
    "CBCGTERZ6W2M6SMKVKQDTNKWFQXEPXEQO6ZCEKNZHT3QMA4X7Z2IYUS4", // 1e513890 mainnet
  ],
  weighted_threshold: [
    "CD4U2LCISSOJ4JL3OKQDD7F732D67BG3CGHIOSTPWKUNLCYKE4G4MFOT", // v0.8.0 mainnet
    "CCMZ6X4KM3RC7HXWCZDTH7CMWIJXFPN6HLGKJBM63MCOW2AJ2V5W7YXY", // 1e513890 testnet
    "CDY6CPMPVGQ6GI5UG4BK2HHTQF5ASFYTV23CLFUZJB43DSKZVD5HN4UT", // 1e513890 mainnet
  ],
} as const;

// ============================================================================
// Ledger Constants
// ============================================================================

/** Approximate number of ledgers per day (~5 seconds per ledger) */
export const LEDGERS_PER_DAY = 17280;

/** Number of stroops (smallest unit) per XLM */
export const STROOPS_PER_XLM = 10_000_000;

// ============================================================================
// Display Constants
// ============================================================================

/** Number of characters to show at start of truncated address */
export const TRUNCATE_START_CHARS = 8;

/** Number of characters to show at end of truncated address */
export const TRUNCATE_END_CHARS = 8;

/**
 * Truncate a contract ID or address for display
 */
export function truncateAddress(address: string, startChars = TRUNCATE_START_CHARS, endChars = TRUNCATE_END_CHARS): string {
  if (address.length <= startChars + endChars + 3) {
    return address;
  }
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}
