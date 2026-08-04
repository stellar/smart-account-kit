import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import {
  connectWallet,
  connectWithCredentials,
  createWallet,
  disconnect,
} from "./wallet-ops";
import { deriveContractAddress, generateChallenge } from "../utils";
import { MemoryStorage } from "../storage/memory";
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
  return {
    signed: {
      toXDR: vi.fn(() => "signed-xdr"),
    },
  };
}

describe("wallet-ops", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("creates a wallet, stores the credential, and saves the session", async () => {
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
    expect(setConnectedState).toHaveBeenCalledWith(
      "CDETERMINISTICCONTRACTADDRESS12345678901234567890123456",
      credentialId
    );
    expect(storage.saveSession).toHaveBeenCalledWith({
      contractId: "CDETERMINISTICCONTRACTADDRESS12345678901234567890123456",
      credentialId,
      connectedAt: 1_000,
      expiresAt: 11_000,
    });
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

    expect(connectWithCredentialsMock).toHaveBeenCalledWith("cred", "contract");
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
    expect(connectWithCredentialsMock).toHaveBeenCalledWith("cred-from-auth");
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

  it("keeps a secondary credential mapping across reconnects", async () => {
    vi.spyOn(Date, "now").mockReturnValue(9_000);

    const storage = new MemoryStorage();
    const events = createEventMock();
    const rpc = {
      getContractData: vi.fn().mockResolvedValue({}),
    };
    const credential = {
      credentialId: "cred",
      publicKey: new Uint8Array(65).fill(9),
      contractId: "Cstoredcontract",
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
      events: events as never,
      setConnectedState,
    };

    await connectWithCredentials(deps, "cred");
    await storage.clearSession();
    const result = await connectWithCredentials(deps, "cred");

    expect(rpc.getContractData).toHaveBeenCalledTimes(2);
    expect(rpc.getContractData).toHaveBeenNthCalledWith(
      2,
      "Cstoredcontract",
      xdr.ScVal.scvLedgerKeyContractInstance()
    );
    expect(await storage.get("cred")).toEqual(credential);
    expect(setConnectedState).toHaveBeenCalledWith("Cstoredcontract", "cred");
    expect(await storage.getSession()).toEqual({
      contractId: "Cstoredcontract",
      credentialId: "cred",
      connectedAt: 9_000,
      expiresAt: 16_000,
    });
    expect(result).toEqual({
      credentialId: "cred",
      contractId: "Cstoredcontract",
      credential,
    });
  });

  it("cleans up a pending credential that maps to its derived contract", async () => {
    const storage = new MemoryStorage();
    const events = createEventMock();
    const credential = {
      credentialId: "cred",
      publicKey: new Uint8Array(65).fill(9),
      contractId: "CDETERMINISTICCONTRACTADDRESS12345678901234567890123456",
      deploymentStatus: "pending",
    } as const;
    await storage.save(credential);

    await connectWithCredentials(
      {
        storage,
        rpc: { getContractData: vi.fn().mockResolvedValue({}) } as never,
        deployerKeypair: Keypair.random(),
        networkPassphrase: "Test SDF Network ; September 2015",
        sessionExpiryMs: 7_000,
        events: events as never,
        setConnectedState: vi.fn(),
      },
      "cred"
    );

    expect(await storage.get("cred")).toBeNull();
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
