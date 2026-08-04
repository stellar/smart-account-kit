/**
 * Signer Manager
 *
 * Manages signers (passkeys and delegated accounts) for context rules.
 */

import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/browser";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import type { SmartAccountEventEmitter } from "../events.js";
import type { StorageAdapter, StoredCredential } from "../types.js";
import { buildKeyData } from "../utils.js";
import { SignerNotFoundError } from "../errors.js";
import { unwrapContractResult } from "../contract-errors.js";
import { validateSigner, validateSigners } from "../validation.js";

/** Dependencies required by SignerManager */
export interface SignerManagerDeps {
  /** Get the connected wallet client, throws if not connected */
  requireWallet: () => {
    wallet: {
      add_signer: (args: { context_rule_id: number; signer: ContractSigner }) => Promise<AssembledTransaction<number>>;
      batch_add_signer: (args: { context_rule_id: number; signers: ContractSigner[] }) => Promise<AssembledTransaction<null>>;
      get_signer_id: (args: { signer: ContractSigner }) => Promise<AssembledTransaction<number>>;
      remove_signer: (args: { context_rule_id: number; signer_id: number }) => Promise<AssembledTransaction<null>>;
    };
    contractId: string;
  };
  /** Storage adapter for credentials */
  storage: StorageAdapter;
  /** Event emitter */
  events: SmartAccountEventEmitter;
  /** WebAuthn verifier contract address */
  webauthnVerifierAddress: string;
  /** Create a passkey via WebAuthn */
  createPasskey: (appName: string, userName: string) => Promise<{
    rawResponse: { response: { transports?: AuthenticatorTransportFuture[] } };
    credentialId: string;
    publicKey: Uint8Array;
  }>;
}

/**
 * Manages signers for smart account context rules.
 */
export class SignerManager {
  constructor(private deps: SignerManagerDeps) {}

  /**
   * Add a new passkey signer to a context rule.
   * Creates a new WebAuthn passkey and registers it as an External signer.
   */
  async addPasskey(
    contextRuleId: number,
    appName: string,
    userName: string,
    options?: { nickname?: string }
  ) {
    const { wallet, contractId } = this.deps.requireWallet();

    // Create the passkey
    const { rawResponse, credentialId, publicKey } = await this.deps.createPasskey(
      appName,
      userName
    );

    // Store the credential
    const storedCredential: StoredCredential = {
      credentialId,
      publicKey,
      contractId,
      nickname: options?.nickname ?? `${userName} - ${new Date().toLocaleDateString()}`,
      createdAt: Date.now(),
      transports: rawResponse.response.transports,
      isPrimary: false,
      contextRuleId,
    };

    await this.deps.storage.save(storedCredential);

    // Emit credential created event
    this.deps.events.emit("credentialCreated", { credential: storedCredential });

    // Build the External signer for the contract
    const keyData = buildKeyData(publicKey, credentialId);
    const signer: ContractSigner = {
      tag: "External",
      values: [this.deps.webauthnVerifierAddress, keyData],
    };
    validateSigner(signer);

    // Build and return the add_signer transaction
    const transaction = await wallet.add_signer({
      context_rule_id: contextRuleId,
      signer,
    });

    return {
      credentialId,
      publicKey,
      transaction,
    };
  }

  /**
   * Add a delegated signer (Stellar account) to a context rule.
   */
  async addDelegated(contextRuleId: number, publicKey: string) {
    const { wallet } = this.deps.requireWallet();

    const signer: ContractSigner = {
      tag: "Delegated",
      values: [publicKey],
    };
    validateSigner(signer);

    return wallet.add_signer({
      context_rule_id: contextRuleId,
      signer,
    });
  }

  /**
   * Add multiple signers to a context rule in one transaction (batch_add_signer).
   *
   * @param contextRuleId - The context rule to add the signers to
   * @param signers - The signers to add
   * @param options.existingSignerCount - Number of signers already on the target
   *   rule. Pass this so the batch is pre-checked against the rule-level
   *   `MAX_SIGNERS` limit (existing + new). When omitted it defaults to 0, so
   *   only the size of this batch is checked and the contract enforces the
   *   rule-level limit at simulation.
   * @returns Assembled transaction that adds the signers when signed and sent
   * @throws {ValidationError} If the batch (plus `existingSignerCount`) would
   *   exceed `MAX_SIGNERS` or a signer is invalid
   * @throws Error if not connected to a wallet
   */
  async addBatch(
    contextRuleId: number,
    signers: ContractSigner[],
    options?: { existingSignerCount?: number }
  ) {
    const { wallet } = this.deps.requireWallet();
    validateSigners(signers, options?.existingSignerCount ?? 0);
    return wallet.batch_add_signer({
      context_rule_id: contextRuleId,
      signers,
    });
  }

  /**
   * Resolve the stable on-chain signer ID for a signer (get_signer_id).
   *
   * @param signer - The signer to look up
   * @returns The signer's numeric ID
   * @throws {SignerNotFoundError} If the signer is not registered
   * @throws Error if not connected to a wallet
   */
  async idOf(signer: ContractSigner): Promise<number> {
    const { wallet } = this.deps.requireWallet();
    const signerId = unwrapContractResult(
      (await wallet.get_signer_id({ signer })).result,
      (error) =>
        error.contractCode === 3006
          ? new SignerNotFoundError("signer")
          : error
    );
    if (signerId === undefined || signerId === null) {
      throw new SignerNotFoundError("signer");
    }
    return signerId;
  }

  /**
   * Remove a signer from a context rule.
   */
  async remove(contextRuleId: number, signer: ContractSigner) {
    const { wallet } = this.deps.requireWallet();
    const signerId = unwrapContractResult(
      (await wallet.get_signer_id({ signer })).result,
      (error) =>
        error.contractCode === 3006
          ? new SignerNotFoundError(`signer on context rule ${contextRuleId}`)
          : error
    );

    if (signerId === undefined || signerId === null) {
      throw new SignerNotFoundError(
        `signer on context rule ${contextRuleId}`
      );
    }

    return wallet.remove_signer({
      context_rule_id: contextRuleId,
      signer_id: signerId,
    });
  }
}
