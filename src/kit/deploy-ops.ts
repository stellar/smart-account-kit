import { Address, hash, xdr } from "@stellar/stellar-sdk";
import type { contract, rpc } from "@stellar/stellar-sdk";
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
  const sentTx = await tx.send();
  const txResponse = sentTx.getTransactionResponse;

  return {
    hashValue: sentTx.sendTransactionResponse?.hash ?? "",
    ledger: txResponse?.status === "SUCCESS" ? txResponse.ledger : undefined,
  };
}

export async function submitDeploymentTx(
  deps: {
    storage: StorageAdapter;
    rpc: rpc.Server;
    relayer: RelayerClient | null;
    deployerKeypair: Keypair;
    usingSharedDeployer: boolean;
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
    try {
      const relayerResult = await deps.relayer!.send(
        deployment.func.toXDR("base64"),
        deployment.auth.map((entry) => entry.toXDR("base64"))
      );
      if (!relayerResult.success) {
        throw new Error(relayerResult.error ?? "Relayer submission failed");
      }

      const hashValue = relayerResult.hash ?? "";
      const txResult = await deps.rpc.pollTransaction(hashValue, { attempts: 10 });
      if (txResult.status !== "SUCCESS") {
        throw new Error(
          txResult.status === "FAILED"
            ? "Transaction failed on-chain"
            : "Transaction confirmation timed out"
        );
      }

      await deps.storage.delete(credentialId);
      return { success: true, hash: hashValue, ledger: txResult.ledger };
    } catch (err) {
      const error =
        decodeContractError(err) ??
        wrapError(err, SmartAccountErrorCode.CREDENTIAL_DEPLOYMENT_FAILED);
      await deps.storage.update(credentialId, {
        deploymentStatus: "failed",
        deploymentError: error.message,
      });
      return failedTransaction(error);
    }
  }

  const tx = deployment;

  const rpcSubmit = () => sendDeploymentTxViaRpc(tx);

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

        const txResult = await deps.rpc.pollTransaction(hashValue, { attempts: 10 });
        if (txResult.status === "SUCCESS") {
          ledger = txResult.ledger;
        } else if (txResult.status === "FAILED") {
          throw new Error("Transaction failed on-chain");
        }
      }
    } else {
      ({ hashValue, ledger } = await rpcSubmit());
    }

    await deps.storage.delete(credentialId);
    return {
      success: true,
      hash: hashValue,
      ledger,
    };
  } catch (err) {
    const error =
      decodeContractError(err) ??
      wrapError(err, SmartAccountErrorCode.CREDENTIAL_DEPLOYMENT_FAILED);
    await deps.storage.update(credentialId, {
      deploymentStatus: "failed",
      deploymentError: error.message,
    });
    return failedTransaction(error);
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
  // Building deliberately does NOT require a relayer. Producing the shared
  // deployer's `{func, auth}` payload only signs an authorization entry — it
  // spends nothing and consumes no sequence, and the signature confers no
  // privilege (the key is public, so anyone can produce it). Integrators who
  // run their own submission infrastructure can therefore build here and
  // source/pay from any funded account of their choosing. Only SUBMISSION is
  // constrained, and that is enforced in submitDeploymentTx.
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
    !Buffer.from(fromAddress.salt()).equals(salt)
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
