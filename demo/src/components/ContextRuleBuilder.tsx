import { useState, useCallback, useEffect, useMemo } from "react";
import { Buffer } from "buffer";
import type {
  SmartAccountKit,
  StoredCredential,
  ConnectedWallet,
} from "smart-account-kit";
import {
  createDefaultContext,
  createCallContractContext,
  createCreateContractContext,
  getCredentialIdFromSigner,
  signersEqual,
  validateContextRuleName,
  MAX_NAME_SIZE,
} from "smart-account-kit";
import { rpc } from "@stellar/stellar-sdk";
import type { ContextRule, Signer, ContextRuleType } from "smart-account-kit-bindings";
import { SignerPicker, type SelectedSigner } from "./SignerPicker";
import { formatSignerForDisplay } from "../utils/sdk";
import { CONFIG, WEIGHTED_THRESHOLD_ENABLED, type KnownPolicy } from "../config";
import {
  absoluteValidUntilToLedgerDelta,
  DEFAULT_EXPIRATION_LEDGER_DELTA,
  expirationDaysToLedgerDelta,
  expirationLedgerDeltaToDays,
} from "../utils/expiration";
import { useMultiSignerSubmit } from "../hooks/useMultiSignerSubmit";
import {
  type SignerEntry,
  type SignerEntryInfo,
  type SignerAddMode,
  type ContextTypeOption,
  type SelectedPolicy,
} from "./rule-builder/types";
import {
  encodePolicyInstallParam,
  readRulePolicyParams,
  signerEntryToContractSigner,
} from "./rule-builder/policyParams";
import { PolicyConfigList } from "./rule-builder/PolicyConfigList";

async function getCurrentLedgerSequence(): Promise<number> {
  const server = new rpc.Server(CONFIG.rpcUrl);
  const { sequence } = await server.getLatestLedger();
  return sequence;
}

/** Format a signer label using the SDK display util. */
function formatSignerLabel(signer: Signer): string {
  const { type, display } = formatSignerForDisplay(signer);
  if (type === "Passkey") {
    return `Passkey ${display}`;
  }
  return display;
}

interface ContextRuleBuilderProps {
  kit: SmartAccountKit;
  isOpen: boolean;
  onClose: () => void;
  onLog: (message: string, type?: "info" | "success" | "error") => void;
  onSuccess: () => void;
  editingRule?: ContextRule | null;
  /** Available policy contracts */
  availablePolicies: KnownPolicy[];
  /** WebAuthn verifier address for passkey signers */
  webauthnVerifierAddress: string;
  /** Ed25519 verifier address for ed25519 signers */
  ed25519VerifierAddress: string;
  /** Current active credential ID (to highlight in signer list) */
  activeCredentialId?: string | null;
  /** All existing signers from on-chain context rules */
  existingSigners?: Signer[];
  /** Pending credentials from SDK storage */
  pendingCredentials?: StoredCredential[];
  /** All connected wallets */
  connectedWallets: ConnectedWallet[];
  /** Function to connect external wallet */
  connectWallet: () => Promise<ConnectedWallet | null>;
  /** Function to disconnect external wallet by address */
  disconnectWalletByAddress: (address: string) => void;
  /** Register a G-address signer from a secret key (for the SignerPicker) */
  addFromSecret?: (secretKey: string) => { address: string } | null;
  /** Register an Ed25519 signer from a secret key */
  addEd25519FromSecret?: (
    secretKey: string
  ) => { address: string; publicKey: string } | null;
}

export function ContextRuleBuilder({
  kit,
  isOpen,
  onClose,
  onLog,
  onSuccess,
  editingRule,
  availablePolicies,
  webauthnVerifierAddress,
  ed25519VerifierAddress,
  activeCredentialId,
  existingSigners = [],
  pendingCredentials = [],
  connectedWallets,
  connectWallet,
  disconnectWalletByAddress,
  addFromSecret,
  addEd25519FromSecret,
}: ContextRuleBuilderProps) {
  // Form state
  const [name, setName] = useState(editingRule?.name || "");
  const [contextType, setContextType] = useState<ContextTypeOption>("default");
  const [contractAddress, setContractAddress] = useState("");
  const [wasmHash, setWasmHash] = useState("");
  const [signers, setSigners] = useState<SignerEntry[]>([]);

  // Signer add state
  const [addMode, setAddMode] = useState<SignerAddMode>("existing");
  const [selectedSignerId, setSelectedSignerId] = useState<string>("");
  const [newPasskeyName, setNewPasskeyName] = useState("");
  const [gAddress, setGAddress] = useState("");
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [ed25519Secret, setEd25519Secret] = useState("");
  const [addingEd25519, setAddingEd25519] = useState(false);

  // Policy state - supports multiple policies
  const [selectedPolicies, setSelectedPolicies] = useState<SelectedPolicy[]>([]);
  const [selectedPolicyToAdd, setSelectedPolicyToAdd] = useState<string>("");

  // Expiration
  const [hasExpiration, setHasExpiration] = useState(false);
  const [expirationLedgers, setExpirationLedgers] = useState(DEFAULT_EXPIRATION_LEDGER_DELTA);

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Signer picker state for multi-signer operations
  const [signerPickerOpen, setSignerPickerOpen] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState(false);

  const submit = useMultiSignerSubmit(kit, onLog);
  const hasEd25519 = Boolean(ed25519VerifierAddress);

  const visiblePolicies = useMemo(
    () =>
      availablePolicies.filter(
        (policy) => policy.type !== "weighted_threshold" || WEIGHTED_THRESHOLD_ENABLED
      ),
    [availablePolicies]
  );

  const isEditing = !!editingRule;

  const needsMultiSigner = useCallback(
    (): boolean => kit.multiSigners.needsMultiSigner(existingSigners),
    [existingSigners, kit]
  );

  /** Sign + submit a transaction, using the multi-signer flow when needed. */
  const submitTx = useCallback(
    (tx: import("smart-account-kit").AssembledTransaction<unknown>, selectedSigners?: SelectedSigner[]) =>
      submit(tx, {
        selectedSigners,
        ruleSigners: existingSigners,
        activeCredentialId,
      }),
    [submit, existingSigners, activeCredentialId]
  );

  // Reset form when modal opens/closes
  useEffect(() => {
    if (!isOpen) return;

    if (editingRule) {
      setName(editingRule.name || "");

      if (editingRule.context_type.tag === "CallContract") {
        setContextType("call_contract");
        setContractAddress(editingRule.context_type.values[0] as string);
      } else if (editingRule.context_type.tag === "CreateContract") {
        setContextType("create_contract");
        const hashBytes = editingRule.context_type.values[0] as Buffer;
        setWasmHash(hashBytes.toString("hex"));
      } else {
        setContextType("default");
        setContractAddress("");
        setWasmHash("");
      }

      // Load signers from the rule
      const loadedSigners: SignerEntry[] = editingRule.signers.map((signer) => ({
        id: crypto.randomUUID(),
        type:
          signer.tag === "Delegated"
            ? ("delegated" as const)
            : getCredentialIdFromSigner(signer)
              ? ("passkey" as const)
              : ("ed25519" as const),
        address: signer.tag === "Delegated" ? (signer.values[0] as string) : undefined,
        credentialId: getCredentialIdFromSigner(signer) || undefined,
        label: formatSignerLabel(signer),
        signer,
        isActive: getCredentialIdFromSigner(signer) === activeCredentialId,
      }));
      setSigners(loadedSigners);

      // Load expiration
      setHasExpiration(!!editingRule.valid_until);
      setExpirationLedgers(DEFAULT_EXPIRATION_LEDGER_DELTA);
      if (editingRule.valid_until) {
        void getCurrentLedgerSequence()
          .then((currentLedger) => {
            setExpirationLedgers(
              absoluteValidUntilToLedgerDelta(editingRule.valid_until!, currentLedger)
            );
          })
          .catch((loadError) => {
            console.warn("Failed to resolve current ledger for expiration:", loadError);
            setExpirationLedgers(DEFAULT_EXPIRATION_LEDGER_DELTA);
          });
      }

      // Load policies with their live on-chain params via the typed policy clients
      void readRulePolicyParams(kit, editingRule, visiblePolicies)
        .then(setSelectedPolicies)
        .catch((loadError) => {
          console.warn("Failed to load rule policies:", loadError);
          setSelectedPolicies([]);
        });
    } else {
      // Create mode - reset form
      setName("");
      setContextType("default");
      setContractAddress("");
      setWasmHash("");
      setSigners([]);
      setSelectedPolicies([]);
      setHasExpiration(false);
    }
    setError(null);
    setSelectedPolicyToAdd("");
    setSelectedSignerId("");
    setEd25519Secret("");
  }, [isOpen, editingRule, activeCredentialId, kit, visiblePolicies]);

  // Candidate signers (on-chain + pending) for the "existing" add mode
  const existingSignerEntries: SignerEntryInfo[] = useMemo(() => {
    const onChainSignerEntries: SignerEntryInfo[] = existingSigners.map((signer) => {
      const credId = getCredentialIdFromSigner(signer);
      const isActive = credId ? credId === activeCredentialId : false;
      const isDelegated = signer.tag === "Delegated";
      const address = isDelegated ? (signer.values[0] as string) : undefined;
      const id = credId || address || crypto.randomUUID();
      return {
        id,
        signer,
        label: formatSignerLabel(signer),
        type: isDelegated ? ("delegated" as const) : ("passkey" as const),
        credentialId: credId,
        address,
        isActive,
        isPending: false,
      };
    });

    const pendingSignerEntries: SignerEntryInfo[] = pendingCredentials
      .filter((pc) => !onChainSignerEntries.some((e) => e.credentialId === pc.credentialId))
      .map((pc) => ({
        id: pc.credentialId,
        signer: undefined,
        label: `${pc.nickname || pc.credentialId.slice(0, 8)} (pending)`,
        type: "passkey" as const,
        credentialId: pc.credentialId,
        publicKey: pc.publicKey,
        isActive: false,
        isPending: true,
      }));

    return [...onChainSignerEntries, ...pendingSignerEntries];
  }, [existingSigners, activeCredentialId, pendingCredentials]);

  const handleAddExistingSigner = useCallback(() => {
    const entry = existingSignerEntries.find((e) => e.id === selectedSignerId);
    if (!entry) {
      setError("Please select a signer");
      return;
    }

    if (entry.credentialId && signers.some((s) => s.credentialId === entry.credentialId)) {
      setError("This signer is already added");
      return;
    }
    if (entry.address && signers.some((s) => s.address === entry.address)) {
      setError("This signer is already added");
      return;
    }

    let newSigner: SignerEntry;
    if (entry.isPending && entry.publicKey) {
      newSigner = {
        id: crypto.randomUUID(),
        type: "passkey" as const,
        credentialId: entry.credentialId || undefined,
        publicKey: entry.publicKey,
        label: entry.label.replace(" (pending)", ""),
        isActive: false,
      };
    } else {
      newSigner = {
        id: crypto.randomUUID(),
        type: entry.type,
        address: entry.address,
        credentialId: entry.credentialId || undefined,
        label: entry.label + (entry.isActive ? " (active)" : ""),
        signer: entry.signer,
        isActive: entry.isActive,
      };
    }

    setSigners([...signers, newSigner]);
    setError(null);

    const nextAvailable = existingSignerEntries.find((e) => {
      if (e.id === entry.id) return false;
      if (e.credentialId && signers.some((s) => s.credentialId === e.credentialId)) return false;
      if (e.address && signers.some((s) => s.address === e.address)) return false;
      return true;
    });
    if (nextAvailable) {
      setSelectedSignerId(nextAvailable.id);
    }
  }, [selectedSignerId, existingSignerEntries, signers]);

  const handleCreateNewPasskey = useCallback(async () => {
    setAddingPasskey(true);
    setError(null);

    try {
      const label = newPasskeyName.trim() || `Signer ${signers.length + 1}`;
      const credential = await kit.credentials.create({
        nickname: label,
        appName: "Smart Account Demo",
      });

      setSigners([
        ...signers,
        {
          id: crypto.randomUUID(),
          type: "passkey",
          credentialId: credential.credentialId,
          publicKey: credential.publicKey,
          label,
        },
      ]);

      setNewPasskeyName("");
      onLog(`Created new passkey: ${label}`, "success");
      onLog(`Passkey saved locally - will persist if submission fails`, "info");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to create passkey";
      setError(message);
      onLog(`Failed to create passkey: ${message}`, "error");
    } finally {
      setAddingPasskey(false);
    }
  }, [kit, newPasskeyName, signers, onLog]);

  const handleAddGAddress = useCallback(() => {
    const address = gAddress.trim();

    if (!address.startsWith("G") || address.length !== 56) {
      setError("Invalid Stellar address. Must start with G and be 56 characters.");
      return;
    }

    if (signers.some((s) => s.type === "delegated" && s.address === address)) {
      setError("This signer is already added");
      return;
    }

    setSigners([
      ...signers,
      {
        id: crypto.randomUUID(),
        type: "delegated",
        address,
        label: `${address.slice(0, 8)}...${address.slice(-8)}`,
      },
    ]);
    setGAddress("");
    setError(null);
  }, [gAddress, signers]);

  const handleAddEd25519 = useCallback(() => {
    const secret = ed25519Secret.trim();
    if (!secret.startsWith("S") || secret.length !== 56) {
      setError("Invalid secret key. Must start with S and be 56 characters.");
      return;
    }
    if (!ed25519VerifierAddress) {
      setError("No Ed25519 verifier is configured.");
      return;
    }
    if (!addEd25519FromSecret) {
      setError("Ed25519 signing is not available.");
      return;
    }

    setAddingEd25519(true);
    setError(null);
    try {
      // Register the keypair so it can sign later, and derive the 32-byte pubkey.
      const registered = addEd25519FromSecret(secret);
      if (!registered) {
        throw new Error("Failed to register Ed25519 signer");
      }
      const publicKey = Buffer.from(registered.publicKey, "hex");

      if (
        signers.some(
          (s) =>
            s.type === "ed25519" &&
            s.publicKey &&
            Buffer.from(s.publicKey).toString("hex") === registered.publicKey
        )
      ) {
        setError("This Ed25519 signer is already added");
        return;
      }

      setSigners([
        ...signers,
        {
          id: crypto.randomUUID(),
          type: "ed25519",
          publicKey,
          verifierAddress: ed25519VerifierAddress,
          label: `Ed25519 ${registered.publicKey.slice(0, 8)}...`,
        },
      ]);
      setEd25519Secret("");
      onLog(`Added Ed25519 signer: ${registered.address.slice(0, 10)}...`, "success");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to add Ed25519 signer";
      setError(message);
    } finally {
      setAddingEd25519(false);
    }
  }, [ed25519Secret, ed25519VerifierAddress, addEd25519FromSecret, signers, onLog]);

  const handleAddConnectedWallet = useCallback((wallet: ConnectedWallet) => {
    const address = wallet.address;

    if (signers.some((s) => s.type === "delegated" && s.address === address)) {
      setError("This wallet is already added as a signer");
      return;
    }

    const walletLabel = `${wallet.walletName}: ${address.slice(0, 8)}...${address.slice(-8)}`;

    setSigners([
      ...signers,
      {
        id: crypto.randomUUID(),
        type: "delegated",
        address,
        label: walletLabel,
      },
    ]);
    setError(null);
    onLog(`Added ${wallet.walletName} (${address.slice(0, 8)}...) as signer`, "success");
  }, [signers, onLog]);

  const handleRemoveSigner = (id: string) => {
    setSigners(signers.filter((s) => s.id !== id));
  };

  /**
   * Execute the actual submission logic.
   * @param selectedSigners Optional signers from SignerPicker (multi-signer flow)
   */
  const executeSubmit = async (selectedSigners?: SelectedSigner[]) => {
    setLoading(true);
    onLog(`${isEditing ? "Updating" : "Creating"} context rule "${name}"...`);

    const runSubmit = (
      tx: import("smart-account-kit").AssembledTransaction<unknown>
    ) => submitTx(tx, selectedSigners);

    try {
      // Build context type
      let ctxType: ContextRuleType;
      if (contextType === "call_contract") {
        ctxType = createCallContractContext(contractAddress);
      } else if (contextType === "create_contract") {
        ctxType = createCreateContractContext(wasmHash);
      } else {
        ctxType = createDefaultContext();
      }

      // Build signers (reuse on-chain objects, otherwise construct fresh ones)
      const builtSigners: Signer[] = [];
      for (const entry of signers) {
        const signer = signerEntryToContractSigner(
          entry,
          webauthnVerifierAddress,
          ed25519VerifierAddress
        );
        if (signer) {
          builtSigners.push(signer);
        }
      }

      // Calculate expiration
      const validUntil = hasExpiration
        ? (await getCurrentLedgerSequence()) + expirationLedgers
        : undefined;

      if (isEditing) {
        const ruleId = editingRule!.id;

        // Update name if changed
        if (name.trim() !== editingRule!.name) {
          onLog(`Updating rule name...`);
          const tx = await kit.rules.updateName(ruleId, name.trim());
          const result = await runSubmit(tx);
          if (!result.success) {
            throw new Error(result.error || "Failed to update rule name");
          }
        }

        // New signers (those without a pre-existing signer object)
        const newSigners = signers.filter((entry) => !entry.signer);

        // Removed signers (in the original rule but not in current signers)
        const removedSigners = editingRule!.signers.filter(
          (originalSigner) => !signers.some((s) => s.signer && signersEqual(s.signer, originalSigner))
        );

        // Add new signers in one batch_add_signer call (batch add coverage)
        if (newSigners.length > 0) {
          const contractSigners = newSigners
            .map((e) => signerEntryToContractSigner(e, webauthnVerifierAddress, ed25519VerifierAddress))
            .filter((s): s is Signer => s !== null);
          if (contractSigners.length > 0) {
            onLog(
              contractSigners.length > 1
                ? `Adding ${contractSigners.length} signers (batch)...`
                : `Adding signer...`
            );
            const tx = await kit.signers.addBatch(ruleId, contractSigners);
            const result = await runSubmit(tx);
            if (!result.success) {
              throw new Error(result.error || "Failed to add signers");
            }
          }
        }

        // Remove signers that were deleted
        for (const signer of removedSigners) {
          onLog(`Removing signer...`);
          const tx = await kit.signers.remove(ruleId, signer);
          const result = await runSubmit(tx);
          if (!result.success) {
            throw new Error(result.error || "Failed to remove signer");
          }
        }

        // Handle policy changes. Adding signers changes auth requirements, so skip
        // policy edits in the same operation when new signers were added.
        const currentPolicyAddresses = selectedPolicies.map((sp) => sp.policy.address);
        const originalPolicyAddresses = editingRule!.policies;

        const policiesToAdd = selectedPolicies.filter(
          (sp) => !originalPolicyAddresses.includes(sp.policy.address)
        );
        const policiesToRemove = originalPolicyAddresses.filter(
          (addr) => !currentPolicyAddresses.includes(addr)
        );
        const policiesToUpdate = selectedPolicies.filter(
          (sp) => originalPolicyAddresses.includes(sp.policy.address) && sp.modified
        );

        const hasPolicyChanges =
          policiesToAdd.length > 0 || policiesToRemove.length > 0 || policiesToUpdate.length > 0;
        const addedNewSigners = newSigners.length > 0;

        const addPolicy = async (sp: SelectedPolicy) => {
          const encoded = encodePolicyInstallParam(
            kit,
            sp,
            signers,
            webauthnVerifierAddress,
            ed25519VerifierAddress
          );
          const tx = await kit.policies.add(ruleId, sp.policy.address, encoded);
          const result = await runSubmit(tx);
          if (!result.success) {
            throw new Error(result.error || `Failed to add policy ${sp.policy.name}`);
          }
        };

        if (hasPolicyChanges && addedNewSigners) {
          onLog(`Note: Policy changes skipped - please update policies separately after adding signers`, "info");
        } else {
          // Remove policies (both removed and those being re-added with new params)
          for (const policyAddress of policiesToRemove) {
            onLog(`Removing policy ${policyAddress.slice(0, 8)}...`);
            const tx = await kit.policies.remove(ruleId, policyAddress);
            const result = await runSubmit(tx);
            if (!result.success) {
              throw new Error(result.error || `Failed to remove policy ${policyAddress}`);
            }
          }
          for (const sp of policiesToUpdate) {
            onLog(`Updating policy ${sp.policy.name}...`);
            const removeTx = await kit.policies.remove(ruleId, sp.policy.address);
            const removeResult = await runSubmit(removeTx);
            if (!removeResult.success) {
              throw new Error(removeResult.error || `Failed to update policy ${sp.policy.name}`);
            }
          }

          // Re-add updated policies, then add net-new policies
          for (const sp of policiesToUpdate) {
            await addPolicy(sp);
          }
          for (const sp of policiesToAdd) {
            onLog(`Adding policy ${sp.policy.name}...`);
            await addPolicy(sp);
          }
        }

        // Update expiration if changed (unless we added new signers)
        const originalExpiration = editingRule!.valid_until || undefined;
        const newExpiration = validUntil || undefined;
        const expirationChanged = originalExpiration !== newExpiration;

        if (expirationChanged && !addedNewSigners) {
          onLog(`Updating expiration...`);
          const tx = await kit.rules.updateExpiration(ruleId, validUntil);
          const result = await runSubmit(tx);
          if (!result.success) {
            throw new Error(result.error || "Failed to update expiration");
          }
        } else if (expirationChanged && addedNewSigners) {
          onLog(`Note: Expiration update skipped - please update expiration separately after adding signers`, "info");
        }

        onLog(`Context rule "${name}" updated!`, "success");
      } else {
        // Create new rule - build sorted policies map (Soroban requires sorted keys)
        const policies = new Map<string, unknown>();
        for (const sp of selectedPolicies) {
          policies.set(
            sp.policy.address,
            encodePolicyInstallParam(kit, sp, signers, webauthnVerifierAddress, ed25519VerifierAddress)
          );
        }
        const sortedPolicies = new Map(
          [...policies.entries()].sort(([a], [b]) => a.localeCompare(b))
        );

        const tx = await kit.rules.add(ctxType, name.trim(), builtSigners, sortedPolicies, validUntil);
        const result = await runSubmit(tx);
        if (!result.success) {
          throw new Error(result.error || "Failed to create rule");
        }
        onLog(`Context rule "${name}" created!`, "success");
      }

      // Clean up any pending passkeys that were successfully added
      for (const entry of signers) {
        if (entry.type === "passkey" && entry.credentialId && !entry.signer) {
          await kit.credentials.delete(entry.credentialId);
          onLog(`Cleaned up pending passkey: ${entry.label}`, "info");
        }
      }

      onSuccess();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      onLog(`Failed to ${isEditing ? "update" : "create"} rule: ${message}`, "error");
    } finally {
      setLoading(false);
      setPendingSubmit(false);
    }
  };

  /** Validate and either submit directly or open the SignerPicker. */
  const handleSubmit = async () => {
    setError(null);

    if (!name.trim()) {
      setError("Rule name is required.");
      return;
    }
    // Use the SDK's byte-accurate validation (the contract's MAX_NAME_SIZE is a
    // UTF-8 byte limit, not a character count — multi-byte names can pass a
    // char-count check yet fail on-chain).
    try {
      validateContextRuleName(name.trim());
    } catch {
      setError(`Rule name must be at most ${MAX_NAME_SIZE} bytes (UTF-8).`);
      return;
    }
    if (contextType === "call_contract") {
      if (!contractAddress.startsWith("C") || contractAddress.length !== 56) {
        setError("Invalid contract address. Must start with C and be 56 characters.");
        return;
      }
    }
    if (contextType === "create_contract") {
      const cleanHash = wasmHash.startsWith("0x") ? wasmHash.slice(2) : wasmHash;
      if (cleanHash.length !== 64 || !/^[0-9a-fA-F]+$/.test(cleanHash)) {
        setError("Invalid WASM hash. Must be 64 hex characters (32 bytes).");
        return;
      }
    }
    if (signers.length === 0 && selectedPolicies.length === 0) {
      setError("At least one signer or policy is required.");
      return;
    }

    // Validate threshold policies
    const thresholdPolicies = selectedPolicies.filter((p) => p.policy.type === "threshold");
    for (const tp of thresholdPolicies) {
      if ((tp.threshold || 1) > signers.length) {
        setError(`Threshold (${tp.threshold || 1}) cannot exceed number of signers (${signers.length}).`);
        return;
      }
    }

    // Multi-signer flow - show the picker
    if (needsMultiSigner()) {
      setPendingSubmit(true);
      setSignerPickerOpen(true);
      return;
    }

    await executeSubmit();
  };

  const handleSignerPickerConfirm = (selectedSigners: SelectedSigner[]) => {
    setSignerPickerOpen(false);
    if (pendingSubmit) {
      executeSubmit(selectedSigners);
    }
  };

  const handleSignerPickerClose = () => {
    setSignerPickerOpen(false);
    setPendingSubmit(false);
  };

  // Compute available signers (those not already added)
  const availableExistingSigners = useMemo(() => {
    return existingSignerEntries.filter((entry) => {
      if (entry.credentialId && signers.some((s) => s.credentialId === entry.credentialId)) {
        return false;
      }
      if (entry.address && signers.some((s) => s.address === entry.address)) {
        return false;
      }
      return true;
    });
  }, [existingSignerEntries, signers]);

  // Set initial selected signer ID when available signers change
  useEffect(() => {
    if (isOpen && availableExistingSigners.length > 0) {
      if (!selectedSignerId || !availableExistingSigners.some((e) => e.id === selectedSignerId)) {
        setSelectedSignerId(availableExistingSigners[0].id);
      }
    }
  }, [isOpen, availableExistingSigners, selectedSignerId]);

  if (!isOpen) return null;

  return (
  <>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{isEditing ? "Edit Context Rule" : "Create Context Rule"}</h3>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          {/* Rule Name */}
          <div className="form-group">
            <label>Rule Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Primary Signers, Trading Bot, Daily Spending"
            />
          </div>

          {/* Context Type */}
          <div className="form-group">
            <label>Context Type</label>
            <div className="radio-group">
              <label className="radio-label">
                <input
                  type="radio"
                  name="contextType"
                  value="default"
                  checked={contextType === "default"}
                  onChange={() => setContextType("default")}
                />
                <span>Default (Any Operation)</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="contextType"
                  value="call_contract"
                  checked={contextType === "call_contract"}
                  onChange={() => setContextType("call_contract")}
                />
                <span>Call Contract</span>
              </label>
              <label className="radio-label">
                <input
                  type="radio"
                  name="contextType"
                  value="create_contract"
                  checked={contextType === "create_contract"}
                  onChange={() => setContextType("create_contract")}
                />
                <span>Create Contract</span>
              </label>
            </div>
            {contextType === "call_contract" && (
              <input
                type="text"
                value={contractAddress}
                onChange={(e) => setContractAddress(e.target.value)}
                placeholder="Contract address (C...)"
                style={{ marginTop: "8px" }}
              />
            )}
            {contextType === "create_contract" && (
              <input
                type="text"
                value={wasmHash}
                onChange={(e) => setWasmHash(e.target.value)}
                placeholder="WASM hash (64 hex chars, e.g., abc123...)"
                style={{ marginTop: "8px" }}
              />
            )}
          </div>

          {/* Signers */}
          <div className="form-group">
            <label>Signers</label>
            <p className="form-hint">
              Add accounts that can authorize transactions under this rule.
            </p>

            {/* Current signers list */}
            {signers.length > 0 && (
              <div className="signer-list">
                {signers.map((signer) => {
                  const matchingWallet = signer.type === "delegated" && signer.address
                    ? connectedWallets.find((w) => w.address === signer.address)
                    : undefined;

                  return (
                    <div key={signer.id} className={`signer-item ${signer.isActive ? "active" : ""} ${matchingWallet ? "connected" : ""}`}>
                      <span className="signer-type-badge">
                        {signer.type === "delegated"
                          ? "G-Address"
                          : signer.type === "ed25519"
                            ? "Ed25519"
                            : "Passkey"}
                      </span>
                      <span className="signer-value">
                        {signer.label}
                        {signer.isActive && <span className="active-badge">active</span>}
                        {matchingWallet && <span className="connected-badge">{matchingWallet.walletName}</span>}
                      </span>
                      <button
                        className="remove-btn"
                        onClick={() => handleRemoveSigner(signer.id)}
                        title="Remove signer"
                      >
                        &times;
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add signer section */}
            <div className="add-signer-section">
              <div className="signer-mode-tabs">
                <button
                  className={`mode-tab ${addMode === "existing" ? "active" : ""}`}
                  onClick={() => setAddMode("existing")}
                  disabled={addingPasskey}
                >
                  Existing
                </button>
                <button
                  className={`mode-tab ${addMode === "new_passkey" ? "active" : ""}`}
                  onClick={() => setAddMode("new_passkey")}
                  disabled={addingPasskey}
                >
                  New Passkey
                </button>
                <button
                  className={`mode-tab ${addMode === "connected_wallet" ? "active" : ""}`}
                  onClick={() => setAddMode("connected_wallet")}
                  disabled={addingPasskey}
                >
                  Connected Wallet
                </button>
                <button
                  className={`mode-tab ${addMode === "g_address" ? "active" : ""}`}
                  onClick={() => setAddMode("g_address")}
                  disabled={addingPasskey}
                >
                  Manual G-Address
                </button>
                {hasEd25519 && (
                  <button
                    className={`mode-tab ${addMode === "ed25519" ? "active" : ""}`}
                    onClick={() => setAddMode("ed25519")}
                    disabled={addingPasskey}
                  >
                    Ed25519 Key
                  </button>
                )}
              </div>

              <div className="signer-mode-content">
                {addMode === "existing" && (
                  <div className="add-signer-row">
                    {availableExistingSigners.length > 0 ? (
                      <>
                        <select
                          value={selectedSignerId}
                          onChange={(e) => setSelectedSignerId(e.target.value)}
                          disabled={addingPasskey}
                        >
                          {availableExistingSigners.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              {entry.label} ({entry.type})
                              {entry.isActive && " * active"}
                            </option>
                          ))}
                        </select>
                        <button
                          className="small"
                          onClick={handleAddExistingSigner}
                          disabled={addingPasskey}
                        >
                          Add
                        </button>
                      </>
                    ) : (
                      <span className="no-credentials">
                        {existingSignerEntries.length === 0
                          ? "No existing signers found on-chain."
                          : "All existing signers already added."}
                      </span>
                    )}
                  </div>
                )}

                {addMode === "new_passkey" && (
                  <div className="add-signer-row">
                    <input
                      type="text"
                      value={newPasskeyName}
                      onChange={(e) => setNewPasskeyName(e.target.value)}
                      placeholder="Passkey name (optional)"
                      disabled={addingPasskey}
                    />
                    <button
                      className="small"
                      onClick={handleCreateNewPasskey}
                      disabled={addingPasskey}
                    >
                      {addingPasskey ? <span className="spinner" /> : "Create"}
                    </button>
                  </div>
                )}

                {addMode === "connected_wallet" && (
                  <div className="connected-wallets-add-section">
                    {connectedWallets.length > 0 ? (
                      <div className="connected-wallets-list">
                        {connectedWallets.map((wallet) => {
                          const isAlreadyAdded = signers.some(
                            (s) => s.type === "delegated" && s.address === wallet.address
                          );
                          return (
                            <div key={wallet.address} className="connected-wallet-item">
                              <div className="wallet-info">
                                <span className="wallet-badge">{wallet.walletName}</span>
                                <span className="wallet-address">
                                  {wallet.address.slice(0, 10)}...{wallet.address.slice(-6)}
                                </span>
                              </div>
                              <button
                                className="small"
                                onClick={() => handleAddConnectedWallet(wallet)}
                                disabled={isAlreadyAdded}
                              >
                                {isAlreadyAdded ? "Added" : "Add"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="no-wallets-message">
                        <span className="no-credentials">No wallets connected yet</span>
                      </div>
                    )}
                    <button
                      className="small secondary connect-more-btn"
                      onClick={() => {
                        // connect() throws on genuine failures; don't leave the
                        // promise rejection unhandled.
                        connectWallet().catch((error) => {
                          onLog(
                            `Wallet connection failed: ${error instanceof Error ? error.message : String(error)}`,
                            "error"
                          );
                        });
                      }}
                      style={{ marginTop: connectedWallets.length > 0 ? "12px" : "0" }}
                    >
                      {connectedWallets.length > 0 ? "+ Connect Another Wallet" : "Connect Wallet"}
                    </button>
                  </div>
                )}

                {addMode === "g_address" && (
                  <div className="add-signer-row">
                    <input
                      type="text"
                      value={gAddress}
                      onChange={(e) => setGAddress(e.target.value)}
                      placeholder="Stellar address (G...)"
                      disabled={addingPasskey}
                    />
                    <button
                      className="small"
                      onClick={handleAddGAddress}
                      disabled={addingPasskey || !gAddress}
                    >
                      Add
                    </button>
                  </div>
                )}

                {addMode === "ed25519" && (
                  <div className="add-signer-row">
                    <input
                      type="password"
                      value={ed25519Secret}
                      onChange={(e) => setEd25519Secret(e.target.value)}
                      placeholder="Ed25519 secret key (S...)"
                      disabled={addingEd25519}
                    />
                    <button
                      className="small"
                      onClick={handleAddEd25519}
                      disabled={addingEd25519 || !ed25519Secret.trim()}
                    >
                      {addingEd25519 ? <span className="spinner" /> : "Add"}
                    </button>
                  </div>
                )}
              </div>
              {addMode === "ed25519" && (
                <p className="form-hint">
                  Registers a local Ed25519 keypair as an External signer via the
                  configured verifier. Use an isolated test key only. Page code
                  can read the key while it is in memory.
                </p>
              )}
            </div>
          </div>

          {/* Policies */}
          <PolicyConfigList
            selectedPolicies={selectedPolicies}
            setSelectedPolicies={setSelectedPolicies}
            visiblePolicies={visiblePolicies}
            signers={signers}
            selectedPolicyToAdd={selectedPolicyToAdd}
            setSelectedPolicyToAdd={setSelectedPolicyToAdd}
          />

          {/* Expiration */}
          <div className="form-group">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={hasExpiration}
                onChange={(e) => setHasExpiration(e.target.checked)}
              />
              <span>Set Expiration</span>
            </label>
            {hasExpiration && (
              <div style={{ marginTop: "8px" }}>
                <label>
                  Expires in:
                  <input
                    type="number"
                    min={1}
                    value={expirationLedgerDeltaToDays(expirationLedgers)}
                    onChange={(e) =>
                      setExpirationLedgers(expirationDaysToLedgerDelta(parseInt(e.target.value) || 1))
                    }
                    style={{ width: "80px", marginLeft: "8px" }}
                  />
                  <span style={{ marginLeft: "4px" }}>days</span>
                </label>
              </div>
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={loading}>
            {loading ? (
              <span className="spinner" />
            ) : isEditing ? (
              "Update Rule"
            ) : (
              "Create Rule"
            )}
          </button>
        </div>
      </div>
    </div>

    {/* SignerPicker modal for multi-signer operations */}
    <SignerPicker
      isOpen={signerPickerOpen}
      onClose={handleSignerPickerClose}
      availableSigners={existingSigners}
      activeCredentialId={activeCredentialId || null}
      onConfirm={handleSignerPickerConfirm}
      title={isEditing ? "Select Signers for Update" : "Select Signers"}
      description="Choose which signers to use for this context rule operation."
      connectedWallets={connectedWallets}
      connectWallet={connectWallet}
      disconnectWalletByAddress={disconnectWalletByAddress}
      addFromSecret={addFromSecret}
      addEd25519FromSecret={addEd25519FromSecret}
      canSignEd25519={(signer) =>
        signer.tag === "External" &&
        kit.externalSigners.canSignEd25519(signer.values[1] as Buffer)
      }
    />
  </>
  );
}
