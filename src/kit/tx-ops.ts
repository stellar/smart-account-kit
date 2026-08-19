import { contract, rpc } from "@stellar/stellar-sdk";
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  nativeToScVal,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  SubmissionMethod,
  SubmissionOptions,
  TransactionResult,
} from "../types.js";
import type { RelayerClient } from "../relayer.js";
import {
  SimulationError,
  SmartAccountErrorCode,
  SubmissionError,
  WalletNotConnectedError,
  wrapError,
} from "../errors.js";
import {
  decodeContractError,
  failedTransaction,
  submissionFailure,
} from "../contract-errors.js";
import { isDefaultDeployer } from "../utils.js";

/**
 * The shared default deployer is a sign-only / address-derivation identity: it
 * must never be a transaction source (sequence) or fee payer. Thrown wherever a
 * code path would otherwise use it that way.
 */
function assertNotSharedDeployerSource(publicKey: string): void {
  if (isDefaultDeployer(publicKey)) {
    throw new SubmissionError(
      `The shared default deployer ${publicKey} must never be a transaction ` +
        `source or fee payer because its signing key is public. Use a relayer ` +
        `(the relayer/channel account sources and pays) or configure a ` +
        `dedicated \`deployerSecret\` you control for this path.`
    );
  }
}

type ResolveContextRuleIds = (
  entry: xdr.SorobanAuthorizationEntry,
  index: number
) => number[] | Promise<number[]>;

export function getSubmissionMethod(
  relayer: RelayerClient | null,
  options?: SubmissionOptions
): SubmissionMethod {
  if (options?.forceMethod) {
    return options.forceMethod;
  }

  if (relayer) {
    return "relayer";
  }

  return "rpc";
}

export function shouldUseFeeSponsoring(
  relayer: RelayerClient | null,
  options?: SubmissionOptions
): boolean {
  return getSubmissionMethod(relayer, options) === "relayer";
}

export async function sendAndPoll(
  deps: {
    rpc: rpc.Server;
    relayer: RelayerClient | null;
  },
  transaction: Transaction,
  options?: SubmissionOptions
): Promise<TransactionResult> {
  const method = getSubmissionMethod(deps.relayer, options);
  let hash: string;

  switch (method) {
    case "relayer": {
      if (!deps.relayer) {
        return failedTransaction(new SubmissionError("Relayer is not configured"));
      }

      const operations = transaction.operations;
      if (operations.length !== 1) {
        return failedTransaction(
          new SubmissionError("Relayer requires exactly one invokeHostFunction operation")
        );
      }

      const op = operations[0];
      if (op.type !== "invokeHostFunction") {
        return failedTransaction(
          new SubmissionError("Relayer only supports invokeHostFunction operations")
        );
      }

      const invokeOp = op as Operation.InvokeHostFunction;
      const funcXdr = invokeOp.func.toXDR("base64");
      const authXdrs = (invokeOp.auth ?? []).map((entry) => entry.toXDR("base64"));

      const relayerResult = await deps.relayer.send(funcXdr, authXdrs);

      if (!relayerResult.success) {
        return submissionFailure(
          relayerResult.error ?? "Relayer submission failed"
        );
      }

      hash = relayerResult.hash ?? "";
      break;
    }

    case "rpc":
    default: {
      const sendResult = await deps.rpc.sendTransaction(transaction);

      if (sendResult.status === "ERROR") {
        return submissionFailure(
          sendResult.errorResult?.toXDR("base64") ?? "Transaction submission failed",
          sendResult.hash
        );
      }

      hash = sendResult.hash;
      break;
    }
  }

  const txResult = await deps.rpc.pollTransaction(hash, {
    attempts: 10,
  });

  if (txResult.status === "SUCCESS") {
    return {
      success: true,
      hash,
      ledger: txResult.ledger,
    };
  }

  if (txResult.status === "FAILED") {
    const resultXdr = txResult.resultXdr?.toXDR("base64");
    return submissionFailure(
      resultXdr
        ? `Transaction failed on-chain: ${resultXdr}`
        : "Transaction failed on-chain",
      hash
    );
  }

  return failedTransaction(
    new SubmissionError("Transaction confirmation timed out", hash),
    hash
  );
}

export function hasSourceAccountAuth(transaction: Transaction): boolean {
  for (const op of transaction.operations) {
    if (op.type !== "invokeHostFunction") continue;

    const invokeOp = op as Operation.InvokeHostFunction;
    if (!invokeOp.auth) continue;

    for (const entry of invokeOp.auth) {
      if (entry.credentials().switch().name === "sorobanCredentialsSourceAccount") {
        return true;
      }
    }
  }
  return false;
}

/**
 * Build an `scvI128` ScVal from a bigint stroop amount.
 *
 * Typed convenience wrapper over the SDK's `nativeToScVal`, used by the
 * raw host-function transfer builder.
 */
export function buildI128ScVal(amount: bigint): xdr.ScVal {
  return nativeToScVal(amount, { type: "i128" });
}

export function buildTokenTransferHostFunction(
  tokenContract: string,
  fromAddress: string,
  toAddress: string,
  amountInStroops: bigint
): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(tokenContract).toScAddress(),
      functionName: "transfer",
      args: [
        xdr.ScVal.scvAddress(Address.fromString(fromAddress).toScAddress()),
        xdr.ScVal.scvAddress(Address.fromString(toAddress).toScAddress()),
        buildI128ScVal(amountInStroops),
      ],
    })
  );
}

/**
 * Build a direct token `transfer` invocation authorized by the smart account.
 *
 * Transfers are signed as direct nested-call authorizations — the canonical
 * Soroban model — so the auth entry's context is the token-contract call
 * itself. Context rules scoped to the token (and policies attached to them,
 * such as spending limits) therefore match and enforce on transfers. The
 * smart account's `execute` entry point is not involved; it stays reserved
 * for account-mediated calls such as policy configuration.
 *
 * Simulation runs against the token contract with the default (null) source;
 * the returned AssembledTransaction carries the auth entries requiring the
 * smart account's authorization, ready for the standard signing pipeline.
 * Throws a decoded {@link ContractError} (or {@link SimulationError}) when the
 * build-time simulation fails, so callers surface the on-chain reason instead
 * of submitting an unassembled transaction.
 */
export async function buildDirectTokenTransfer(
  deps: { rpc: rpc.Server; networkPassphrase: string; timeoutInSeconds: number },
  tokenContract: string,
  fromAddress: string,
  toAddress: string,
  amountInStroops: bigint
): Promise<contract.AssembledTransaction<unknown>> {
  const transaction = await contract.AssembledTransaction.buildWithOp(
    Operation.invokeHostFunction({
      func: buildTokenTransferHostFunction(tokenContract, fromAddress, toAddress, amountInStroops),
      auth: [],
    }),
    {
      contractId: tokenContract,
      networkPassphrase: deps.networkPassphrase,
      rpcUrl: deps.rpc.serverURL.toString(),
      server: deps.rpc,
      timeoutInSeconds: deps.timeoutInSeconds,
      method: "transfer",
      parseResultXdr: (value: xdr.ScVal) => value,
    }
  );

  const simulation = transaction.simulation;
  if (simulation && rpc.Api.isSimulationError(simulation)) {
    throw (
      decodeContractError(simulation.error) ??
      new SimulationError(`Transaction simulation failed: ${simulation.error}`)
    );
  }

  return transaction;
}

/**
 * Sign a prepared transaction with the fee-paying source keypair when required.
 *
 * Single source of truth for the fee-sponsor guard: when the transaction is not
 * fee-sponsored via the relayer, or it still carries source-account auth, the
 * local keypair must sign as the fee payer. Consolidates the guard that was
 * duplicated across signAndSubmit, fundWallet, and the multi-signer paths.
 */
export function signFeePayer(
  transaction: Transaction,
  keypair: Keypair,
  deps: {
    shouldUseFeeSponsoring: (options?: SubmissionOptions) => boolean;
    hasSourceAccountAuth: (transaction: Transaction) => boolean;
  },
  options?: SubmissionOptions
): void {
  if (!deps.shouldUseFeeSponsoring(options) || deps.hasSourceAccountAuth(transaction)) {
    // The deployer must never sign as fee payer when it is the shared default.
    assertNotSharedDeployerSource(keypair.publicKey());
    transaction.sign(keypair);
  }
}

/**
 * Re-simulate an invokeHostFunction transaction with signed auth entries, then
 * assemble the final prepared transaction.
 *
 * Single source of truth for the re-simulate -> assemble step that was
 * duplicated across signResimulateAndPrepare, fundWallet, and the multi-signer
 * submission path. Throws a decoded {@link ContractError} (or
 * {@link SimulationError}) when re-simulation fails, so callers can surface the
 * on-chain reason.
 */
export async function resimulateAndAssemble(
  deps: {
    rpc: rpc.Server;
    networkPassphrase: string;
    timeoutInSeconds: number;
  },
  sourceAccount: Account,
  hostFunc: xdr.HostFunction,
  signedAuthEntries: xdr.SorobanAuthorizationEntry[]
): Promise<Transaction> {
  const resimTx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: deps.networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: hostFunc,
        auth: signedAuthEntries,
      })
    )
    .setTimeout(deps.timeoutInSeconds)
    .build();

  const resimResult = await deps.rpc.simulateTransaction(resimTx);

  if ("error" in resimResult) {
    throw (
      decodeContractError(resimResult.error) ??
      new SimulationError(`Re-simulation failed: ${resimResult.error}`)
    );
  }

  const normalizedTx = TransactionBuilder.fromXDR(resimTx.toXDR(), deps.networkPassphrase);
  return rpc.assembleTransaction(normalizedTx as Transaction, resimResult).build() as Transaction;
}

/**
 * Pick the source account for a re-simulation, honouring the sign-only
 * invariant for the shared default deployer.
 *
 * On the fee-sponsored path, `sendAndPoll` submits only `func` and `auth`.
 * The relayer or channel account supplies the source and fee.
 * A placeholder source is correct because the built envelope is discarded.
 *
 * The direct-RPC path submits the envelope and requires the real source sequence.
 * This function refuses the shared deployer as that source.
 */
export async function resolveResimSource(
  deps: {
    rpc: rpc.Server;
    deployerKeypair: Keypair;
    shouldUseFeeSponsoring: (options?: SubmissionOptions) => boolean;
  },
  options?: SubmissionOptions
): Promise<Account> {
  const publicKey = deps.deployerKeypair.publicKey();
  if (deps.shouldUseFeeSponsoring(options)) {
    return new Account(publicKey, "0");
  }
  assertNotSharedDeployerSource(publicKey);
  return deps.rpc.getAccount(publicKey);
}

export async function signResimulateAndPrepare(
  deps: {
    rpc: rpc.Server;
    networkPassphrase: string;
    timeoutInSeconds: number;
    deployerKeypair: Keypair;
    shouldUseFeeSponsoring: (options?: SubmissionOptions) => boolean;
    signAuthEntry: (
      entry: xdr.SorobanAuthorizationEntry,
      options?: {
        credentialId?: string;
        expiration?: number;
        contextRuleIds?: number[];
      }
    ) => Promise<xdr.SorobanAuthorizationEntry>;
  },
  hostFunc: xdr.HostFunction,
  authEntries: xdr.SorobanAuthorizationEntry[],
  options?: {
    credentialId?: string;
    expiration?: number;
    forceMethod?: SubmissionMethod;
    resolveContextRuleIds?: ResolveContextRuleIds;
  }
): Promise<Transaction> {
  const signedAuthEntries: xdr.SorobanAuthorizationEntry[] = [];
  for (const [index, authEntry] of authEntries.entries()) {
    const signedEntry = await deps.signAuthEntry(authEntry, {
      credentialId: options?.credentialId,
      expiration: options?.expiration,
      contextRuleIds: options?.resolveContextRuleIds
        ? await options.resolveContextRuleIds(authEntry, index)
        : undefined,
    });
    signedAuthEntries.push(signedEntry);
  }

  // Source selection honours the sign-only invariant: dummy source on the
  // relayer path (envelope discarded), real source only on direct RPC where the
  // shared deployer is refused. See resolveResimSource.
  let sourceAccount: Account;
  try {
    sourceAccount = await resolveResimSource(deps, { forceMethod: options?.forceMethod });
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError(
      `Re-simulation requires the fee-paying source account ` +
      `${deps.deployerKeypair.publicKey()} to exist on-chain. Use a relayer ` +
      `(fee sponsoring) so a sponsor account sources fees, or configure a ` +
      `dedicated \`deployerSecret\` you control and fund that account.`
    );
  }

  return resimulateAndAssemble(deps, sourceAccount, hostFunc, signedAuthEntries);
}

export async function sign(
  deps: {
    getContractId: () => string | undefined;
    getCredentialId: () => string | undefined;
    calculateExpiration: () => Promise<number>;
    signAuthEntry: (
      entry: xdr.SorobanAuthorizationEntry,
      options?: {
        credentialId?: string;
        expiration?: number;
        contextRuleIds?: number[];
      }
    ) => Promise<xdr.SorobanAuthorizationEntry>;
  },
  transaction: contract.AssembledTransaction<unknown>,
  options?: {
    credentialId?: string;
    expiration?: number;
    resolveContextRuleIds?: ResolveContextRuleIds;
  }
): Promise<contract.AssembledTransaction<unknown>> {
  const contractId = deps.getContractId();
  if (!contractId) {
    throw new WalletNotConnectedError("sign a transaction");
  }

  const credentialId = options?.credentialId ?? deps.getCredentialId();
  const expiration = options?.expiration ?? await deps.calculateExpiration();

  await transaction.signAuthEntries({
    address: contractId,
    authorizeEntry: async (entry: xdr.SorobanAuthorizationEntry) => {
      const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
      const authEntries = transaction.simulationData?.result?.auth || [];
      const entryIndex = authEntries.findIndex((authEntry) => authEntry.toXDR("base64") === entry.toXDR("base64"));
      return deps.signAuthEntry(clone, {
        credentialId,
        expiration,
        contextRuleIds: entryIndex >= 0 && options?.resolveContextRuleIds
          ? await options.resolveContextRuleIds(clone, entryIndex)
          : undefined,
      });
    },
  });

  return transaction;
}

export async function signAndSubmit(
  deps: {
    getContractId: () => string | undefined;
    signResimulateAndPrepare: (
      hostFunc: xdr.HostFunction,
      authEntries: xdr.SorobanAuthorizationEntry[],
      options?: {
        credentialId?: string;
        expiration?: number;
        forceMethod?: SubmissionMethod;
        resolveContextRuleIds?: ResolveContextRuleIds;
      }
    ) => Promise<Transaction>;
    shouldUseFeeSponsoring: (options?: SubmissionOptions) => boolean;
    hasSourceAccountAuth: (transaction: Transaction) => boolean;
    sendAndPoll: (transaction: Transaction, options?: SubmissionOptions) => Promise<TransactionResult>;
    deployerKeypair: Keypair;
  },
  transaction: contract.AssembledTransaction<unknown>,
  options?: {
    credentialId?: string;
    expiration?: number;
    forceMethod?: SubmissionMethod;
    resolveContextRuleIds?: ResolveContextRuleIds;
  }
): Promise<TransactionResult> {
  if (!deps.getContractId()) {
    return failedTransaction(new WalletNotConnectedError("submit a transaction"));
  }

  try {
    const builtTx = transaction.built;
    if (!builtTx) {
      return failedTransaction(new SubmissionError("Transaction has no built transaction"));
    }

    const operations = builtTx.operations;
    if (operations.length !== 1) {
      return failedTransaction(new SubmissionError("Expected exactly one operation"));
    }

    const operation = operations[0];
    if (operation.type !== "invokeHostFunction") {
      return failedTransaction(new SubmissionError("Expected invokeHostFunction operation"));
    }

    const invokeOp = operation as Operation.InvokeHostFunction;

    const simData = transaction.simulationData;
    if (!simData?.result?.auth) {
      return failedTransaction(new SubmissionError("No simulation data or auth entries"));
    }

      const preparedTx = await deps.signResimulateAndPrepare(
        invokeOp.func,
        simData.result.auth,
        {
          credentialId: options?.credentialId,
          expiration: options?.expiration,
          forceMethod: options?.forceMethod,
          resolveContextRuleIds: options?.resolveContextRuleIds,
        }
      );

    const submissionOpts: SubmissionOptions = { forceMethod: options?.forceMethod };
    signFeePayer(preparedTx, deps.deployerKeypair, deps, submissionOpts);

    return deps.sendAndPoll(preparedTx, submissionOpts);
  } catch (err) {
    return failedTransaction(wrapError(err, SmartAccountErrorCode.TRANSACTION_SIGNING_FAILED));
  }
}
