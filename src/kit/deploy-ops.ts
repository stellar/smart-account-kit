import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { contract, type rpc } from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import type { SubmissionOptions, TransactionResult } from "../types.js";
import type { RelayerClient } from "../relayer.js";
import type { StorageAdapter } from "../types.js";
import { buildKeyData } from "../utils.js";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import { Client as SmartAccountClient } from "smart-account-kit-bindings";
import type { Keypair } from "@stellar/stellar-sdk";
import { getSubmissionMethod } from "./tx-ops.js";
import { buildConstructorPolicies } from "./policies-ops.js";
import { SmartAccountErrorCode, SubmissionError, wrapError } from "../errors.js";
import { decodeContractError, failedTransaction } from "../contract-errors.js";
import type { PolicyConfig } from "../types.js";
import { LEDGERS_PER_HOUR } from "../constants.js";
import {
  buildAddressSignatureScVal,
  buildSignaturePreimage,
  createAddressCredentials,
  randomAuthEntryNonce,
} from "./auth-payload.js";
import { constructorArgsHash } from "./wallet-provenance.js";

export interface AuthEntryDeployment {
  kind: "auth-entry";
  func: xdr.HostFunction;
  auth: xdr.SorobanAuthorizationEntry[];
}

export type DeployTransaction =
  | contract.AssembledTransaction<null>
  | AuthEntryDeployment;

export interface RelayerDeploymentPayload {
  func: string;
  auth: string[];
}

export function isAuthEntryDeployment(
  deployment: DeployTransaction
): deployment is AuthEntryDeployment {
  return "kind" in deployment && deployment.kind === "auth-entry";
}

/** Immutable birth facts extracted from the exact deployment operation. */
export interface DeploymentBirthDescriptor {
  birthWasmHash: string;
  birthConstructorArgsHash: string;
}

/** Extract immutable birth facts from either supported deployment carrier. */
export function describeDeploymentBirth(
  deployment: DeployTransaction
): DeploymentBirthDescriptor {
  let func: xdr.HostFunction | undefined;
  if (isAuthEntryDeployment(deployment)) {
    func = deployment.func;
  } else {
    const operation = deployment.built?.operations[0];
    if (
      deployment.built?.operations.length === 1 &&
      operation?.type === "invokeHostFunction"
    ) {
      func = operation.func;
    }
  }
  if (!func || func.switch().name !== "hostFunctionTypeCreateContractV2") {
    throw new SubmissionError("Deployment does not contain one CreateContractV2 operation");
  }
  const create = func.createContractV2();
  const executable = create.executable();
  if (executable.switch().name !== "contractExecutableWasm") {
    throw new SubmissionError("Deployment does not create a WASM contract");
  }
  return {
    birthWasmHash: Buffer.from(executable.wasmHash()).toString("hex"),
    birthConstructorArgsHash: constructorArgsHash(create.constructorArgs()),
  };
}

function deploymentCreateArgs(
  deployment: DeployTransaction
): xdr.CreateContractArgsV2 {
  let func: xdr.HostFunction | undefined;
  if (isAuthEntryDeployment(deployment)) {
    func = deployment.func;
  } else {
    const operation = deployment.built?.operations[0];
    if (
      deployment.built?.operations.length === 1 &&
      operation?.type === "invokeHostFunction"
    ) {
      func = operation.func;
    }
  }
  if (!func || func.switch().name !== "hostFunctionTypeCreateContractV2") {
    throw new SubmissionError("Deployment does not contain CreateContractV2");
  }
  return func.createContractV2();
}

export async function confirmSubmittedDeployment(
  rpcServer: rpc.Server,
  networkPassphrase: string,
  deployment: DeployTransaction,
  transactionHash: string,
  ledger: number | undefined
): Promise<number> {
  const response = await rpcServer.getTransaction(transactionHash);
  if (
    response.status !== Api.GetTransactionStatus.SUCCESS ||
    (ledger !== undefined && response.ledger !== ledger)
  ) {
    throw new SubmissionError(
      "The confirmed deployment transaction is unavailable or has the wrong ledger",
      transactionHash
    );
  }
  const parsed = TransactionBuilder.fromXDR(
    response.envelopeXdr,
    networkPassphrase
  );
  if (parsed.hash().toString("hex") !== transactionHash.toLowerCase()) {
    throw new SubmissionError(
      "The confirmed deployment envelope has the wrong transaction hash",
      transactionHash
    );
  }
  const transaction =
    parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;
  const expected = deploymentCreateArgs(deployment).toXDR();
  const matchingCreates = transaction.operations.filter(
    (operation) =>
      operation.type === "invokeHostFunction" &&
      operation.func.switch().name === "hostFunctionTypeCreateContractV2" &&
      Buffer.from(operation.func.createContractV2().toXDR()).equals(expected)
  );
  if (matchingCreates.length !== 1) {
    throw new SubmissionError(
      "The confirmed transaction does not contain the expected wallet deployment",
      transactionHash
    );
  }
  return response.ledger;
}

function requireCreationLedger(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 1) {
    throw new SubmissionError(
      "The confirmed deployment did not return a valid creation ledger"
    );
  }
  return value;
}

export async function prepareDeploymentArtifacts(
  deployment: DeployTransaction,
  signWithDeployer: (
    tx: contract.AssembledTransaction<null>
  ) => Promise<void>
): Promise<{
  signedTransaction?: string;
  relayerPayload?: RelayerDeploymentPayload;
}> {
  if (isAuthEntryDeployment(deployment)) {
    return {
      relayerPayload: {
        func: deployment.func.toXDR("base64"),
        auth: deployment.auth.map((entry) => entry.toXDR("base64")),
      },
    };
  }

  await signWithDeployer(deployment);
  if (!deployment.signed) {
    throw new Error("Failed to sign deployment transaction");
  }
  return { signedTransaction: deployment.signed.toXDR() };
}

/** Refusal for any shared-deployer route without relayer-sourced `{func,auth}`. */
export function sharedDeployerFeeError(
  deployerPublicKey: string
): SubmissionError {
  return new SubmissionError(
    `Refusing to source a smart-account deployment from the shared default ` +
      `deployer ${deployerPublicKey}. It is sign-only: it may sign the deploy ` +
      `authorization entry, but must never provide the transaction sequence or ` +
      `fees. Configure a \`relayerUrl\`, or set a dedicated ` +
      `\`deployerSecret\` you control.`
  );
}

async function sendDeploymentTxViaRpc<T>(
  tx: contract.AssembledTransaction<T>
): Promise<{ hashValue: string; ledger: number | undefined }> {
  let sentTx: Awaited<ReturnType<typeof tx.send>>;
  try {
    sentTx = await tx.send();
  } catch (error) {
    if (
      error instanceof contract.SentTransaction.Errors.TransactionStillPending
    ) {
      const signed = tx.signed as { hash?: () => Buffer } | undefined;
      throw transactionConfirmationError(
        "NOT_FOUND",
        signed?.hash?.().toString("hex")
      );
    }
    throw error;
  }
  const txResponse = sentTx.getTransactionResponse;
  const hashValue = sentTx.sendTransactionResponse?.hash ?? "";

  if (!hashValue) {
    throw new Error("Transaction submission returned no hash");
  }
  if (txResponse?.status !== "SUCCESS") {
    throw transactionConfirmationError(txResponse?.status, hashValue);
  }

  return {
    hashValue,
    ledger: txResponse.ledger,
  };
}

class TransactionConfirmationError extends Error {
  constructor(
    readonly deploymentStatus: "pending" | "failed",
    readonly hash: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "TransactionConfirmationError";
  }
}

function transactionConfirmationError(
  status: string | undefined,
  hash?: string
): TransactionConfirmationError {
  return new TransactionConfirmationError(
    status === "FAILED" ? "failed" : "pending",
    hash,
    status === "FAILED"
      ? "Transaction failed on-chain"
      : "Transaction confirmation timed out"
  );
}

export async function submitDeploymentTx(
  deps: {
    storage: StorageAdapter;
    rpc: rpc.Server;
    relayer: RelayerClient | null;
    deployerKeypair: Keypair;
    usingSharedDeployer: boolean;
    networkPassphrase: string;
    confirmDeployment?: typeof confirmSubmittedDeployment;
  },
  deployment: DeployTransaction,
  credentialId: string,
  options?: SubmissionOptions
): Promise<TransactionResult> {
  const method = getSubmissionMethod(deps.relayer, options);

  const authEntryRoute = isAuthEntryDeployment(deployment);
  if (deps.usingSharedDeployer && (!authEntryRoute || method !== "relayer" || !deps.relayer)) {
    throw sharedDeployerFeeError(deps.deployerKeypair.publicKey());
  }
  if (!deps.usingSharedDeployer && authEntryRoute) {
    throw new SubmissionError(
      "Auth-entry deployment is only valid for the shared default deployer"
    );
  }

  if (authEntryRoute) {
    let submittedHash: string | undefined;
    try {
      const relayerResult = await deps.relayer!.send(
        deployment.func.toXDR("base64"),
        deployment.auth.map((entry) => entry.toXDR("base64"))
      );
      if (!relayerResult.success) {
        throw new Error(relayerResult.error ?? "Relayer submission failed");
      }

      submittedHash = relayerResult.hash ?? "";
      if (!submittedHash) {
        throw new Error("Relayer submission returned no transaction hash");
      }
      const txResult = await deps.rpc.pollTransaction(submittedHash, { attempts: 10 });
      if (txResult.status !== "SUCCESS") {
        throw transactionConfirmationError(txResult.status, submittedHash);
      }

      const confirmedLedger = await (deps.confirmDeployment ?? confirmSubmittedDeployment)(
        deps.rpc,
        deps.networkPassphrase,
        deployment,
        submittedHash,
        txResult.ledger
      );
      const creationLedger = requireCreationLedger(
        confirmedLedger ?? txResult.ledger
      );

      await deps.storage.update(credentialId, {
        deploymentStatus: "deployed",
        deploymentError: undefined,
        deploymentTransactionHash: submittedHash,
        creationTransactionHash: submittedHash,
        creationLedger,
      });
      return { success: true, hash: submittedHash, ledger: creationLedger };
    } catch (err) {
      const error =
        decodeContractError(err) ??
        wrapError(err, SmartAccountErrorCode.CREDENTIAL_DEPLOYMENT_FAILED);
      const confirmation =
        err instanceof TransactionConfirmationError ? err : undefined;
      const knownHash = confirmation?.hash ?? submittedHash;
      await deps.storage.update(credentialId, {
        deploymentStatus:
          confirmation?.deploymentStatus ?? (knownHash ? "pending" : "failed"),
        deploymentError: error.message,
        ...(knownHash ? { deploymentTransactionHash: knownHash } : {}),
      });
      return failedTransaction(error, knownHash);
    }
  }

  const tx = deployment;

  const rpcSubmit = () => sendDeploymentTxViaRpc(tx);

  let submittedHash: string | undefined;
  try {
    let hashValue: string;
    let ledger: number | undefined;

    if (method === "relayer" && tx.signed && deps.relayer) {
      const relayerResult = await deps.relayer.sendXdr(tx.signed);

      if (!relayerResult.success) {
        if (options?.forceMethod === "relayer") {
          throw new Error(relayerResult.error ?? "Relayer submission failed");
        }

        ({ hashValue, ledger } = await rpcSubmit());
      } else {
        hashValue = relayerResult.hash ?? "";
        if (!hashValue) {
          throw new Error("Relayer submission returned no transaction hash");
        }
        submittedHash = hashValue;

        const txResult = await deps.rpc.pollTransaction(hashValue, { attempts: 10 });
        if (txResult.status !== "SUCCESS") {
          throw transactionConfirmationError(txResult.status, hashValue);
        }
        ledger = txResult.ledger;
      }
    } else {
      ({ hashValue, ledger } = await rpcSubmit());
    }
    submittedHash = hashValue;

    const confirmedLedger = await (deps.confirmDeployment ?? confirmSubmittedDeployment)(
      deps.rpc,
      deps.networkPassphrase,
      deployment,
      hashValue,
      ledger
    );
    const creationLedger = requireCreationLedger(confirmedLedger ?? ledger);

    await deps.storage.update(credentialId, {
      deploymentStatus: "deployed",
      deploymentError: undefined,
      deploymentTransactionHash: hashValue,
      creationTransactionHash: hashValue,
      creationLedger,
    });
    return {
      success: true,
      hash: hashValue,
      ledger: creationLedger,
    };
  } catch (err) {
    const error =
      decodeContractError(err) ??
      wrapError(err, SmartAccountErrorCode.CREDENTIAL_DEPLOYMENT_FAILED);
    const confirmation =
      err instanceof TransactionConfirmationError ? err : undefined;
    const knownHash = confirmation?.hash ?? submittedHash;
    await deps.storage.update(credentialId, {
      deploymentStatus:
        confirmation?.deploymentStatus ?? (knownHash ? "pending" : "failed"),
      deploymentError: error.message,
      ...(knownHash ? { deploymentTransactionHash: knownHash } : {}),
    });
    return failedTransaction(error, knownHash);
  }
}

export async function buildDeployTransaction(
  deps: {
    accountWasmHash: string;
    webauthnVerifierAddress: string;
    networkPassphrase: string;
    rpcUrl: string;
    deployerKeypair: Keypair;
    usingSharedDeployer: boolean;
    timeoutInSeconds: number;
  },
  credentialId: Buffer,
  publicKey: Uint8Array,
  policies?: PolicyConfig[]
): Promise<DeployTransaction> {
  // Building does not require a relayer. It returns the shared deployer's
  // `{func, auth}` payload for submission through approved infrastructure.
  // submitDeploymentTx enforces the submission constraints.
  const keyData = buildKeyData(publicKey, credentialId);
  const signer: ContractSigner = {
    tag: "External",
    values: [
      deps.webauthnVerifierAddress,
      keyData,
    ],
  };

  // Constructor policies (config.defaultPolicies or per-call). Converts each
  // PolicyConfig to the Map<Address, Val> the __constructor expects.
  const constructorPolicies = policies?.length
    ? buildConstructorPolicies(policies)
    : new Map<string, xdr.ScVal>();

  const salt = hash(credentialId);
  const deployment = await SmartAccountClient.deploy<null>(
    {
      signers: [signer],
      policies: constructorPolicies,
    },
    {
      networkPassphrase: deps.networkPassphrase,
      rpcUrl: deps.rpcUrl,
      wasmHash: deps.accountWasmHash,
      ...(deps.usingSharedDeployer
        ? { address: deps.deployerKeypair.publicKey() }
        : { publicKey: deps.deployerKeypair.publicKey() }),
      salt,
      timeoutInSeconds: deps.timeoutInSeconds,
    }
  );

  if (!deps.usingSharedDeployer) {
    return deployment;
  }

  const operation = deployment.built?.operations[0];
  const discoveredAuth = deployment.simulationData.result?.auth ?? [];
  const latestLedger = deployment.simulation?.latestLedger;
  if (
    deployment.built?.operations.length !== 1 ||
    operation?.type !== "invokeHostFunction" ||
    discoveredAuth.length !== 1 ||
    latestLedger === undefined
  ) {
    throw new SubmissionError(
      "Shared deploy simulation did not return one create-contract authorization entry"
    );
  }

  const deployerPublicKey = deps.deployerKeypair.publicKey();
  const authorizedFunction = discoveredAuth[0].rootInvocation().function();
  const authorizedCreate = authorizedFunction.switch().name ===
    "sorobanAuthorizedFunctionTypeCreateContractV2HostFn"
    ? authorizedFunction.createContractV2HostFn()
    : undefined;
  const operationCreate = operation.func.switch().name ===
    "hostFunctionTypeCreateContractV2"
    ? operation.func.createContractV2()
    : undefined;
  const fromAddress = authorizedCreate?.contractIdPreimage().fromAddress();
  if (
    !authorizedCreate ||
    !operationCreate ||
    !Buffer.from(authorizedCreate.toXDR()).equals(operationCreate.toXDR()) ||
    !fromAddress ||
    Address.fromScAddress(fromAddress.address()).toString() !== deployerPublicKey ||
    !Buffer.from(fromAddress.salt()).equals(salt) ||
    // The deployer signs the whole tree, so anything hanging off the root would
    // be authorized too. A deployment needs no sub-invocations; refuse any.
    discoveredAuth[0].rootInvocation().subInvocations().length !== 0
  ) {
    throw new SubmissionError(
      "Shared deploy simulation returned authorization for the wrong deployer"
    );
  }

  const expirationLedger = latestLedger + LEDGERS_PER_HOUR;
  const credentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(deployerPublicKey).toScAddress(),
    nonce: randomAuthEntryNonce(),
    signatureExpirationLedger: expirationLedger,
    signature: xdr.ScVal.scvVoid(),
  });
  const signedAuthEntry = new xdr.SorobanAuthorizationEntry({
    credentials: createAddressCredentials(credentials),
    rootInvocation: discoveredAuth[0].rootInvocation(),
  });
  const preimage = buildSignaturePreimage(
    deps.networkPassphrase,
    signedAuthEntry,
    expirationLedger
  );
  credentials.signature(
    buildAddressSignatureScVal(
      deps.deployerKeypair.rawPublicKey(),
      deps.deployerKeypair.sign(hash(preimage.toXDR()))
    )
  );

  return {
    kind: "auth-entry",
    func: operation.func,
    auth: [signedAuthEntry],
  };
}
