/**
 * Testnet wallet-funding pipeline.
 *
 * Friendbot cannot fund contract addresses directly, so this creates a temporary
 * classic account, funds it via Friendbot, and transfers XLM from it to the
 * smart account. Split out of tx-ops so the core submission helpers stay small.
 *
 * @packageDocumentation
 */

import {
  Address,
  Keypair,
  BASE_FEE,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  SubmissionMethod,
  SubmissionOptions,
  TransactionResult,
} from "../types.js";
import {
  FRIENDBOT_RESERVE_XLM,
  FRIENDBOT_URL,
  LEDGERS_PER_HOUR,
} from "../constants.js";
import {
  buildAddressSignatureScVal,
  buildSignaturePreimage,
  createAddressCredentials,
  getAddressCredentials,
  randomAuthEntryNonce,
} from "./auth-payload.js";
import {
  buildTokenTransferHostFunction,
  resimulateAndAssemble,
  signFeePayer,
} from "./tx-ops.js";
import { xlmToStroops, stroopsToXlm } from "../utils.js";
import {
  SmartAccountErrorCode,
  SubmissionError,
  WalletNotConnectedError,
  wrapError,
} from "../errors.js";
import { failedTransaction, simulationFailure } from "../contract-errors.js";

/**
 * Friendbot answers with HTTP 200 as soon as its create-account transaction is
 * submitted, which can land a ledger or two ahead of the configured RPC. Poll
 * briefly so the freshly funded temp account is visible before we build the
 * transfer, instead of failing on a transient "Account not found".
 */
const FRIENDBOT_ACCOUNT_LOOKUP_ATTEMPTS = 10;
const FRIENDBOT_ACCOUNT_LOOKUP_DELAY_MS = 1000;

async function getAccountWithRetry(server: rpc.Server, publicKey: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < FRIENDBOT_ACCOUNT_LOOKUP_ATTEMPTS; attempt++) {
    try {
      return await server.getAccount(publicKey);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) =>
        setTimeout(resolve, FRIENDBOT_ACCOUNT_LOOKUP_DELAY_MS)
      );
    }
  }
  throw lastError;
}

export async function fundWallet(
  deps: {
    getContractId: () => string | undefined;
    rpc: rpc.Server;
    networkPassphrase: string;
    timeoutInSeconds: number;
    shouldUseFeeSponsoring: (options?: SubmissionOptions) => boolean;
    hasSourceAccountAuth: (transaction: Transaction) => boolean;
    sendAndPoll: (transaction: Transaction, options?: SubmissionOptions) => Promise<TransactionResult>;
  },
  nativeTokenContract: string,
  options?: { forceMethod?: SubmissionMethod }
): Promise<TransactionResult & { amount?: number }> {
  const contractId = deps.getContractId();
  if (!contractId) {
    return failedTransaction(new WalletNotConnectedError("fund a wallet"));
  }

  // Exact match: Futurenet's passphrase also contains "Test", but FRIENDBOT_URL
  // and the funding flow are testnet-specific.
  if (deps.networkPassphrase !== Networks.TESTNET) {
    return failedTransaction(new SubmissionError("fundWallet() only works on testnet"));
  }

  try {
    const tempKeypair = Keypair.random();

    const friendbotResponse = await fetch(
      `${FRIENDBOT_URL}?addr=${tempKeypair.publicKey()}`
    );

    if (!friendbotResponse.ok) {
      const text = await friendbotResponse.text();
      return failedTransaction(new SubmissionError(`Friendbot error: ${text}`));
    }

    const RESERVE_XLM = FRIENDBOT_RESERVE_XLM;
    let sourceAccount = await getAccountWithRetry(deps.rpc, tempKeypair.publicKey());

    const fromAddress = Address.fromString(tempKeypair.publicKey());

    // Read the temp account's real native balance from its classic AccountEntry.
    // (The native SAC keeps a G-address's XLM in the classic account ledger
    // entry, not in a ContractData `Balance` entry, so getContractData / a
    // trustline-based getAssetBalance can't see it.) getAccountEntry throws if
    // the account is missing, which propagates to the outer catch — no
    // fabricated fallback balance.
    const accountEntry = await deps.rpc.getAccountEntry(tempKeypair.publicKey());
    const balanceStroops = BigInt(accountEntry.balance().toString());
    const balanceXlm = stroopsToXlm(balanceStroops);

    const transferAmount = balanceXlm - RESERVE_XLM;

    if (transferAmount <= 0) {
      return failedTransaction(new SubmissionError("Insufficient balance after reserve"));
    }

    const amountInStroops = xlmToStroops(transferAmount);

    const transferOp = Operation.invokeHostFunction({
      func: buildTokenTransferHostFunction(
        nativeTokenContract,
        fromAddress.toString(),
        contractId,
        amountInStroops
      ),
      auth: [],
    });

    const simulationTx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: deps.networkPassphrase,
    })
      .addOperation(transferOp)
      .setTimeout(30)
      .build();

    const simResult = await deps.rpc.simulateTransaction(simulationTx);

    if ("error" in simResult) {
      return simulationFailure(simResult.error);
    }

    const authEntries = simResult.result?.auth || [];
    const signedAuthEntries: xdr.SorobanAuthorizationEntry[] = [];

    const currentLedger = simResult.latestLedger;
    const expirationLedger = currentLedger + LEDGERS_PER_HOUR; // ~1 hour

    for (const entry of authEntries) {
      const credType = entry.credentials().switch().name as string;

      // For source_account credentials, convert to Address credentials
      // so the Relayer can use its own channel accounts
      if (credType === "sorobanCredentialsSourceAccount") {
        // Generate a nonce for the new Address credential
        const nonce = randomAuthEntryNonce();

        // Create new Address credentials entry to replace source_account
        const addressEntry = new xdr.SorobanAuthorizationEntry({
          credentials: createAddressCredentials(
            new xdr.SorobanAddressCredentials({
              address: Address.fromString(tempKeypair.publicKey()).toScAddress(),
              nonce,
              signatureExpirationLedger: expirationLedger,
              signature: xdr.ScVal.scvVoid(),
            })
          ),
          rootInvocation: entry.rootInvocation(),
        });
        const preimage = buildSignaturePreimage(
          deps.networkPassphrase,
          addressEntry,
          expirationLedger
        );
        const payload = hash(preimage.toXDR());
        const signature = tempKeypair.sign(payload);
        getAddressCredentials(addressEntry.credentials()).signature(
          buildAddressSignatureScVal(
            tempKeypair.rawPublicKey(),
            signature
          )
        );

        signedAuthEntries.push(addressEntry);
        continue;
      }

      if (credType === "sorobanCredentialsAddressWithDelegates") {
        return failedTransaction(
          new SubmissionError(
            "ADDRESS_WITH_DELEGATES auth entries are not supported by fundWallet() yet"
          )
        );
      }

      // For Address credentials, sign them
      if (
        credType === "sorobanCredentialsAddress" ||
        credType === "sorobanCredentialsAddressV2"
      ) {
        const credentials = getAddressCredentials(entry.credentials());
        credentials.signatureExpirationLedger(expirationLedger);

        const preimage = buildSignaturePreimage(deps.networkPassphrase, entry, expirationLedger);
        const payload = hash(preimage.toXDR());
        const signature = tempKeypair.sign(payload);

        credentials.signature(buildAddressSignatureScVal(tempKeypair.rawPublicKey(), signature));

        signedAuthEntries.push(entry);
        continue;
      }

      // Unknown credential type - push as-is (shouldn't happen)
      signedAuthEntries.push(entry);
    }

    sourceAccount = await deps.rpc.getAccount(tempKeypair.publicKey());

    const invokeHostFn = simulationTx.operations[0] as Operation.InvokeHostFunction;

    const preparedTx = await resimulateAndAssemble(
      deps,
      sourceAccount,
      invokeHostFn.func,
      signedAuthEntries
    );

    // The Friendbot-funded temp account pays its own fee. A relayer sponsors
    // only calls from allowlisted wallets, so it refuses this G-address
    // transfer. Submit through RPC unless the caller forces a method.
    const submissionOpts: SubmissionOptions = { forceMethod: options?.forceMethod ?? "rpc" };
    signFeePayer(preparedTx, tempKeypair, deps, submissionOpts);

    const txResult = await deps.sendAndPoll(preparedTx, submissionOpts);

    return {
      ...txResult,
      amount: txResult.success ? transferAmount : undefined,
    };
  } catch (err) {
    return failedTransaction(wrapError(err, SmartAccountErrorCode.TRANSACTION_SUBMISSION_FAILED));
  }
}
