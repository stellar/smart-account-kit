import { describe, expect, it, vi } from "vitest";
import {
  Address,
  Keypair,
  Networks,
  Operation,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { SmartAccountKit } from "./kit";

function makeAuthEntry(): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9))
          .xdrAccountId()
          .toScAddress?.() ?? xdr.ScAddress.scAddressTypeAccount(
            Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)).xdrAccountId()
          ),
        functionName: "transfer",
        args: [],
      }),
    ),
    subInvocations: [],
  });

  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: xdr.ScAddress.scAddressTypeAccount(
          Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).xdrAccountId(),
        ),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 1,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  });
}

describe("SmartAccountKit top-level surface", () => {
  it("createWallet wires storage, events, and deploy signing", async () => {
    const storage = {
      save: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      saveSession: vi.fn(async () => undefined),
    };
    const events = { emit: vi.fn() };
    const createOperation = Operation.createCustomContract({
      address: Address.fromString(Keypair.random().publicKey()),
      wasmHash: Buffer.from("ab".repeat(32), "hex"),
      salt: hash(Buffer.from("kit-test")),
      constructorArgs: [xdr.ScVal.scvVec([]), xdr.ScVal.scvMap([])],
    });
    const deployTx = {
      built: {
        operations: [
          {
            type: "invokeHostFunction",
            func: createOperation.body().invokeHostFunctionOp().hostFunction(),
          },
        ],
      },
      signed: { toXDR: () => "SIGNED_XDR" },
    };
    const setConnectedState = vi.fn();
    const createPasskey = vi.fn(async () => ({
      rawResponse: { response: { transports: ["internal"] } },
      credentialId: "cred-123",
      publicKey: Uint8Array.from([4, ...new Array(64).fill(1)]),
    }));

    const result = await SmartAccountKit.prototype.createWallet.call(
      {
        storage,
        events,
        deployerKeypair: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)),
        networkPassphrase: Networks.TESTNET,
        sessionExpiryMs: 60_000,
        createPasskey,
        buildDeployTransaction: vi.fn(async () => deployTx),
        signWithDeployer: vi.fn(async () => undefined),
        submitDeploymentTx: vi.fn(async () => ({ success: true, hash: "abc" })),
        fundWallet: vi.fn(async () => ({ success: true, hash: "fund" })),
        setConnectedState,
      } as unknown as SmartAccountKit,
      "My App",
      "user@example.com",
      { autoSubmit: true },
    );

    expect(createPasskey).toHaveBeenCalledWith("My App", "user@example.com", undefined);
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.saveSession).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      "walletConnected",
      expect.objectContaining({ credentialId: "cred-123" }),
    );
    expect(setConnectedState).toHaveBeenCalledTimes(1);
    expect(result.credentialId).toBe("cred-123");
    expect(result.signedTransaction).toBe("SIGNED_XDR");
  });

  it("authenticatePasskey delegates to the configured WebAuthn client", async () => {
    const startAuthentication = vi.fn(async () => ({
      id: "cred-456",
      response: {},
    }));

    const result = await SmartAccountKit.prototype.authenticatePasskey.call(
      {
        rpId: "example.com",
        rpName: "My App",
        webAuthn: { startAuthentication },
      } as unknown as SmartAccountKit,
    );

    expect(startAuthentication).toHaveBeenCalledTimes(1);
    expect(result.credentialId).toBe("cred-456");
  });

  it("connectWallet routes explicit credentials through connectWithCredentials", async () => {
    const connectWithCredentials = vi.fn(async () => ({
      credentialId: "cred-789",
      contractId: "CABC",
    }));

    const result = await SmartAccountKit.prototype.connectWallet.call(
      {
        storage: {},
        events: {},
        rpId: "example.com",
        webAuthn: { startAuthentication: vi.fn() },
        connectWithCredentials,
      } as unknown as SmartAccountKit,
      { credentialId: "cred-789" },
    );

    expect(connectWithCredentials).toHaveBeenCalledWith(
      "cred-789",
      undefined,
      undefined,
      true
    );
    expect(result).toEqual({
      credentialId: "cred-789",
      contractId: "CABC",
    });
  });

  it("disconnect clears session and emits walletDisconnected", async () => {
    const storage = {
      clearSession: vi.fn(async () => undefined),
    };
    const events = { emit: vi.fn() };
    const clearConnectedState = vi.fn();

    await SmartAccountKit.prototype.disconnect.call(
      {
        storage,
        events,
        clearConnectedState,
        _contractId: "CXYZ",
      } as unknown as SmartAccountKit,
    );

    expect(clearConnectedState).toHaveBeenCalledTimes(1);
    expect(storage.clearSession).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith("walletDisconnected", {
      contractId: "CXYZ",
    });
  });

  it("sign forwards credential resolution into signAuthEntry", async () => {
    const authEntry = makeAuthEntry();
    const signAuthEntry = vi.fn(async (entry) => entry);
    const resolveConnectedContextRuleIds = vi.fn(async () => [3]);
    const transaction = {
      simulationData: {
        result: {
          auth: [authEntry],
        },
      },
      signAuthEntries: vi.fn(async ({ authorizeEntry }) => {
        await authorizeEntry(authEntry);
      }),
    };

    await SmartAccountKit.prototype.sign.call(
      {
        _contractId: "CABC",
        _credentialId: "cred-1",
        calculateExpiration: vi.fn(async () => 123),
        signAuthEntry,
        resolveConnectedContextRuleIds,
      } as unknown as SmartAccountKit,
      transaction,
    );

    expect(transaction.signAuthEntries).toHaveBeenCalledTimes(1);
    expect(signAuthEntry).toHaveBeenCalledWith(
      expect.any(xdr.SorobanAuthorizationEntry),
      expect.objectContaining({
        credentialId: "cred-1",
        expiration: 123,
        contextRuleIds: [3],
      }),
    );
    expect(resolveConnectedContextRuleIds).toHaveBeenCalledWith(expect.any(xdr.SorobanAuthorizationEntry), undefined, expect.anything());
  });

  it("sign defaults context rule resolution to the connected credential", async () => {
    const authEntry = makeAuthEntry();
    const signAuthEntry = vi.fn(async (entry) => entry);
    const resolveConnectedContextRuleIds = vi.fn(async () => [4]);
    const transaction = {
      simulationData: {
        result: {
          auth: [authEntry],
        },
      },
      signAuthEntries: vi.fn(async ({ authorizeEntry }) => {
        await authorizeEntry(authEntry);
      }),
    };

    await SmartAccountKit.prototype.sign.call(
      {
        _contractId: "CABC",
        _credentialId: "cred-1",
        calculateExpiration: vi.fn(async () => 123),
        signAuthEntry,
        resolveConnectedContextRuleIds,
      } as unknown as SmartAccountKit,
      transaction,
    );

    expect(resolveConnectedContextRuleIds).toHaveBeenCalledWith(expect.any(xdr.SorobanAuthorizationEntry), undefined, expect.anything());
    expect(signAuthEntry).toHaveBeenCalledWith(
      expect.any(xdr.SorobanAuthorizationEntry),
      expect.objectContaining({
        contextRuleIds: [4],
      }),
    );
  });

  it("discovery methods pass through to the configured indexer", async () => {
    const discoverContractsByCredential = vi.fn(async () => ({ contracts: [{ contract_id: "C1" }] }));
    const discoverContractsByAddress = vi.fn(async () => ({ contracts: [{ contract_id: "C2" }] }));
    const getContractDetailsFromIndexer = vi.fn(async () => ({ contractId: "C3" }));

    const fake = {
      indexer: {},
    } as unknown as SmartAccountKit;

    const credentialResult = await SmartAccountKit.prototype.discoverContractsByCredential.call(
      Object.assign(fake, {
        indexer: {
          lookupByCredentialId: discoverContractsByCredential,
        },
      }),
      "cred",
    );

    const addressResult = await SmartAccountKit.prototype.discoverContractsByAddress.call(
      Object.assign(fake, {
        indexer: {
          lookupByAddress: discoverContractsByAddress,
        },
      }),
      "GABC",
    );

    const detailsResult = await SmartAccountKit.prototype.getContractDetailsFromIndexer.call(
      Object.assign(fake, {
        indexer: {
          getContractDetails: getContractDetailsFromIndexer,
        },
      }),
      "C3",
    );

    expect(credentialResult).toEqual([{ contract_id: "C1" }]);
    expect(addressResult).toEqual([{ contract_id: "C2" }]);
    expect(detailsResult).toEqual({ contractId: "C3" });
  });

  it("transfer resolves token decimals before building the invocation", async () => {
    const contractId = "CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y";
    const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey();
    const transaction = { built: {} };
    const buildTokenTransfer = vi.fn(async () => transaction);
    const signAndSubmit = vi.fn(async () => ({ success: true, hash: "transfer-hash" }));
    const resolveConnectedContextRuleIds = vi.fn(async () => [7]);

    const result = await SmartAccountKit.prototype.transfer.call(
      {
        _contractId: contractId,
        requireWallet: vi.fn(() => ({ wallet: {} })),
        buildTokenTransfer,
        signAndSubmit,
        resolveConnectedContextRuleIds,
        rpc: {
          simulateTransaction: vi.fn(async () => ({
            result: { retval: (await import("@stellar/stellar-sdk")).xdr.ScVal.scvU32(6) },
          })),
        },
        networkPassphrase: "Test SDF Network ; September 2015",
        timeoutInSeconds: 30,
      } as unknown as SmartAccountKit,
      "CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y",
      recipient,
      1,
    );

    // Six-decimal token: 1 unit resolves to 1_000_000 raw, not 10_000_000.
    expect(buildTokenTransfer).toHaveBeenCalledWith(
      "CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y",
      contractId,
      recipient,
      1_000_000n
    );
    expect(signAndSubmit).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        credentialId: undefined,
        forceMethod: undefined,
        resolveContextRuleIds: expect.any(Function),
      })
    );
    const [, signOptions] = signAndSubmit.mock.calls[0];
    await expect(signOptions.resolveContextRuleIds(makeAuthEntry(), 0)).resolves.toEqual([7]);
    expect(resolveConnectedContextRuleIds).toHaveBeenCalledWith(expect.any(xdr.SorobanAuthorizationEntry), undefined, expect.anything());
    expect(result).toEqual({ success: true, hash: "transfer-hash" });
  });

  it("transfer rejects amounts with more precision than the token supports", async () => {
    const contractId = "CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y";
    const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6)).publicKey();
    const { xdr: sdkXdr } = await import("@stellar/stellar-sdk");

    const result = await SmartAccountKit.prototype.transfer.call(
      {
        _contractId: contractId,
        requireWallet: vi.fn(() => ({ wallet: {} })),
        buildTokenTransfer: vi.fn(),
        signAndSubmit: vi.fn(),
        resolveConnectedContextRuleIds: vi.fn(),
        rpc: {
          simulateTransaction: vi.fn(async () => ({
            result: { retval: sdkXdr.ScVal.scvU32(6) },
          })),
        },
        networkPassphrase: "Test SDF Network ; September 2015",
        timeoutInSeconds: 30,
      } as unknown as SmartAccountKit,
      "CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y",
      recipient,
      1.1234567,
    );

    expect(result.success).toBe(false);
  });

  it("transfer propagates credential overrides into context rule resolution", async () => {
    const contractId = "CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y";
    const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey();
    const transaction = { built: {} };
    const buildTokenTransfer = vi.fn(async () => transaction);
    const signAndSubmit = vi.fn(async () => ({ success: true, hash: "transfer-hash" }));
    const resolveConnectedContextRuleIds = vi.fn(async () => [11]);
    const { xdr: sdkXdr } = await import("@stellar/stellar-sdk");

    await SmartAccountKit.prototype.transfer.call(
      {
        _contractId: contractId,
        requireWallet: vi.fn(() => ({ wallet: {} })),
        buildTokenTransfer,
        signAndSubmit,
        resolveConnectedContextRuleIds,
        rpc: {
          simulateTransaction: vi.fn(async () => ({
            result: { retval: sdkXdr.ScVal.scvU32(7) },
          })),
        },
        networkPassphrase: "Test SDF Network ; September 2015",
        timeoutInSeconds: 30,
      } as unknown as SmartAccountKit,
      contractId,
      recipient,
      2,
      { credentialId: "cred-override" }
    );

    const [, signOptions] = signAndSubmit.mock.calls[0];
    await expect(signOptions.resolveContextRuleIds(makeAuthEntry(), 0)).resolves.toEqual([11]);
    expect(resolveConnectedContextRuleIds).toHaveBeenCalledWith(
      expect.any(xdr.SorobanAuthorizationEntry),
      "cred-override",
      expect.anything()
    );
  });

  it("signAndSubmit defaults context rule resolution to the requested credential", async () => {
    const authEntry = makeAuthEntry();
    const transaction = {
      built: {
        operations: [
          {
            type: "invokeHostFunction",
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString("CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y").toScAddress(),
                functionName: "set_config",
                args: [],
              })
            ),
          },
        ],
      },
      simulationData: {
        result: {
          auth: [authEntry],
        },
      },
    };
    const txResult = { success: true, hash: "tx-hash" };
    const resolveConnectedContextRuleIds = vi.fn(async () => [9]);
    const preparedTx = {
      sign: vi.fn(),
    };
    const signResimulateAndPrepare = vi.fn(async (_func, _auth, signOptions) => {
      await signOptions.resolveContextRuleIds(authEntry, 0);
      return preparedTx;
    });
    const sendAndPoll = vi.fn(async () => txResult);

    const result = await SmartAccountKit.prototype.signAndSubmit.call(
      {
        _contractId: "CABC",
        signResimulateAndPrepare,
        shouldUseFeeSponsoring: vi.fn(() => false),
        hasSourceAccountAuth: vi.fn(() => false),
        sendAndPoll,
        deployerKeypair: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)),
        resolveConnectedContextRuleIds,
      } as unknown as SmartAccountKit,
      transaction as any,
      {
        credentialId: "cred-override",
      }
    );

    expect(result).toEqual(txResult);
    expect(resolveConnectedContextRuleIds).toHaveBeenCalledWith(expect.any(xdr.SorobanAuthorizationEntry), "cred-override", expect.anything());
    expect(signResimulateAndPrepare).toHaveBeenCalledTimes(1);
    expect(sendAndPoll).toHaveBeenCalledWith(preparedTx, { forceMethod: undefined });
  });
});
