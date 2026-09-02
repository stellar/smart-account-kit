/**
 * Indexer Client for Smart Account Kit
 *
 * Provides reverse lookups from signer identifiers to unverified wallet candidates.
 * A caller must verify a candidate before treating it as a wallet.
 */

import {
  DEFAULT_INDEXER_TIMEOUT_MS,
  API_PATH_LOOKUP,
  API_PATH_LOOKUP_ADDRESS,
  API_PATH_CONTRACT,
  API_PATH_STATS,
} from "./constants.js";
import { StrKey } from "@stellar/stellar-sdk";

// ============================================================================
// Indexer Response Types
// ============================================================================

/**
 * Summary of a smart account contract from the indexer
 */
export interface IndexedContractSummary {
  /** Smart account contract address (C-address) */
  contract_id: string;
  /** Number of context rules on the contract */
  context_rule_count: number;
  /** Number of External signers (WebAuthn, custom verifiers) */
  external_signer_count: number;
  /** Number of Delegated signers (G-addresses) */
  delegated_signer_count: number;
  /** Number of Native signers */
  native_signer_count: number;
  /** First ledger where events were seen */
  first_seen_ledger: number;
  /** Most recent ledger where events were seen */
  last_seen_ledger: number;
  /** Array of context rule IDs on this contract */
  context_rule_ids: number[];
  /** WASM hash from the immutable creation transaction. */
  birth_wasm_hash?: string;
  /** Transaction hash that created this contract. */
  creation_transaction_hash?: string;
  /** Ledger that created this contract. */
  creation_ledger?: number;
  /** Current WASM hash confirmed by the indexer through RPC. */
  current_wasm_hash?: string;
  /** Whether this address matches the configured deployer and credential salt. */
  derived_address?: boolean;
  /** Whether another candidate exists for the same credential. */
  collision?: boolean;
  /** True when any required indexer or RPC fact is unavailable. */
  incomplete?: boolean;
}

/** Minimum immutable facts needed to verify a wallet birth. */
export interface WalletCandidate {
  contractId: string;
  birthWasmHash: string;
  creationTransactionHash: string;
  creationLedger: number;
}

/** A complete schema-2 reverse-lookup result. */
export interface IndexedWalletCandidate extends WalletCandidate {
  currentWasmHash: string;
  derivedAddress: boolean;
  collision: boolean;
}

/** A lookup is usable only when every candidate is complete and current. */
export type WalletCandidateLookup =
  | {
      schema: 2;
      complete: true;
      indexedThroughLedger: number;
      candidates: IndexedWalletCandidate[];
    }
  | {
      schema?: number;
      complete: false;
      indexedThroughLedger?: number;
      candidates: Partial<IndexedWalletCandidate>[];
    };

/**
 * A signer as stored in the indexer
 */
export interface IndexedSigner {
  /** Signer type: 'External', 'Delegated', or 'Native' */
  signer_type: "External" | "Delegated" | "Native";
  /** Verifier contract address (for External) or G-address (for Delegated) */
  signer_address: string | null;
  /** Credential ID for External signers (hex-encoded), null for Delegated */
  credential_id: string | null;
}

/**
 * A policy as stored in the indexer
 */
export interface IndexedPolicy {
  /** Policy contract address */
  policy_address: string;
  /** Installation parameters (JSON) */
  install_params: unknown | null;
}

/**
 * A context rule with its signers and policies
 */
export interface IndexedContextRule {
  /** Context rule ID */
  context_rule_id: number;
  /** Signers in this rule */
  signers: IndexedSigner[];
  /** Policies in this rule */
  policies: IndexedPolicy[];
}

/**
 * Response from credential ID lookup
 */
export interface CredentialLookupResponse {
  /** The credential ID that was looked up */
  credentialId: string;
  /** Contracts associated with this credential */
  contracts: IndexedContractSummary[];
  /** Number of contracts found */
  count: number;
  /** Security schema version. Only schema 2 carries wallet-birth facts. */
  schema?: number;
  /** True only after a complete scan and live RPC confirmation. */
  complete?: boolean;
  /** Latest ledger fully reflected by this response. */
  indexed_through_ledger?: number;
}

/**
 * Response from address lookup
 */
export interface AddressLookupResponse {
  /** The address that was looked up */
  signerAddress: string;
  /** Contracts associated with this address */
  contracts: IndexedContractSummary[];
  /** Number of contracts found */
  count: number;
}

/**
 * Response from contract details endpoint
 */
export interface ContractDetailsResponse {
  /** The contract ID */
  contractId: string;
  /** Summary statistics */
  summary: IndexedContractSummary;
  /** Active context rules with signers and policies */
  contextRules: IndexedContextRule[];
}

/**
 * Response from stats endpoint
 */
export interface IndexerStatsResponse {
  stats: {
    total_events: number;
    unique_contracts: number;
    unique_credentials: number;
    first_ledger: number;
    last_ledger: number;
    eventTypes: Array<{
      event_type: string;
      count: number;
    }>;
  };
}

// ============================================================================
// Indexer Client
// ============================================================================

/**
 * Configuration for the IndexerClient
 */
export interface IndexerConfig {
  /** Base URL of the indexer API */
  baseUrl: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /**
   * Optional provider token sent as an Authorization bearer token.
   *
   * The default provider (Mercury) serves its read endpoints anonymously, so
   * this is optional — supply one only for a provider that requires it. Browser
   * applications expose this value to end users; never use a privileged token
   * or account credential here.
   */
  authToken?: string;
}

/**
 * Default indexer URLs for known networks.
 *
 * As of v0.4.0 the default provider is Mercury (https://mercurydata.app), a
 * hosted managed indexer. Its read endpoints are public, so no token is required
 * for the lookups the SDK performs. Override via `indexerUrl` to use any
 * wire-compatible provider.
 */
export const DEFAULT_INDEXER_URLS: Record<string, string> = {
  "Test SDF Network ; September 2015":
    "https://testnet.mercurydata.app/rest/smart-account-indexer",
  "Public Global Stellar Network ; September 2015":
    "https://mainnet.mercurydata.app/rest/smart-account-indexer",
};

/**
 * Client for querying the smart account indexer.
 *
 * The indexer returns unverified candidates associated with signer identifiers.
 * Use SDK connection verification before trusting a candidate.
 *
 * @example
 * ```typescript
 * const indexer = new IndexerClient({
 *   baseUrl: 'https://testnet.mercurydata.app/rest/smart-account-indexer'
 * });
 *
 * // Find contracts by credential ID (from passkey)
 * const result = await indexer.lookupByCredentialId(credentialId);
 *
 * // Find contracts by G-address (for delegated signers)
 * const result = await indexer.lookupByAddress('GABCD...');
 *
 * // Get full contract details
 * const details = await indexer.getContractDetails('CABC...');
 * ```
 */
export class IndexerClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly authToken?: string;

  constructor(config: IndexerConfig) {
    // Remove trailing slash if present
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_INDEXER_TIMEOUT_MS;
    this.authToken = config.authToken;
  }

  /**
   * Create an IndexerClient for a specific network passphrase.
   * Uses the default indexer URL for known networks.
   *
   * @param networkPassphrase - The Stellar network passphrase
   * @param config - Optional timeout and bearer-token configuration
   * @returns IndexerClient configured for the network, or null if no default URL exists
   */
  static forNetwork(
    networkPassphrase: string,
    config: Omit<IndexerConfig, "baseUrl"> = {}
  ): IndexerClient | null {
    const url = DEFAULT_INDEXER_URLS[networkPassphrase];
    if (!url) return null;
    return new IndexerClient({ baseUrl: url, ...config });
  }

  /**
   * Look up smart account contracts by credential ID.
   *
   * This is the primary lookup method for passkey-based signers.
   * The credential ID comes from WebAuthn authentication.
   *
   * @param credentialId - Hex-encoded credential ID (from passkey)
   * @returns Contracts associated with this credential
   */
  async lookupByCredentialId(
    credentialId: string
  ): Promise<CredentialLookupResponse> {
    // Ensure credential ID is lowercase hex
    const normalizedId = credentialId.toLowerCase().replace(/^0x/, "");
    const response = await this.fetch<CredentialLookupResponse>(
      `${API_PATH_LOOKUP}/${normalizedId}`
    );
    // Convert string counts to numbers (postgres returns strings for bigint)
    return {
      ...response,
      contracts: response.contracts.map(this.normalizeContractSummary),
    };
  }

  /**
   * Resolve schema-2 wallet candidates without inventing missing birth data.
   * Legacy and malformed responses remain incomplete and cannot connect.
   */
  async lookupWalletCandidates(
    credentialId: string
  ): Promise<WalletCandidateLookup> {
    const normalizedCredentialId = credentialId.toLowerCase().replace(/^0x/, "");
    const response = await this.lookupByCredentialId(normalizedCredentialId);
    const indexedThroughLedger = normalizePositiveInteger(
      response.indexed_through_ledger
    );
    const candidates = response.contracts
      .map(parseWalletCandidate)
      .filter(
        (candidate): candidate is IndexedWalletCandidate =>
          candidate !== undefined
      );
    const contractIds = new Set(
      candidates.map((candidate) => candidate.contractId)
    );
    const responseCount = Number(response.count);
    const collisionExpected = candidates.length > 1;
    const complete =
      response.schema === 2 &&
      response.complete === true &&
      indexedThroughLedger !== undefined &&
      typeof response.credentialId === "string" &&
      response.credentialId.toLowerCase().replace(/^0x/, "") ===
        normalizedCredentialId &&
      Number.isSafeInteger(responseCount) &&
      responseCount >= 0 &&
      responseCount === response.contracts.length &&
      candidates.length === response.contracts.length &&
      contractIds.size === candidates.length &&
      candidates.every(
        (candidate) =>
          candidate.creationLedger <= indexedThroughLedger &&
          candidate.collision === collisionExpected
      );

    if (!complete) {
      return {
        ...(response.schema !== undefined ? { schema: response.schema } : {}),
        complete: false,
        ...(indexedThroughLedger !== undefined ? { indexedThroughLedger } : {}),
        candidates,
      };
    }
    return {
      schema: 2,
      complete: true,
      indexedThroughLedger,
      candidates,
    };
  }

  /**
   * Look up smart account contracts by signer address.
   *
   * This works for both:
   * - G-addresses (Delegated signers)
   * - C-addresses (External signer verifier contracts)
   *
   * @param address - Stellar address (G... or C...)
   * @returns Contracts associated with this address
   */
  async lookupByAddress(address: string): Promise<AddressLookupResponse> {
    const response = await this.fetch<AddressLookupResponse>(
      `${API_PATH_LOOKUP_ADDRESS}/${address}`
    );
    return {
      ...response,
      contracts: response.contracts.map(this.normalizeContractSummary),
    };
  }

  /**
   * Get detailed information about a smart account contract.
   *
   * Returns the current state including:
   * - Contract summary statistics
   * - Active context rules (excluding removed ones)
   * - Signers for each rule
   * - Policies for each rule
   *
   * @param contractId - Smart account contract address (C...)
   * @returns Contract details or null if not found
   */
  async getContractDetails(
    contractId: string
  ): Promise<ContractDetailsResponse | null> {
    try {
      const response = await this.fetch<ContractDetailsResponse>(
        `${API_PATH_CONTRACT}/${contractId}`
      );
      return {
        ...response,
        summary: this.normalizeContractSummary(response.summary),
      };
    } catch (error) {
      // Return null for 404 (contract not found)
      if (error instanceof IndexerError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get indexer statistics.
   *
   * Useful for debugging and monitoring.
   */
  async getStats(): Promise<IndexerStatsResponse> {
    return this.fetch<IndexerStatsResponse>(API_PATH_STATS);
  }

  /**
   * Check if the indexer is healthy and reachable.
   */
  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.fetch<{ status: string }>("/");
      return response.status === "ok";
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async fetch<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new IndexerError(
          `Indexer request failed: ${response.status} ${response.statusText}`,
          response.status,
          errorBody
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof IndexerError) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new IndexerError("Indexer request timed out", 0);
      }
      throw new IndexerError(
        `Indexer request failed: ${error instanceof Error ? error.message : String(error)}`,
        0
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Normalize contract summary counts from strings to numbers.
   * PostgreSQL returns bigint as strings in JSON.
   */
  private normalizeContractSummary(
    summary: IndexedContractSummary
  ): IndexedContractSummary {
    return {
      ...summary,
      context_rule_count: Number(summary.context_rule_count),
      external_signer_count: Number(summary.external_signer_count),
      delegated_signer_count: Number(summary.delegated_signer_count),
      native_signer_count: Number(summary.native_signer_count),
      first_seen_ledger: Number(summary.first_seen_ledger),
      last_seen_ledger: Number(summary.last_seen_ledger),
    };
  }
}

const HASH_HEX = /^[0-9a-f]{64}$/;

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeHash(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.toLowerCase().replace(/^0x/, "");
  return HASH_HEX.test(normalized) ? normalized : undefined;
}

function parseWalletCandidate(
  contract: IndexedContractSummary
): IndexedWalletCandidate | undefined {
  const birthWasmHash = normalizeHash(contract.birth_wasm_hash);
  const creationTransactionHash = normalizeHash(
    contract.creation_transaction_hash
  );
  const creationLedger = normalizePositiveInteger(contract.creation_ledger);
  const currentWasmHash = normalizeHash(contract.current_wasm_hash);
  if (
    !StrKey.isValidContract(contract.contract_id) ||
    !birthWasmHash ||
    !creationTransactionHash ||
    creationLedger === undefined ||
    !currentWasmHash ||
    typeof contract.derived_address !== "boolean" ||
    typeof contract.collision !== "boolean" ||
    contract.incomplete !== false
  ) {
    return undefined;
  }
  return {
    contractId: contract.contract_id,
    birthWasmHash,
    creationTransactionHash,
    creationLedger,
    currentWasmHash,
    derivedAddress: contract.derived_address,
    collision: contract.collision,
  };
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown by IndexerClient operations
 */
export class IndexerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string
  ) {
    super(message);
    this.name = "IndexerError";
  }
}
