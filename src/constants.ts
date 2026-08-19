/**
 * Constants used throughout the Smart Account Kit SDK.
 *
 * @packageDocumentation
 */

// ============================================================================
// WebAuthn Configuration
// ============================================================================

/** Default timeout for WebAuthn operations in milliseconds */
export const WEBAUTHN_TIMEOUT_MS = 60000;

// ============================================================================
// Stellar smart contract configuration
// ============================================================================

/** Number of stroops per XLM (1 XLM = 10,000,000 stroops) */
export const STROOPS_PER_XLM = 10_000_000;

/** Reserve XLM amount to keep when funding via Friendbot */
export const FRIENDBOT_RESERVE_XLM = 5;

// ============================================================================
// Cryptographic Constants
// ============================================================================

/** Size of an uncompressed secp256r1 (P-256) public key in bytes */
export const SECP256R1_PUBLIC_KEY_SIZE = 65;

/** First byte of an uncompressed secp256r1 public key (0x04) */
export const UNCOMPRESSED_PUBKEY_PREFIX = 0x04;

/** Size of an Ed25519 public key in bytes (= External signer key data). */
export const ED25519_PUBLIC_KEY_SIZE = 32;

/** Size of an Ed25519 signature in bytes. */
export const ED25519_SIGNATURE_SIZE = 64;

// ============================================================================
// Contract Limits
// ============================================================================
//
// These mirror the deployed stellar-accounts contract constants (see
// scratchpad #576 §E). Client-side validation against them produces clear
// SDK errors instead of opaque on-chain failures.

/** Maximum signers per context rule (contract: MAX_SIGNERS). */
export const MAX_SIGNERS = 15;

/** Maximum policies per context rule (contract: MAX_POLICIES). */
export const MAX_POLICIES = 5;

/** Maximum context rule name length, in UTF-8 bytes (contract: MAX_NAME_SIZE). */
export const MAX_NAME_SIZE = 20;

/** Maximum External signer key-data length, in bytes (contract: MAX_EXTERNAL_KEY_SIZE). */
export const MAX_EXTERNAL_KEY_SIZE = 256;

// ============================================================================
// Context-rule discovery probe defaults (single source of truth)
// ============================================================================

/** Highest context-rule id probed directly on-chain when the indexer is behind. */
export const DEFAULT_MAX_PROBED_RULE_ID = 8;

/** Stop probing after this many consecutive misses. */
export const DEFAULT_MAX_CONSECUTIVE_PROBE_MISSES = 3;

/** Default timeout (seconds) for read-only getter simulations. */
export const DEFAULT_READ_TIMEOUT_SECONDS = 30;

// ============================================================================
// Deployer
// ============================================================================

/**
 * Seed for the default (deterministic) deployer keypair.
 *
 * Deriving the deployer from a fixed, well-known seed makes contract addresses
 * reproducible across clients from a credential ID alone (no per-user deployer
 * state). The deployer only salts the deploy; it never controls the smart
 * account. This determinism is intentional and load-bearing for keyId → contract
 * discovery — the seed value must not change.
 *
 * SECURITY: the seed and resulting key are public. The account is shared and
 * must never hold value or pay fees. The SDK uses it only for deployment
 * authorization. Use a relayer or a dedicated `deployerSecret` instead. See
 * docs/security-deterministic-deployer.md.
 */
export const DEFAULT_DEPLOYER_SEED = "openzeppelin-smart-account-kit";

// ============================================================================
// Storage Configuration
// ============================================================================

/** Default IndexedDB database name */
export const DB_NAME = "smart-account-kit";

/** Current IndexedDB schema version */
export const DB_VERSION = 2;

/** LocalStorage key for credentials */
export const LOCALSTORAGE_CREDENTIALS_KEY = "smart-account-kit:credentials";

/** LocalStorage key for session */
export const LOCALSTORAGE_SESSION_KEY = "smart-account-kit:session";

// ============================================================================
// Session Configuration
// ============================================================================

/** Default session expiration time in milliseconds (7 days) */
export const DEFAULT_SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// Ledger Configuration
// ============================================================================

/** Approximate number of ledgers per hour (~5 seconds per ledger) */
export const LEDGERS_PER_HOUR = 720;

/** Approximate number of ledgers per day */
export const LEDGERS_PER_DAY = 17280;

/** Approximate number of ledgers per week */
export const LEDGERS_PER_WEEK = 120960;

/** Buffer ledgers for auth entry expiration to ensure they don't expire during signing */
export const AUTH_ENTRY_EXPIRATION_BUFFER = 100;

// ============================================================================
// Network URLs
// ============================================================================

/** Stellar Friendbot URL for testnet funding */
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

// ============================================================================
// Indexer Configuration
// ============================================================================

/** Default timeout for indexer requests in milliseconds */
export const DEFAULT_INDEXER_TIMEOUT_MS = 10000;

/** Default timeout for relayer requests in milliseconds (6 minutes for testnet retries) */
export const DEFAULT_RELAYER_TIMEOUT_MS = 360000;

// ============================================================================
// IndexedDB Configuration
// ============================================================================

/** IndexedDB store name for credentials */
export const IDB_STORE_CREDENTIALS = "credentials";

/** IndexedDB store name for session data */
export const IDB_STORE_SESSION = "session";

/** IndexedDB key for current session */
export const IDB_SESSION_KEY = "current";

/** IndexedDB index name for contract ID lookups */
export const IDB_INDEX_CONTRACT_ID = "contractId";

/** IndexedDB index name for creation date sorting */
export const IDB_INDEX_CREATED_AT = "createdAt";

/** IndexedDB index name for primary credential filtering */
export const IDB_INDEX_IS_PRIMARY = "isPrimary";

// ============================================================================
// API Paths
// ============================================================================

/** Indexer API path for credential lookup */
export const API_PATH_LOOKUP = "/api/lookup";

/** Indexer API path for address lookup */
export const API_PATH_LOOKUP_ADDRESS = "/api/lookup/address";

/** Indexer API path for contract details */
export const API_PATH_CONTRACT = "/api/contract";

/** Indexer API path for stats */
export const API_PATH_STATS = "/api/stats";
