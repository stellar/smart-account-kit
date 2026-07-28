import { afterEach, describe, expect, it, vi } from "vitest";
const { assembleTransactionMock } = vi.hoisted(() => ({
  assembleTransactionMock: vi.fn(),
}));
const { resolveContextRuleIdsForEntryMock } = vi.hoisted(() => ({
  resolveContextRuleIdsForEntryMock: vi.fn(),
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

vi.mock("../kit/context-rules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kit/context-rules")>();
  return {
    ...actual,
    resolveContextRuleIdsForEntry: resolveContextRuleIdsForEntryMock,
  };
});

import { Account, Address, Keypair, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import { MultiSignerManager } from "./multi-signer-manager";
import { resolveContextRuleIdsForEntry } from "../kit/context-rules";
import {
  getAddressCredentials,
  readAuthPayload,
  writeAuthPayload,
} from "../kit/auth-payload";
import {
  makeAccount,
  makeAddressAuthEntry,
  makeContract,
  makeDelegatedSigner,
  makeExternalSigner,
} from "./test-utils";
import { signersEqual } from "../signer-utils";
import {
  SignerNotFoundError,
  ValidationError,
  SmartAccountErrorCode,
} from "../errors";

function makeDeps() {
  const externalSigners = {
    canSignFor: vi.fn(),
    signAuthEntry: vi.fn(),
    canSignEd25519: vi.fn().mockReturnValue(false),
    signEd25519Digest: vi.fn(),
  };

  const deps = {
    getContractId: vi.fn().mockReturnValue(makeContract(99)),
    isConnected: vi.fn().mockReturnValue(true),
    getRules: vi.fn(),
    requireWallet: vi.fn(() => ({ wallet: {} })),
    externalSigners,
    rpc: {
      getLatestLedger: vi.fn(),
      getAccount: vi.fn(),
      simulateTransaction: vi.fn(),
    } as any,
    networkPassphrase: "Test SDF Network ; September 2015",
    timeoutInSeconds: 30,
    deployerKeypair: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)),
    deployerPublicKey: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)).publicKey(),
    signAuthEntry: vi.fn(),
    sendAndPoll: vi.fn(),
    hasSourceAccountAuth: vi.fn().mockReturnValue(false),
    shouldUseFeeSponsoring: vi.fn().mockReturnValue(false),
    buildTokenTransfer: vi.fn(),
  };

  return deps;
}

function makeBuiltTransaction(auth: xdr.SorobanAuthorizationEntry[] = []) {
  return new TransactionBuilder(new Account(makeAccount(77), "1"), {
    fee: "100",
    networkPassphrase: "Test SDF Network ; September 2015",
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(makeContract(31)).toScAddress(),
            functionName: "ping",
            args: [],
          })
        ),
        auth,
      })
    )
    .setTimeout(30)
    .build();
}

describe("MultiSignerManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    assembleTransactionMock.mockReset();
    resolveContextRuleIdsForEntryMock.mockReset();
  });

  it("returns no signers when disconnected and deduplicates connected signers", async () => {
    const deps = makeDeps();
    deps.isConnected.mockReturnValue(false);
    const manager = new MultiSignerManager(deps);

    await expect(manager.getAvailableSigners()).resolves.toEqual([]);
    expect(deps.getRules).not.toHaveBeenCalled();

    deps.isConnected.mockReturnValue(true);
    const signerA = makeDelegatedSigner(1);
    const signerB = makeExternalSigner(2, 3, 4);
    deps.getRules.mockResolvedValue([
      { signers: [signerA, signerB] },
      { signers: [signerA] },
    ]);

    await expect(manager.getAvailableSigners()).resolves.toEqual([signerA, signerB]);
    expect(deps.getRules).toHaveBeenCalledWith({
      tag: "Default",
      values: undefined,
    });
  });

  it("builds selected signers from the active passkey and connected delegated wallets", () => {
    const deps = makeDeps();
    const manager = new MultiSignerManager(deps);
    const passkeySigner = makeExternalSigner(1, 2, 3);
    const otherPasskeySigner = makeExternalSigner(4, 5, 6);
    const delegatedSigner = makeDelegatedSigner(7);
    deps.externalSigners.canSignFor.mockImplementation((address: string) => address === makeAccount(7));

    const selected = manager.buildSelectedSigners(
      [passkeySigner, otherPasskeySigner, delegatedSigner],
      Buffer.alloc(20, 3).toString("base64url")
    );

    expect(selected).toEqual([
      {
        signer: passkeySigner,
        type: "passkey",
        credentialId: Buffer.alloc(20, 3).toString("base64url"),
      },
      {
        signer: delegatedSigner,
        type: "wallet",
        walletAddress: makeAccount(7),
      },
    ]);
  });

  it("selects ed25519 external signers when a matching local key is held", () => {
    const deps = makeDeps();
    const manager = new MultiSignerManager(deps);
    const keyData = Buffer.alloc(32, 9);
    const ed25519Signer: ContractSigner = {
      tag: "External",
      values: [makeContract(5), keyData],
    };
    deps.externalSigners.canSignEd25519.mockImplementation((k: Buffer) =>
      Buffer.from(k).equals(keyData)
    );

    const selected = manager.buildSelectedSigners([ed25519Signer], null);

    expect(selected).toEqual([
      {
        signer: ed25519Signer,
        type: "ed25519",
        ed25519PublicKey: keyData.toString("hex"),
      },
    ]);
  });

  it("ignores ed25519-shaped signers with no matching local key", () => {
    const deps = makeDeps();
    const manager = new MultiSignerManager(deps);
    const ed25519Signer: ContractSigner = {
      tag: "External",
      values: [makeContract(5), Buffer.alloc(32, 9)],
    };
    // canSignEd25519 defaults to false in the fake.
    expect(manager.buildSelectedSigners([ed25519Signer], null)).toEqual([]);
  });

  it("treats ed25519 signers as needing the multi-signer flow", () => {
    const deps = makeDeps();
    const manager = new MultiSignerManager(deps);
    const ed25519Signer: ContractSigner = {
      tag: "External",
      values: [makeContract(5), Buffer.alloc(32, 9)],
    };
    expect(manager.needsMultiSigner([ed25519Signer])).toBe(true);
  });

  it("detects when multi-signer flows are needed", () => {
    const deps = makeDeps();
    const manager = new MultiSignerManager(deps);
    const delegated = makeDelegatedSigner(1);
    const external = makeExternalSigner(2, 3, 4);

    expect(manager.needsMultiSigner([external])).toBe(false);
    expect(manager.needsMultiSigner([delegated])).toBe(true);
    expect(manager.needsMultiSigner([external, delegated])).toBe(true);
  });

  it("submits auth-less operations through sendAndPoll", async () => {
    const deps = makeDeps();
    deps.shouldUseFeeSponsoring.mockReturnValue(true);
    deps.sendAndPoll.mockResolvedValue({ success: true, hash: "tx-1" });
    const manager = new MultiSignerManager(deps);
    const assembledTx = {
      built: makeBuiltTransaction(),
      signAndSend: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        hash: "tx-1",
      }),
    } as any;

    const result = await manager.operation(assembledTx, [], { forceMethod: "rpc" });

    expect(assembledTx.signAndSend).not.toHaveBeenCalled();
    expect(deps.sendAndPoll).toHaveBeenCalledTimes(1);
    expect(deps.sendAndPoll).toHaveBeenCalledWith(expect.anything(), { forceMethod: "rpc" });
    expect(result).toEqual({
      success: true,
      hash: "tx-1",
    });
  });

  it("builds multi-signer transfers as direct token invocations", async () => {
    const deps = makeDeps();
    const assembledTx = {
      built: makeBuiltTransaction([makeAddressAuthEntry(makeContract(99))]),
    } as any;
    deps.buildTokenTransfer.mockResolvedValue(assembledTx);
    const manager = new MultiSignerManager(deps);
    const selectedSigners = [makeDelegatedSigner(1)];
    const operation = vi
      .spyOn(manager, "operation")
      .mockResolvedValue({ success: true, hash: "transfer-hash" });

    const result = await manager.transfer(
      makeContract(11),
      makeAccount(2),
      5,
      selectedSigners,
      { onLog: vi.fn() }
    );

    // Direct invocation: token contract, from = smart account, recipient, stroops.
    expect(deps.buildTokenTransfer).toHaveBeenCalledWith(
      makeContract(11),
      makeContract(99),
      makeAccount(2),
      50_000_000n
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledWith(
      assembledTx,
      selectedSigners,
      expect.objectContaining({ onLog: expect.any(Function) })
    );
    expect(result).toEqual({ success: true, hash: "transfer-hash" });
  });

  it("fails fast on unsupported external auth entries", async () => {
    const deps = makeDeps();
    deps.rpc.getLatestLedger.mockResolvedValue({ sequence: 100 });
    const manager = new MultiSignerManager(deps);
    const unsupportedAddress = makeAccount(12);

    const result = await manager.operation(
      {
        built: {
          operations: [{
            type: "invokeHostFunction",
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(makeContract(41)).toScAddress(),
                functionName: "ping",
                args: [],
              })
            ),
            auth: [makeAddressAuthEntry(unsupportedAddress)],
          }],
        },
      } as any,
      [],
      {}
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(SignerNotFoundError);
      expect(result.error.code).toBe(SmartAccountErrorCode.SIGNER_NOT_FOUND);
      expect(result.error.message).toContain(unsupportedAddress);
      expect(result.error.message).toContain(
        "Add an external signer for that address"
      );
    }
  });

  it("signs separate delegated auth entries before submission", async () => {
    const deps = makeDeps();
    const delegatedAddress = makeAccount(21);
    const authEntry = makeAddressAuthEntry(delegatedAddress);
    const preparedTx = { sign: vi.fn() };
    deps.externalSigners.canSignFor.mockReturnValue(true);
    deps.externalSigners.signAuthEntry.mockResolvedValue({
      signedAuthEntry: Buffer.alloc(64, 7).toString("base64"),
      signerAddress: delegatedAddress,
    });
    deps.rpc.getLatestLedger.mockResolvedValue({ sequence: 200 });
    deps.rpc.getAccount.mockResolvedValue(new Account(deps.deployerPublicKey, "1"));
    deps.rpc.simulateTransaction.mockResolvedValue({ result: { auth: [] } });
    deps.shouldUseFeeSponsoring.mockReturnValue(true);
    deps.sendAndPoll.mockResolvedValue({ success: true, hash: "tx-2" });
    assembleTransactionMock.mockReturnValue({
      build: () => preparedTx,
    });
    const manager = new MultiSignerManager(deps);

    const result = await manager.operation(
      {
        built: {
          operations: [{
            type: "invokeHostFunction",
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(makeContract(42)).toScAddress(),
                functionName: "ping",
                args: [],
              })
            ),
            auth: [authEntry],
          }],
        },
      } as any,
      [{
        signer: makeDelegatedSigner(21),
        type: "wallet",
        walletAddress: delegatedAddress,
      }],
      {}
    );

    expect(deps.externalSigners.signAuthEntry).toHaveBeenCalledTimes(1);
    expect(assembleTransactionMock).toHaveBeenCalledTimes(1);
    expect(deps.sendAndPoll).toHaveBeenCalledWith(preparedTx, { forceMethod: undefined });
    expect(result).toEqual({ success: true, hash: "tx-2" });
  });

  it("fails fast when a wallet signer is missing contract signer metadata", async () => {
    const deps = makeDeps();
    const contractId = deps.getContractId();
    const walletAddress = makeAccount(22);
    deps.rpc.getLatestLedger.mockResolvedValue({ sequence: 300 });
    deps.externalSigners.canSignFor.mockImplementation((address: string) => address === walletAddress);
    const manager = new MultiSignerManager(deps);

    const result = await manager.operation(
      {
        built: {
          operations: [{
            type: "invokeHostFunction",
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(makeContract(43)).toScAddress(),
                functionName: "ping",
                args: [],
              })
            ),
            auth: [makeAddressAuthEntry(contractId)],
          }],
        },
      } as any,
      [{
        type: "wallet",
        walletAddress,
      }],
      {}
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toBe(
        `Wallet signer ${walletAddress} is missing contract signer metadata. Use buildSelectedSigners() or provide the signer field explicitly.`
      );
    }
  });

  it("resolves context rule ids before signing passkey auth entries by default", async () => {
    const deps = makeDeps();
    const contractId = deps.getContractId();
    const preparedTx = { sign: vi.fn() };
    deps.rpc.getLatestLedger.mockResolvedValue({ sequence: 400 });
    deps.rpc.getAccount.mockResolvedValue(new Account(deps.deployerPublicKey, "1"));
    deps.rpc.simulateTransaction.mockResolvedValue({ result: { auth: [] } });
    deps.sendAndPoll.mockResolvedValue({ success: true, hash: "tx-3" });
    deps.signAuthEntry.mockImplementation(async (entry, options) => {
      expect(options?.contextRuleIds).toEqual([12]);
      return entry;
    });
    assembleTransactionMock.mockReturnValue({
      build: () => preparedTx,
    });
    vi.mocked(resolveContextRuleIdsForEntry).mockResolvedValue([12]);
    const manager = new MultiSignerManager(deps);

    const result = await manager.operation(
      {
        built: {
          operations: [{
            type: "invokeHostFunction",
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(makeContract(44)).toScAddress(),
                functionName: "ping",
                args: [],
              })
            ),
            auth: [makeAddressAuthEntry(contractId)],
          }],
        },
      } as any,
      [{
        signer: makeExternalSigner(3, 4, 5),
        type: "passkey",
        credentialId: Buffer.alloc(20, 5).toString("base64url"),
      }],
      {}
    );

    expect(resolveContextRuleIdsForEntry).toHaveBeenCalledTimes(1);
    expect(deps.signAuthEntry).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, hash: "tx-3" });
  });

  it("preserves delegated wallet signers when passkey signing returns a cloned auth entry", async () => {
    const deps = makeDeps();
    const contractId = deps.getContractId();
    const walletAddress = makeAccount(23);
    const passkeySigner = makeExternalSigner(6, 7, 8);
    const walletSigner = makeDelegatedSigner(23);
    const preparedTx = { sign: vi.fn() };
    deps.rpc.getLatestLedger.mockResolvedValue({ sequence: 500 });
    deps.rpc.getAccount.mockResolvedValue(new Account(deps.deployerPublicKey, "1"));
    deps.rpc.simulateTransaction.mockResolvedValue({ result: { auth: [] } });
    deps.externalSigners.canSignFor.mockImplementation((address: string) => address === walletAddress);
    deps.externalSigners.signAuthEntry.mockResolvedValue({
      signedAuthEntry: Buffer.alloc(64, 8).toString("base64"),
      signerAddress: walletAddress,
    });
    deps.sendAndPoll.mockResolvedValue({ success: true, hash: "tx-4" });
    deps.signAuthEntry.mockImplementation(async (entry, options) => {
      const clonedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
      const credentials = getAddressCredentials(clonedEntry.credentials());
      const signer = options?.signer;
      expect(signer).toBeDefined();
      credentials.signature(
        writeAuthPayload({
          context_rule_ids: options?.contextRuleIds ?? [],
          signers: new Map([[signer!, Buffer.from("aa", "hex")]]),
        })
      );
      return clonedEntry;
    });
    assembleTransactionMock.mockReturnValue({
      build: () => preparedTx,
    });
    vi.mocked(resolveContextRuleIdsForEntry).mockResolvedValue([12]);
    const manager = new MultiSignerManager(deps);

    const result = await manager.operation(
      {
        built: {
          operations: [{
            type: "invokeHostFunction",
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(makeContract(45)).toScAddress(),
                functionName: "ping",
                args: [],
              })
            ),
            auth: [makeAddressAuthEntry(contractId)],
          }],
        },
      } as any,
      [
        {
          signer: passkeySigner,
          type: "passkey",
          credentialId: Buffer.alloc(20, 8).toString("base64url"),
        },
        {
          signer: walletSigner,
          type: "wallet",
          walletAddress,
        },
      ],
      {}
    );

    expect(result).toEqual({ success: true, hash: "tx-4" });
    const resimTx = deps.rpc.simulateTransaction.mock.calls[0][0] as any;
    const submittedAuthEntry = resimTx.operations[0].auth[0] as xdr.SorobanAuthorizationEntry;
    const authPayload = readAuthPayload(
      getAddressCredentials(submittedAuthEntry.credentials()).signature()
    );

    const passkeySignature = Array.from(authPayload.signers.entries())
      .find(([signer]) => signersEqual(signer, passkeySigner))?.[1];
    const walletSignature = Array.from(authPayload.signers.entries())
      .find(([signer]) => signersEqual(signer, walletSigner))?.[1];

    expect(authPayload.context_rule_ids).toEqual([12]);
    expect(passkeySignature).toEqual(Buffer.from("aa", "hex"));
    expect(walletSignature).toEqual(Buffer.alloc(0));
  });
});
