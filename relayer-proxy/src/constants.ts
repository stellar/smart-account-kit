/**
 * Constants for Smart Account Relayer Proxy
 */

// ============================================================================
// Service Metadata
// ============================================================================

/** Service name for health checks */
export const SERVICE_NAME = "smart-account-relayer-proxy";

// ============================================================================
// Network URLs
// ============================================================================

/** Stellar Friendbot URL for testnet funding */
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

// ============================================================================
// API Key Configuration
// ============================================================================

/** KV storage key prefix for API keys */
export const API_KEY_PREFIX = "api-key:";

/** Possible field names for API key in response */
export const API_KEY_FIELD_NAMES = ["apiKey", "api_key", "key", "token"] as const;

/** Minimum length for valid API key response */
export const API_KEY_MIN_LENGTH = 10;

/** Maximum length for valid API key response */
export const API_KEY_MAX_LENGTH = 200;

// ============================================================================
// Stellar Address Validation
// ============================================================================

/** Length of Stellar account address (G-address) */
export const STELLAR_ADDRESS_LENGTH = 55;

/** Regex pattern for extracting missing account from error */
export const MISSING_ACCOUNT_PATTERN = /Account not found:\s*(G[A-Z0-9]{55})/;

// ============================================================================
// Retry Configuration
// ============================================================================

/** Duration to retry on testnet when channel accounts need funding (5 minutes) */
export const TESTNET_RETRY_DURATION_MS = 5 * 60 * 1000;

// ============================================================================
// Abuse Prevention
// ============================================================================

export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DEFAULT_RATE_LIMIT_PER_IP = 10;
export const DEFAULT_RATE_LIMIT_GLOBAL = 100;
export const DEFAULT_MAX_RESOURCE_FEE_STROOPS = 1_000_000n;
export const SIMULATION_SOURCE =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

export const DEFAULT_WALLET_FUNCTIONS = [
  "execute",
  "upgrade",
  "add_policy",
  "remove_policy",
  "add_signer",
  "remove_signer",
  "add_context_rule",
  "remove_context_rule",
  "batch_add_signer",
  "update_context_rule_name",
  "update_context_rule_valid_until",
] as const;

// ============================================================================
// HTTP Headers
// ============================================================================

export const IP_HEADERS = {
  CF_CONNECTING_IP: "CF-Connecting-IP",
} as const;

/** Default IP value when none can be determined */
export const UNKNOWN_IP = "unknown";
