import { useState, useEffect, useCallback } from "react";
import {
  SmartAccountKit,
  IndexedDBStorage,
  StellarWalletsKitAdapter,
  type StoredCredential,
} from "smart-account-kit";
import { CONFIG, buildDemoStorageName } from "../config";
import type { LogFn } from "../types";

/**
 * Owns the SmartAccountKit instance + the editable config that drives it
 * (WASM hash, WebAuthn verifier) and the locally-stored pending credentials.
 *
 * Re-initializes the kit whenever the config changes; connection state is
 * owned by {@link useWalletSession}, which resets when the kit identity changes.
 */
export function useKit(log: LogFn) {
  const [kit, setKit] = useState<SmartAccountKit | null>(null);
  const [configValid, setConfigValid] = useState(false);
  const [accountWasmHash, setAccountWasmHash] = useState(CONFIG.accountWasmHash);
  const [webauthnVerifier, setWebauthnVerifier] = useState(
    CONFIG.webauthnVerifierAddress
  );
  const [pendingCredentials, setPendingCredentials] = useState<StoredCredential[]>(
    []
  );

  const refreshPending = useCallback(async () => {
    if (kit) {
      setPendingCredentials(await kit.credentials.getPending());
    }
  }, [kit]);

  useEffect(() => {
    if (!accountWasmHash || !webauthnVerifier) {
      setConfigValid(false);
      return;
    }

    let cancelled = false;

    const initKit = async () => {
      try {
        const storage = new IndexedDBStorage(
          buildDemoStorageName(
            CONFIG.networkPassphrase,
            accountWasmHash,
            webauthnVerifier
          )
        );

        // Create and initialize the external wallet adapter
        const walletAdapter = new StellarWalletsKitAdapter({
          network: CONFIG.networkPassphrase,
        });
        await walletAdapter.init();

        const newKit = new SmartAccountKit({
          rpcUrl: CONFIG.rpcUrl,
          networkPassphrase: CONFIG.networkPassphrase,
          accountWasmHash,
          webauthnVerifierAddress: webauthnVerifier,
          // Enables Ed25519 external signers (kit.externalSigners.addEd25519FromSecret)
          ed25519VerifierAddress: CONFIG.ed25519VerifierAddress,
          storage,
          rpName: "Smart Account Kit Demo",
          externalWallet: walletAdapter,
          indexerUrl: CONFIG.indexerUrl,
          indexerAuthToken: CONFIG.indexerAuthToken,
          // Enable Relayer fee sponsoring if URL is configured
          relayerUrl: CONFIG.relayerUrl || undefined,
        });
        if (cancelled) return;

        setKit(newKit);
        setConfigValid(true);
        log("SDK initialized with provided config", "success");

        if (newKit.relayer) {
          log("Relayer fee sponsoring enabled", "success");
        }

        // Sync local records and keep unresolved credentials visible.
        const { deployed } = await newKit.credentials.syncAll();
        if (cancelled) return;
        if (deployed > 0) {
          log(`Confirmed ${deployed} deployed credential(s)`, "info");
        }
        const pendingCreds = await newKit.credentials.getPending();
        if (cancelled) return;
        setPendingCredentials(pendingCreds);
        if (pendingCreds.length > 0) {
          log(`Found ${pendingCreds.length} pending credential(s)`, "info");
        }
      } catch (error) {
        if (cancelled) return;
        log(`Failed to initialize SDK: ${error}`, "error");
        setConfigValid(false);
      }
    };

    initKit();

    return () => {
      cancelled = true;
    };
  }, [accountWasmHash, webauthnVerifier, log]);

  return {
    kit,
    configValid,
    accountWasmHash,
    setAccountWasmHash,
    webauthnVerifier,
    setWebauthnVerifier,
    pendingCredentials,
    setPendingCredentials,
    refreshPending,
  };
}
