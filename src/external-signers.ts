/**
 * External Signer Manager
 *
 * Manages G-address signers (Stellar accounts) for multi-signature operations.
 * Supports two methods of adding signers:
 * 1. Raw secret key (Keypair) - stored in memory only, not isolated from application code
 * 2. External wallet via StellarWalletsKit (if installed)
 *
 * Wallet connections can be persisted to storage and auto-restored on init.
 *
 * @packageDocumentation
 */

import { Keypair, hash, xdr, Address } from "@stellar/stellar-sdk";
import type { ConnectedWallet, ExternalWalletAdapter } from "./types.js";
import { SignerNotFoundError, ValidationError } from "./errors.js";
import { Ed25519Signer } from "./signers.js";

/** Storage key for persisted wallet connections */
const WALLET_STORAGE_KEY = "external_wallets";

/**
 * Stored wallet connection info for persistence
 */
interface StoredWalletConnection {
  /** Stellar G-address */
  address: string;
  /** Wallet identifier for reconnection */
  walletId: string;
  /** Human-readable wallet name */
  walletName: string;
  /** Timestamp when connected */
  connectedAt: number;
}

/**
 * Simple storage interface for wallet connections
 * Compatible with localStorage, sessionStorage, or custom implementations
 */
export interface WalletStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Represents an external signer.
 *
 * - `keypair`/`wallet`: Delegated (G-address) signers that produce a nested
 *   `require_auth` over the auth preimage.
 * - `ed25519`: an External Ed25519 signer that signs the auth digest directly;
 *   `verifierAddress` is the on-chain ed25519 verifier and `publicKey` is the
 *   32-byte key data.
 */
export interface ExternalSigner {
  /** Stellar G-address (also the ed25519 public key in G-form) */
  address: string;
  /** How this signer was added */
  type: "keypair" | "wallet" | "ed25519";
  /** Wallet name (for wallet-based signers) */
  walletName?: string;
  /** Wallet ID (for wallet-based signers) */
  walletId?: string;
  /** Verifier contract address (for ed25519 signers) */
  verifierAddress?: string;
  /** Hex-encoded 32-byte public key (for ed25519 signers) */
  publicKey?: string;
}

/**
 * Internal storage for keypair-based signers
 */
interface KeypairSigner {
  keypair: Keypair;
  address: string;
}

/**
 * Manages external (G-address) signers for the SDK.
 *
 * This class provides a unified interface for managing Stellar account signers,
 * whether they come from raw secret keys or external wallet connections.
 *
 * @example
 * ```typescript
 * // Add from raw secret key (memory-only)
 * const { address } = kit.externalSigners.addFromSecret("S...");
 *
 * // Add from external wallet (if SWK installed)
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
export class ExternalSignerManager {
  /** Keypair-based signers (memory-only, never persisted) */
  private keypairSigners: Map<string, KeypairSigner> = new Map();

  /**
   * Ed25519 external signers, keyed by hex-encoded 32-byte public key
   * (memory-only, never persisted).
   */
  private ed25519Signers: Map<string, Ed25519Signer> = new Map();

  /** External wallet adapter (optional, for SWK integration) */
  private walletAdapter: ExternalWalletAdapter | null = null;

  /** Network passphrase for signing */
  private networkPassphrase: string;

  /** Storage for persisting wallet connections (optional) */
  private storage: WalletStorage | null = null;

  /** Whether connections have been restored */
  private restored = false;

  /** Default Ed25519 verifier contract address (from SDK config), if any. */
  private ed25519VerifierAddress: string | null = null;

  constructor(
    networkPassphrase: string,
    walletAdapter?: ExternalWalletAdapter,
    storage?: WalletStorage,
    ed25519VerifierAddress?: string
  ) {
    this.networkPassphrase = networkPassphrase;
    this.walletAdapter = walletAdapter ?? null;
    this.storage = storage ?? null;
    this.ed25519VerifierAddress = ed25519VerifierAddress ?? null;
  }

  /**
   * Add a signer from a raw secret key.
   *
   * The keypair is stored in memory only and is never persisted.
   * Application code can read process memory, so use only trusted callers.
   * It will be lost when the page is refreshed.
   *
   * @param secretKey - Stellar secret key (S...)
   * @returns The derived public address
   * @throws Error if the secret key is invalid
   *
   * @example
   * ```typescript
   * const { address } = kit.externalSigners.addFromSecret("S...your-56-character-secret-seed...");
   * console.log(`Added signer: ${address}`);
   * ```
   */
  addFromSecret(secretKey: string): { address: string } {
    // Validate and create keypair
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secretKey);
    } catch {
      throw new ValidationError(
        "Invalid secret key. Must be a valid Stellar secret key (S...)"
      );
    }

    const address = keypair.publicKey();

    // Store in memory
    this.keypairSigners.set(address, { keypair, address });

    return { address };
  }

  /**
   * Add an Ed25519 External signer from a raw secret key.
   *
   * Unlike {@link addFromSecret} (which registers a Delegated G-address signer),
   * this registers an `External(verifierAddress, publicKey)` signer that signs
   * the smart-account auth digest directly with Ed25519. The keypair is stored
   * in memory only and is never persisted.
   * Application code can read process memory, so use only trusted callers.
   *
   * @param secretKey - Stellar secret key (S...)
   * @param ed25519VerifierAddress - Deployed Ed25519 verifier contract address.
   *   Defaults to the address configured on the SDK (`ed25519VerifierAddress`).
   * @returns The G-address and hex-encoded 32-byte public key
   * @throws {ValidationError} If the secret key is invalid or no verifier address
   *   is available
   *
   * @example
   * ```typescript
   * // Uses the SDK-configured ed25519VerifierAddress
   * const { address } = kit.externalSigners.addEd25519FromSecret("S...");
   * ```
   */
  addEd25519FromSecret(
    secretKey: string,
    ed25519VerifierAddress?: string
  ): { address: string; publicKey: string } {
    const verifierAddress = ed25519VerifierAddress ?? this.ed25519VerifierAddress;
    if (!verifierAddress) {
      throw new ValidationError(
        "An Ed25519 verifier address is required. Configure ed25519VerifierAddress " +
          "on the SDK or pass it explicitly to addEd25519FromSecret()."
      );
    }
    const signer = Ed25519Signer.fromSecret(secretKey, verifierAddress);
    const publicKeyHex = signer.publicKey.toString("hex");
    this.ed25519Signers.set(publicKeyHex, signer);
    return { address: signer.address, publicKey: publicKeyHex };
  }

  /**
   * Look up a registered Ed25519 signer by its 32-byte key data.
   *
   * @param keyData - The 32-byte Ed25519 public key (External signer key data)
   * @returns The matching {@link Ed25519Signer}, or `undefined`
   * @internal
   */
  getEd25519Signer(keyData: Uint8Array | Buffer): Ed25519Signer | undefined {
    return this.ed25519Signers.get(Buffer.from(keyData).toString("hex"));
  }

  /**
   * Whether a registered Ed25519 signer can sign for the given key data.
   *
   * @param keyData - The 32-byte Ed25519 public key
   * @internal
   */
  canSignEd25519(keyData: Uint8Array | Buffer): boolean {
    return this.ed25519Signers.has(Buffer.from(keyData).toString("hex"));
  }

  /**
   * Sign an auth digest with a registered Ed25519 signer.
   *
   * @param keyData - The 32-byte Ed25519 public key identifying the signer
   * @param authDigest - The 32-byte smart-account auth digest
   * @returns The 64-byte Ed25519 signature
   * @throws {SignerNotFoundError} If no Ed25519 signer matches the key data
   * @internal
   */
  signEd25519Digest(keyData: Uint8Array | Buffer, authDigest: Buffer): Buffer {
    const signer = this.getEd25519Signer(keyData);
    if (!signer) {
      throw new SignerNotFoundError(
        `ed25519:${Buffer.from(keyData).toString("hex").slice(0, 16)}…`,
        "Use kit.externalSigners.addEd25519FromSecret() to add the signer."
      );
    }
    return signer.signAuthDigest(authDigest);
  }

  /**
   * Add a signer from an external wallet (Freighter, Lobstr, etc.)
   *
   * Requires StellarWalletsKit to be installed and the adapter to be initialized.
   * Shows the wallet selection modal and tracks the connected wallet.
   * If storage is configured, the connection is persisted for auto-restore.
   *
   * @returns Connected wallet info, or null if cancelled/unavailable
   * @throws Error if no wallet adapter is configured
   *
   * @example
   * ```typescript
   * const wallet = await kit.externalSigners.addFromWallet();
   * if (wallet) {
   *   console.log(`Connected: ${wallet.walletName} (${wallet.address})`);
   * }
   * ```
   */
  async addFromWallet(): Promise<ConnectedWallet | null> {
    if (!this.walletAdapter) {
      throw new Error(
        "No wallet adapter configured. Install @creit-tech/stellar-wallets-kit " +
        "and pass a StellarWalletsKitAdapter to the SDK config."
      );
    }

    const wallet = await this.walletAdapter.connect();

    // Persist the connection if storage is configured
    if (wallet && this.storage) {
      this.saveWalletToStorage(wallet);
    }

    return wallet;
  }

  /**
   * Restore previously connected wallets from storage.
   *
   * Attempts to reconnect to all wallets that were saved in storage.
   * This is called automatically if storage is configured, but can also
   * be called manually.
   *
   * @returns Array of successfully restored wallet connections
   *
   * @example
   * ```typescript
   * const restored = await kit.externalSigners.restoreConnections();
   * console.log(`Restored ${restored.length} wallet connections`);
   * ```
   */
  async restoreConnections(): Promise<ConnectedWallet[]> {
    if (this.restored) {
      // Already restored, return current wallet connections
      return this.walletAdapter?.getConnectedWallets() ?? [];
    }

    this.restored = true;

    if (!this.storage || !this.walletAdapter?.reconnect) {
      return [];
    }

    const stored = this.getStoredWallets();
    const restored: ConnectedWallet[] = [];

    for (const savedWallet of stored) {
      try {
        const wallet = await this.walletAdapter.reconnect(savedWallet.walletId);
        if (wallet) {
          restored.push(wallet);
        } else {
          // Reconnection failed - remove stale entry from storage
          this.removeWalletFromStorage(savedWallet.address);
        }
      } catch {
        // Reconnection failed - remove stale entry from storage
        this.removeWalletFromStorage(savedWallet.address);
      }
    }

    return restored;
  }

  /**
   * Remove a signer by address.
   *
   * For keypair signers, this removes the keypair from memory.
   * For wallet signers, this disconnects the wallet and removes from storage.
   *
   * @param address - The G-address to remove
   */
  remove(address: string): void {
    // Remove from keypair signers
    this.keypairSigners.delete(address);

    // Remove any ed25519 signer whose G-address matches
    for (const [publicKey, signer] of this.ed25519Signers) {
      if (signer.address === address) {
        this.ed25519Signers.delete(publicKey);
      }
    }

    // Remove from wallet adapter if it has the method
    const adapter = this.walletAdapter as ExternalWalletAdapter & {
      disconnectByAddress?: (address: string) => void;
    };
    if (adapter?.disconnectByAddress) {
      adapter.disconnectByAddress(address);
    }

    // Remove from storage
    this.removeWalletFromStorage(address);
  }

  // ===========================================================================
  // Private Storage Helpers
  // ===========================================================================

  /**
   * Get stored wallet connections from storage
   */
  private getStoredWallets(): StoredWalletConnection[] {
    if (!this.storage) return [];

    try {
      const data = this.storage.getItem(WALLET_STORAGE_KEY);
      if (!data) return [];
      return JSON.parse(data) as StoredWalletConnection[];
    } catch {
      return [];
    }
  }

  /**
   * Save a wallet connection to storage
   */
  private saveWalletToStorage(wallet: ConnectedWallet): void {
    if (!this.storage) return;

    const stored = this.getStoredWallets();

    // Remove existing entry for this address (if any)
    const filtered = stored.filter((w) => w.address !== wallet.address);

    // Add new entry
    filtered.push({
      address: wallet.address,
      walletId: wallet.walletId,
      walletName: wallet.walletName,
      connectedAt: Date.now(),
    });

    this.storage.setItem(WALLET_STORAGE_KEY, JSON.stringify(filtered));
  }

  /**
   * Remove a wallet connection from storage
   */
  private removeWalletFromStorage(address: string): void {
    if (!this.storage) return;

    const stored = this.getStoredWallets();
    const filtered = stored.filter((w) => w.address !== address);

    if (filtered.length === 0) {
      this.storage.removeItem(WALLET_STORAGE_KEY);
    } else {
      this.storage.setItem(WALLET_STORAGE_KEY, JSON.stringify(filtered));
    }
  }

  /**
   * Remove all signers.
   *
   * Clears all keypair signers from memory and disconnects all wallets.
   */
  async removeAll(): Promise<void> {
    this.keypairSigners.clear();
    this.ed25519Signers.clear();

    if (this.walletAdapter) {
      await this.walletAdapter.disconnect();
    }

    // Clear storage
    if (this.storage) {
      this.storage.removeItem(WALLET_STORAGE_KEY);
    }
  }

  /**
   * Get all registered external signers.
   *
   * @returns Array of external signer info
   */
  getAll(): ExternalSigner[] {
    const signers: ExternalSigner[] = [];

    // Add keypair signers
    for (const [address] of this.keypairSigners) {
      signers.push({
        address,
        type: "keypair",
      });
    }

    // Add ed25519 external signers
    for (const [publicKey, signer] of this.ed25519Signers) {
      signers.push({
        address: signer.address,
        type: "ed25519",
        verifierAddress: signer.verifier,
        publicKey,
      });
    }

    // Add wallet signers
    if (this.walletAdapter) {
      const wallets = this.walletAdapter.getConnectedWallets();
      for (const wallet of wallets) {
        // Skip if already added as keypair (keypair takes precedence)
        if (!this.keypairSigners.has(wallet.address)) {
          signers.push({
            address: wallet.address,
            type: "wallet",
            walletName: wallet.walletName,
            walletId: wallet.walletId,
          });
        }
      }
    }

    return signers;
  }

  /**
   * Check if we can sign for a specific address.
   *
   * @param address - The G-address to check
   * @returns True if we have a keypair or connected wallet for this address
   */
  canSignFor(address: string): boolean {
    // Check keypair signers first
    if (this.keypairSigners.has(address)) {
      return true;
    }

    // Check wallet adapter
    if (this.walletAdapter?.canSignFor(address)) {
      return true;
    }

    return false;
  }

  /**
   * Check if any external signers are registered.
   */
  get hasSigners(): boolean {
    return this.keypairSigners.size > 0 ||
      this.ed25519Signers.size > 0 ||
      (this.walletAdapter?.getConnectedWallets().length ?? 0) > 0;
  }

  /**
   * Sign an auth entry preimage with an external signer.
   *
   * For keypair signers, signs directly with the Keypair.
   * For wallet signers, delegates to the wallet adapter.
   *
   * @param preimageXdr - Base64-encoded HashIdPreimage XDR
   * @param address - The G-address to sign with
   * @returns Base64-encoded signature
   * @throws Error if no signer is available for the address
   *
   * @internal Used by the SDK during multi-signer operations
   */
  async signAuthEntry(
    preimageXdr: string,
    address: string
  ): Promise<{ signedAuthEntry: string; signerAddress: string }> {
    // Try keypair signer first
    const keypairSigner = this.keypairSigners.get(address);
    if (keypairSigner) {
      // Parse the preimage and sign
      const preimage = xdr.HashIdPreimage.fromXDR(preimageXdr, "base64");
      const payload = hash(preimage.toXDR());
      const signature = keypairSigner.keypair.sign(payload);

      return {
        signedAuthEntry: signature.toString("base64"),
        signerAddress: address,
      };
    }

    // Try wallet adapter
    if (this.walletAdapter?.canSignFor(address)) {
      const result = await this.walletAdapter.signAuthEntry(preimageXdr, {
        networkPassphrase: this.networkPassphrase,
        address,
      });
      return {
        signedAuthEntry: result.signedAuthEntry,
        signerAddress: result.signerAddress ?? address,
      };
    }

    throw new SignerNotFoundError(address);
  }

}
