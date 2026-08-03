import { useState, useCallback, useEffect } from "react";
import { rpc, Asset } from "@stellar/stellar-sdk";
import {
  getCredentialIdFromSigner,
  collectUniqueSigners,
  type SmartAccountKit,
  type StoredCredential,
  type SelectedSigner,
  type IndexedContractSummary,
} from "smart-account-kit";
import type { ContextRule, Signer } from "smart-account-kit-bindings";
import { CONFIG } from "../config";
import { STROOPS_PER_XLM } from "../constants";
import type { LogFn } from "../types";
import { validateAddress, validateAmount } from "../utils/sdk";

interface UseWalletSessionDeps {
  kit: SmartAccountKit | null;
  log: LogFn;
  /** Current WebAuthn verifier address (for restored-wallet shape checks). */
  webauthnVerifier: string;
  /** Refresh the locally-stored pending credentials list. */
  refreshPending: () => Promise<void>;
}

/**
 * Owns everything about the connected wallet session: connect/create/disconnect,
 * balance, on-chain signers, funding, transfers (single + multi-signer), pending
 * deployment, the multi-contract picker, and silent auto-reconnect.
 */
export function useWalletSession({
  kit,
  log,
  webauthnVerifier,
  refreshPending,
}: UseWalletSessionDeps) {
  const [isConnected, setIsConnected] = useState(false);
  const [contractId, setContractId] = useState<string | null>(null);
  const [credentialId, setCredentialId] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [allSigners, setAllSigners] = useState<Signer[]>([]);
  const [activeSigner, setActiveSigner] = useState<Signer | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [autoConnectAttempted, setAutoConnectAttempted] = useState(false);

  // Multi-contract picker (when a passkey maps to several accounts)
  const [discoveredContracts, setDiscoveredContracts] = useState<
    IndexedContractSummary[]
  >([]);
  const [showContractPicker, setShowContractPicker] = useState(false);
  const [pendingCredentialForPicker, setPendingCredentialForPicker] = useState<
    string | null
  >(null);

  // Multi-signer transfer picker
  const [signerPickerOpen, setSignerPickerOpen] = useState(false);
  const [pendingTransfer, setPendingTransfer] = useState<{
    recipient: string;
    amount: number;
  } | null>(null);

  const ensureCurrentWalletShape = useCallback(
    async (
      kitInstance: SmartAccountKit,
      restoredContractId: string,
      activeCredentialId?: string | null
    ): Promise<ContextRule[] | undefined> => {
      const details = await kitInstance.getContractDetailsFromIndexer(
        restoredContractId
      );
      if (!details || !kitInstance.wallet) {
        return undefined;
      }

      const rules = await kitInstance.rules.list();

      if (details.contextRules.length > 0 && rules.length === 0) {
        throw new Error(
          "Failed to decode active context rules for the restored wallet"
        );
      }

      // Return the enumerated rules so callers can reuse this snapshot for
      // fetchAllSigners instead of re-enumerating (rules.list is uncached).
      if (!activeCredentialId) {
        return rules;
      }

      const active = rules
        .flatMap((rule) => rule.signers)
        .find(
          (signer) => getCredentialIdFromSigner(signer) === activeCredentialId
        );

      if (!active) {
        throw new Error(
          "The authenticated passkey is not an active signer on this wallet"
        );
      }

      if (active.tag !== "External") {
        throw new Error("The authenticated signer is not a current WebAuthn signer");
      }

      const verifierAddress = active.values[0];
      if (verifierAddress !== webauthnVerifier) {
        throw new Error(
          `This wallet uses an older WebAuthn verifier (${verifierAddress}) instead of the current demo verifier (${webauthnVerifier})`
        );
      }

      return rules;
    },
    [webauthnVerifier]
  );

  const fetchBalance = useCallback(async (walletContractId: string) => {
    try {
      const server = new rpc.Server(CONFIG.rpcUrl);
      const result = await server.getSACBalance(
        walletContractId,
        Asset.native(),
        CONFIG.networkPassphrase
      );
      if (result.balanceEntry) {
        const xlmBalance = (
          Number(result.balanceEntry.amount) / STROOPS_PER_XLM
        ).toFixed(2);
        setBalance(xlmBalance);
      } else {
        setBalance("0.00");
      }
    } catch (error) {
      console.warn("Failed to fetch balance:", error);
      setBalance(null);
    }
  }, []);

  const fetchAllSigners = useCallback(
    async (
      kitInstance: SmartAccountKit,
      activeCredId: string | null,
      prefetchedRules?: ContextRule[]
    ) => {
      try {
        // Reuse a snapshot enumerated by the caller (ensureCurrentWalletShape)
        // instead of a second uncached rules.list() enumeration.
        const rules = prefetchedRules ?? (await kitInstance.rules.list());
        const uniqueSigners = collectUniqueSigners(
          rules.flatMap((rule) => rule.signers)
        );
        setAllSigners(uniqueSigners);

        if (activeCredId) {
          const active = uniqueSigners.find(
            (s) => getCredentialIdFromSigner(s) === activeCredId
          );
          setActiveSigner(active || null);
        } else {
          setActiveSigner(null);
        }

        return uniqueSigners;
      } catch (error) {
        console.warn("Failed to fetch signers:", error);
        return [];
      }
    },
    []
  );

  const refreshSigners = useCallback(() => {
    if (kit) {
      void fetchAllSigners(kit, credentialId);
    }
  }, [kit, credentialId, fetchAllSigners]);

  // Apply a successful connection: update state + kick off balance/signer loads.
  const applyConnection = useCallback(
    (
      nextContractId: string,
      nextCredentialId: string,
      prefetchedRules?: ContextRule[]
    ) => {
      setContractId(nextContractId);
      setCredentialId(nextCredentialId);
      setIsConnected(true);
      fetchBalance(nextContractId);
      if (kit) {
        void fetchAllSigners(kit, nextCredentialId, prefetchedRules);
      }
    },
    [kit, fetchBalance, fetchAllSigners]
  );

  // Reset connection state whenever the kit is re-created (config changed).
  useEffect(() => {
    setIsConnected(false);
    setContractId(null);
    setCredentialId(null);
    setBalance(null);
    setAllSigners([]);
    setActiveSigner(null);
    setAutoConnectAttempted(false);
  }, [kit]);

  // Silent auto-reconnect to a stored session (no passkey prompt).
  useEffect(() => {
    if (!kit || isConnected || autoConnectAttempted) {
      return;
    }
    setAutoConnectAttempted(true);

    const autoConnect = async () => {
      const result = await kit.connectWallet();
      if (!result) return;

      try {
        const shapeRules = await ensureCurrentWalletShape(kit, result.contractId, result.credentialId);
        log(`Session restored: ${result.contractId.slice(0, 10)}...`, "success");
        applyConnection(result.contractId, result.credentialId, shapeRules);
      } catch (error) {
        await kit.disconnect();
        log(
          `Stored wallet is not compatible with the current demo contract surface. Create a fresh wallet with the current demo config. ${error}`,
          "error"
        );
      }
    };

    autoConnect().catch((error) => {
      log(`Auto-connect failed: ${error}`, "error");
    });
  }, [
    kit,
    isConnected,
    autoConnectAttempted,
    log,
    applyConnection,
    ensureCurrentWalletShape,
  ]);

  const createWallet = useCallback(
    async (userName: string) => {
      if (!kit) return;
      const name = userName.trim() || "Demo User";
      setLoading("Creating wallet...");
      log(`Creating wallet for "${name}"...`);

      try {
        const result = await kit.createWallet("Smart Account Demo", name, {
          autoSubmit: true,
        });

        log(`Passkey created: ${result.credentialId.slice(0, 20)}...`, "success");
        log(`Contract address: ${result.contractId}`, "success");

        if (result.submitResult?.success) {
          log("Wallet deployed successfully!", "success");
          log(`Transaction: ${result.submitResult.hash.slice(0, 20)}...`, "success");
          applyConnection(result.contractId, result.credentialId);
        } else if (result.submitResult) {
          log(`Deployment failed: ${result.submitResult.error.message}`, "error");
          await refreshPending();
        }
      } catch (error) {
        log(`Failed to create wallet: ${error}`, "error");
        await refreshPending();
      } finally {
        setLoading(null);
      }
    },
    [kit, log, applyConnection, refreshPending]
  );

  const connectExisting = useCallback(async () => {
    if (!kit) return;
    setLoading("Connecting...");
    log("Prompting for passkey selection...");

    try {
      // Step 1: Authenticate to get the credential ID (no contract yet)
      const { credentialId: authCredentialId } = await kit.authenticatePasskey();
      log(`Authenticated with credential: ${authCredentialId.slice(0, 20)}...`, "success");

      // Step 2: Discover contracts via indexer. Best-effort: a failing or
      // unreachable indexer (e.g. a 500) must NOT hard-fail the connect — fall
      // through to the derived-contract-ID path with a visible warning instead.
      let contracts: IndexedContractSummary[] | null = null;
      try {
        contracts = await kit.discoverContractsByCredential(authCredentialId);
      } catch (discoveryError) {
        const message =
          discoveryError instanceof Error ? discoveryError.message : String(discoveryError);
        console.warn("Indexer discovery failed, falling back to derived contract ID:", discoveryError);
        log(`⚠️ Indexer discovery failed (${message}); falling back to derived contract ID`, "info");
        contracts = null;
      }

      if (contracts && contracts.length > 1) {
        log(`Found ${contracts.length} smart accounts for this passkey`, "info");
        setDiscoveredContracts(contracts);
        setPendingCredentialForPicker(authCredentialId);
        setShowContractPicker(true);
        setLoading(null);
        return;
      }

      if (contracts && contracts.length === 1) {
        log(`Found 1 smart account via indexer, connecting...`, "info");
        const result = await kit.connectWallet({
          contractId: contracts[0].contract_id,
          credentialId: authCredentialId,
        });
        if (result) {
          const shapeRules = await ensureCurrentWalletShape(kit, result.contractId, result.credentialId);
          log(`Contract ID: ${result.contractId}`, "success");
          applyConnection(result.contractId, result.credentialId, shapeRules);
        }
        return;
      }

      // Step 3: No indexed contracts (or indexer unavailable) - fall back to the
      // derived contract ID.
      log(`No indexed contracts found, trying derived contract ID...`, "info");
      const result = await kit.connectWallet({ credentialId: authCredentialId });
      if (result) {
        const shapeRules = await ensureCurrentWalletShape(kit, result.contractId, result.credentialId);
        log(`Contract ID: ${result.contractId}`, "success");
        applyConnection(result.contractId, result.credentialId, shapeRules);
      }
    } catch (error) {
      await kit.disconnect().catch(() => undefined);
      log(`Failed to connect: ${error}`, "error");
    } finally {
      setLoading(null);
    }
  }, [kit, log, applyConnection, ensureCurrentWalletShape]);

  const cancelContractPicker = useCallback(() => {
    setShowContractPicker(false);
    setPendingCredentialForPicker(null);
    setDiscoveredContracts([]);
  }, []);

  const selectContract = useCallback(
    async (selectedContract: IndexedContractSummary) => {
      if (!kit || !pendingCredentialForPicker) return;

      setShowContractPicker(false);
      setLoading("Connecting to selected account...");
      log(`Connecting to contract: ${selectedContract.contract_id.slice(0, 10)}...`);

      try {
        const result = await kit.connectWallet({
          contractId: selectedContract.contract_id,
          credentialId: pendingCredentialForPicker,
        });
        if (result) {
          const shapeRules = await ensureCurrentWalletShape(kit, result.contractId, result.credentialId);
          log(`Connected to: ${result.contractId}`, "success");
          applyConnection(result.contractId, result.credentialId, shapeRules);
        }
      } catch (error) {
        await kit.disconnect().catch(() => undefined);
        log(`Failed to connect: ${error}`, "error");
      } finally {
        setLoading(null);
        setPendingCredentialForPicker(null);
        setDiscoveredContracts([]);
      }
    },
    [kit, pendingCredentialForPicker, log, applyConnection, ensureCurrentWalletShape]
  );

  const disconnect = useCallback(async () => {
    if (!kit) return;
    await kit.disconnect();
    setContractId(null);
    setBalance(null);
    setCredentialId(null);
    setIsConnected(false);
    setAllSigners([]);
    setActiveSigner(null);
    log("Disconnected from wallet");
  }, [kit, log]);

  const fundWallet = useCallback(async () => {
    if (!kit || !contractId) return;
    setLoading("Funding wallet...");
    log("Funding wallet via Friendbot and transfer...");

    try {
      const result = await kit.fundWallet(CONFIG.nativeTokenContract);
      if (result.success) {
        const amount = result.amount?.toFixed(2) ?? "?";
        log(`Funded smart wallet with ${amount} XLM!`, "success");
        if (result.hash) {
          log(`Transaction: ${result.hash.slice(0, 20)}...`, "success");
        }
        fetchBalance(contractId);
      } else {
        throw new Error(result.error.message || "Funding failed");
      }
    } catch (error) {
      log(`Funding failed: ${error}`, "error");
    } finally {
      setLoading(null);
    }
  }, [kit, contractId, log, fetchBalance]);

  // Transfer entry point: single-signer runs directly; multi-signer opens the picker.
  const requestTransfer = useCallback(
    async (recipientRaw: string, amountRaw: string) => {
      if (!kit || !isConnected || !contractId) return;

      const recipient = recipientRaw.trim();
      const amount = parseFloat(amountRaw.trim());

      try {
        validateAddress(recipient, "recipient address");
        validateAmount(amount, "transfer amount");
      } catch (error) {
        log(error instanceof Error ? error.message : "Validation failed", "error");
        return;
      }

      if (allSigners.length > 1) {
        log("Multiple signers available - select signers for this transaction");
        setPendingTransfer({ recipient, amount });
        setSignerPickerOpen(true);
        return;
      }

      setLoading("Building transfer...");
      log(`Transferring ${amount} XLM to ${recipient.slice(0, 10)}...`);
      log(`From smart wallet: ${contractId}`, "info");

      try {
        const result = await kit.transfer(
          CONFIG.nativeTokenContract,
          recipient,
          amount
        );
        if (result.success) {
          log(`Transfer successful! Sent ${amount} XLM to ${recipient.slice(0, 10)}...`, "success");
          log(`Transaction: ${result.hash.slice(0, 20)}...`, "success");
          if (kit.relayer) {
            log("Fees sponsored by the Relayer — your wallet paid no network fee", "info");
          }
          fetchBalance(contractId);
        } else {
          throw new Error(result.error.message || "Transfer failed");
        }
      } catch (error) {
        log(`Transfer failed: ${error}`, "error");
      } finally {
        setLoading(null);
      }
    },
    [kit, isConnected, contractId, allSigners, log, fetchBalance]
  );

  const confirmTransferSigners = useCallback(
    async (selectedSigners: SelectedSigner[]) => {
      if (!kit || !pendingTransfer || !contractId) return;

      const { recipient, amount } = pendingTransfer;
      setPendingTransfer(null);
      setSignerPickerOpen(false);

      setLoading("Building multi-signer transfer...");
      log(`Transferring ${amount} XLM with ${selectedSigners.length} signer(s)`);
      log(`From smart wallet: ${contractId}`, "info");

      try {
        const result = await kit.multiSigners.transfer(
          CONFIG.nativeTokenContract,
          recipient,
          amount,
          selectedSigners,
          { onLog: log }
        );
        if (result.success) {
          log(`Transfer successful! Sent ${amount} XLM to ${recipient.slice(0, 10)}...`, "success");
          log(`Transaction: ${result.hash.slice(0, 20)}...`, "success");
          if (kit.relayer) {
            log("Fees sponsored by the Relayer — your wallet paid no network fee", "info");
          }
          fetchBalance(contractId);
        } else {
          throw new Error(result.error.message || "Transfer failed");
        }
      } catch (error) {
        log(`Multi-signer transfer failed: ${error}`, "error");
      } finally {
        setLoading(null);
      }
    },
    [kit, pendingTransfer, contractId, log, fetchBalance]
  );

  const cancelTransferSigners = useCallback(() => {
    setSignerPickerOpen(false);
    setPendingTransfer(null);
  }, []);

  const deployPending = useCallback(
    async (credential: StoredCredential) => {
      if (!kit) return;
      setLoading(`Deploying ${credential.credentialId.slice(0, 10)}...`);
      log(`Deploying pending credential: ${credential.credentialId.slice(0, 20)}...`);

      try {
        const result = await kit.credentials.deploy(credential.credentialId, {
          autoSubmit: true,
        });

        if (result.submitResult?.success) {
          log("Wallet deployed successfully!", "success");
          log(`Transaction: ${result.submitResult.hash.slice(0, 20)}...`, "success");
          applyConnection(result.contractId, credential.credentialId);
          await refreshPending();
        } else if (result.submitResult) {
          log(`Deployment failed: ${result.submitResult.error.message}`, "error");
          await refreshPending();
        }
      } catch (error) {
        log(`Failed to deploy: ${error}`, "error");
        await refreshPending();
      } finally {
        setLoading(null);
      }
    },
    [kit, log, applyConnection, refreshPending]
  );

  const deletePending = useCallback(
    async (credential: StoredCredential) => {
      if (!kit) return;
      log(`Removing pending credential: ${credential.credentialId.slice(0, 20)}...`);
      try {
        await kit.credentials.delete(credential.credentialId);
        log("Credential removed from storage", "success");
        await refreshPending();
      } catch (error) {
        log(`Failed to remove: ${error}`, "error");
      }
    },
    [kit, log, refreshPending]
  );

  return {
    // state
    isConnected,
    contractId,
    credentialId,
    balance,
    allSigners,
    activeSigner,
    loading,
    discoveredContracts,
    showContractPicker,
    pendingTransfer,
    signerPickerOpen,
    // actions
    createWallet,
    connectExisting,
    selectContract,
    cancelContractPicker,
    disconnect,
    fundWallet,
    requestTransfer,
    confirmTransferSigners,
    cancelTransferSigners,
    deployPending,
    deletePending,
    refreshSigners,
  };
}
