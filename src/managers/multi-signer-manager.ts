/**
 * Multi-Signer Manager
 *
 * Handles multi-signature operations for smart accounts, coordinating
 * between passkey signers and external wallet signers.
 */

import {
  Address,
  hash,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { Keypair, Transaction, rpc } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import type {
  Client as SmartAccountClient,
  Signer as ContractSigner,
  ContextRuleType,
} from "smart-account-kit-bindings";
import type { ContractDetailsResponse } from "../indexer.js";
import type { ExternalSignerManager } from "../external-signers.js";
import type { SelectedSigner, SubmissionOptions, TransactionResult } from "../types.js";
import { AUTH_ENTRY_EXPIRATION_BUFFER } from "../constants.js";
import {
  getCredentialIdFromSigner,
  collectUniqueSigners,
} from "../signer-utils.js";
import {
  buildAddressSignatureScVal,
  buildSignaturePreimage,
  createAddressCredentials,
  getAddressCredentials,
  getAuthEntryAddress,
  normalizeSignatureExpirationLedger,
  randomAuthEntryNonce,
  readAuthPayload,
  upsertAuthPayloadSigner,
  writeAuthPayload,
} from "../kit/auth-payload.js";
import { resolveContextRuleIdsForEntry } from "../kit/context-rules.js";
import {
  buildDirectTokenTransfer,
  resolveTokenAmount,
  resimulateAndAssemble,
  resolveResimSource,
  signFeePayer,
} from "../kit/tx-ops.js";
import { computeEntryAuthDigest } from "../signers.js";
import { validateAddress, validateAmount } from "../utils.js";
import {
  SmartAccountErrorCode,
  SignerNotFoundError,
  SubmissionError,
  ValidationError,
  WalletNotConnectedError,
  wrapError,
} from "../errors.js";
import { failedTransaction } from "../contract-errors.js";

export interface MultiSignerOptions {
  onLog?: (message: string, type?: "info" | "success" | "error") => void;
  forceMethod?: SubmissionOptions["forceMethod"];
  resolveContextRuleIds?: (
    entry: xdr.SorobanAuthorizationEntry,
    index: number
  ) => number[] | Promise<number[]>;
}

export interface MultiSignerManagerDeps {
  getContractId: () => string | undefined;
  isConnected: () => boolean;
  getRules: (contextRuleType: ContextRuleType) => Promise<Array<{ signers: ContractSigner[] }>>;
  getContractDetailsFromIndexer?: () => Promise<ContractDetailsResponse | null>;
  requireWallet: () => { wallet: SmartAccountClient };
  externalSigners: ExternalSignerManager;
  rpc: rpc.Server;
  networkPassphrase: string;
  timeoutInSeconds: number;
  deployerKeypair: Keypair;
  deployerPublicKey: string;
  signAuthEntry: (
    entry: xdr.SorobanAuthorizationEntry,
    options?: {
      credentialId?: string;
      expiration?: number;
      contextRuleIds?: number[];
      signer?: ContractSigner;
    }
  ) => Promise<xdr.SorobanAuthorizationEntry>;
  sendAndPoll: (tx: Transaction, options?: SubmissionOptions) => Promise<TransactionResult>;
  hasSourceAccountAuth: (tx: Transaction) => boolean;
  shouldUseFeeSponsoring: (options?: SubmissionOptions) => boolean;
}

export class MultiSignerManager {
  constructor(private deps: MultiSignerManagerDeps) {}

  async getAvailableSigners(): Promise<ContractSigner[]> {
    if (!this.deps.isConnected()) {
      return [];
    }

    try {
      const defaultRules = await this.deps.getRules({
        tag: "Default",
        values: undefined,
      });
      return collectUniqueSigners((defaultRules || []).flatMap((rule) => rule.signers));
    } catch (error) {
      console.warn("[SmartAccountKit] Failed to fetch available signers:", error);
      return [];
    }
  }

  needsMultiSigner(signers: ContractSigner[]): boolean {
    // The single-signer convenience path only handles WebAuthn passkeys. Any
    // Delegated or non-passkey External (e.g. Ed25519) signer, or more than one
    // signer, must go through the multi-signer path.
    const hasNonPasskey = signers.some(
      (signer) => signer.tag === "Delegated" || !getCredentialIdFromSigner(signer)
    );
    return hasNonPasskey || signers.length > 1;
  }

  /**
   * Map contract signers to the {@link SelectedSigner}s this client can actually
   * sign with (passkey, delegated wallet, or local Ed25519 key).
   *
   * A signer we cannot sign for is omitted. Delegated/passkey omissions are
   * benign (they simply aren't offered), but an Ed25519 External signer with no
   * matching local key is logged with a warning: its private key is memory-only
   * and cannot be re-derived, so for an all-signers rule its omission would
   * otherwise produce an opaque under-signed submission.
   */
  buildSelectedSigners(
    signers: ContractSigner[],
    activeCredentialId?: string | null
  ): SelectedSigner[] {
    const selected: SelectedSigner[] = [];

    for (const signer of signers) {
      if (signer.tag === "Delegated") {
        const address = signer.values[0] as string;
        if (this.deps.externalSigners.canSignFor(address)) {
          selected.push({
            signer,
            type: "wallet",
            walletAddress: address,
          });
        }
        continue;
      }

      const credentialId = getCredentialIdFromSigner(signer);
      if (credentialId) {
        if (!activeCredentialId || credentialId === activeCredentialId) {
          selected.push({
            signer,
            type: "passkey",
            credentialId,
          });
        }
        continue;
      }

      // External signer without a credential ID: an Ed25519 signer if we hold a
      // matching local keypair (key data is the 32-byte public key).
      const keyData = signer.values[1] as Buffer;
      if (keyData && this.deps.externalSigners.canSignEd25519(keyData)) {
        selected.push({
          signer,
          type: "ed25519",
          ed25519PublicKey: Buffer.from(keyData).toString("hex"),
        });
      } else if (keyData) {
        // Loud drop: an Ed25519 External signer with no matching local key is
        // silently omitted (its private key is memory-only and gone after a
        // page reload). It can NOT be re-derived. For an all-signers rule this
        // would otherwise build an under-signed transaction that fails opaquely
        // at __check_auth; surface it so the caller can re-import the key or
        // exclude the signer. (For threshold/k-of-n rules, signing with the
        // available subset is legitimate, so this is a warning, not a throw.)
        console.warn(
          `[SmartAccountKit] Ed25519 signer ${Buffer.from(keyData).toString("hex").slice(0, 16)}… ` +
            "has no matching local key and will not sign. Re-import it via " +
            "kit.externalSigners.addEd25519FromSecret() if this rule requires it."
        );
      }
    }

    return selected;
  }

  private async signWalletAddressAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
    authAddress: string,
    expiration: number
  ): Promise<xdr.SorobanAuthorizationEntry> {
    const signedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    const normalizedExpiration = normalizeSignatureExpirationLedger(expiration);
    const credentialType = signedEntry.credentials().switch().name as string;
    if (credentialType === "sorobanCredentialsAddressWithDelegates") {
      throw new Error(
        "ADDRESS_WITH_DELEGATES auth entries are not supported by wallet signing yet"
      );
    }

    const credentials = getAddressCredentials(signedEntry.credentials());
    credentials.signatureExpirationLedger(normalizedExpiration);
    const preimage = buildSignaturePreimage(
      this.deps.networkPassphrase,
      signedEntry,
      normalizedExpiration
    );

    const { signedAuthEntry } = await this.deps.externalSigners.signAuthEntry(
      preimage.toXDR("base64"),
      authAddress
    );

    credentials.signature(
      buildAddressSignatureScVal(
        Address.fromString(authAddress).toScAddress().accountId().ed25519(),
        Buffer.from(signedAuthEntry, "base64")
      )
    );

    return signedEntry;
  }

  private async submitWithSelectedSigners(
    hostFunc: xdr.HostFunction,
    authEntries: xdr.SorobanAuthorizationEntry[],
    selectedSigners: SelectedSigner[],
    options?: MultiSignerOptions
  ): Promise<TransactionResult> {
    const onLog = options?.onLog ?? (() => {});
    const contractId = this.deps.getContractId();

    if (!contractId) {
      return failedTransaction(new WalletNotConnectedError("submit a transaction"));
    }

    const passkeySigners = selectedSigners.filter((signer) => signer.type === "passkey");
    const walletSigners = selectedSigners.filter((signer) => signer.type === "wallet");
    const ed25519Signers = selectedSigners.filter((signer) => signer.type === "ed25519");

    onLog(
      `Signing with ${passkeySigners.length} passkey(s), ${walletSigners.length} wallet(s), ` +
        `and ${ed25519Signers.length} ed25519 key(s)`
    );

    for (const walletSigner of walletSigners) {
      if (!walletSigner.walletAddress) continue;
      if (!this.deps.externalSigners.canSignFor(walletSigner.walletAddress)) {
        return failedTransaction(
          new SignerNotFoundError(
            walletSigner.walletAddress,
            "Use kit.externalSigners.addFromSecret() or kit.externalSigners.addFromWallet() to add a signer."
          )
        );
      }
    }

    for (const ed25519Signer of ed25519Signers) {
      if (!ed25519Signer.ed25519PublicKey) continue;
      if (!this.deps.externalSigners.canSignEd25519(Buffer.from(ed25519Signer.ed25519PublicKey, "hex"))) {
        return failedTransaction(
          new SignerNotFoundError(
            `ed25519:${ed25519Signer.ed25519PublicKey.slice(0, 16)}…`,
            "Use kit.externalSigners.addEd25519FromSecret() to add the signer."
          )
        );
      }
    }

    try {
      onLog(`Found ${authEntries.length} auth entries to sign`);

      const signedAuthEntries: xdr.SorobanAuthorizationEntry[] = [];
      const { sequence } = await this.deps.rpc.getLatestLedger();
      const expiration = sequence + AUTH_ENTRY_EXPIRATION_BUFFER;

      for (const [authEntryIndex, entry] of authEntries.entries()) {
        const credentials = entry.credentials();
        const credentialType = credentials.switch().name as string;

        if (credentialType === "sorobanCredentialsAddressWithDelegates") {
          return failedTransaction(
            new SubmissionError(
              "ADDRESS_WITH_DELEGATES auth entries are not supported by multi-signer signing yet"
            )
          );
        }

        if (
          credentialType !== "sorobanCredentialsAddress" &&
          credentialType !== "sorobanCredentialsAddressV2"
        ) {
          signedAuthEntries.push(entry);
          continue;
        }

        const authAddress = getAuthEntryAddress(entry);

        if (authAddress !== contractId) {
          const walletSigner = walletSigners.find((signer) => signer.walletAddress === authAddress);
          if (!walletSigner || !this.deps.externalSigners.canSignFor(authAddress)) {
            return failedTransaction(
              new SignerNotFoundError(
                authAddress,
                "Add an external signer for that address or remove it from the transaction."
              )
            );
          }

          onLog(`Signing separate auth entry for ${authAddress.slice(0, 8)}...`);
          signedAuthEntries.push(
            await this.signWalletAddressAuthEntry(entry, authAddress, expiration)
          );
          continue;
        }

        let signedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
        getAddressCredentials(signedEntry.credentials()).signatureExpirationLedger(expiration);
        const selectedContractSigners = selectedSigners
          .map(({ signer }) => signer)
          .filter((signer): signer is ContractSigner => signer !== undefined);
        const resolvedContextRuleIds = options?.resolveContextRuleIds
          ? await options.resolveContextRuleIds(signedEntry, authEntryIndex)
          : await resolveContextRuleIdsForEntry(
            this.deps.requireWallet().wallet,
            signedEntry,
            selectedContractSigners,
            {
              getContractDetailsFromIndexer: this.deps.getContractDetailsFromIndexer,
              rpc: this.deps.rpc,
              contractId,
              networkPassphrase: this.deps.networkPassphrase,
              timeoutInSeconds: this.deps.timeoutInSeconds,
            }
          );

        for (const [index, passkeySigner] of passkeySigners.entries()) {
          onLog(`Signing with passkey ${index + 1}/${passkeySigners.length}...`);
          signedEntry = await this.deps.signAuthEntry(signedEntry, {
            credentialId: passkeySigner.credentialId,
            expiration,
            contextRuleIds: resolvedContextRuleIds,
            signer: passkeySigner.signer as ContractSigner | undefined,
          });
        }

        const signedCredentials = getAddressCredentials(signedEntry.credentials());
        signedCredentials.signatureExpirationLedger(expiration);

        for (const walletSigner of walletSigners) {
          if (!walletSigner.walletAddress) continue;
          if (!walletSigner.signer) {
            return failedTransaction(
              new ValidationError(
                `Wallet signer ${walletSigner.walletAddress} is missing contract signer metadata. Use buildSelectedSigners() or provide the signer field explicitly.`
              )
            );
          }
        }

        const authPayload = readAuthPayload(signedCredentials.signature());
        if (authPayload.context_rule_ids.length === 0) {
          authPayload.context_rule_ids = resolvedContextRuleIds;
        }

        // The auth digest is shared by every signer on this entry (passkeys sign
        // it inside signAuthEntry; ed25519 keys and delegated signers sign it
        // here). It is independent of the AuthPayload signature content.
        const { authDigest } = computeEntryAuthDigest(
          this.deps.networkPassphrase,
          signedEntry,
          expiration,
          authPayload.context_rule_ids
        );

        // Ed25519 external signers contribute their raw 64-byte signature bytes.
        for (const ed25519Signer of ed25519Signers) {
          if (!ed25519Signer.ed25519PublicKey || !ed25519Signer.signer) continue;
          const signatureBytes = this.deps.externalSigners.signEd25519Digest(
            Buffer.from(ed25519Signer.ed25519PublicKey, "hex"),
            authDigest
          );
          upsertAuthPayloadSigner(
            authPayload,
            ed25519Signer.signer as ContractSigner,
            signatureBytes
          );
        }

        // Delegated (wallet) signers contribute empty bytes here; their auth is
        // a separate nested require_auth entry created below.
        for (const walletSigner of walletSigners) {
          if (!walletSigner.walletAddress) continue;
          upsertAuthPayloadSigner(authPayload, walletSigner.signer as ContractSigner, Buffer.alloc(0));
        }
        signedCredentials.signature(writeAuthPayload(authPayload));
        signedAuthEntries.push(signedEntry);

        if (walletSigners.length === 0) {
          continue;
        }

        onLog(`Creating auth entries for ${walletSigners.length} delegated signer(s)...`);

        for (const walletSigner of walletSigners) {
          if (!walletSigner.walletAddress) continue;

          onLog(`Getting delegated auth from ${walletSigner.walletAddress.slice(0, 8)}...`);

          const delegatedNonce = randomAuthEntryNonce();
          const delegatedInvocation = new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(contractId).toScAddress(),
                functionName: "__check_auth",
                args: [xdr.ScVal.scvBytes(authDigest)],
              })
            ),
            subInvocations: [],
          });

          const delegatedPreimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
            new xdr.HashIdPreimageSorobanAuthorization({
              networkId: hash(Buffer.from(this.deps.networkPassphrase)),
              nonce: delegatedNonce,
              signatureExpirationLedger: expiration,
              invocation: delegatedInvocation,
            })
          );

          const { signedAuthEntry: walletSignatureBase64 } = await this.deps.externalSigners.signAuthEntry(
            delegatedPreimage.toXDR("base64"),
            walletSigner.walletAddress
          );

          signedAuthEntries.push(
            new xdr.SorobanAuthorizationEntry({
              credentials: createAddressCredentials(
                new xdr.SorobanAddressCredentials({
                  address: Address.fromString(walletSigner.walletAddress).toScAddress(),
                  nonce: delegatedNonce,
                  signatureExpirationLedger: expiration,
                  signature: buildAddressSignatureScVal(
                    Address.fromString(walletSigner.walletAddress).toScAddress().accountId().ed25519(),
                    Buffer.from(walletSignatureBase64, "base64")
                  ),
                })
              ),
              rootInvocation: delegatedInvocation,
            })
          );
        }
      }

      onLog("Re-simulating with signatures...");
      const submissionOptions: SubmissionOptions = { forceMethod: options?.forceMethod };
      // Use a placeholder source for the discarded relayer envelope.
      // Use the real source only for direct RPC, which refuses the shared deployer.
      const sourceAccount = await resolveResimSource(this.deps, submissionOptions);
      const preparedTx = await resimulateAndAssemble(
        this.deps,
        sourceAccount,
        hostFunc,
        signedAuthEntries
      );

      signFeePayer(preparedTx, this.deps.deployerKeypair, this.deps, submissionOptions);

      onLog("Submitting transaction...");
      return this.deps.sendAndPoll(preparedTx, submissionOptions);
    } catch (err) {
      return failedTransaction(wrapError(err, SmartAccountErrorCode.TRANSACTION_SIGNING_FAILED));
    }
  }

  async operation<T>(
    assembledTx: AssembledTransaction<T>,
    selectedSigners: SelectedSigner[],
    options?: MultiSignerOptions
  ): Promise<TransactionResult> {
    const onLog = options?.onLog ?? (() => {});

    try {
      const builtTx = assembledTx.built;
      if (!builtTx) {
        return failedTransaction(new SubmissionError("Transaction not built"));
      }

      const operations = builtTx.operations;
      if (!operations || operations.length === 0) {
        return failedTransaction(new SubmissionError("No operations in transaction"));
      }

      const invokeOp = operations[0] as Operation.InvokeHostFunction;
      const authEntries = invokeOp.auth || [];
      const submissionOptions: SubmissionOptions = { forceMethod: options?.forceMethod };

      if (authEntries.length === 0) {
        onLog("No auth entries - submitting directly...");
        const preparedTx = TransactionBuilder.fromXDR(
          builtTx.toXDR(),
          this.deps.networkPassphrase
        ) as Transaction;
        signFeePayer(preparedTx, this.deps.deployerKeypair, this.deps, submissionOptions);
        return this.deps.sendAndPoll(preparedTx, submissionOptions);
      }

      return this.submitWithSelectedSigners(
        invokeOp.func,
        authEntries,
        selectedSigners,
        options
      );
    } catch (err) {
      return failedTransaction(wrapError(err, SmartAccountErrorCode.TRANSACTION_SUBMISSION_FAILED));
    }
  }

  async transfer(
    tokenContract: string,
    recipient: string,
    amount: number,
    selectedSigners: SelectedSigner[],
    options?: MultiSignerOptions
  ): Promise<TransactionResult> {
    const contractId = this.deps.getContractId();
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

    const { raw: amountRaw } = await resolveTokenAmount(
      this.deps,
      tokenContract,
      amount
    );
    try {
      // Direct token invocation authorized by the smart account (not wrapped
      // in the account's `execute`), so token-scoped context rules and their
      // policies match the transfer. See buildDirectTokenTransfer.
      const assembledTx = await buildDirectTokenTransfer(
        this.deps,
        tokenContract,
        contractId,
        recipient,
        amountRaw
      );

      return this.operation(
        assembledTx,
        selectedSigners,
        options
      );
    } catch (err) {
      return failedTransaction(wrapError(err, SmartAccountErrorCode.TRANSACTION_SUBMISSION_FAILED));
    }
  }
}
