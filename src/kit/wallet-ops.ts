import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/browser";
import { Keypair, hash, xdr } from "@stellar/stellar-sdk";
import type { Horizon } from "@stellar/stellar-sdk";
import base64url from "../base64url.js";
import type {
  StorageAdapter,
  StoredCredential,
  CreateWalletResult,
  ConnectWalletResult,
  TransactionResult,
  SubmissionOptions,
  SubmissionMethod,
} from "../types.js";
import type { SmartAccountEventEmitter } from "../events.js";
import type { contract, rpc } from "@stellar/stellar-sdk";
import type { ContextRule } from "smart-account-kit-bindings";
import type {
  WalletCandidate,
  WalletCandidateLookup,
} from "../indexer.js";
import { WEBAUTHN_TIMEOUT_MS, DEFAULT_SESSION_EXPIRY_MS } from "../constants.js";
import {
  deriveContractAddress,
  generateChallenge,
} from "../utils.js";
import {
  ValidationError,
  WalletAmbiguousError,
  WalletCodeNotAcceptedError,
  WalletOwnershipError,
  WalletProvenanceError,
} from "../errors.js";
import { failedTransaction } from "../contract-errors.js";
import {
  describeDeploymentBirth,
  prepareDeploymentArtifacts,
  type DeployTransaction,
} from "./deploy-ops.js";
import {
  publicKeyFromExternalSigner,
  signerMatchesCredential,
  verifyFreshAssertion,
  verifyWalletBirth,
  type WalletBirthVerificationDeps,
  type WalletBirthResult,
} from "./wallet-provenance.js";

export interface FreshOwnershipProof {
  response: AuthenticationResponseJSON;
  challenge: string;
}

export async function createWallet(
  deps: {
    storage: StorageAdapter;
    events: SmartAccountEventEmitter;
    deployerKeypair: Keypair;
    networkPassphrase: string;
    sessionExpiryMs: number;
    createPasskey: (
      appName: string,
      userName: string,
      authenticatorSelection?: {
        authenticatorAttachment?: "platform" | "cross-platform";
        residentKey?: "discouraged" | "preferred" | "required";
        userVerification?: "discouraged" | "preferred" | "required";
      }
    ) => Promise<{ rawResponse: RegistrationResponseJSON; credentialId: string; publicKey: Uint8Array }>;
    /**
     * Validate (and thereby convert) the constructor policies up front. Called
     * before the WebAuthn ceremony so an invalid policy config fails fast
     * instead of orphaning a freshly-created passkey + pending credential.
     */
    validateConstructorPolicies?: () => void;
    buildDeployTransaction: (
      credentialIdBuffer: Buffer,
      publicKey: Uint8Array
    ) => Promise<DeployTransaction>;
    signWithDeployer: (tx: contract.AssembledTransaction<null>) => Promise<void>;
    submitDeploymentTx: (
      tx: DeployTransaction,
      credentialId: string,
      options?: SubmissionOptions
    ) => Promise<TransactionResult>;
    fundWallet: (
      nativeTokenContract: string,
      options?: { forceMethod?: SubmissionMethod }
    ) => Promise<TransactionResult & { amount?: number }>;
    setConnectedState: (contractId: string, credentialId: string) => void;
  },
  appName: string,
  userName: string,
  options?: {
    nickname?: string;
    authenticatorSelection?: {
      authenticatorAttachment?: "platform" | "cross-platform";
      residentKey?: "discouraged" | "preferred" | "required";
      userVerification?: "discouraged" | "preferred" | "required";
    };
    autoSubmit?: boolean;
    autoFund?: boolean;
    nativeTokenContract?: string;
    forceMethod?: SubmissionMethod;
  }
): Promise<CreateWalletResult & { submitResult?: TransactionResult; fundResult?: TransactionResult & { amount?: number } }> {
  // Validate constructor policies BEFORE the WebAuthn ceremony: a bad policy
  // config must fail fast, not after we've created (and would orphan) a passkey.
  deps.validateConstructorPolicies?.();

  const { rawResponse, credentialId, publicKey } = await deps.createPasskey(
    appName,
    userName,
    options?.authenticatorSelection
  );

  const storedCredential: StoredCredential = {
    credentialId,
    publicKey,
    contractId: deriveContractAddress(
      base64url.toBuffer(credentialId),
      deps.deployerKeypair.publicKey(),
      deps.networkPassphrase
    ),
    nickname: options?.nickname ?? `${userName} - ${new Date().toLocaleDateString()}`,
    createdAt: Date.now(),
    transports: rawResponse?.response?.transports,
    isPrimary: true,
    deploymentStatus: "pending",
  };

  await deps.storage.save(storedCredential);
  deps.events.emit("credentialCreated", { credential: storedCredential });

  const credentialIdBuffer = base64url.toBuffer(credentialId);
  const contractId = deriveContractAddress(
    credentialIdBuffer,
    deps.deployerKeypair.publicKey(),
    deps.networkPassphrase
  );

  const deployTx = await deps.buildDeployTransaction(
    credentialIdBuffer,
    publicKey
  );
  await deps.storage.update(
    credentialId,
    describeDeploymentBirth(deployTx)
  );

  const submissionOpts: SubmissionOptions = { forceMethod: options?.forceMethod };
  const deploymentArtifacts = await prepareDeploymentArtifacts(
    deployTx,
    deps.signWithDeployer
  );

  const submitResult = options?.autoSubmit
    ? await deps.submitDeploymentTx(deployTx, credentialId, submissionOpts)
    : undefined;

  // A derived address is only a prediction until deployment succeeds. Do not
  // expose it as a connected wallet or persist it as a restorable session.
  if (submitResult?.success) {
    deps.setConnectedState(contractId, credentialId);
    deps.events.emit("walletConnected", { contractId, credentialId });

    const now = Date.now();
    await deps.storage.saveSession({
      contractId,
      credentialId,
      connectedAt: now,
      expiresAt: now + (deps.sessionExpiryMs ?? DEFAULT_SESSION_EXPIRY_MS),
    });
  }

  let fundResult: (TransactionResult & { amount?: number }) | undefined;
  if (options?.autoFund && submitResult?.success) {
    if (!options.nativeTokenContract) {
      fundResult = failedTransaction(
        new ValidationError("nativeTokenContract is required for autoFund")
      );
    } else {
      fundResult = await deps.fundWallet(options.nativeTokenContract, { forceMethod: options?.forceMethod });
    }
  }

  return {
    rawResponse,
    credentialId,
    publicKey,
    contractId,
    ...deploymentArtifacts,
    submitResult,
    fundResult,
  };
}

export async function connectWallet(
  deps: {
    storage: StorageAdapter;
    events: SmartAccountEventEmitter;
    rpId?: string;
    webAuthn: {
      startAuthentication: (args: { optionsJSON: PublicKeyCredentialRequestOptionsJSON }) => Promise<AuthenticationResponseJSON>;
    };
    connectWithCredentials: (
      credentialId?: string,
      contractId?: string,
      proof?: FreshOwnershipProof,
      allowAuthentication?: boolean
    ) => Promise<ConnectWalletResult>;
  },
  options?: {
    credentialId?: string;
    contractId?: string;
    fresh?: boolean;
    prompt?: boolean;
  }
): Promise<ConnectWalletResult | null> {
  let credentialId = options?.credentialId;
  let contractId = options?.contractId;
  let rawResponse: AuthenticationResponseJSON | undefined;

  if (credentialId || contractId) {
    return deps.connectWithCredentials(credentialId, contractId, undefined, true);
  }

  if (!options?.fresh) {
    const session = await deps.storage.getSession();
    if (session) {
      if (session.expiresAt && Date.now() > session.expiresAt) {
        deps.events.emit("sessionExpired", {
          contractId: session.contractId,
          credentialId: session.credentialId,
        });
        await deps.storage.clearSession();
      } else {
        try {
          return await deps.connectWithCredentials(
            session.credentialId,
            session.contractId,
            undefined,
            false
          );
        } catch (error) {
          if (
            !(error instanceof WalletProvenanceError) &&
            !(error instanceof WalletOwnershipError) &&
            !(error instanceof WalletCodeNotAcceptedError)
          ) {
            throw error;
          }
          await deps.storage.clearSession();
          if (!options?.prompt) return null;
        }
      }
    }
  }

  if (!options?.prompt && !options?.fresh) {
    return null;
  }

  const challenge = generateChallenge();
  const authOptions: PublicKeyCredentialRequestOptionsJSON = {
    challenge,
    rpId: deps.rpId,
    userVerification: "preferred",
    timeout: WEBAUTHN_TIMEOUT_MS,
  };

  rawResponse = await deps.webAuthn.startAuthentication({ optionsJSON: authOptions });
  credentialId = rawResponse.id;

  const result = await deps.connectWithCredentials(credentialId, undefined, {
    response: rawResponse,
    challenge,
  });
  return {
    ...result,
    rawResponse,
  };
}

/**
 * Assert a contract instance runs code on the accepted allowlist.
 *
 * Reads the executable out of an instance ledger entry the caller already has,
 * so this costs no extra round-trip.
 */
function assertAcceptedCode(
  instance: Awaited<ReturnType<rpc.Server["getContractData"]>>,
  contractId: string,
  accepted: readonly string[]
): void {
  const executable = instance.val.contractData().val().instance().executable();
  if (executable.switch().name !== "contractExecutableWasm") {
    // A Stellar-asset-contract executable has no WASM hash to bind, so it can
    // never be an accepted smart account.
    throw new WalletCodeNotAcceptedError(contractId, "not-a-wasm-contract", accepted);
  }
  const actual = executable.wasmHash().toString("hex");
  if (!accepted.includes(actual)) {
    throw new WalletCodeNotAcceptedError(contractId, actual, accepted);
  }
}

export async function connectWithCredentials(
  deps: {
    storage: StorageAdapter;
    rpc: rpc.Server;
    deployerKeypair: Keypair;
    networkPassphrase: string;
    sessionExpiryMs: number;
    /** Accepted code identities, lowercase hex. Never empty. */
    acceptedWasmHashes: readonly string[];
    /** Accepted immutable birth code identities, lowercase hex. */
    acceptedBirthWasmHashes: readonly string[];
    webauthnVerifierAddress: string;
    rpId?: string;
    allowedOrigins?: readonly string[];
    history?: Pick<Horizon.Server, "transactions">;
    expectedPolicies?: readonly import("../types.js").PolicyConfig[];
    lookupWalletCandidates?: (
      credentialId: string
    ) => Promise<WalletCandidateLookup | null>;
    readContextRule?: (
      contractId: string,
      contextRuleId: number
    ) => Promise<ContextRule>;
    authenticateCredential?: (
      credentialId: string
    ) => Promise<FreshOwnershipProof>;
    verifyBirth?: (
      verificationDeps: WalletBirthVerificationDeps,
      candidate: WalletCandidate
    ) => Promise<WalletBirthResult>;
    events: SmartAccountEventEmitter;
    setConnectedState: (contractId: string, credentialId: string) => void;
  },
  credentialId?: string,
  contractId?: string,
  proof?: FreshOwnershipProof,
  allowAuthentication = true
): Promise<ConnectWalletResult> {
  let credential: StoredCredential | null = null;
  let usedDerivedCandidate = false;
  if (credentialId) {
    credential = await deps.storage.get(credentialId);
    if (!contractId && credential?.contractId) {
      contractId = credential.contractId;
    }
  }

  if (!contractId && credentialId) {
    const credentialIdBuffer = base64url.toBuffer(credentialId);
    contractId = deriveContractAddress(
      credentialIdBuffer,
      deps.deployerKeypair.publicKey(),
      deps.networkPassphrase
    );
    usedDerivedCandidate = true;
  }

  if (!contractId) {
    throw new Error("Could not determine contract ID");
  }

  if (!credentialId) {
    throw new Error("Could not determine credential ID");
  }

  let instance: Awaited<ReturnType<typeof deps.rpc.getContractData>>;
  try {
    instance = await deps.rpc.getContractData(
      contractId,
      xdr.ScVal.scvLedgerKeyContractInstance()
    );
  } catch {
    if (credential && credential.deploymentStatus !== "failed") {
      await deps.storage.update(credentialId, {
        deploymentStatus: "pending",
      });
    }
    throw new Error(
      `Smart account contract not found on-chain for credential ${credentialId}. ` +
      "The wallet may not have been deployed yet."
    );
  }

  // Current code identity is necessary for every connection. Local storage
  // cannot safely exempt an account from the SDK's accepted-code contract.
  assertAcceptedCode(instance, contractId, deps.acceptedWasmHashes);

  const storedCandidate = candidateFromStoredCredential(credential, contractId);
  let candidates: readonly WalletCandidate[] = storedCandidate
    ? [storedCandidate]
    : [];
  if (!storedCandidate) {
    if (!deps.lookupWalletCandidates) {
      throw new WalletProvenanceError(
        contractId,
        "The indexer did not return one complete schema-2 birth claim."
      );
    }
    const ledgerAtLookupStart = (await deps.rpc.getLatestLedger()).sequence;
    const lookup = await deps.lookupWalletCandidates(credentialId);
    if (!lookup || !lookup.complete || lookup.schema !== 2) {
      throw new WalletProvenanceError(
        contractId,
        "The indexer did not return one complete schema-2 birth claim."
      );
    }
    if (lookup.indexedThroughLedger < ledgerAtLookupStart) {
      throw new WalletProvenanceError(
        contractId,
        `The indexer is stale at ledger ${lookup.indexedThroughLedger}; ` +
          `the network was at ledger ${ledgerAtLookupStart} before lookup.`
      );
    }
    if (usedDerivedCandidate) {
      const contractIds = [
        ...new Set(lookup.candidates.map((candidate) => candidate.contractId)),
      ];
      if (
        contractIds.length > 1 ||
        lookup.candidates.some((candidate) => candidate.collision)
      ) {
        throw new WalletAmbiguousError(contractIds);
      }
    }
    candidates = lookup.candidates.filter(
      (candidate) => candidate.contractId === contractId
    );
  }
  if (candidates.length !== 1) {
    throw new WalletProvenanceError(
      contractId,
      candidates.length === 0
        ? "No immutable birth claim matches this address."
        : "The indexer returned duplicate birth claims for this address.",
      { candidateCount: candidates.length }
    );
  }

  const localPrimary =
    credential !== null &&
    credential.isPrimary !== false &&
    credential.birthConstructorArgsHash !== undefined;
  const localSecondary =
    credential !== null &&
    credential.isPrimary === false &&
    credential.associationVerified === true &&
    credential.birthConstructorArgsHash !== undefined;
  const locallyApproved = localPrimary || localSecondary;
  const candidate = candidates[0]!;
  const birth = await (deps.verifyBirth ?? verifyWalletBirth)(
    {
      rpc: deps.rpc,
      history: deps.history,
      networkPassphrase: deps.networkPassphrase,
      acceptedBirthWasmHashes: deps.acceptedBirthWasmHashes,
      webauthnVerifierAddress: deps.webauthnVerifierAddress,
      ...(locallyApproved
        ? {
            expectedConstructorArgsHash:
              credential!.birthConstructorArgsHash,
          }
        : {
            expectedDeployer: deps.deployerKeypair.publicKey(),
            expectedSalt: hash(base64url.toBuffer(credentialId)),
            expectedPolicies: deps.expectedPolicies ?? [],
          }),
    },
    candidate
  );
  if (!birth.ok) {
    throw new WalletProvenanceError(
      contractId,
      `Birth verification failed: ${birth.detail}`,
      { reason: birth.reason }
    );
  }

  let publicKey = credential?.publicKey;
  if (!publicKey) {
    publicKey = publicKeyFromExternalSigner(birth.birth.birthSigner);
  }
  if (!publicKey) {
    throw new WalletOwnershipError(
      "The wallet birth does not contain a usable WebAuthn public key",
      { contractId }
    );
  }
  if (
    !localSecondary &&
    !signerMatchesCredential(
      birth.birth.birthSigner,
      deps.webauthnVerifierAddress,
      publicKey,
      credentialId
    )
  ) {
    throw new WalletOwnershipError(
      "The passkey is not the wallet's immutable primary signer",
      { contractId, credentialId }
    );
  }

  if (!deps.readContextRule) {
    throw new WalletOwnershipError(
      "Current signer state is unavailable and ownership cannot be verified",
      { contractId }
    );
  }
  const contextRuleId = localSecondary
    ? credential!.contextRuleId
    : 0;
  if (contextRuleId === undefined) {
    throw new WalletOwnershipError(
      "The local secondary association has no context rule id",
      { contractId, credentialId }
    );
  }
  const liveRule = await deps.readContextRule(contractId, contextRuleId);
  const liveLedger = (await deps.rpc.getLatestLedger()).sequence;
  if (
    liveRule.valid_until !== undefined &&
    liveRule.valid_until !== null &&
    liveRule.valid_until < liveLedger
  ) {
    throw new WalletOwnershipError(
      "The passkey signer belongs to an expired context rule",
      { contractId, credentialId, contextRuleId, validUntil: liveRule.valid_until }
    );
  }
  const liveMatches = liveRule.signers.filter((signer) =>
    signerMatchesCredential(
      signer,
      deps.webauthnVerifierAddress,
      publicKey!,
      credentialId!
    )
  );
  if (liveMatches.length !== 1) {
    throw new WalletOwnershipError(
      "The passkey is not one exact live signer on the expected context rule",
      { contractId, credentialId, contextRuleId }
    );
  }

  if (!locallyApproved) {
    const ownershipProof =
      proof ??
      (allowAuthentication
        ? await deps.authenticateCredential?.(credentialId)
        : undefined);
    if (!ownershipProof || !deps.rpId || !deps.allowedOrigins?.length) {
      throw new WalletOwnershipError(
        "A fresh WebAuthn assertion, rpId, and allowed origin are required for this wallet",
        { contractId, credentialId }
      );
    }
    const assertion = await verifyFreshAssertion(ownershipProof.response, {
      expectedChallenge: ownershipProof.challenge,
      expectedCredentialId: credentialId,
      rpId: deps.rpId,
      publicKey,
      allowedOrigins: deps.allowedOrigins,
    });
    if (!assertion.ok) {
      throw new WalletOwnershipError(
        `Fresh WebAuthn ownership verification failed: ${assertion.detail}`,
        { contractId, credentialId, reason: assertion.reason }
      );
    }
  }

  const verifiedCredential: StoredCredential = {
    ...(credential ?? {
      credentialId,
      createdAt: Date.now(),
      isPrimary: true,
    }),
    credentialId,
    publicKey,
    contractId,
    deploymentStatus: "deployed",
    deploymentError: undefined,
    birthWasmHash: birth.birth.birthWasmHash,
    creationTransactionHash: birth.birth.creationTransactionHash,
    creationLedger: birth.birth.creationLedger,
    birthConstructorArgsHash: birth.birth.constructorArgsHash,
  };
  await deps.storage.save(verifiedCredential);

  deps.setConnectedState(contractId, credentialId);

  deps.events.emit("walletConnected", { contractId, credentialId });

  const now = Date.now();
  await deps.storage.saveSession({
    contractId,
    credentialId,
    connectedAt: now,
    expiresAt: now + deps.sessionExpiryMs,
  });

  return {
    credentialId,
    contractId,
    credential: verifiedCredential,
  };
}

function candidateFromStoredCredential(
  credential: StoredCredential | null,
  contractId: string
): WalletCandidate | undefined {
  if (
    !credential ||
    credential.contractId !== contractId ||
    !credential.birthWasmHash ||
    !credential.creationTransactionHash ||
    !Number.isSafeInteger(credential.creationLedger) ||
    credential.creationLedger === undefined ||
    credential.creationLedger < 1
  ) {
    return undefined;
  }
  return {
    contractId,
    birthWasmHash: credential.birthWasmHash,
    creationTransactionHash: credential.creationTransactionHash,
    creationLedger: credential.creationLedger,
  };
}

export async function disconnect(
  deps: {
    storage: StorageAdapter;
    events: SmartAccountEventEmitter;
    clearConnectedState: () => void;
    getContractId: () => string | undefined;
  }
): Promise<void> {
  const contractId = deps.getContractId();
  deps.clearConnectedState();
  await deps.storage.clearSession();

  if (contractId) {
    deps.events.emit("walletDisconnected", { contractId });
  }
}
