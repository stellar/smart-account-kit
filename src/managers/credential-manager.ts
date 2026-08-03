/**
 * Credential Manager
 *
 * Manages WebAuthn credentials (passkeys) including creation, storage,
 * deployment, and synchronization with on-chain state.
 */

import base64url from "../base64url.js";
import { xdr } from "@stellar/stellar-sdk";
import type { contract, rpc } from "@stellar/stellar-sdk";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/browser";
import type { SmartAccountEventEmitter } from "../events.js";
import type { PolicyConfig, StorageAdapter, StoredCredential, SubmissionMethod, SubmissionOptions, TransactionResult } from "../types.js";
import {
  prepareDeploymentArtifacts,
  type DeployTransaction,
  type RelayerDeploymentPayload,
} from "../kit/deploy-ops.js";

/** Dependencies required by CredentialManager */
export interface CredentialManagerDeps {
  /** Storage adapter for credentials */
  storage: StorageAdapter;
  /** RPC server for checking on-chain state */
  rpc: rpc.Server;
  /** Event emitter */
  events: SmartAccountEventEmitter;
  /** Relying party name for WebAuthn */
  rpName: string;
  /** Get current contract ID (if connected) */
  getContractId: () => string | undefined;
  /** Set contract ID and credential ID after deployment */
  setConnectedState: (contractId: string, credentialId: string) => void;
  /** Initialize wallet client for a contract */
  initializeWallet: (contractId: string) => void;
  /** Create a passkey via WebAuthn */
  createPasskey: (appName: string, userName: string) => Promise<{
    rawResponse: { response: { transports?: AuthenticatorTransportFuture[] } };
    credentialId: string;
    publicKey: Uint8Array;
  }>;
  /**
   * Build a deploy transaction. `policies` are the constructor policies to
   * install on the new wallet's default context rule; when omitted the kit's
   * `config.defaultPolicies` are used (wired in the dependency closure).
   */
  buildDeployTransaction: (
    credentialIdBuffer: Buffer,
    publicKey: Uint8Array,
    policies?: PolicyConfig[]
  ) => Promise<DeployTransaction>;
  /** Sign a custom-deployer transaction envelope. */
  signWithDeployer: (tx: contract.AssembledTransaction<null>) => Promise<void>;
  /** Submit deployment transaction */
  submitDeploymentTx: (tx: DeployTransaction, credentialId: string, options?: SubmissionOptions) => Promise<TransactionResult>;
  /** Derive contract address from credential ID */
  deriveContractAddress: (credentialIdBuffer: Buffer) => string;
}

/**
 * Manages WebAuthn credentials for smart accounts.
 */
export class CredentialManager {
  constructor(private deps: CredentialManagerDeps) {}

  /**
   * Get all stored credentials.
   */
  async getAll(): Promise<StoredCredential[]> {
    return this.deps.storage.getAll();
  }

  /**
   * Get credentials for the current wallet.
   */
  async getForWallet(): Promise<StoredCredential[]> {
    const contractId = this.deps.getContractId();
    if (!contractId) {
      return [];
    }
    return this.deps.storage.getByContract(contractId);
  }

  /**
   * Get credentials that are pending deployment.
   */
  async getPending(): Promise<StoredCredential[]> {
    const all = await this.deps.storage.getAll();
    return all.filter(c => c.deploymentStatus === "pending" || c.deploymentStatus === "failed");
  }

  /**
   * Create a new passkey and save it to storage.
   */
  async create(options?: {
    nickname?: string;
    appName?: string;
  }): Promise<StoredCredential> {
    const now = new Date();
    const nickname = options?.nickname || `Passkey ${now.toLocaleDateString()}`;
    const appName = options?.appName || this.deps.rpName;

    const { rawResponse, credentialId, publicKey } = await this.deps.createPasskey(
      appName,
      nickname
    );

    const storedCredential: StoredCredential = {
      credentialId,
      publicKey,
      contractId: "",
      nickname,
      createdAt: Date.now(),
      transports: rawResponse?.response?.transports,
      deploymentStatus: "pending",
    };

    await this.deps.storage.save(storedCredential);
    this.deps.events.emit("credentialCreated", { credential: storedCredential });

    return storedCredential;
  }

  /**
   * Save a credential to storage.
   */
  async save(credential: {
    credentialId: string;
    publicKey: Uint8Array;
    nickname?: string;
    contractId?: string;
  }): Promise<StoredCredential> {
    const storedCredential: StoredCredential = {
      credentialId: credential.credentialId,
      publicKey: credential.publicKey,
      contractId: credential.contractId || "",
      nickname: credential.nickname,
      createdAt: Date.now(),
      deploymentStatus: "pending",
    };

    await this.deps.storage.save(storedCredential);
    return storedCredential;
  }

  /**
   * Deploy a wallet using an existing pending credential.
   *
   * @param options.policies - Constructor policies to install on the new
   *   wallet's default context rule. Overrides `config.defaultPolicies` when
   *   provided; when omitted, `config.defaultPolicies` are honored (matching
   *   {@link SmartAccountKit.createWallet}).
   */
  async deploy(
    credentialId: string,
    options?: { autoSubmit?: boolean; forceMethod?: SubmissionMethod; policies?: PolicyConfig[] }
  ): Promise<{
    contractId: string;
    signedTransaction?: string;
    relayerPayload?: RelayerDeploymentPayload;
    submitResult?: TransactionResult;
  }> {
    const credential = await this.deps.storage.get(credentialId);
    if (!credential) {
      throw new Error(`Credential ${credentialId} not found in storage`);
    }

    const credentialIdBuffer = base64url.toBuffer(credentialId);
    const contractId = this.deps.deriveContractAddress(credentialIdBuffer);

    const deployTx = await this.deps.buildDeployTransaction(
      credentialIdBuffer,
      credential.publicKey,
      options?.policies
    );

    const submissionOpts = { forceMethod: options?.forceMethod };
    const deploymentArtifacts = await prepareDeploymentArtifacts(
      deployTx,
      this.deps.signWithDeployer
    );

    this.deps.setConnectedState(contractId, credentialId);
    this.deps.initializeWallet(contractId);
    this.deps.events.emit("walletConnected", { contractId, credentialId });

    const submitResult = options?.autoSubmit
      ? await this.deps.submitDeploymentTx(deployTx, credentialId, submissionOpts)
      : undefined;

    return {
      contractId,
      ...deploymentArtifacts,
      submitResult,
    };
  }

  /**
   * Sync a credential with on-chain state.
   * If deployed, removes from storage. Returns true if deployed.
   */
  async sync(credentialId: string): Promise<boolean> {
    const credential = await this.deps.storage.get(credentialId);
    if (!credential) {
      throw new Error(`Credential ${credentialId} not found in storage`);
    }

    try {
      await this.deps.rpc.getContractData(
        credential.contractId,
        xdr.ScVal.scvLedgerKeyContractInstance()
      );
      await this.deps.storage.delete(credentialId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sync all stored credentials with on-chain state.
   */
  async syncAll(): Promise<{ deployed: number; pending: number; failed: number }> {
    const all = await this.deps.storage.getAll();
    let deployed = 0;
    let pending = 0;
    let failed = 0;

    for (const credential of all) {
      const exists = await this.sync(credential.credentialId);
      if (exists) {
        deployed++;
      } else if (credential.deploymentStatus === "failed") {
        failed++;
      } else {
        pending++;
      }
    }

    return { deployed, pending, failed };
  }

  /**
   * Delete a pending credential.
   */
  async delete(credentialId: string): Promise<void> {
    const credential = await this.deps.storage.get(credentialId);
    if (!credential) {
      throw new Error(`Credential ${credentialId} not found in storage`);
    }

    const isDeployed = await this.sync(credentialId);
    if (isDeployed) {
      throw new Error("Cannot delete a deployed credential. The wallet exists on-chain.");
    }

    await this.deps.storage.delete(credentialId);
  }
}
