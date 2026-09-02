/**
 * Smart Account Kit
 *
 * TypeScript SDK for deploying and managing OpenZeppelin Smart Account contracts
 * on Stellar with WebAuthn passkey authentication.
 *
 * @packageDocumentation
 */

// Main client SDK
export { SmartAccountKit } from "./kit.js";

// Sub-manager types
export type {
  SignerManager,
  ContextRuleManager,
  PolicyManager,
  CredentialManager,
  MultiSignerManager,
  MultiSignerOptions,
} from "./kit.js";

// External signer types
export {
  ExternalSignerManager,
  type ExternalSigner,
  type WalletStorage,
} from "./external-signers.js";

// SDK Types
export type {
  // Configuration
  SmartAccountConfig,
  PolicyConfig,

  // Credentials & Sessions
  StoredCredential,
  StoredSession,
  CredentialDeploymentStatus,
  StorageAdapter,

  // Results
  CreateWalletResult,
  ConnectWalletResult,
  TransactionResult,
  TransactionSuccess,
  TransactionFailure,
  SubmissionOptions,
  SubmissionMethod,

  // External Wallet Integration
  ExternalWalletAdapter,
  ConnectedWallet,

  // Multi-Signer
  SelectedSigner,

  // Shared signing/submission option types
  SignOptions,
  SubmitOptions,
  SignAndSubmitOptions,
  ResolveContextRuleIds,
} from "./types.js";

// Contract Types (re-exported from bindings)
export type {
  // Contract Signer types
  Signer as ContractSigner,

  // Context Rules
  ContextRule,
  ContextRuleType,
  AuthPayload,
} from "smart-account-kit-bindings";
export type {
  WebAuthnSigData,
  SimpleThresholdAccountParams,
  WeightedThresholdAccountParams,
  SpendingLimitAccountParams,
  SpendingLimitData,
  SpendingEntry,
} from "./contract-types.js";

// Storage adapters
export {
  MemoryStorage,
  LocalStorageAdapter,
  IndexedDBStorage,
} from "./storage/index.js";

// Constants (public API - implementation details are internal)
export {
  // Useful timing constants
  WEBAUTHN_TIMEOUT_MS,
  // Transaction/funding constants
  STROOPS_PER_XLM,
  FRIENDBOT_RESERVE_XLM,
  // Contract limits (mirror the deployed contract)
  MAX_SIGNERS,
  MAX_POLICIES,
  MAX_NAME_SIZE,
  MAX_EXTERNAL_KEY_SIZE,
  ED25519_PUBLIC_KEY_SIZE,
  ED25519_SIGNATURE_SIZE,
} from "./constants.js";

// Client-side validation of contract limits
export {
  validateContextRule,
  validateContextRuleName,
  validateSigner,
  validateSigners,
  validatePolicyCount,
  validateExternalKeySize,
  validateValidUntil,
} from "./validation.js";

// Error classes
export {
  SmartAccountError,
  SmartAccountErrorCode,
  WalletNotConnectedError,
  WalletCodeNotAcceptedError,
  WalletProvenanceError,
  WalletOwnershipError,
  WalletAmbiguousError,
  CredentialNotFoundError,
  SignerNotFoundError,
  PolicyNotFoundError,
  SimulationError,
  SubmissionError,
  ValidationError,
  WebAuthnError,
  SessionError,
  ContractError,
  wrapError,
} from "./errors.js";

// Contract error decoding
export {
  CONTRACT_ERROR_REGISTRY,
  decodeContractError,
  contractErrorFromCode,
} from "./contract-errors.js";
export type {
  ContractErrorFamily,
  ContractErrorInfo,
} from "./contract-errors.js";

// Utility functions
export {
  xlmToStroops,
  stroopsToXlm,
  validateAddress,
  validateAmount,
  generateChallenge,
} from "./utils.js";

// Builder utilities
export {
  // Signer builders
  createDelegatedSigner,
  createExternalSigner,
  createWebAuthnSigner,
  createEd25519Signer,
  // Context rule type builders
  createDefaultContext,
  createCallContractContext,
  createCreateContractContext,
  // Policy parameter builders
  createThresholdParams,
  createWeightedThresholdParams,
  createSpendingLimitParams,
  // Time period constants (for spending limits)
  LEDGERS_PER_HOUR,
  LEDGERS_PER_DAY,
  LEDGERS_PER_WEEK,
  // Compatibility helpers
  truncateAddress,
  describeSignerType,
  formatSignerForDisplay,
  formatContextType,
} from "./builders.js";
export {
  getCredentialIdFromSigner,
  signersEqual,
  getSignerKey,
  collectUniqueSigners,
} from "./signer-utils.js";

// Signer abstraction (Ed25519 + shared auth-digest core)
export { Ed25519Signer, computeEntryAuthDigest } from "./signers.js";
export type { AuthDigestSigner } from "./signers.js";

// Advanced flows: auth-payload signer encoding + transaction helpers
export { signerToScVal, parseSignerScVal } from "./kit/auth-payload.js";
export {
  buildDirectTokenTransfer,
  buildI128ScVal,
  signFeePayer,
  resimulateAndAssemble,
} from "./kit/tx-ops.js";

// Typed policy clients
export {
  SimpleThresholdPolicyClient,
  WeightedThresholdPolicyClient,
  SpendingLimitPolicyClient,
} from "./policy-clients.js";
export type { PolicyClientDeps } from "./policy-clients.js";

// Event emitter
export { SmartAccountEventEmitter } from "./events.js";
export type {
  SmartAccountEventMap,
  SmartAccountEvent,
  EventListener,
} from "./events.js";

// Indexer client for reverse lookups
export {
  IndexerClient,
  IndexerError,
  DEFAULT_INDEXER_URLS,
} from "./indexer.js";
export type {
  IndexerConfig,
  IndexedContractSummary,
  IndexedWalletCandidate,
  WalletCandidate,
  WalletCandidateLookup,
  IndexedSigner,
  IndexedPolicy,
  IndexedContextRule,
  CredentialLookupResponse,
  AddressLookupResponse,
  ContractDetailsResponse,
  IndexerStatsResponse,
} from "./indexer.js";

// Relayer client for fee-sponsored transactions via proxy
export { RelayerClient, RelayerErrorCodes } from "./relayer.js";
export type {
  RelayerResponse,
  RelayerSendOptions,
  RelayerErrorCode,
} from "./relayer.js";

// Wallet Adapters
export { StellarWalletsKitAdapter } from "./wallet-adapter.js";
export type { StellarWalletsKitAdapterConfig } from "./wallet-adapter.js";

// Re-exported from stellar-sdk for convenience
export { BASE_FEE } from "@stellar/stellar-sdk";
export type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
