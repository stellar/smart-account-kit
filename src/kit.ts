/**
 * SmartAccountKit - Client-side SDK for Smart Account Management
 *
 * This is the main entry point for client applications to create and manage
 * smart wallets secured by WebAuthn passkeys.
 */

import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import {
  hash,
  xdr,
  Keypair,
  Transaction,
  rpc,
  contract,
} from "@stellar/stellar-sdk";

const { Server: RpcServer } = rpc;
const { AssembledTransaction } = contract;

import type {
  SmartAccountConfig,
  StorageAdapter,
  CreateWalletResult,
  ConnectWalletResult,
  TransactionResult,
  SubmissionOptions,
  SubmissionMethod,
  ExternalWalletAdapter,
  PolicyConfig,
  SignOptions,
  SubmitOptions,
  SignAndSubmitOptions,
} from "./types.js";
import { MemoryStorage } from "./storage/memory.js";
import {
  Client as SmartAccountClient,
} from "smart-account-kit-bindings";
import type {
  ContextRule,
  Signer as ContractSigner,
} from "smart-account-kit-bindings";

// Constants
import {
  DEFAULT_DEPLOYER_SEED,
  DEFAULT_SESSION_EXPIRY_MS,
  LEDGERS_PER_HOUR,
} from "./constants.js";

// Error classes
import {
  SmartAccountErrorCode,
  ValidationError,
  WalletNotConnectedError,
  wrapError,
} from "./errors.js";
import { failedTransaction } from "./contract-errors.js";

// Typed policy clients
import {
  SimpleThresholdPolicyClient,
  WeightedThresholdPolicyClient,
  SpendingLimitPolicyClient,
  CONTEXT_RULE_SPEC_TYPE,
  type PolicyClientDeps,
} from "./policy-clients.js";

// Utility functions
import { deriveContractAddress, isDefaultDeployer } from "./utils.js";

// Event emitter
import { SmartAccountEventEmitter } from "./events.js";

// External signer management
import { ExternalSignerManager, type ExternalSigner } from "./external-signers.js";

// Indexer client for contract discovery
import {
  IndexerClient,
  type IndexedContractSummary,
  type ContractDetailsResponse,
} from "./indexer.js";

// Relayer client for fee-sponsored transactions via proxy
import { RelayerClient } from "./relayer.js";

// Manager classes
import {
  SignerManager as SignerManagerClass,
  ContextRuleManager as ContextRuleManagerClass,
  PolicyManager as PolicyManagerClass,
  CredentialManager as CredentialManagerClass,
  MultiSignerManager as MultiSignerManagerClass,
} from "./managers/index.js";
export type {
  SignerManager,
  ContextRuleManager,
  PolicyManager,
  CredentialManager,
  MultiSignerManager,
} from "./managers/index.js";
export type {
  MultiSignerOptions,
} from "./managers/multi-signer-manager.js";

import {
  discoverContractsByCredential,
  discoverContractsByAddress,
  getContractDetailsFromIndexer,
} from "./kit/indexer-ops.js";
import {
  createPasskey,
  authenticatePasskey,
  signAuthEntry,
} from "./kit/webauthn-ops.js";
import {
  createWallet,
  connectWallet,
  connectWithCredentials,
  disconnect,
} from "./kit/wallet-ops.js";
import {
  buildDeployTransaction,
  submitDeploymentTx,
  sharedDeployerFeeError,
  type DeployTransaction,
} from "./kit/deploy-ops.js";
import {
  sign,
  signAndSubmit,
  buildDirectTokenTransfer,
  hasSourceAccountAuth,
  signResimulateAndPrepare,
  shouldUseFeeSponsoring,
  sendAndPoll,
  getSubmissionMethod,
} from "./kit/tx-ops.js";
import { fundWallet } from "./kit/fund-ops.js";
import { convertPolicyParams, buildPoliciesScVal, buildConstructorPolicies } from "./kit/policies-ops.js";
import {
  findWebAuthnSignerForCredential,
  listContextRules,
  resolveContextRuleIdsForEntry,
} from "./kit/context-rules.js";
import { normalizeSignatureExpirationLedger } from "./kit/auth-payload.js";
import { validateAddress, validateAmount, xlmToStroops } from "./utils.js";

/**
 * Per-operation memo shared across all auth entries of a single sign/submit so
 * the connected wallet's context rules (and matched signer) are enumerated once
 * rather than per entry. Not persisted between operations, so it never serves a
 * stale snapshot.
 */
type ConnectedContextRuleCache = {
  rules?: Promise<ContextRule[]>;
  signer?: Promise<ContractSigner>;
};


/**
 * External signer management interface.
 *
 * Provides unified management of G-address signers (Stellar accounts) for
 * multi-signature operations. Supports two methods:
 * 1. Raw secret key - stored in memory only (never persisted)
 * 2. External wallet via StellarWalletsKit (optional)
 *
 * @example
 * ```typescript
 * // Add from raw secret key (memory-only)
 * const { address } = kit.externalSigners.addFromSecret("S...");
 *
 * // Add from external wallet (if SWK configured)
 * const wallet = await kit.externalSigners.addFromWallet();
 *
 * // Check if we can sign for an address
 * if (kit.externalSigners.canSignFor("G...")) {
 *   // SDK will automatically use this signer during multi-sig operations
 * }
 * ```
 */

/**
 * SmartAccountKit - Main client SDK for smart account management
 *
 * @example
 * ```typescript
 * const kit = new SmartAccountKit({
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: 'Test SDF Network ; September 2015',
 *   accountWasmHash: '...',
 *   webauthnVerifierAddress: 'C...',
 *   relayerUrl: 'https://my-relayer-proxy.example.com',
 * });
 *
 * // Create a new wallet
 * const { credentialId, contractId, relayerPayload } = await kit.createWallet('MyApp', 'user@example.com');
 *
 * // Connect to existing wallet
 * const { contractId } = await kit.connectWallet({ credentialId: 'savedCredentialId' });
 *
 * // Sign a transaction
 * const signedTx = await kit.sign(transaction);
 * ```
 */
export class SmartAccountKit {
  // Network configuration
  public readonly rpcUrl: string;
  public readonly networkPassphrase: string;
  public readonly rpc: InstanceType<typeof RpcServer>;

  // Contract configuration
  private readonly accountWasmHash: string;
  /** Accepted code identities, lowercase hex. Never empty. */
  readonly acceptedWasmHashes: readonly string[];
  private readonly webauthnVerifierAddress: string;
  /** Deployed Ed25519 verifier contract address, if configured. */
  public readonly ed25519VerifierAddress?: string;
  /** Default constructor policies applied to new wallets, if configured. */
  private readonly defaultPolicies?: PolicyConfig[];
  private readonly timeoutInSeconds: number;
  private readonly signatureExpirationLedgers: number;
  private readonly probeRuleIds?: {
    maxRuleId?: number;
    maxConsecutiveMisses?: number;
  };

  // WebAuthn configuration
  private readonly rpId?: string;
  private readonly rpName: string;
  private readonly webAuthn: {
    startRegistration: typeof startRegistration;
    startAuthentication: typeof startAuthentication;
  };

  // Storage
  private readonly storage: StorageAdapter;

  // External wallet adapter (optional)
  private readonly externalWalletAdapter?: ExternalWalletAdapter;

  // Session configuration
  private readonly sessionExpiryMs: number;

  // State
  private _credentialId?: string;
  private _contractId?: string;

  /** Smart account contract client (after connection) */
  public wallet?: SmartAccountClient;

  // Contract-address identity and deploy authorizer; only custom deployers source.
  private readonly deployerKeypair: Keypair;

  // True when the deployer matches the shared default identity.
  // Source and fee guards use this identity check.
  private readonly usingSharedDeployer: boolean;

  // ==========================================================================
  // Sub-managers for organized access to contract methods
  // ==========================================================================

  /**
   * Signer management methods.
   * Add, remove, and manage signers on context rules.
   */
  public readonly signers: SignerManagerClass;

  /**
   * Context rule management methods.
   * Create, read, update, and delete context rules.
   */
  public readonly rules: ContextRuleManagerClass;

  /**
   * Policy management methods.
   * Add and remove policies from context rules.
   */
  public readonly policies: PolicyManagerClass;

  /**
   * Credential storage management methods.
   * Manage locally stored credentials for pending deployments.
   */
  public readonly credentials: CredentialManagerClass;

  /**
   * Event emitter for credential lifecycle events.
   * Subscribe to events like walletConnected, credentialCreated, etc.
   *
   * @example
   * ```typescript
   * kit.events.on('walletConnected', ({ contractId }) => {
   *   console.log('Connected to wallet:', contractId);
   * });
   * ```
   */
  public readonly events: SmartAccountEventEmitter;

  /**
   * Multi-signer operations.
   * Execute transactions that require multiple signers (passkeys + external wallets).
   *
   * @example
   * ```typescript
   * const selectedSigners = kit.multiSigners.buildSelectedSigners(signers, activeCredentialId);
   * const result = await kit.multiSigners.transfer(
   *   tokenContract, recipient, amount, selectedSigners
   * );
   * ```
   */
  public readonly multiSigners: MultiSignerManagerClass;

  /**
   * External signer management.
   * Unified interface for managing G-address signers (Stellar accounts) for
   * multi-signature operations.
   *
   * Supports two methods of adding signers:
   * 1. Raw secret key (Keypair) - stored in memory only
   * 2. External wallet via StellarWalletsKit (if configured)
   *
   * @example
   * ```typescript
   * // Add from raw secret key (memory-only, lost on refresh)
   * const { address } = kit.externalSigners.addFromSecret("S...");
   *
   * // Add from external wallet (if SWK configured)
   * const wallet = await kit.externalSigners.addFromWallet();
   *
   * // List all external signers
   * const signers = kit.externalSigners.getAll();
   *
   * // Check if we can sign for an address
   * if (kit.externalSigners.canSignFor("G...")) {
   *   // SDK will automatically use this signer during multi-sig operations
   * }
   * ```
   */
  public readonly externalSigners: ExternalSignerManager;

  /**
   * Indexer client for discovering smart account contracts.
   *
   * The indexer enables reverse lookups from signer credentials to contracts,
   * which is essential for discovering which contracts a user has access to.
   *
   * This is automatically configured for known networks (testnet and mainnet) if not
   * explicitly disabled via `indexerUrl: false` in the config.
   *
   * @example
   * ```typescript
   * // Check if indexer is available
   * if (kit.indexer) {
   *   // Discover contracts by credential ID
   *   const { contracts } = await kit.indexer.lookupByCredentialId(credentialId);
   *
   *   // Discover contracts by G-address
   *   const { contracts } = await kit.indexer.lookupByAddress('GABCD...');
   *
   *   // Get full contract details
   *   const details = await kit.indexer.getContractDetails('CABC...');
   * }
   * ```
   */
  public readonly indexer: IndexerClient | null;

  /**
   * Optional Relayer client for fee-sponsored transaction submission.
   *
   * When configured, allows submitting transactions without paying fees -
   * the fees are sponsored by the Relayer proxy service.
   *
   * The Relayer uses channel accounts for parallel transaction submission with
   * automatic fee bumping, eliminating sequence number conflicts.
   *
   * @example
   * ```typescript
   * // Configure Relayer in the kit
   * const kit = new SmartAccountKit({
   *   // ... other config
   *   relayerUrl: 'https://my-relayer-proxy.example.com',
   * });
   *
   * const { relayerPayload } = await kit.createWallet('MyApp', 'user@example.com');
   * if (kit.relayer && relayerPayload) {
   *   const result = await kit.relayer.send(relayerPayload.func, relayerPayload.auth);
   *   console.log('Hash:', result.hash);
   * }
   * ```
   */
  public readonly relayer: RelayerClient | null;

  constructor(config: SmartAccountConfig) {
    // Validate required config
    const requireConfig = (value: unknown, field: string): void => {
      if (!value) {
        throw new ValidationError(
          `${field} is required`,
          SmartAccountErrorCode.MISSING_CONFIG,
          { field }
        );
      }
    };
    requireConfig(config.rpcUrl, "rpcUrl");
    requireConfig(config.networkPassphrase, "networkPassphrase");
    requireConfig(config.accountWasmHash, "accountWasmHash");
    requireConfig(config.webauthnVerifierAddress, "webauthnVerifierAddress");

    // Network
    this.rpcUrl = config.rpcUrl;
    this.networkPassphrase = config.networkPassphrase;
    this.rpc = new RpcServer(config.rpcUrl);

    // Contracts
    this.accountWasmHash = config.accountWasmHash;
    // Seeded from the deploy hash so the common case is zero-config; an empty
    // array would silently accept nothing, so treat it as "not supplied".
    this.acceptedWasmHashes = (
      config.acceptedWasmHashes?.length
        ? config.acceptedWasmHashes
        : [config.accountWasmHash]
    ).map((h) => h.toLowerCase());
    this.webauthnVerifierAddress = config.webauthnVerifierAddress;
    this.ed25519VerifierAddress = config.ed25519VerifierAddress;
    this.defaultPolicies = config.defaultPolicies;
    this.timeoutInSeconds = config.timeoutInSeconds ?? 30;
    this.signatureExpirationLedgers = config.signatureExpirationLedgers ?? LEDGERS_PER_HOUR; // ~1 hour

    // WebAuthn
    this.rpId = config.rpId;
    this.rpName = config.rpName ?? "Smart Account";
    this.webAuthn = config.webAuthn ?? { startRegistration, startAuthentication };

    // Storage (default to memory if not provided)
    this.storage = config.storage ?? new MemoryStorage();

    // External wallet adapter (optional)
    this.externalWalletAdapter = config.externalWallet;

    // Session configuration
    this.sessionExpiryMs = config.sessionExpiryMs ?? DEFAULT_SESSION_EXPIRY_MS;

    // Indexer client for contract discovery
    // - If indexerUrl is explicitly set to false, disable indexer
    // - If indexerUrl is a string, use that URL
    // - Otherwise, try to use default URL for the network
    if (config.indexerUrl === false) {
      this.indexer = null;
    } else if (typeof config.indexerUrl === "string") {
      this.indexer = new IndexerClient({
        baseUrl: config.indexerUrl,
        authToken: config.indexerAuthToken,
      });
    } else {
      // Try to use the default indexer URL for this network (null if none known)
      this.indexer = IndexerClient.forNetwork(this.networkPassphrase, {
        authToken: config.indexerAuthToken,
      });
    }

    // Relayer client for fee-sponsored transactions via proxy (optional)
    // Only initialize if url is provided
    this.relayer = config.relayerUrl
      ? new RelayerClient(config.relayerUrl)
      : null;

    // Deployer keypair - a custom fee payer (config.deployerSecret) or the
    // deterministic default derived from a fixed seed (see DEFAULT_DEPLOYER_SEED).
    // The default is sign-only: it authorizes the deploy but never pays for it.
    this.deployerKeypair = config.deployerSecret
      ? Keypair.fromSecret(config.deployerSecret)
      : Keypair.fromRawEd25519Seed(hash(Buffer.from(DEFAULT_DEPLOYER_SEED)));

    // Check the resolved identity instead of the configuration path.
    // Source and fee guards always apply to the shared default deployer.
    this.usingSharedDeployer = isDefaultDeployer(this.deployerKeypair.publicKey());
    // Event emitter (initialized first as other managers may use it)
    this.events = new SmartAccountEventEmitter();
    this.probeRuleIds = config.contextRuleProbe?.enabled === false
      ? undefined
      : {
          maxRuleId: config.contextRuleProbe?.maxRuleId,
          maxConsecutiveMisses: config.contextRuleProbe?.maxConsecutiveMisses,
        };

    // External signer manager - unified interface for G-address signers.
    // Persistence uses the configured external-signer storage, defaulting to
    // browser localStorage when available, rather than a hardcoded global.
    const walletStorage =
      config.externalSignerStorage ??
      (typeof localStorage !== "undefined" ? localStorage : undefined);

    this.externalSigners = new ExternalSignerManager(
      this.networkPassphrase,
      this.externalWalletAdapter,
      walletStorage,
      this.ed25519VerifierAddress
    );

    // Initialize sub-managers with dependencies
    this.signers = new SignerManagerClass({
      requireWallet: () => this.requireWallet(),
      storage: this.storage,
      events: this.events,
      webauthnVerifierAddress: this.webauthnVerifierAddress,
      createPasskey: (appName, userName) => this.createPasskey(appName, userName),
    });

    this.rules = new ContextRuleManagerClass({
      requireWallet: () => this.requireWallet(),
      rpc: this.rpc,
      networkPassphrase: this.networkPassphrase,
      timeoutInSeconds: this.timeoutInSeconds,
      getContractDetailsFromIndexer: () => this.getActiveContractDetailsFromIndexer(),
      probeRuleIds: this.probeRuleIds,
    });

    this.policies = new PolicyManagerClass({
      requireWallet: () => this.requireWallet(),
    });

    this.credentials = new CredentialManagerClass({
      storage: this.storage,
      rpc: this.rpc,
      events: this.events,
      rpName: this.rpName,
      getContractId: () => this._contractId,
      setConnectedState: (contractId, credentialId) => {
        this._contractId = contractId;
        this._credentialId = credentialId;
      },
      initializeWallet: (contractId) => this.initializeWallet(contractId),
      createPasskey: (appName, userName) => this.createPasskey(appName, userName),
      buildDeployTransaction: (credentialIdBuffer, publicKey, policies) =>
        this.buildDeployTransaction(credentialIdBuffer, publicKey, policies ?? this.defaultPolicies),
      signWithDeployer: (tx) => this.signWithDeployer(tx),
      submitDeploymentTx: (tx, credentialId, options) =>
        this.submitDeploymentTx(tx, credentialId, options),
      deriveContractAddress: (credentialIdBuffer) =>
        deriveContractAddress(credentialIdBuffer, this.deployerKeypair.publicKey(), this.networkPassphrase),
    });

    this.multiSigners = new MultiSignerManagerClass({
      getContractId: () => this._contractId,
      isConnected: () => this.isConnected,
      getRules: (contextRuleType) => this.rules.getAll(contextRuleType),
      getContractDetailsFromIndexer: () => this.getActiveContractDetailsFromIndexer(),
      requireWallet: () => this.requireWallet(),
      externalSigners: this.externalSigners,
      rpc: this.rpc,
      networkPassphrase: this.networkPassphrase,
      timeoutInSeconds: this.timeoutInSeconds,
      deployerKeypair: this.deployerKeypair,
      deployerPublicKey: this.deployerPublicKey,
      signAuthEntry: (entry, options) => this.signAuthEntry(entry, options),
      sendAndPoll: (tx, options) => this.sendAndPoll(tx, options),
      hasSourceAccountAuth: (tx) => this.hasSourceAccountAuth(tx),
      shouldUseFeeSponsoring: (options) => this.shouldUseFeeSponsoring(options),
    });
  }

  // ==========================================================================
  // Getters
  // ==========================================================================

  /** Currently connected credential ID (Base64URL encoded) */
  get credentialId(): string | undefined {
    return this._credentialId;
  }

  /** Currently connected contract ID */
  get contractId(): string | undefined {
    return this._contractId;
  }

  /** Check if connected to a wallet */
  get isConnected(): boolean {
    return !!this._contractId;
  }

  /**
   * Get the deployer public key.
   *
   * By default this is the shared, deterministic keypair derived from a fixed
   * seed ({@link DEFAULT_DEPLOYER_SEED}). It is used to derive contract
   * addresses (salt) and to sign authorization entries — it must NOT be used as
   * a transaction source or fee payer (the SDK enforces this for the shared
   * default). Override with a dedicated `deployerSecret` to change that.
   */
  get deployerPublicKey(): string {
    return this.deployerKeypair.publicKey();
  }

  // ==========================================================================
  // Contract Discovery (Indexer)
  // ==========================================================================

  /**
   * Discover smart account contracts associated with a credential ID.
   *
   * This uses the indexer to perform a reverse lookup from the credential ID
   * to find all contracts where this credential is registered as a signer.
   *
   * @param credentialId - The credential ID to look up (hex or base64url encoded)
   * @returns Array of contract summaries, or null if indexer is not available
   *
   * @example
   * ```typescript
   * // After WebAuthn authentication, find contracts for the credential
   * const contracts = await kit.discoverContractsByCredential(credentialId);
   * if (contracts && contracts.length > 0) {
   *   // User has access to these contracts
   *   console.log(`Found ${contracts.length} smart accounts`);
   * }
   * ```
   */
  async discoverContractsByCredential(
    credentialId: string
  ): Promise<IndexedContractSummary[] | null> {
    return discoverContractsByCredential(this.indexer, credentialId);
  }

  /**
   * Discover smart account contracts associated with a Stellar address.
   *
   * This works for both G-addresses (Delegated signers) and C-addresses
   * (External signer verifier contracts).
   *
   * @param address - Stellar address (G... or C...)
   * @returns Array of contract summaries, or null if indexer is not available
   *
   * @example
   * ```typescript
   * // Find contracts where this G-address is a delegated signer
   * const contracts = await kit.discoverContractsByAddress('GABCD...');
   * ```
   */
  async discoverContractsByAddress(
    address: string
  ): Promise<IndexedContractSummary[] | null> {
    return discoverContractsByAddress(this.indexer, address);
  }

  /**
   * Get detailed information about a smart account contract from the indexer.
   *
   * Returns the current state including active context rules, signers, and policies.
   * This is useful for displaying contract details and discovering active rule IDs.
   *
   * Note: the SDK relies on the indexer for active rule discovery because the
   * contract does not expose an iterator for active rule IDs.
   *
   * @param contractId - Smart account contract address (C...)
   * @returns Contract details or null if not found/indexer unavailable
   */
  async getContractDetailsFromIndexer(
    contractId: string
  ): Promise<ContractDetailsResponse | null> {
    return getContractDetailsFromIndexer(this.indexer, contractId);
  }

  private async getActiveContractDetailsFromIndexer(): Promise<ContractDetailsResponse | null> {
    if (!this._contractId) {
      return null;
    }

    return getContractDetailsFromIndexer(this.indexer, this._contractId);
  }

  // ==========================================================================
  // Private Helpers - Connection Guards
  // ==========================================================================

  /**
   * Require that a wallet is connected and return the wallet client and contract ID.
   * Throws if not connected.
   * @internal
   */
  private requireWallet(): { wallet: SmartAccountClient; contractId: string } {
    if (!this._contractId || !this.wallet) {
      throw new WalletNotConnectedError();
    }
    return { wallet: this.wallet, contractId: this._contractId };
  }

  /**
   * Initialize the wallet client for a contract.
   * @internal
   */
  private initializeWallet(contractId: string): void {
    this.wallet = new SmartAccountClient({
      contractId,
      networkPassphrase: this.networkPassphrase,
      rpcUrl: this.rpcUrl,
    });
  }

  /**
   * Update connection state and initialize wallet client.
   * @internal
   */
  private setConnectedState(contractId: string, credentialId: string): void {
    this._contractId = contractId;
    this._credentialId = credentialId;
    this.initializeWallet(contractId);
  }

  /**
   * Clear connection state.
   * @internal
   */
  private clearConnectedState(): void {
    this._contractId = undefined;
    this._credentialId = undefined;
    this.wallet = undefined;
  }

  /**
   * Sign an assembled transaction with the deployer keypair.
   * @internal
   */
  private async signWithDeployer<T>(
    tx: contract.AssembledTransaction<T>
  ): Promise<void> {
    await tx.sign(
      contract.basicNodeSigner(this.deployerKeypair, this.networkPassphrase)
    );
  }

  /**
   * Calculate expiration ledger from current ledger.
   * @internal
   */
  private async calculateExpiration(): Promise<number> {
    const { sequence } = await this.rpc.getLatestLedger();
    return normalizeSignatureExpirationLedger(sequence + this.signatureExpirationLedgers);
  }

  /**
   * Submit a deployment transaction and update credential storage.
   * On success, deletes the credential from storage.
   * On failure, marks it as failed for retry.
   *
   * Shared deployers submit signed address auth via `{func,auth}`; custom
   * deployers keep the signed-envelope route.
   *
   * @internal
   */
  private async submitDeploymentTx(
    tx: DeployTransaction,
    credentialId: string,
    options?: SubmissionOptions
  ): Promise<TransactionResult> {
    return submitDeploymentTx(
      {
        storage: this.storage,
        rpc: this.rpc,
        relayer: this.relayer,
        deployerKeypair: this.deployerKeypair,
        usingSharedDeployer: this.usingSharedDeployer,
      },
      tx,
      credentialId,
      options
    );
  }

  // ==========================================================================
  // Wallet Creation
  // ==========================================================================

  /**
   * Create a new smart wallet with a passkey as the primary signer
   *
   * @param appName - Application name (displayed to user during passkey creation)
   * @param userName - User identifier (displayed to user during passkey creation)
   * @param options - Additional options
   * @returns Wallet creation result with credential ID, contract ID, and signed transaction
   */
  async createWallet(
    appName: string,
    userName: string,
    options?: {
      nickname?: string;
      authenticatorSelection?: {
        authenticatorAttachment?: "platform" | "cross-platform";
        residentKey?: "discouraged" | "preferred" | "required";
        userVerification?: "discouraged" | "preferred" | "required";
      };
      /**
       * If true, submit and wait for confirmation. The kit connects only after
       * a successful deployment. Default: false.
       */
      autoSubmit?: boolean;
      /** If true and on testnet, fund the wallet via Friendbot after creation. Requires nativeTokenContract. */
      autoFund?: boolean;
      /** Native XLM token SAC address (required for autoFund) */
      nativeTokenContract?: string;
      /** Force a specific submission method (relayer or rpc) */
      forceMethod?: SubmissionMethod;
      /**
       * Constructor policies to install on the new wallet's default context
       * rule. Overrides `config.defaultPolicies` when provided.
       */
      policies?: PolicyConfig[];
    }
  ): Promise<CreateWalletResult & { submitResult?: TransactionResult; fundResult?: TransactionResult & { amount?: number } }> {
    // Fast-fail BEFORE the passkey ceremony when we are going to auto-submit and
    // the only submission path would fund the deploy from the shared default
    // deployer over RPC — so a misconfig does not orphan a freshly-created
    // passkey. (The relayer-failure→RPC fallback can't be predicted here; it
    // stays guarded at submit time.)
    //
    // With `autoSubmit: false` there is deliberately NO relayer requirement: the
    // caller just wants the `{func, auth}` payload, which costs nothing to
    // produce, and may submit it through their own funded source. Submission
    // remains guarded in submitDeploymentTx.
    if (options?.autoSubmit) {
      const method = getSubmissionMethod(this.relayer, { forceMethod: options?.forceMethod });
      const willSubmitViaRpc = method === "rpc" || (method === "relayer" && !this.relayer);
      if (willSubmitViaRpc && this.usingSharedDeployer) {
        throw sharedDeployerFeeError(this.deployerKeypair.publicKey());
      }
    }

    const constructorPolicies = options?.policies ?? this.defaultPolicies;
    return createWallet(
      {
        storage: this.storage,
        events: this.events,
        deployerKeypair: this.deployerKeypair,
        networkPassphrase: this.networkPassphrase,
        sessionExpiryMs: this.sessionExpiryMs,
        createPasskey: (name, user, selection) => this.createPasskey(name, user, selection),
        validateConstructorPolicies: () => {
          // Convert (and thus validate) up front so a bad policy config throws
          // before the passkey ceremony rather than after it.
          if (constructorPolicies?.length) {
            buildConstructorPolicies(constructorPolicies);
          }
        },
        buildDeployTransaction: (credentialIdBuffer, publicKey) =>
          this.buildDeployTransaction(credentialIdBuffer, publicKey, constructorPolicies),
        signWithDeployer: (tx) => this.signWithDeployer(tx),
        submitDeploymentTx: (tx, credentialId, submissionOptions) =>
          this.submitDeploymentTx(tx, credentialId, submissionOptions),
        fundWallet: (nativeTokenContract, fundOptions) =>
          this.fundWallet(nativeTokenContract, fundOptions),
        setConnectedState: (contractId, credentialId) =>
          this.setConnectedState(contractId, credentialId),
      },
      appName,
      userName,
      options
    );
  }

  /**
   * Create a passkey without deploying a wallet.
   * Used internally for wallet creation and adding passkey signers.
   *
   * @internal
   */
  private async createPasskey(
    appName: string,
    userName: string,
    authenticatorSelection?: {
      authenticatorAttachment?: "platform" | "cross-platform";
      residentKey?: "discouraged" | "preferred" | "required";
      userVerification?: "discouraged" | "preferred" | "required";
    }
  ): Promise<{
    rawResponse: RegistrationResponseJSON;
    credentialId: string;
    publicKey: Uint8Array;
  }> {
    return createPasskey(
      {
        rpId: this.rpId,
        rpName: this.rpName,
        webAuthn: this.webAuthn,
      },
      appName,
      userName,
      authenticatorSelection
    );
  }

  // ==========================================================================
  // Wallet Connection
  // ==========================================================================

  /**
   * Authenticate with a passkey without connecting to a specific contract.
   *
   * This is useful when you need to:
   * 1. Get the credential ID first
   * 2. Use the indexer to discover which contracts the passkey has access to
   * 3. Then connect to a specific contract using connectWallet({ contractId, credentialId })
   *
   * @returns The credential ID from the selected passkey
   *
   * @example
   * ```typescript
   * // Step 1: Authenticate to get credential ID
   * const { credentialId } = await kit.authenticatePasskey();
   *
   * // Step 2: Discover contracts via indexer
   * const contracts = await kit.discoverContractsByCredential(credentialId);
   *
   * // Step 3: Let user choose or connect to the first one
   * if (contracts && contracts.length > 0) {
   *   await kit.connectWallet({
   *     contractId: contracts[0].contract_id,
   *     credentialId
   *   });
   * }
   * ```
   */
  async authenticatePasskey(): Promise<{ credentialId: string; rawResponse: AuthenticationResponseJSON }> {
    return authenticatePasskey({
      rpId: this.rpId,
      rpName: this.rpName,
      webAuthn: this.webAuthn,
    });
  }

  /**
   * Connect to an existing smart wallet
   *
   * Behavior based on options:
   * - No options: Silent restore from storage, returns null if no stored session
   * - `{ prompt: true }`: Try stored session first, prompt user if none
   * - `{ fresh: true }`: Ignore stored session, always prompt user
   * - `{ credentialId }`: Connect using specific credential ID
   * - `{ contractId }`: Connect using specific contract ID
   *
   * @param options - Connection options
   * @returns Connection result, or null if no session and not prompting
   *
   * @example
   * ```typescript
   * // Page load - silent restore
   * const result = await kit.connectWallet();
   * if (!result) showConnectButton();
   *
   * // User clicks "Connect Wallet"
   * await kit.connectWallet({ prompt: true });
   *
   * // User clicks "Switch Wallet"
   * await kit.connectWallet({ fresh: true });
   * ```
   */
  async connectWallet(options?: {
    /** Use specific credential ID */
    credentialId?: string;
    /** Use specific contract ID */
    contractId?: string;
    /** Ignore stored session, always prompt user */
    fresh?: boolean;
    /** Prompt user if no stored session (default: false) */
    prompt?: boolean;
  }): Promise<ConnectWalletResult | null> {
    return connectWallet(
      {
        storage: this.storage,
        events: this.events,
        rpId: this.rpId,
        webAuthn: this.webAuthn,
        connectWithCredentials: (credentialId, contractId) =>
          this.connectWithCredentials(credentialId, contractId),
      },
      options
    );
  }

  /**
   * Internal helper to connect with known credentials
   */
  private async connectWithCredentials(
    credentialId?: string,
    contractId?: string
  ): Promise<ConnectWalletResult> {
    return connectWithCredentials(
      {
        storage: this.storage,
        rpc: this.rpc,
        deployerKeypair: this.deployerKeypair,
        networkPassphrase: this.networkPassphrase,
        sessionExpiryMs: this.sessionExpiryMs,
        acceptedWasmHashes: this.acceptedWasmHashes,
        events: this.events,
        setConnectedState: (nextContractId, nextCredentialId) =>
          this.setConnectedState(nextContractId, nextCredentialId),
      },
      credentialId,
      contractId
    );
  }

  /**
   * Disconnect from the current wallet and clear stored session
   */
  async disconnect(): Promise<void> {
    return disconnect({
      storage: this.storage,
      events: this.events,
      clearConnectedState: () => this.clearConnectedState(),
      getContractId: () => this._contractId,
    });
  }

  // ==========================================================================
  // Transaction Signing
  // ==========================================================================

  /**
   * Sign a transaction's auth entries with a passkey.
   *
   * **IMPORTANT**: This method only signs authorization entries. It does NOT
   * re-simulate the transaction. For WebAuthn signatures, you MUST re-simulate
   * before submission because WebAuthn signatures are much larger than the
   * placeholders used during initial simulation.
   *
   * For most use cases, prefer `signAndSubmit()` which handles the full flow:
   * sign → re-simulate → assemble → submit.
   *
   * @param transaction - AssembledTransaction to sign
   * @param options - Signing options
   * @returns The transaction with signed auth entries (NOT ready for direct submission)
   */
  async sign<T>(
    transaction: contract.AssembledTransaction<T>,
    options?: SignOptions
  ): Promise<contract.AssembledTransaction<T>> {
    const ctxRuleCache: ConnectedContextRuleCache = {};
    const resolvedOptions = {
      ...options,
      resolveContextRuleIds: options?.resolveContextRuleIds ?? ((entry: xdr.SorobanAuthorizationEntry) =>
        this.resolveConnectedContextRuleIds(entry, options?.credentialId, ctxRuleCache)),
    };

    const signed = await sign(
      {
        getContractId: () => this._contractId,
        getCredentialId: () => this._credentialId,
        calculateExpiration: () => this.calculateExpiration(),
        signAuthEntry: (entry, signOptions) => this.signAuthEntry(entry, signOptions),
      },
      transaction,
      resolvedOptions
    );

    return signed as contract.AssembledTransaction<T>;
  }

  /**
   * Sign and submit a transaction with proper re-simulation for WebAuthn.
   *
   * This is the recommended method for submitting transactions signed by the
   * smart account's passkey. It handles the full flow:
   * 1. Sign authorization entries with WebAuthn
   * 2. Re-simulate with signed entries (required for accurate resource costs)
   * 3. Assemble the transaction with correct fees
   * 4. Sign with fee payer and submit
   *
   * @param transaction - AssembledTransaction to sign and submit
   * @param options - Signing options
   * @returns Transaction result
   */
  async signAndSubmit<T>(
    transaction: contract.AssembledTransaction<T>,
    options?: SignAndSubmitOptions
  ): Promise<TransactionResult> {
    const ctxRuleCache: ConnectedContextRuleCache = {};
    const resolvedOptions = {
      ...options,
      resolveContextRuleIds: options?.resolveContextRuleIds ?? ((entry: xdr.SorobanAuthorizationEntry) =>
        this.resolveConnectedContextRuleIds(entry, options?.credentialId, ctxRuleCache)),
    };

    return signAndSubmit(
      {
        getContractId: () => this._contractId,
        signResimulateAndPrepare: (hostFunc, authEntries, signOptions) =>
          this.signResimulateAndPrepare(hostFunc, authEntries, signOptions),
        shouldUseFeeSponsoring: (submissionOptions) =>
          this.shouldUseFeeSponsoring(submissionOptions),
        hasSourceAccountAuth: (preparedTx) => this.hasSourceAccountAuth(preparedTx),
        sendAndPoll: (preparedTx, submissionOptions) =>
          this.sendAndPoll(preparedTx, submissionOptions),
        deployerKeypair: this.deployerKeypair,
      },
      transaction,
      resolvedOptions
    );
  }

  /**
   * Sign a single authorization entry with a passkey.
   *
   * This is a low-level method useful for multi-signer flows.
   * For most use cases, prefer:
   * - `signAndSubmit()` for full sign + re-simulate + submit flow
   * - `sign()` to sign auth entries on an AssembledTransaction
   * - `multiSigners.operation()` for multi-signer operations
   *
   * @param entry - The authorization entry to sign
   * @param options - Signing options (credentialId, expiration)
   * @returns The signed authorization entry
   */
  async signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
    options?: {
      credentialId?: string;
      expiration?: number;
      contextRuleIds?: number[];
    }
  ): Promise<xdr.SorobanAuthorizationEntry> {
    return signAuthEntry(
      {
        rpId: this.rpId,
        rpName: this.rpName,
        webAuthn: this.webAuthn,
        networkPassphrase: this.networkPassphrase,
        storage: this.storage,
        calculateExpiration: () => this.calculateExpiration(),
        getCredentialId: () => this._credentialId,
        requireWallet: () => this.requireWallet(),
        rpc: this.rpc,
        timeoutInSeconds: this.timeoutInSeconds,
      },
      entry,
      options
    );
  }

  // ==========================================================================
  // Transaction Helpers
  // ==========================================================================

  /**
   * Fund a wallet on testnet using Friendbot
   *
   * Only works on Stellar testnet. Creates a temporary account, funds it
   * via Friendbot, then transfers XLM to the smart account contract.
   * This is necessary because Friendbot can't fund contract addresses directly.
   *
   * @param nativeTokenContract - Native XLM token SAC address (required for transfer)
   * @param options - Optional settings
   * @returns Whether the funding was successful, and the amount funded
   */
  async fundWallet(
    nativeTokenContract: string,
    options?: SubmitOptions
  ): Promise<TransactionResult & { amount?: number }> {
    return fundWallet(
      {
        getContractId: () => this._contractId,
        rpc: this.rpc,
        networkPassphrase: this.networkPassphrase,
        timeoutInSeconds: this.timeoutInSeconds,
        shouldUseFeeSponsoring: (submissionOptions) =>
          this.shouldUseFeeSponsoring(submissionOptions),
        hasSourceAccountAuth: (preparedTx) => this.hasSourceAccountAuth(preparedTx),
        sendAndPoll: (preparedTx, submissionOptions) =>
          this.sendAndPoll(preparedTx, submissionOptions),
      },
      nativeTokenContract,
      options
    );
  }

  /**
   * Transfer tokens from the smart wallet to a recipient
   *
   * This handles the full flow: build transaction, simulate, sign auth entries
   * with passkey, re-simulate for accurate resources, and submit.
   *
   * The transfer is built as a direct token-contract invocation authorized by
   * the smart account (a nested-call authorization, Soroban's canonical
   * model) rather than being wrapped in the account's `execute` entry point.
   * The signed context is therefore the token call itself, so context rules
   * scoped to the token — and policies attached to them, such as spending
   * limits — match and enforce on transfers.
   *
   * A custom `deployerSecret` sources and pays for the transaction. The shared
   * default deployer never does — a relayer/channel account supplies both.
   *
   * @param tokenContract - Token contract address (SAC address for native assets)
   * @param recipient - Recipient address (G... or C...)
   * @param amount - Amount to transfer (in token units, e.g., 10 for 10 XLM)
   * @param options - Transfer options
   * @returns Transfer result
   */
  async transfer(
    tokenContract: string,
    recipient: string,
    amount: number,
    options?: Pick<SignAndSubmitOptions, "credentialId" | "forceMethod" | "resolveContextRuleIds">
  ): Promise<TransactionResult> {
    const contractId = this._contractId;
    if (!contractId) {
      return failedTransaction(new WalletNotConnectedError("transfer"));
    }

    try {
      validateAddress(tokenContract, "tokenContract");
      validateAddress(recipient, "recipient");
      validateAmount(amount, "amount");
    } catch (err) {
      return failedTransaction(wrapError(err, SmartAccountErrorCode.INVALID_INPUT));
    }

    if (recipient === contractId) {
      return failedTransaction(new ValidationError("Cannot transfer to self"));
    }

    try {
      const amountInStroops = xlmToStroops(amount);
      const transaction = await this.buildTokenTransfer(
        tokenContract,
        contractId,
        recipient,
        amountInStroops
      );
      const ctxRuleCache: ConnectedContextRuleCache = {};
      return this.signAndSubmit(transaction, {
        credentialId: options?.credentialId,
        resolveContextRuleIds:
          options?.resolveContextRuleIds ??
          ((entry) =>
            this.resolveConnectedContextRuleIds(entry, options?.credentialId, ctxRuleCache)),
        forceMethod: options?.forceMethod,
      });
    } catch (err) {
      return failedTransaction(wrapError(err, SmartAccountErrorCode.TRANSACTION_SUBMISSION_FAILED));
    }
  }

  /**
   * Build a smart-account mediated contract call.
   *
   * This wraps the generated `wallet.execute(...)` method and returns the
   * assembled transaction so callers can inspect, sign, or compose around it.
   *
   * For the common "build + sign + submit" flow, prefer `executeAndSubmit()`.
   *
   * @param target - Target contract address
   * @param targetFn - Function name to invoke on the target contract
   * @param targetArgs - Arguments to pass to the target contract function
   * @returns Assembled transaction for the smart-account `execute` call
   */
  async execute(
    target: string,
    targetFn: string,
    targetArgs: Array<unknown>
  ): Promise<Awaited<ReturnType<SmartAccountClient["execute"]>>> {
    const { wallet } = this.requireWallet();

    return wallet.execute({
      target,
      target_fn: targetFn,
      target_args: targetArgs,
    });
  }

  /**
   * Upgrade the smart account contract's WASM (upgrade).
   *
   * Returns an assembled transaction that must be signed by the smart account
   * (self-auth) and submitted. The contract's `operator` argument is ignored
   * (stellar-contract-utils Upgradeable), so the account's own address is passed.
   *
   * @param newWasmHash - The new contract WASM hash (32-byte hash as hex string
   *   or Buffer)
   * @returns Assembled transaction that upgrades the contract when signed and sent
   * @throws {ValidationError} If the hash is not 32 bytes
   * @throws Error if not connected to a wallet
   */
  async upgrade(
    newWasmHash: string | Buffer
  ): Promise<Awaited<ReturnType<SmartAccountClient["upgrade"]>>> {
    const { wallet, contractId } = this.requireWallet();
    const wasmHash =
      typeof newWasmHash === "string" ? Buffer.from(newWasmHash, "hex") : newWasmHash;
    if (wasmHash.length !== 32) {
      throw new ValidationError(
        `newWasmHash must be a 32-byte hash (got ${wasmHash.length} bytes)`,
        SmartAccountErrorCode.INVALID_INPUT,
        { length: wasmHash.length }
      );
    }
    return wallet.upgrade({ new_wasm_hash: wasmHash, operator: contractId });
  }

  private policyClientDeps(): PolicyClientDeps {
    return {
      rpc: this.rpc,
      networkPassphrase: this.networkPassphrase,
      timeoutInSeconds: this.timeoutInSeconds,
      getSmartAccount: () => this.requireWallet().contractId,
      encodeContextRule: (rule) =>
        this.requireWallet().wallet.spec.nativeToScVal(rule, CONTEXT_RULE_SPEC_TYPE),
      execute: (target, targetFn, targetArgs) =>
        this.execute(target, targetFn, targetArgs),
    };
  }

  /**
   * Typed clients for the three example policies. Getters read via simulation;
   * setters return an AssembledTransaction routed through the smart account.
   *
   * @example
   * ```typescript
   * const client = kit.policyClients.threshold(policyAddress);
   * const current = await client.getThreshold(ruleId);
   * const { result: rule } = await kit.rules.get(ruleId);
   * const tx = await client.setThreshold(3, rule);
   * await kit.signAndSubmit(tx);
   * ```
   */
  get policyClients() {
    const deps = () => this.policyClientDeps();
    return {
      /** Simple threshold policy client. */
      threshold: (policyAddress: string) =>
        new SimpleThresholdPolicyClient(policyAddress, deps()),
      /** Weighted threshold policy client. */
      weighted: (policyAddress: string) =>
        new WeightedThresholdPolicyClient(policyAddress, deps()),
      /** Spending limit policy client. */
      spendingLimit: (policyAddress: string) =>
        new SpendingLimitPolicyClient(policyAddress, deps()),
    };
  }

  /**
   * Build, sign, re-simulate, and submit a smart-account mediated contract call.
   *
   * This is the high-level convenience path for arbitrary smart-account
   * executions, equivalent to:
   * 1. `kit.execute(...)`
   * 2. `kit.signAndSubmit(...)`
   *
   * @param target - Target contract address
   * @param targetFn - Function name to invoke on the target contract
   * @param targetArgs - Arguments to pass to the target contract function
   * @param options - Signing and submission options
   * @returns Transaction result
   */
  async executeAndSubmit(
    target: string,
    targetFn: string,
    targetArgs: Array<unknown>,
    options?: SignAndSubmitOptions
  ): Promise<TransactionResult> {
    const transaction = await this.execute(target, targetFn, targetArgs);
    return this.signAndSubmit(transaction, options);
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Check if a transaction has any auth entries using source_account credentials.
   *
   * When auth uses source_account credentials, the authorization comes from the
   * transaction envelope signature, so we MUST sign even when using fee sponsoring.
   * For Address credentials, the authorization is in the auth entry itself.
   *
   * @param transaction - The transaction to check
   * @returns true if any auth entry uses source_account credentials
   * @internal
   */
  private hasSourceAccountAuth(transaction: Transaction): boolean {
    return hasSourceAccountAuth(transaction);
  }

  /**
   * Build a direct token `transfer` invocation authorized by the connected
   * smart account. See {@link buildDirectTokenTransfer} for the authorization
   * model.
   * @internal
   */
  private buildTokenTransfer(
    tokenContract: string,
    fromAddress: string,
    toAddress: string,
    amountInStroops: bigint
  ): Promise<contract.AssembledTransaction<unknown>> {
    return buildDirectTokenTransfer(
      {
        rpc: this.rpc,
        networkPassphrase: this.networkPassphrase,
        timeoutInSeconds: this.timeoutInSeconds,
      },
      tokenContract,
      fromAddress,
      toAddress,
      amountInStroops
    );
  }

  /**
   * Sign auth entries with WebAuthn, re-simulate, and prepare transaction for submission.
   *
   * This is the core helper that handles the WebAuthn-specific flow:
   * 1. Sign each auth entry with the passkey
   * 2. Rebuild transaction with signed auth
   * 3. Re-simulate to get accurate resource costs (WebAuthn signatures are large)
   * 4. Assemble transaction with correct fees and soroban data
   *
   * @returns Prepared transaction ready for fee payer signature and submission
   */
  private async signResimulateAndPrepare(
    hostFunc: xdr.HostFunction,
    authEntries: xdr.SorobanAuthorizationEntry[],
    options?: SignOptions & { forceMethod?: SubmissionMethod }
  ): Promise<Transaction> {
    return signResimulateAndPrepare(
      {
        rpc: this.rpc,
        networkPassphrase: this.networkPassphrase,
        timeoutInSeconds: this.timeoutInSeconds,
        deployerKeypair: this.deployerKeypair,
        shouldUseFeeSponsoring: (opts) => shouldUseFeeSponsoring(this.relayer, opts),
        signAuthEntry: (entry, signOptions) => this.signAuthEntry(entry, signOptions),
      },
      hostFunc,
      authEntries,
      options
    );
  }

  private async resolveConnectedContextRuleIds(
    entry: xdr.SorobanAuthorizationEntry,
    credentialIdOverride?: string,
    cache: ConnectedContextRuleCache = {}
  ): Promise<number[]> {
    const credentialId = credentialIdOverride ?? this._credentialId;
    if (!credentialId) {
      throw new WalletNotConnectedError("resolve context rule IDs");
    }

    const { wallet, contractId } = this.requireWallet();
    const discoveryDeps = {
      getContractDetailsFromIndexer: () => this.getContractDetailsFromIndexer(contractId),
      probeRuleIds: this.probeRuleIds,
      rpc: this.rpc,
      contractId,
      networkPassphrase: this.networkPassphrase,
      timeoutInSeconds: this.timeoutInSeconds,
    };
    // Enumerate rules once and share the snapshot across the signer lookup AND
    // every auth entry of this operation (2N → 1 enumeration). Signing never
    // mutates rules, so the shared snapshot is safe.
    if (!cache.rules) {
      cache.rules = listContextRules(wallet, discoveryDeps);
    }
    const rules = await cache.rules;

    if (!cache.signer) {
      cache.signer = findWebAuthnSignerForCredential(wallet, credentialId, discoveryDeps, rules);
    }
    const signer = await cache.signer;

    return resolveContextRuleIdsForEntry(wallet, entry, [signer], discoveryDeps, rules);
  }

  /**
   * Check if fee sponsoring service (Relayer) should be used.
   * When using fee sponsoring, transactions are wrapped in a fee-bump, so the
   * envelope signature is generally not required (unless source_account auth is present).
   */
  private shouldUseFeeSponsoring(options?: SubmissionOptions): boolean {
    return shouldUseFeeSponsoring(this.relayer, options);
  }

  /**
   * Send a transaction and poll for confirmation.
   *
   * Uses the following priority for submission (unless overridden):
   * 1. Relayer (if configured) - submits func + auth entries
   * 2. RPC (direct submission) - submits full transaction XDR
   *
   * @param transaction - The transaction to submit
   * @param options - Submission options
   * @returns Transaction result with hash and status
   */
  private async sendAndPoll(
    transaction: Transaction,
    options?: SubmissionOptions
  ): Promise<TransactionResult> {
    return sendAndPoll(
      { rpc: this.rpc, relayer: this.relayer },
      transaction,
      options
    );
  }

  /**
   * Build either a shared-deployer auth payload or a custom-deployer transaction.
   */
  private async buildDeployTransaction(
    credentialId: Buffer,
    publicKey: Uint8Array,
    policies?: PolicyConfig[]
  ) {
    return buildDeployTransaction(
      {
        accountWasmHash: this.accountWasmHash,
        webauthnVerifierAddress: this.webauthnVerifierAddress,
        networkPassphrase: this.networkPassphrase,
        rpcUrl: this.rpcUrl,
        deployerKeypair: this.deployerKeypair,
        usingSharedDeployer: this.usingSharedDeployer,
        timeoutInSeconds: this.timeoutInSeconds,
      },
      credentialId,
      publicKey,
      policies
    );
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Convert policy parameters to ScVal format for on-chain submission.
   *
   * When adding policies via `kit.policies.add()`, the install parameters need
   * to be in ScVal format. This method converts native JavaScript objects to
   * the proper ScVal format based on the policy type.
   *
   * @param policyType - The type of policy: "threshold", "spending_limit", or "weighted_threshold"
   * @param params - The policy parameters as a native JavaScript object
   * @returns The parameters converted to ScVal format
   * @throws {ValidationError} If the params don't match the expected shape for the policy type
   *
   * @example
   * ```typescript
   * // Convert threshold policy params
   * const thresholdParams = kit.convertPolicyParams("threshold", { threshold: 2 });
   *
   * // Convert spending limit params
   * const spendingParams = kit.convertPolicyParams("spending_limit", {
   *   token: "CDLZFC3...",
   *   limit: 1000000000n,
   *   period: 8640, // ~1 day in ledgers
   * });
   *
   * // Use with policies.add()
   * const tx = await kit.policies.add(ruleId, policyAddress, thresholdParams);
   * ```
   */
  public convertPolicyParams(
    policyType: "threshold" | "spending_limit" | "weighted_threshold",
    params: unknown
  ): xdr.ScVal {
    return convertPolicyParams(policyType, params);
  }

  /**
   * Build a sorted policies Map as ScVal for on-chain submission.
   *
   * Soroban requires ScMap keys to be sorted. This method converts a JavaScript
   * Map of policy addresses to params into a properly sorted ScVal.
   *
   * @param policies - Map of policy addresses (C...) to their params
   * @param policyTypes - Map of policy addresses to their types (for conversion)
   * @returns ScVal representing the sorted policies map
   */
  public buildPoliciesScVal(
    policies: Map<string, unknown>,
    policyTypes: Map<string, "threshold" | "spending_limit" | "weighted_threshold" | "custom">
  ): xdr.ScVal {
    return buildPoliciesScVal(this.wallet, policies, policyTypes);
  }
}
