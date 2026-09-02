import { useState, useEffect, useCallback } from "react";
import { Buffer } from "buffer";
import type { Signer } from "smart-account-kit-bindings";
import type { SelectedSigner } from "smart-account-kit";
import {
  getCredentialIdFromSigner,
  type ConnectedWallet,
} from "smart-account-kit";
import { formatSignerForDisplay, truncateAddress } from "../utils/sdk";

// Re-export SelectedSigner for convenience
export type { SelectedSigner };

interface SignerPickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** All signers from context rules that could sign */
  availableSigners: Signer[];
  /** The active passkey credential ID (if any) */
  activeCredentialId: string | null;
  /** Callback when user confirms signer selection */
  onConfirm: (selectedSigners: SelectedSigner[]) => void;
  /** Title for the modal */
  title?: string;
  /** Description text */
  description?: string;
  /** All connected wallets (from SDK) */
  connectedWallets: ConnectedWallet[];
  /** Function to connect a wallet (from SDK) */
  connectWallet: () => Promise<ConnectedWallet | null>;
  /** Function to disconnect a wallet by address (from SDK) */
  disconnectWalletByAddress: (address: string) => void;
  /** Function to add a signer from secret key (for manually imported G-addresses) */
  addFromSecret?: (secretKey: string) => { address: string } | null;
  /** Function to register an Ed25519 signer from a secret key */
  addEd25519FromSecret?: (
    secretKey: string
  ) => { address: string; publicKey: string } | null;
  /** Whether a registered Ed25519 signer can sign for the given signer */
  canSignEd25519?: (signer: Signer) => boolean;
}

/** Hex-encode an External signer's 32-byte Ed25519 key data. */
function ed25519KeyHex(signer: Signer): string {
  return Buffer.from(signer.values[1] as Buffer).toString("hex");
}

/**
 * Format a signer for display in the picker list
 */
function formatSignerLabel(signer: Signer): string {
  const { type, display } = formatSignerForDisplay(signer);
  if (type === "Passkey") {
    return `Passkey: ${display}`;
  }
  return display;
}

export function SignerPicker({
  isOpen,
  onClose,
  availableSigners,
  activeCredentialId,
  onConfirm,
  title = "Select Signers",
  description = "Choose which signers to use for this transaction.",
  connectedWallets,
  connectWallet,
  disconnectWalletByAddress,
  addFromSecret,
  addEd25519FromSecret,
  canSignEd25519,
}: SignerPickerProps) {
  // Helper to check if we can sign for an address
  const canSignFor = useCallback((address: string) => {
    return connectedWallets.some((w) => w.address === address);
  }, [connectedWallets]);

  // Helper to get wallet for an address
  const getWalletForAddress = useCallback((address: string) => {
    return connectedWallets.find((w) => w.address === address);
  }, [connectedWallets]);
  const [selectedSignerIds, setSelectedSignerIds] = useState<Set<number>>(new Set());
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Secret key input state (delegated G-address signers)
  const [secretKeyInputAddress, setSecretKeyInputAddress] = useState<string | null>(null);
  const [secretKeyValue, setSecretKeyValue] = useState("");
  const [secretKeyError, setSecretKeyError] = useState<string | null>(null);
  const [isAddingSecret, setIsAddingSecret] = useState(false);

  // Secret key input state (Ed25519 signers, keyed by key-data hex)
  const [ed25519InputKey, setEd25519InputKey] = useState<string | null>(null);
  const [ed25519Secret, setEd25519Secret] = useState("");
  const [ed25519Error, setEd25519Error] = useState<string | null>(null);
  const [ed25519Adding, setEd25519Adding] = useState(false);

  // Categorize signers
  const passkeySigners = availableSigners.filter((s) => {
    if (s.tag !== "External") return false;
    const credId = getCredentialIdFromSigner(s);
    return credId !== null;
  });

  const delegatedSigners = availableSigners.filter((s) => s.tag === "Delegated");

  // Ed25519 External signers: External with 32-byte key data and no credential ID
  const ed25519Signers = availableSigners.filter((s) => {
    if (s.tag !== "External") return false;
    if (getCredentialIdFromSigner(s) !== null) return false;
    const keyData = s.values[1] as Buffer;
    return keyData?.length === 32;
  });

  // Auto-select active passkey on open
  useEffect(() => {
    if (isOpen && activeCredentialId) {
      const activeIndex = availableSigners.findIndex((s) => {
        const credId = getCredentialIdFromSigner(s);
        return credId === activeCredentialId;
      });
      if (activeIndex >= 0) {
        setSelectedSignerIds(new Set([activeIndex]));
      }
    }
  }, [isOpen, activeCredentialId, availableSigners]);

  // Auto-select delegated signers that match connected wallets
  useEffect(() => {
    if (isOpen && connectedWallets.length > 0) {
      const matchingIndices: number[] = [];

      for (const wallet of connectedWallets) {
        const walletIndex = availableSigners.findIndex((s) => {
          if (s.tag !== "Delegated") return false;
          return s.values[0] === wallet.address;
        });
        if (walletIndex >= 0) {
          matchingIndices.push(walletIndex);
        }
      }

      if (matchingIndices.length > 0) {
        setSelectedSignerIds((prev) => new Set([...prev, ...matchingIndices]));
      }
    }
  }, [isOpen, connectedWallets, availableSigners]);

  const toggleSigner = (index: number) => {
    setSelectedSignerIds((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleConnectWallet = async () => {
    setIsConnecting(true);
    setConnectError(null);
    try {
      await connectWallet();
    } catch (error) {
      // connect() throws on genuine failures (user cancellation returns null).
      // Show it instead of letting the promise rejection go unhandled.
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsConnecting(false);
    }
  };

  // Handle adding a secret key for a manually imported G-address
  const handleAddSecretKey = () => {
    if (!addFromSecret || !secretKeyInputAddress) return;

    const secretKey = secretKeyValue.trim();
    if (!secretKey) {
      setSecretKeyError("Please enter a secret key");
      return;
    }

    if (!secretKey.startsWith("S") || secretKey.length !== 56) {
      setSecretKeyError("Invalid secret key. Must start with S and be 56 characters.");
      return;
    }

    setIsAddingSecret(true);
    setSecretKeyError(null);

    try {
      const result = addFromSecret(secretKey);
      if (result) {
        // Verify the derived address matches the expected address
        if (result.address !== secretKeyInputAddress) {
          setSecretKeyError(`Secret key doesn't match this address. Got ${result.address.slice(0, 8)}...`);
          return;
        }
        // Success - close the input and auto-select this signer
        const signerIndex = availableSigners.findIndex((s) => {
          if (s.tag !== "Delegated") return false;
          return s.values[0] === secretKeyInputAddress;
        });
        if (signerIndex >= 0) {
          setSelectedSignerIds((prev) => new Set([...prev, signerIndex]));
        }
        setSecretKeyInputAddress(null);
        setSecretKeyValue("");
      }
    } catch (err) {
      setSecretKeyError(err instanceof Error ? err.message : "Failed to add secret key");
    } finally {
      setIsAddingSecret(false);
    }
  };

  const cancelSecretKeyInput = () => {
    setSecretKeyInputAddress(null);
    setSecretKeyValue("");
    setSecretKeyError(null);
  };

  // Register an Ed25519 signer's keypair from its secret key.
  const handleAddEd25519Secret = () => {
    if (!addEd25519FromSecret || !ed25519InputKey) return;

    const secretKey = ed25519Secret.trim();
    if (!secretKey.startsWith("S") || secretKey.length !== 56) {
      setEd25519Error("Invalid secret key. Must start with S and be 56 characters.");
      return;
    }

    setEd25519Adding(true);
    setEd25519Error(null);

    try {
      const result = addEd25519FromSecret(secretKey);
      if (result) {
        if (result.publicKey.toLowerCase() !== ed25519InputKey.toLowerCase()) {
          setEd25519Error(
            `Secret key doesn't match this signer. Got ${result.publicKey.slice(0, 8)}...`
          );
          return;
        }
        const signerIndex = availableSigners.findIndex(
          (s) =>
            s.tag === "External" &&
            getCredentialIdFromSigner(s) === null &&
            ed25519KeyHex(s).toLowerCase() === ed25519InputKey.toLowerCase()
        );
        if (signerIndex >= 0) {
          setSelectedSignerIds((prev) => new Set([...prev, signerIndex]));
        }
        setEd25519InputKey(null);
        setEd25519Secret("");
      }
    } catch (err) {
      setEd25519Error(err instanceof Error ? err.message : "Failed to add Ed25519 key");
    } finally {
      setEd25519Adding(false);
    }
  };

  const cancelEd25519Input = () => {
    setEd25519InputKey(null);
    setEd25519Secret("");
    setEd25519Error(null);
  };

  const handleConfirm = () => {
    const selected: SelectedSigner[] = [];

    for (const index of selectedSignerIds) {
      const signer = availableSigners[index];
      if (!signer) continue;

      if (signer.tag === "External") {
        const credId = getCredentialIdFromSigner(signer);
        if (credId) {
          selected.push({
            signer,
            type: "passkey",
            credentialId: credId,
          });
        } else if (canSignEd25519?.(signer)) {
          selected.push({
            signer,
            type: "ed25519",
            ed25519PublicKey: ed25519KeyHex(signer),
          });
        }
      } else if (signer.tag === "Delegated") {
        const address = signer.values[0] as string;
        // Check if this matches any connected wallet
        if (canSignFor(address)) {
          selected.push({
            signer,
            type: "wallet",
            walletAddress: address,
          });
        }
      }
    }

    onConfirm(selected);
    onClose();
  };

  const canConfirm = selectedSignerIds.size > 0;

  // Check which delegated signers have matching connected wallets
  const getMatchingWallet = (signer: Signer): ConnectedWallet | undefined => {
    if (signer.tag !== "Delegated") return undefined;
    const address = signer.values[0] as string;
    return getWalletForAddress(address);
  };

  // Check if there are any delegated signers without a connected wallet
  const hasUnmatchedDelegatedSigners = delegatedSigners.some(
    (s) => !canSignFor(s.values[0] as string)
  );

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content signer-picker" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="close-button" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          <p className="description">{description}</p>

          {/* Passkey Signers */}
          {passkeySigners.length > 0 && (
            <div className="signer-section">
              <h4>Passkey Signers</h4>
              <div className="signer-list">
                {passkeySigners.map((signer) => {
                  const globalIndex = availableSigners.indexOf(signer);
                  const credId = getCredentialIdFromSigner(signer);
                  const isActive = credId === activeCredentialId;
                  const isSelected = selectedSignerIds.has(globalIndex);

                  return (
                    <label
                      key={globalIndex}
                      className={`signer-item ${isSelected ? "selected" : ""} ${isActive ? "active" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSigner(globalIndex)}
                      />
                      <div className="signer-info">
                        <span className="signer-label">
                          {formatSignerLabel(signer)}
                          {isActive && <span className="badge active">Active</span>}
                        </span>
                        <span className="signer-type">WebAuthn Passkey</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Delegated Signers */}
          {delegatedSigners.length > 0 && (
            <div className="signer-section">
              <h4>Stellar Account Signers</h4>
              <div className="signer-list">
                {delegatedSigners.map((signer) => {
                  const globalIndex = availableSigners.indexOf(signer);
                  const matchingWallet = getMatchingWallet(signer);
                  const isSelected = selectedSignerIds.has(globalIndex);
                  const address = signer.values[0] as string;
                  const isEnteringSecretKey = secretKeyInputAddress === address;

                  return (
                    <div key={globalIndex} className="delegated-signer-wrapper">
                      <label
                        className={`signer-item ${isSelected ? "selected" : ""} ${!matchingWallet ? "disabled" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSigner(globalIndex)}
                          disabled={!matchingWallet}
                        />
                        <div className="signer-info">
                          <span className="signer-label">
                            {formatSignerLabel(signer)}
                            {matchingWallet && (
                              <span className="badge connected">{matchingWallet.walletName}</span>
                            )}
                          </span>
                          <span className="signer-type">
                            {matchingWallet
                              ? "Ready to sign"
                              : "Connect wallet or enter secret key"}
                          </span>
                        </div>
                        {/* Show secret key button for unconnected signers */}
                        {!matchingWallet && addFromSecret && !isEnteringSecretKey && (
                          <button
                            type="button"
                            className="small secondary secret-key-btn"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSecretKeyInputAddress(address);
                              setSecretKeyValue("");
                              setSecretKeyError(null);
                            }}
                            title="Enter secret key for this address"
                          >
                            🔑 Enter Key
                          </button>
                        )}
                      </label>

                      {/* Secret key input form */}
                      {isEnteringSecretKey && (
                        <div className="secret-key-input-form">
                          <div className="secret-key-header">
                            <span>Enter secret key for {truncateAddress(address, 6)}</span>
                            <button
                              type="button"
                              className="small secondary close-btn"
                              onClick={cancelSecretKeyInput}
                            >
                              ×
                            </button>
                          </div>
                          <input
                            type="password"
                            className="secret-key-input"
                            value={secretKeyValue}
                            onChange={(e) => setSecretKeyValue(e.target.value)}
                            placeholder="S..."
                            autoFocus
                          />
                          {secretKeyError && (
                            <div className="secret-key-error">{secretKeyError}</div>
                          )}
                          <div className="secret-key-actions">
                            <button
                              type="button"
                              className="small secondary"
                              onClick={cancelSecretKeyInput}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="small"
                              onClick={handleAddSecretKey}
                              disabled={isAddingSecret || !secretKeyValue.trim()}
                            >
                              {isAddingSecret ? <span className="spinner" /> : "Add"}
                            </button>
                          </div>
                          <p className="secret-key-warning">
                            ⚠️ Use an isolated test key only. Page code can read a key while it is in memory.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Ed25519 Signers */}
          {ed25519Signers.length > 0 && (
            <div className="signer-section">
              <h4>Ed25519 Signers</h4>
              <div className="signer-list">
                {ed25519Signers.map((signer) => {
                  const globalIndex = availableSigners.indexOf(signer);
                  const keyHex = ed25519KeyHex(signer);
                  const isRegistered = canSignEd25519?.(signer) ?? false;
                  const isSelected = selectedSignerIds.has(globalIndex);
                  const isEnteringSecret = ed25519InputKey === keyHex;

                  return (
                    <div key={globalIndex} className="delegated-signer-wrapper">
                      <label
                        className={`signer-item ${isSelected ? "selected" : ""} ${!isRegistered ? "disabled" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSigner(globalIndex)}
                          disabled={!isRegistered}
                        />
                        <div className="signer-info">
                          <span className="signer-label">
                            {formatSignerLabel(signer)}
                            {isRegistered && <span className="badge connected">Ready</span>}
                          </span>
                          <span className="signer-type">
                            {isRegistered ? "Ready to sign" : "Enter secret key to sign"}
                          </span>
                        </div>
                        {!isRegistered && addEd25519FromSecret && !isEnteringSecret && (
                          <button
                            type="button"
                            className="small secondary secret-key-btn"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setEd25519InputKey(keyHex);
                              setEd25519Secret("");
                              setEd25519Error(null);
                            }}
                            title="Enter Ed25519 secret key for this signer"
                          >
                            🔑 Enter Key
                          </button>
                        )}
                      </label>

                      {isEnteringSecret && (
                        <div className="secret-key-input-form">
                          <div className="secret-key-header">
                            <span>Enter Ed25519 secret key for {keyHex.slice(0, 8)}...</span>
                            <button
                              type="button"
                              className="small secondary close-btn"
                              onClick={cancelEd25519Input}
                            >
                              ×
                            </button>
                          </div>
                          <input
                            type="password"
                            className="secret-key-input"
                            value={ed25519Secret}
                            onChange={(e) => setEd25519Secret(e.target.value)}
                            placeholder="S..."
                            autoFocus
                          />
                          {ed25519Error && (
                            <div className="secret-key-error">{ed25519Error}</div>
                          )}
                          <div className="secret-key-actions">
                            <button
                              type="button"
                              className="small secondary"
                              onClick={cancelEd25519Input}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="small"
                              onClick={handleAddEd25519Secret}
                              disabled={ed25519Adding || !ed25519Secret.trim()}
                            >
                              {ed25519Adding ? <span className="spinner" /> : "Add"}
                            </button>
                          </div>
                          <p className="secret-key-warning">
                            ⚠️ Use an isolated test key only. Page code can read a key while it is in memory.
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Connected Wallets Section */}
          {connectedWallets.length > 0 && (
            <div className="signer-section connected-wallets-section">
              <h4>Connected Wallets ({connectedWallets.length})</h4>
              <div className="connected-wallets-list">
                {connectedWallets.map((wallet) => {
                  // Check if this wallet matches any delegated signer
                  const matchesSigner = delegatedSigners.some(
                    (s) => s.values[0] === wallet.address
                  );

                  return (
                    <div key={wallet.address} className={`connected-wallet-item ${matchesSigner ? "matches-signer" : ""}`}>
                      <div className="wallet-info">
                        <span className="wallet-name">{wallet.walletName}</span>
                        <span className="wallet-address">{truncateAddress(wallet.address, 6)}</span>
                        {matchesSigner && <span className="badge signer-match">Signer</span>}
                        {!matchesSigner && <span className="badge no-match">Not a signer</span>}
                      </div>
                      <button
                        className="small secondary remove-wallet"
                        onClick={() => disconnectWalletByAddress(wallet.address)}
                        title="Disconnect this wallet"
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Connect Wallet Button */}
          {(delegatedSigners.length > 0 || connectedWallets.length > 0) && (
            <div className="connect-wallet-section">
              {hasUnmatchedDelegatedSigners && (
                <p className="hint">
                  Connect a wallet to sign with a Stellar account signer.
                </p>
              )}
              <button
                className="secondary"
                onClick={handleConnectWallet}
                disabled={isConnecting}
              >
                {isConnecting ? (
                  <span className="spinner" />
                ) : connectedWallets.length > 0 ? (
                  "+ Connect Another Wallet"
                ) : (
                  "Connect Wallet"
                )}
              </button>
              {connectError && (
                <div className="secret-key-error">{connectError}</div>
              )}
            </div>
          )}

          {availableSigners.length === 0 && (
            <p className="no-signers">No signers available for this context.</p>
          )}
        </div>

        <div className="modal-footer">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button onClick={handleConfirm} disabled={!canConfirm}>
            Confirm ({selectedSignerIds.size} selected)
          </button>
        </div>
      </div>
    </div>
  );
}
