import { afterEach, describe, expect, it, vi } from "vitest";
import { Address, Keypair, Operation, hash, xdr } from "@stellar/stellar-sdk";
import {
  connectWallet,
  connectWithCredentials,
  createWallet,
  disconnect,
} from "./wallet-ops";
import { deriveContractAddress, generateChallenge } from "../utils";
import { MemoryStorage } from "../storage/memory";
import { WalletProvenanceError } from "../errors";
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from "@simplewebauthn/browser";

vi.mock("../utils", async () => {
  const actual = await vi.importActual<typeof import("../utils")>("../utils");

  return {
    ...actual,
    deriveContractAddress: vi.fn(() => "CDETERMINISTICCONTRACTADDRESS12345678901234567890123456"),
    generateChallenge: vi.fn(() => "generated-challenge"),
  };
});

function createStorageMock() {
  return {
    save: vi.fn(),
    get: vi.fn(),
    getByContract: vi.fn(),
    getAll: vi.fn(),
    delete: vi.fn(),
    update: vi.fn(),
    clear: vi.fn(),
    saveSession: vi.fn(),
    getSession: vi.fn(),
    clearSession: vi.fn(),
  };
}

function createEventMock() {
  return {
    emit: vi.fn(),
  };
}

function createDeployTxMock() {
  const operation = Operation.createCustomContract({
    address: Address.fromString(Keypair.random().publicKey()),
    wasmHash: Buffer.from("ab".repeat(32), "hex"),
    salt: hash(Buffer.from("wallet-ops-test")),
    constructorArgs: [xdr.ScVal.scvVec([]), xdr.ScVal.scvMap([])],
  });
  const func = operation.body().invokeHostFunctionOp().hostFunction();
  return {
    built: { operations: [{ type: "invokeHostFunction", func }] },
    signed: {
      toXDR: vi.fn(() => "signed-xdr"),
    },
  };
}

const DERIVED_CONTRACT_ID =
  "CDETERMINISTICCONTRACTADDRESS12345678901234567890123456";
const ACCEPTED_WASM_HASH = "ab".repeat(32);

/** An instance ledger entry carrying a WASM executable hash. */
function instanceWithWasm(hashHex: string) {
  return {
    val: {
      contractData: () => ({
        val: () => ({
          instance: () => ({
            executable: () => ({
              switch: () => ({ name: "contractExecutableWasm" }),
              wasmHash: () => Buffer.from(hashHex, "hex"),
            }),
          }),
        }),
      }),
    },
  };
}

describe("wallet-ops", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("creates deployment artifacts without connecting before submission", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);

    const storage = createStorageMock();
    const events = createEventMock();
    const credentialId = "credential-123";
    const publicKey = new Uint8Array(65).fill(7);
    const rawResponse = {
      id: credentialId,
      response: { transports: ["internal"] },
    } as unknown as RegistrationResponseJSON;
    const createPasskey = vi.fn().mockResolvedValue({
      rawResponse,
      credentialId,
      publicKey,
    });
    const buildDeployTransaction = vi.fn().mockResolvedValue(createDeployTxMock());
    const signWithDeployer = vi.fn().mockResolvedValue(undefined);
    const submitDeploymentTx = vi.fn();
    const fundWallet = vi.fn();
    const setConnectedState = vi.fn();
    const result = await createWallet(
      {
        storage: storage as never,
        events: events as never,
        deployerKeypair: Keypair.random(),
        networkPassphrase: "Test SDF Network ; September 2015",
        sessionExpiryMs: 10_000,
        createPasskey,
        buildDeployTransaction,
        signWithDeployer,
        submitDeploymentTx,
        fundWallet,
        setConnectedState,
      },
      "My App",
      "alice",
      { nickname: "Primary", forceMethod: "rpc" }
    );

    expect(createPasskey).toHaveBeenCalledWith("My App", "alice", undefined);
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      "credentialCreated",
      expect.objectContaining({ credential: expect.objectContaining({ credentialId, nickname: "Primary" }) })
    );
    expect(buildDeployTransaction).toHaveBeenCalledTimes(1);
    expect(signWithDeployer).toHaveBeenCalledTimes(1);
    expect(setConnectedState).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith(
      "walletConnected",
      expect.anything()
    );
    expect(storage.saveSession).not.toHaveBeenCalled();
    expect(submitDeploymentTx).not.toHaveBeenCalled();
    expect(fundWallet).not.toHaveBeenCalled();
    expect(result).toEqual({
      rawResponse,
      credentialId,
      publicKey,
      contractId: "CDETERMINISTICCONTRACTADDRESS12345678901234567890123456",
      signedTransaction: "signed-xdr",
      submitResult: undefined,
      fundResult: undefined,
    });
  });

  it("submits and funds a wallet when autoSubmit and autoFund are enabled", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);

    const storage = createStorageMock();
    const events = createEventMock();
    const credentialId = "credential-456";
    const publicKey = new Uint8Array(65).fill(8);
    const rawResponse = {
      id: credentialId,
      response: { transports: ["internal"] },
    } as unknown as RegistrationResponseJSON;
    const deployTx = createDeployTxMock();
    const createPasskey = vi.fn().mockResolvedValue({
      rawResponse,
      credentialId,
      publicKey,
    });
    const buildDeployTransaction = vi.fn().mockResolvedValue(deployTx);
    const signWithDeployer = vi.fn().mockResolvedValue(undefined);
    const submitDeploymentTx = vi.fn().mockResolvedValue({ success: true, hash: "submit-hash" });
    const fundWallet = vi.fn().mockResolvedValue({ success: true, hash: "fund-hash", amount: 123 });
    const setConnectedState = vi.fn();

    const result = await createWallet(
      {
        storage: storage as never,
        events: events as never,
        deployerKeypair: Keypair.random(),
        networkPassphrase: "Test SDF Network ; September 2015",
        sessionExpiryMs: 5_000,
        createPasskey,
        buildDeployTransaction,
        signWithDeployer,
        submitDeploymentTx,
        fundWallet,
        setConnectedState,
      },
      "My App",
      "alice",
      {
        autoSubmit: true,
        autoFund: true,
        nativeTokenContract: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
        forceMethod: "rpc",
      }
    );

    expect(submitDeploymentTx).toHaveBeenCalledWith(deployTx, credentialId, { forceMethod: "rpc" });
    expect(fundWallet).toHaveBeenCalledWith(
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      { forceMethod: "rpc" }
    );
    expect(result.submitResult).toEqual({ success: true, hash: "submit-hash" });
    expect(result.fundResult).toEqual({ success: true, hash: "fund-hash", amount: 123 });
    expect(setConnectedState).toHaveBeenCalledWith(
      DERIVED_CONTRACT_ID,
      credentialId
    );
    expect(events.emit).toHaveBeenCalledWith("walletConnected", {
      contractId: DERIVED_CONTRACT_ID,
      credentialId,
    });
    expect(storage.saveSession).toHaveBeenCalledWith({
      contractId: DERIVED_CONTRACT_ID,
      credentialId,
      connectedAt: 2_000,
      expiresAt: 7_000,
    });
  });

  it("does not connect when automatic deployment fails", async () => {
    const storage = createStorageMock();
    const events = createEventMock();
    const credentialId = "credential-failed";
    const submitResult = {
      success: false as const,
      error: new Error("deployment failed"),
    };
    const setConnectedState = vi.fn();

    await createWallet(
      {
        storage: storage as never,
        events: events as never,
        deployerKeypair: Keypair.random(),
        networkPassphrase: "Test SDF Network ; September 2015",
        sessionExpiryMs: 5_000,
        createPasskey: vi.fn().mockResolvedValue({
          rawResponse: {
            id: credentialId,
            response: { transports: ["internal"] },
          } as unknown as RegistrationResponseJSON,
          credentialId,
          publicKey: new Uint8Array(65).fill(8),
        }),
        buildDeployTransaction: vi.fn().mockResolvedValue(createDeployTxMock()),
        signWithDeployer: vi.fn().mockResolvedValue(undefined),
        submitDeploymentTx: vi.fn().mockResolvedValue(submitResult),
        fundWallet: vi.fn(),
        setConnectedState,
      },
      "My App",
      "alice",
      { autoSubmit: true }
    );

    expect(setConnectedState).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith(
      "walletConnected",
      expect.anything()
    );
    expect(storage.saveSession).not.toHaveBeenCalled();
  });

  it("restores a wallet from session without prompting", async () => {
    const storage = createStorageMock();
    const events = createEventMock();
    const connectWithCredentialsMock = vi.fn().mockResolvedValue({
      credentialId: "cred",
      contractId: "contract",
    });
    storage.getSession.mockResolvedValue({
      credentialId: "cred",
      contractId: "contract",
      connectedAt: 1,
      expiresAt: Date.now() + 10_000,
    });

    const result = await connectWallet(
      {
        storage: storage as never,
        events: events as never,
        webAuthn: {
          startAuthentication: vi.fn(),
        },
        connectWithCredentials: connectWithCredentialsMock,
      },
      {}
    );

    expect(connectWithCredentialsMock).toHaveBeenCalledWith(
      "cred",
      "contract",
      undefined,
      false
    );
    expect(result).toEqual({ credentialId: "cred", contractId: "contract" });
  });

  it("prompts for passkey auth when requested", async () => {
    vi.spyOn(Date, "now").mockReturnValue(3_000);

    const storage = createStorageMock();
    const events = createEventMock();
    const connectWithCredentialsMock = vi.fn().mockResolvedValue({
      credentialId: "cred-from-auth",
      contractId: "contract-from-auth",
    });
    const startAuthentication = vi.fn().mockResolvedValue({
      id: "cred-from-auth",
      response: { authenticatorData: "", clientDataJSON: "", signature: "" },
    } as unknown as AuthenticationResponseJSON);

    const result = await connectWallet(
      {
        storage: storage as never,
        events: events as never,
        rpId: "app.example",
        webAuthn: {
          startAuthentication,
        },
        connectWithCredentials: connectWithCredentialsMock,
      },
      { prompt: true }
    );

    expect(generateChallenge).toHaveBeenCalledTimes(1);
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({
        challenge: "generated-challenge",
        rpId: "app.example",
        timeout: expect.any(Number),
      }),
    });
    expect(connectWithCredentialsMock).toHaveBeenCalledWith(
      "cred-from-auth",
      undefined,
      {
        response: expect.objectContaining({ id: "cred-from-auth" }),
        challenge: "generated-challenge",
      }
    );
    expect(result).toEqual({
      credentialId: "cred-from-auth",
      contractId: "contract-from-auth",
      rawResponse: expect.any(Object),
    });
  });

  it("clears an expired session and returns null when not prompted", async () => {
    vi.spyOn(Date, "now").mockReturnValue(5_000);

    const storage = createStorageMock();
    const events = createEventMock();
    const connectWithCredentialsMock = vi.fn();
    storage.getSession.mockResolvedValue({
      credentialId: "cred",
      contractId: "contract",
      connectedAt: 1,
      expiresAt: 4_000,
    });

    const result = await connectWallet(
      {
        storage: storage as never,
        events: events as never,
        webAuthn: {
          startAuthentication: vi.fn(),
        },
        connectWithCredentials: connectWithCredentialsMock,
      },
      {}
    );

    expect(events.emit).toHaveBeenCalledWith(
      "sessionExpired",
      { contractId: "contract", credentialId: "cred" }
    );
    expect(storage.clearSession).toHaveBeenCalledTimes(1);
    expect(connectWithCredentialsMock).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("clears an unverified session without starting authentication", async () => {
    const storage = createStorageMock();
    const events = createEventMock();
    const startAuthentication = vi.fn();
    const connectWithCredentialsMock = vi
      .fn()
      .mockRejectedValue(new WalletProvenanceError("Ccontract", "unverified"));
    storage.getSession.mockResolvedValue({
      credentialId: "cred",
      contractId: "Ccontract",
      connectedAt: 1,
      expiresAt: Date.now() + 10_000,
    });

    const result = await connectWallet(
      {
        storage: storage as never,
        events: events as never,
        webAuthn: { startAuthentication },
        connectWithCredentials: connectWithCredentialsMock,
      },
      {}
    );

    expect(storage.clearSession).toHaveBeenCalledTimes(1);
    expect(startAuthentication).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("rejects an unverified secondary credential mapping", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);

    const storage = new MemoryStorage();
    const events = createEventMock();
    const rpc = {
      getContractData: vi
        .fn()
        .mockResolvedValue(instanceWithWasm(ACCEPTED_WASM_HASH)),
    };
    const credential = {
      credentialId: "cred",
      publicKey: new Uint8Array(65).fill(9),
      contractId: "Cstoredcontract",
      isPrimary: false,
      deploymentStatus: "pending",
    } as const;
    await storage.save(credential);
    const setConnectedState = vi.fn();
    const deps = {
      storage,
      rpc: rpc as never,
      deployerKeypair: Keypair.random(),
      networkPassphrase: "Test SDF Network ; September 2015",
      sessionExpiryMs: 7_000,
      acceptedWasmHashes: [ACCEPTED_WASM_HASH],
      acceptedBirthWasmHashes: [ACCEPTED_WASM_HASH],
      webauthnVerifierAddress: "CVERIFIER",
      events: events as never,
      setConnectedState,
    };

    await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
      /birth provenance/i
    );

    expect(await storage.get("cred")).toEqual(credential);
    expect(setConnectedState).not.toHaveBeenCalled();
    expect(await storage.getSession()).toBeNull();
  });

  it("keeps a pending credential when occupancy has no birth claim", async () => {
    const storage = new MemoryStorage();
    const events = createEventMock();
    const credential = {
      credentialId: "cred",
      publicKey: new Uint8Array(65).fill(9),
      contractId: DERIVED_CONTRACT_ID,
      deploymentStatus: "pending",
    } as const;
    await storage.save(credential);

    await expect(connectWithCredentials(
      {
        storage,
        rpc: {
          getContractData: vi
            .fn()
            .mockResolvedValue(instanceWithWasm(ACCEPTED_WASM_HASH)),
        } as never,
        deployerKeypair: Keypair.random(),
        networkPassphrase: "Test SDF Network ; September 2015",
        sessionExpiryMs: 7_000,
        acceptedWasmHashes: [ACCEPTED_WASM_HASH],
        acceptedBirthWasmHashes: [ACCEPTED_WASM_HASH],
        webauthnVerifierAddress: "CVERIFIER",
        events: events as never,
        setConnectedState: vi.fn(),
      },
      "cred"
    )).rejects.toThrow(/birth provenance/i);

    expect(await storage.get("cred")).toEqual(credential);
  });

  it("marks a stored credential pending when on-chain lookup fails", async () => {
    const storage = createStorageMock();
    const events = createEventMock();
    const rpc = {
      getContractData: vi.fn().mockRejectedValue(new Error("missing")),
    };
    storage.get.mockResolvedValue({
      credentialId: "cred",
      publicKey: new Uint8Array(65).fill(10),
      contractId: "",
      deploymentStatus: "pending",
    });
    const setConnectedState = vi.fn();

    await expect(
      connectWithCredentials(
        {
          storage: storage as never,
          rpc: rpc as never,
          deployerKeypair: Keypair.random(),
          networkPassphrase: "Test SDF Network ; September 2015",
          sessionExpiryMs: 7_000,
          events: events as never,
          setConnectedState,
        },
        "cred",
        undefined
      )
    ).rejects.toThrow(/wallet may not have been deployed yet/i);

    expect(storage.update).toHaveBeenCalledWith("cred", { deploymentStatus: "pending" });
    expect(setConnectedState).not.toHaveBeenCalled();
    expect(storage.saveSession).not.toHaveBeenCalled();
  });

  describe("code identity on untrusted resolution", () => {
    const makeDeps = (rpc: unknown, storage: MemoryStorage) => ({
      storage,
      rpc: rpc as never,
      deployerKeypair: Keypair.random(),
      networkPassphrase: "Test SDF Network ; September 2015",
      sessionExpiryMs: 7_000,
      acceptedWasmHashes: [ACCEPTED_WASM_HASH],
      acceptedBirthWasmHashes: [ACCEPTED_WASM_HASH],
      webauthnVerifierAddress: "CVERIFIER",
      events: createEventMock() as never,
      setConnectedState: vi.fn(),
    });

    it("REJECTS a derived address running unaccepted code", async () => {
      // A derived address without a confirmed mapping is untrusted.
      // The connection must fail closed when its code is not accepted.
      const storage = new MemoryStorage();
      const deps = makeDeps(
        { getContractData: vi.fn().mockResolvedValue(instanceWithWasm("cd".repeat(32))) },
        storage
      );

      await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
        /unaccepted code/i
      );
      expect(deps.setConnectedState).not.toHaveBeenCalled();
      expect(await storage.getSession()).toBeNull();
    });

    it("REJECTS a non-WASM executable at the derived address", async () => {
      const storage = new MemoryStorage();
      const deps = makeDeps(
        {
          getContractData: vi.fn().mockResolvedValue({
            val: {
              contractData: () => ({
                val: () => ({
                  instance: () => ({
                    executable: () => ({
                      switch: () => ({ name: "contractExecutableStellarAsset" }),
                    }),
                  }),
                }),
              }),
            },
          }),
        },
        storage
      );

      await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
        /unaccepted code/i
      );
    });

    it.each([
      ["an empty pending row", "", "pending"],
      ["an empty failed row", "", "failed"],
      ["a derived pending row", DERIVED_CONTRACT_ID, "pending"],
      ["a derived failed row", DERIVED_CONTRACT_ID, "failed"],
    ] as const)(
      "REJECTS unaccepted code when storage contains %s",
      async (_label, contractId, deploymentStatus) => {
        const storage = new MemoryStorage();
        await storage.save({
          credentialId: "cred",
          publicKey: new Uint8Array(65).fill(9),
          contractId,
          createdAt: 1,
          deploymentStatus,
        });
        const deps = makeDeps(
          {
            getContractData: vi
              .fn()
              .mockResolvedValue(instanceWithWasm("cd".repeat(32))),
          },
          storage
        );

        await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
          /unaccepted code/i
        );

        expect(deps.setConnectedState).not.toHaveBeenCalled();
        expect(await storage.getSession()).toBeNull();
        expect(await storage.get("cred")).not.toBeNull();
      }
    );

    it("keeps an empty pending row after accepted code passes without birth proof", async () => {
      const storage = new MemoryStorage();
      await storage.save({
        credentialId: "cred",
        publicKey: new Uint8Array(65).fill(9),
        contractId: "",
        createdAt: 1,
        deploymentStatus: "pending",
      });
      const deps = makeDeps(
        {
          getContractData: vi
            .fn()
            .mockResolvedValue(instanceWithWasm(ACCEPTED_WASM_HASH)),
        },
        storage
      );

      await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
        /birth provenance/i
      );
      expect(deps.setConnectedState).not.toHaveBeenCalled();
      expect(await storage.get("cred")).not.toBeNull();
      expect(await storage.getSession()).toBeNull();
    });

    it("REJECTS a primary predicted row after the deployer changes", async () => {
      const storage = new MemoryStorage();
      await storage.save({
        credentialId: "cred",
        publicKey: new Uint8Array(65).fill(9),
        contractId: DERIVED_CONTRACT_ID,
        createdAt: 1,
        isPrimary: true,
        deploymentStatus: "failed",
      });
      vi.mocked(deriveContractAddress).mockReturnValueOnce(
        "CNEWDEPLOYERCONTRACTADDRESS123456789012345678901234567"
      );
      const deps = makeDeps(
        {
          getContractData: vi
            .fn()
            .mockResolvedValue(instanceWithWasm("cd".repeat(32))),
        },
        storage
      );

      await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
        /unaccepted code/i
      );

      expect(deps.setConnectedState).not.toHaveBeenCalled();
      expect(await storage.getSession()).toBeNull();
      expect(await storage.get("cred")).not.toBeNull();
    });

    it("REJECTS accepted code at a derived address without verified birth", async () => {
      const storage = new MemoryStorage();
      const deps = makeDeps(
        {
          getContractData: vi
            .fn()
            .mockResolvedValue(instanceWithWasm(ACCEPTED_WASM_HASH)),
        },
        storage
      );

      await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
        /birth|provenance|unverified/i
      );
      expect(deps.setConnectedState).not.toHaveBeenCalled();
      expect(await storage.getSession()).toBeNull();
    });

    it("requires explicit selection when discovery returns multiple candidates", async () => {
      const storage = new MemoryStorage();
      const deps = {
        ...makeDeps(
          {
            getContractData: vi
              .fn()
              .mockResolvedValue(instanceWithWasm(ACCEPTED_WASM_HASH)),
          },
          storage
        ),
        lookupWalletCandidates: vi.fn().mockResolvedValue({
          schema: 2,
          complete: true,
          indexedThroughLedger: 100,
          candidates: [
            {
              contractId: DERIVED_CONTRACT_ID,
              birthWasmHash: ACCEPTED_WASM_HASH,
              creationTransactionHash: "12".repeat(32),
              creationLedger: 90,
              currentWasmHash: ACCEPTED_WASM_HASH,
              derivedAddress: true,
              collision: true,
            },
            {
              contractId: "Cothercontract",
              birthWasmHash: ACCEPTED_WASM_HASH,
              creationTransactionHash: "34".repeat(32),
              creationLedger: 91,
              currentWasmHash: ACCEPTED_WASM_HASH,
              derivedAddress: false,
              collision: true,
            },
          ],
        }),
      };

      await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
        /explicit contract selection/i
      );

      expect(deps.setConnectedState).not.toHaveBeenCalled();
    });

    it("REJECTS unaccepted code at a storage-resolved address", async () => {
      const storage = new MemoryStorage();
      await storage.save({
        credentialId: "cred",
        publicKey: new Uint8Array(65).fill(9),
        contractId: "Cstoredcontract",
        isPrimary: false,
      } as never);
      // An upgrade must remain on the explicit current-code allowlist.
      const deps = makeDeps(
        { getContractData: vi.fn().mockResolvedValue(instanceWithWasm("cd".repeat(32))) },
        storage
      );

      await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
        /unaccepted code/i
      );
      expect(deps.setConnectedState).not.toHaveBeenCalled();
    });

    it("uses an explicit address instead of a stored address", async () => {
      const storage = new MemoryStorage();
      await storage.save({
        credentialId: "cred",
        publicKey: new Uint8Array(65).fill(9),
        contractId: "Cstoredcontract",
        createdAt: 1,
      });
      const getContractData = vi
        .fn()
        .mockResolvedValue(instanceWithWasm("cd".repeat(32)));
      const deps = makeDeps({ getContractData }, storage);

      await expect(
        connectWithCredentials(deps, "cred", "Cexplicitcontract")
      ).rejects.toThrow(/unaccepted code/i);

      expect(getContractData).toHaveBeenCalledWith(
        "Cexplicitcontract",
        expect.anything()
      );
    });

    it("connects only after stored birth and the live signer verify", async () => {
      const storage = new MemoryStorage();
      const credentialId = "cred";
      const publicKey = new Uint8Array(65).fill(9);
      publicKey[0] = 0x04;
      const signer = {
        tag: "External" as const,
        values: [
          "CVERIFIER",
          Buffer.concat([
            Buffer.from(publicKey),
            Buffer.from(credentialId, "base64url"),
          ]),
        ] as [string, Buffer],
      };
      await storage.save({
        credentialId,
        publicKey,
        contractId: DERIVED_CONTRACT_ID,
        createdAt: 1,
        isPrimary: true,
        deploymentStatus: "deployed",
        birthWasmHash: ACCEPTED_WASM_HASH,
        creationTransactionHash: "12".repeat(32),
        creationLedger: 123,
        birthConstructorArgsHash: "34".repeat(32),
      });
      const deps = {
        ...makeDeps(
          {
            getContractData: vi
              .fn()
              .mockResolvedValue(instanceWithWasm(ACCEPTED_WASM_HASH)),
          },
          storage
        ),
        readContextRule: vi.fn().mockResolvedValue({ signers: [signer] }),
        verifyBirth: vi.fn().mockResolvedValue({
          ok: true,
          birth: {
            contractId: DERIVED_CONTRACT_ID,
            birthWasmHash: ACCEPTED_WASM_HASH,
            creationTransactionHash: "12".repeat(32),
            creationLedger: 123,
            constructorArgsHash: "34".repeat(32),
            birthSigner: signer,
          },
        }),
      };

      const result = await connectWithCredentials(deps, credentialId);

      expect(result.contractId).toBe(DERIVED_CONTRACT_ID);
      expect(deps.setConnectedState).toHaveBeenCalledWith(
        DERIVED_CONTRACT_ID,
        credentialId
      );
      expect(await storage.getSession()).toMatchObject({
        contractId: DERIVED_CONTRACT_ID,
        credentialId,
      });
    });

    it("REJECTS an unmarked legacy mapping instead of assuming trust", async () => {
      const storage = new MemoryStorage();
      await storage.save({
        credentialId: "cred",
        publicKey: new Uint8Array(65).fill(9),
        contractId: "Cstoredcontract",
        createdAt: 1,
      });
      const deps = makeDeps(
        {
          getContractData: vi
            .fn()
            .mockResolvedValue(instanceWithWasm("cd".repeat(32))),
        },
        storage
      );

      await expect(connectWithCredentials(deps, "cred")).rejects.toThrow(
        /unaccepted code/i
      );

      expect(deps.setConnectedState).not.toHaveBeenCalled();
      expect(await storage.getSession()).toBeNull();
    });
  });

  it("disconnects and emits a walletDisconnected event", async () => {
    const storage = createStorageMock();
    const events = createEventMock();
    const clearConnectedState = vi.fn();
    const getContractId = vi.fn().mockReturnValue("Ccontract");

    await disconnect({
      storage: storage as never,
      events: events as never,
      clearConnectedState,
      getContractId,
    });

    expect(clearConnectedState).toHaveBeenCalledTimes(1);
    expect(storage.clearSession).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith("walletDisconnected", { contractId: "Ccontract" });
  });
});
