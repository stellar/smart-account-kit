import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON, AuthenticatorTransportFuture } from "@simplewebauthn/browser";
import { Keypair, xdr } from "@stellar/stellar-sdk";
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
import { WEBAUTHN_TIMEOUT_MS, DEFAULT_SESSION_EXPIRY_MS } from "../constants.js";
import {
  deriveContractAddress,
  generateChallenge,
  isCredentialSafeToDelete,
} from "../utils.js";
import { ValidationError } from "../errors.js";
import { failedTransaction } from "../contract-errors.js";
import {
  prepareDeploymentArtifacts,
  type DeployTransaction,
} from "./deploy-ops.js";

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

  const submissionOpts: SubmissionOptions = { forceMethod: options?.forceMethod };
  const deploymentArtifacts = await prepareDeploymentArtifacts(
    deployTx,
    deps.signWithDeployer
  );

  deps.setConnectedState(contractId, credentialId);

  deps.events.emit("walletConnected", { contractId, credentialId });

  const now = Date.now();
  await deps.storage.saveSession({
    contractId,
    credentialId,
    connectedAt: now,
    expiresAt: now + (deps.sessionExpiryMs ?? DEFAULT_SESSION_EXPIRY_MS),
  });

  const submitResult = options?.autoSubmit
    ? await deps.submitDeploymentTx(deployTx, credentialId, submissionOpts)
    : undefined;

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
      contractId?: string
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
    return deps.connectWithCredentials(credentialId, contractId);
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
        return deps.connectWithCredentials(session.credentialId, session.contractId);
      }
    }
  }

  if (!options?.prompt && !options?.fresh) {
    return null;
  }

  const authOptions: PublicKeyCredentialRequestOptionsJSON = {
    challenge: generateChallenge(),
    rpId: deps.rpId,
    userVerification: "preferred",
    timeout: WEBAUTHN_TIMEOUT_MS,
  };

  rawResponse = await deps.webAuthn.startAuthentication({ optionsJSON: authOptions });
  credentialId = rawResponse.id;

  const result = await deps.connectWithCredentials(credentialId);
  return {
    ...result,
    rawResponse,
  };
}

export async function connectWithCredentials(
  deps: {
    storage: StorageAdapter;
    rpc: rpc.Server;
    deployerKeypair: Keypair;
    networkPassphrase: string;
    sessionExpiryMs: number;
    events: SmartAccountEventEmitter;
    setConnectedState: (contractId: string, credentialId: string) => void;
  },
  credentialId?: string,
  contractId?: string
): Promise<ConnectWalletResult> {
  let credential: StoredCredential | null = null;
  let derivedContractId: string | undefined;
  if (credentialId) {
    credential = await deps.storage.get(credentialId);
    if (credential) {
      contractId = credential.contractId;
    }
  }

  if (!contractId && credentialId) {
    const credentialIdBuffer = base64url.toBuffer(credentialId);
    derivedContractId = deriveContractAddress(
      credentialIdBuffer,
      deps.deployerKeypair.publicKey(),
      deps.networkPassphrase
    );
    contractId = derivedContractId;
  }

  if (!contractId) {
    throw new Error("Could not determine contract ID");
  }

  if (!credentialId) {
    throw new Error("Could not determine credential ID");
  }

  try {
    await deps.rpc.getContractData(
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

  if (credential) {
    derivedContractId ??= deriveContractAddress(
      base64url.toBuffer(credentialId),
      deps.deployerKeypair.publicKey(),
      deps.networkPassphrase
    );
    if (isCredentialSafeToDelete(credential, derivedContractId)) {
      await deps.storage.delete(credentialId);
    }
  }

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
    credential: credential ?? undefined,
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
