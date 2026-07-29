import { afterEach, describe, expect, it, vi } from "vitest";
const { assembleTransactionMock } = vi.hoisted(() => ({
  assembleTransactionMock: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: assembleTransactionMock,
    },
  };
});

import { Account, Address, Keypair, StrKey, hash, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { FRIENDBOT_RESERVE_XLM } from "../constants";
import {
  buildDirectTokenTransfer,
  buildI128ScVal,
  getSubmissionMethod,
  hasSourceAccountAuth,
  sendAndPoll,
  shouldUseFeeSponsoring,
  sign,
  signAndSubmit,
  signFeePayer,
} from "./tx-ops";
import { fundWallet } from "./fund-ops";
import { SubmissionError } from "../errors";

function makeAccount(seedByte: number): Keypair {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, seedByte));
}

function makeContractAddress(label: string): string {
  return StrKey.encodeContract(hash(Buffer.from(label)));
}

function makeHostFunction(target = makeContractAddress("target")): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(target).toScAddress(),
      functionName: "transfer",
      args: [],
    })
  );
}

function makeInvokeOperation(auth: xdr.SorobanAuthorizationEntry[] = []): {
  type: "invokeHostFunction";
  func: xdr.HostFunction;
  auth: xdr.SorobanAuthorizationEntry[];
} {
  return {
    type: "invokeHostFunction",
    func: makeHostFunction(),
    auth,
  };
}

function makeRootInvocation(target = makeContractAddress("target")): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(target).toScAddress(),
        functionName: "transfer",
        args: [],
      })
    ),
    subInvocations: [],
  });
}

function makeSourceAccountEntry(target = makeContractAddress("target")): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: makeRootInvocation(target),
  });
}

function makeAddressEntry(
  address: string,
  target = makeContractAddress("target")
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 1,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: makeRootInvocation(target),
  });
}

function makeAssembledTransaction(overrides?: Partial<{
  built: { operations: Operation.InvokeHostFunction[] };
  simulationData: { result: { auth: xdr.SorobanAuthorizationEntry[] } };
  signAuthEntries: (options: {
    address: string;
    authorizeEntry: (entry: xdr.SorobanAuthorizationEntry) => Promise<void>;
  }) => Promise<void>;
}>): any {
  return {
    built: overrides?.built,
    simulationData: overrides?.simulationData,
    signAuthEntries: overrides?.signAuthEntries ?? vi.fn(async () => {}),
  };
}

describe("tx-ops", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    assembleTransactionMock.mockReset();
  });

  it("selects the submission method from forceMethod and relayer presence", () => {
    expect(getSubmissionMethod(null)).toBe("rpc");
    expect(getSubmissionMethod({} as never)).toBe("relayer");
    expect(getSubmissionMethod({} as never, { forceMethod: "rpc" })).toBe("rpc");
    expect(shouldUseFeeSponsoring({} as never)).toBe(true);
    expect(shouldUseFeeSponsoring(null)).toBe(false);
  });

  it("detects source-account auth entries", () => {
    const tx = {
      operations: [{ type: "invokeHostFunction", auth: [makeSourceAccountEntry()] }],
    } as unknown as Transaction;

    const otherTx = {
      operations: [{ type: "invokeHostFunction", auth: [makeAddressEntry(makeAccount(1).publicKey())] }],
    } as unknown as Transaction;

    expect(hasSourceAccountAuth(tx)).toBe(true);
    expect(hasSourceAccountAuth(otherTx)).toBe(false);
  });

  it("sends through the relayer when configured", async () => {
    const invokeOp = makeInvokeOperation([makeAddressEntry(makeAccount(2).publicKey())]);
    const relayerSend = vi.fn().mockResolvedValue({
      success: true,
      hash: "relayer-hash",
    });
    const pollTransaction = vi.fn().mockResolvedValue({
      status: "SUCCESS",
      ledger: 99,
    });

    const result = await sendAndPoll(
      {
        rpc: {
          sendTransaction: vi.fn(),
          pollTransaction,
        } as never,
        relayer: {
          send: relayerSend,
        } as never,
      },
      {
        operations: [invokeOp],
      } as unknown as Transaction
    );

    const [funcXdr, authXdrs] = relayerSend.mock.calls[0];
    expect(typeof funcXdr).toBe("string");
    expect((authXdrs as string[])).toHaveLength(1);
    expect(pollTransaction).toHaveBeenCalledWith("relayer-hash", { attempts: 10 });
    expect(result).toEqual({
      success: true,
      hash: "relayer-hash",
      ledger: 99,
    });
  });

  it("returns an rpc submission error without polling", async () => {
    const sendTransaction = vi.fn().mockResolvedValue({
      status: "ERROR",
      hash: "rpc-hash",
      errorResult: {
        toXDR: () => "error-xdr",
      },
    });
    const pollTransaction = vi.fn();

    const result = await sendAndPoll(
      {
        rpc: {
          sendTransaction,
          pollTransaction,
        } as never,
        relayer: null,
      },
      {
        operations: [makeInvokeOperation()],
      } as unknown as Transaction
    );

    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(pollTransaction).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.hash).toBe("rpc-hash");
      expect(result.error).toBeInstanceOf(SubmissionError);
      expect(result.error.message).toBe("error-xdr");
    }
  });

  it("signs auth entries with the resolved context rule ids", async () => {
    const authEntry = makeAddressEntry(makeAccount(3).publicKey());
    const resolveContextRuleIds = vi.fn().mockResolvedValue([7, 9]);
    const signAuthEntry = vi.fn().mockImplementation(async (entry, options) => {
      expect(options).toMatchObject({
        credentialId: "cred-id",
        expiration: 1234,
        contextRuleIds: [7, 9],
      });
      return entry;
    });
    const signAuthEntries = vi.fn(async ({ authorizeEntry }) => {
      await authorizeEntry(authEntry);
    });

    const tx = makeAssembledTransaction({
      simulationData: { result: { auth: [authEntry] } },
      signAuthEntries,
    });

    const result = await sign(
      {
        getContractId: () => makeContractAddress("contract"),
        getCredentialId: () => "cred-id",
        calculateExpiration: async () => 1234,
        signAuthEntry,
      },
      tx,
      {
        resolveContextRuleIds,
      }
    );

    expect(resolveContextRuleIds).toHaveBeenCalledWith(expect.anything(), 0);
    expect(signAuthEntry).toHaveBeenCalledTimes(1);
    expect(signAuthEntries).toHaveBeenCalledTimes(1);
    expect(result).toBe(tx);
  });

  it("signAndSubmit re-simulates and submits with the prepared transaction", async () => {
    const authEntry = makeAddressEntry(makeAccount(4).publicKey());
    const preparedTx = {
      sign: vi.fn(),
    };
    const signResimulateAndPrepare = vi.fn().mockResolvedValue(preparedTx);
    const sendAndPollMock = vi.fn().mockResolvedValue({
      success: true,
      hash: "tx-hash",
    });
    const tx = makeAssembledTransaction({
      built: { operations: [{ type: "invokeHostFunction", func: makeHostFunction() }] },
      simulationData: { result: { auth: [authEntry] } },
    });

    const result = await signAndSubmit(
      {
        getContractId: () => makeContractAddress("contract"),
        signResimulateAndPrepare,
        shouldUseFeeSponsoring: () => true,
        hasSourceAccountAuth: () => false,
        sendAndPoll: sendAndPollMock,
        deployerKeypair: makeAccount(5),
      },
      tx,
      {
        credentialId: "cred-id",
        expiration: 555,
        forceMethod: "rpc",
      }
    );

    expect(signResimulateAndPrepare).toHaveBeenCalledWith(expect.any(Object), tx.simulationData.result.auth, {
      credentialId: "cred-id",
      expiration: 555,
      resolveContextRuleIds: undefined,
    });
    expect(sendAndPollMock).toHaveBeenCalledWith(preparedTx, { forceMethod: "rpc" });
    expect(result).toEqual({
      success: true,
      hash: "tx-hash",
    });
  });

  it("returns an error when signAndSubmit is called without simulation data", async () => {
    const tx = makeAssembledTransaction({
      built: { operations: [{ type: "invokeHostFunction", func: makeHostFunction() }] },
    });

    const result = await signAndSubmit(
      {
        getContractId: () => makeContractAddress("contract"),
        signResimulateAndPrepare: vi.fn(),
        shouldUseFeeSponsoring: () => true,
        hasSourceAccountAuth: () => false,
        sendAndPoll: vi.fn(),
        deployerKeypair: makeAccount(6),
      },
      tx
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(SubmissionError);
      expect(result.error.message).toBe("No simulation data or auth entries");
    }
  });

  it("fundWallet signs and submits the funded transfer amount", async () => {
    const account = new Account(makeAccount(7).publicKey(), "1");
    const preparedTx = {
      sign: vi.fn(),
    };
    const simulateTransaction = vi
      .fn()
      .mockResolvedValueOnce({
        result: { auth: [] },
        latestLedger: 100,
      })
      .mockResolvedValueOnce({
        result: { auth: [] },
        latestLedger: 100,
      });
    const sendAndPollMock = vi.fn().mockResolvedValue({
      success: true,
      hash: "fund-hash",
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    assembleTransactionMock.mockReturnValue({
      build: () => preparedTx,
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })) as typeof fetch);

    const result = await fundWallet(
      {
        getContractId: () => makeContractAddress("contract"),
        rpc: {
          getAccount: vi.fn().mockResolvedValue(account),
          // Real native balance read: 10,000 XLM = 100,000,000,000 stroops.
          getAccountEntry: vi
            .fn()
            .mockResolvedValue({ balance: () => ({ toString: () => "100000000000" }) }),
          simulateTransaction,
        } as never,
        networkPassphrase: "Test SDF Network ; September 2015",
        timeoutInSeconds: 30,
        shouldUseFeeSponsoring: () => false,
        hasSourceAccountAuth: () => false,
        sendAndPoll: sendAndPollMock,
      },
      makeContractAddress("token")
    );

    expect(simulateTransaction).toHaveBeenCalledTimes(2);
    expect(assembleTransactionMock).toHaveBeenCalledTimes(1);
    expect(preparedTx.sign).toHaveBeenCalledTimes(1);
    expect(sendAndPollMock).toHaveBeenCalledWith(preparedTx, { forceMethod: undefined });
    expect(result).toEqual({
      success: true,
      hash: "fund-hash",
      amount: 10_000 - FRIENDBOT_RESERVE_XLM,
    });
  });
});

describe("buildI128ScVal", () => {
  it("round-trips a positive bigint amount", () => {
    const scv = buildI128ScVal(1_234_567_890n);
    expect(scValToNative(scv)).toBe(1_234_567_890n);
  });

  it("round-trips an amount larger than u64", () => {
    const big = (1n << 70n) + 123n;
    expect(scValToNative(buildI128ScVal(big))).toBe(big);
  });

  it("round-trips zero", () => {
    expect(scValToNative(buildI128ScVal(0n))).toBe(0n);
  });
});

describe("signFeePayer", () => {
  const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21));

  function fakeTx() {
    return { sign: vi.fn() } as unknown as Transaction;
  }

  it("signs when the transaction is not fee-sponsored", () => {
    const tx = fakeTx();
    signFeePayer(tx, keypair, {
      shouldUseFeeSponsoring: () => false,
      hasSourceAccountAuth: () => false,
    });
    expect(tx.sign).toHaveBeenCalledWith(keypair);
  });

  it("signs when fee-sponsored but source-account auth remains", () => {
    const tx = fakeTx();
    signFeePayer(tx, keypair, {
      shouldUseFeeSponsoring: () => true,
      hasSourceAccountAuth: () => true,
    });
    expect(tx.sign).toHaveBeenCalledWith(keypair);
  });

  it("does not sign when fully fee-sponsored", () => {
    const tx = fakeTx();
    signFeePayer(tx, keypair, {
      shouldUseFeeSponsoring: () => true,
      hasSourceAccountAuth: () => false,
    });
    expect(tx.sign).not.toHaveBeenCalled();
  });
});

describe("buildDirectTokenTransfer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a direct token.transfer invocation authorized by the smart account", async () => {
    const { contract } = await import("@stellar/stellar-sdk");
    const buildWithOp = vi
      .spyOn(contract.AssembledTransaction, "buildWithOp")
      .mockResolvedValue({ built: {} } as never);

    const server = new rpc.Server("https://rpc.example");
    const token = StrKey.encodeContract(Buffer.alloc(32, 7));
    const account = StrKey.encodeContract(Buffer.alloc(32, 8));
    const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();

    await buildDirectTokenTransfer(
      {
        rpc: server,
        networkPassphrase: "Test SDF Network ; September 2015",
        timeoutInSeconds: 30,
      },
      token,
      account,
      recipient,
      15_000_000n
    );

    expect(buildWithOp).toHaveBeenCalledTimes(1);
    const [operation, options] = buildWithOp.mock.calls[0];

    // The operation invokes the token contract's transfer directly; the smart
    // account's execute entry point is not involved.
    const invokeOp = operation.body().invokeHostFunctionOp();
    const contractFn = invokeOp.hostFunction().invokeContract();
    expect(Address.fromScAddress(contractFn.contractAddress()).toString()).toBe(token);
    expect(contractFn.functionName().toString()).toBe("transfer");
    const args = contractFn.args();
    expect(args).toHaveLength(3);
    expect(Address.fromScAddress(args[0].address()).toString()).toBe(account);
    expect(Address.fromScAddress(args[1].address()).toString()).toBe(recipient);
    expect(scValToNative(args[2])).toBe(15_000_000n);

    expect(options).toMatchObject({
      contractId: token,
      networkPassphrase: "Test SDF Network ; September 2015",
      timeoutInSeconds: 30,
      method: "transfer",
    });
    // The kit's rpc server is reused instead of constructing a throwaway one.
    expect((options as { server?: rpc.Server }).server).toBe(server);
  });

  it("surfaces a failed build-time simulation as a decoded contract error", async () => {
    const { contract } = await import("@stellar/stellar-sdk");
    vi.spyOn(contract.AssembledTransaction, "buildWithOp").mockResolvedValue({
      built: {},
      simulation: {
        error: "host invocation failed: Error(Contract, #3221)",
        latestLedger: 1,
        events: [],
        _parsed: true,
      },
    } as never);

    const token = StrKey.encodeContract(Buffer.alloc(32, 7));
    const account = StrKey.encodeContract(Buffer.alloc(32, 8));
    const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).publicKey();

    await expect(
      buildDirectTokenTransfer(
        {
          rpc: new rpc.Server("https://rpc.example"),
          networkPassphrase: "Test SDF Network ; September 2015",
          timeoutInSeconds: 30,
        },
        token,
        account,
        recipient,
        15_000_000n
      )
    ).rejects.toThrow(/spending limit/i);
  });
});
