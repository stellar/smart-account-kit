import base64url from "base64url";
import { describe, expect, it, vi } from "vitest";
import type { StoredCredential } from "../types";
import { MemoryStorage } from "../storage/memory";
import { CredentialManager } from "./credential-manager";

function makeStorage(initial: StoredCredential[] = []) {
  const map = new Map(initial.map((credential) => [credential.credentialId, credential]));

  return {
    getAll: vi.fn(async () => Array.from(map.values())),
    getByContract: vi.fn(async (contractId: string) =>
      Array.from(map.values()).filter((credential) => credential.contractId === contractId)
    ),
    get: vi.fn(async (credentialId: string) => map.get(credentialId) ?? null),
    save: vi.fn(async (credential: StoredCredential) => {
      map.set(credential.credentialId, credential);
    }),
    update: vi.fn(async (credentialId: string, patch: Partial<StoredCredential>) => {
      const current = map.get(credentialId);
      if (!current) {
        throw new Error(`Credential ${credentialId} not found`);
      }
      map.set(credentialId, { ...current, ...patch });
    }),
    delete: vi.fn(async (credentialId: string) => {
      map.delete(credentialId);
    }),
  };
}

function makeDeps(initial: StoredCredential[] = []) {
  const storage = makeStorage(initial);
  const rpc = {
    getContractData: vi.fn(),
  } as any;
  const events = {
    emit: vi.fn(),
  };
  const setConnectedState = vi.fn();
  const initializeWallet = vi.fn();
  const createPasskey = vi.fn();
  const buildDeployTransaction = vi.fn();
  const signWithDeployer = vi.fn();
  const submitDeploymentTx = vi.fn();
  const deriveContractAddress = vi.fn();
  const getContractId = vi.fn().mockReturnValue(undefined);
  const describeDeploymentBirth = vi.fn(() => ({
    birthWasmHash: "ab".repeat(32),
    birthConstructorArgsHash: "cd".repeat(32),
  }));

  return {
    storage,
    rpc,
    events,
    setConnectedState,
    initializeWallet,
    createPasskey,
    buildDeployTransaction,
    signWithDeployer,
    submitDeploymentTx,
    deriveContractAddress,
    getContractId,
    describeDeploymentBirth,
  };
}

describe("CredentialManager", () => {
  it("returns stored credentials and wallet-scoped credentials", async () => {
    const credentials: StoredCredential[] = [
      {
        credentialId: "cred-1",
        publicKey: Buffer.alloc(65, 1),
        contractId: "CCONTRACT-1",
        createdAt: 1,
      },
      {
        credentialId: "cred-2",
        publicKey: Buffer.alloc(65, 2),
        contractId: "CCONTRACT-2",
        createdAt: 2,
      },
    ];
    const deps = makeDeps(credentials);
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue("CCONTRACT-2"),
      rpName: "App",
    });

    await expect(manager.getAll()).resolves.toEqual(credentials);
    await expect(manager.getForWallet()).resolves.toEqual([credentials[1]]);

    expect(deps.storage.getByContract).toHaveBeenCalledWith("CCONTRACT-2");
  });

  it("returns no wallet credentials when disconnected and filters pending credentials", async () => {
    const deps = makeDeps([
      {
        credentialId: "cred-1",
        publicKey: Buffer.alloc(65, 1),
        contractId: "",
        createdAt: 1,
        deploymentStatus: "pending",
      },
      {
        credentialId: "cred-2",
        publicKey: Buffer.alloc(65, 2),
        contractId: "",
        createdAt: 2,
        deploymentStatus: "failed",
      },
      {
        credentialId: "cred-3",
        publicKey: Buffer.alloc(65, 3),
        contractId: "",
        createdAt: 3,
        deploymentStatus: "occupied",
      },
      {
        credentialId: "cred-4",
        publicKey: Buffer.alloc(65, 4),
        contractId: "CDEPLOYED",
        createdAt: 4,
        deploymentStatus: "deployed",
      },
    ]);
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    await expect(manager.getForWallet()).resolves.toEqual([]);
    await expect(manager.getPending()).resolves.toHaveLength(3);
  });

  it("creates and saves a new passkey credential", async () => {
    const deps = makeDeps();
    const credentialId = base64url.encode("credential-create");
    const publicKey = Buffer.alloc(65, 9);
    deps.createPasskey.mockResolvedValue({
      rawResponse: { response: { transports: ["internal"] } },
      credentialId,
      publicKey,
    });
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "Smart Account Kit",
    });

    const credential = await manager.create({
      nickname: "Recovery",
      appName: "Demo",
    });

    expect(deps.createPasskey).toHaveBeenCalledWith("Demo", "Recovery");
    expect(deps.storage.save).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId,
        publicKey,
        contractId: "",
        nickname: "Recovery",
        isPrimary: true,
        deploymentStatus: "pending",
      })
    );
    expect(deps.events.emit).toHaveBeenCalledWith(
      "credentialCreated",
      expect.objectContaining({
        credential: expect.objectContaining({ credentialId, nickname: "Recovery" }),
      })
    );
    expect(credential).toEqual(
      expect.objectContaining({
        credentialId,
        publicKey,
        contractId: "",
        nickname: "Recovery",
        isPrimary: true,
        deploymentStatus: "pending",
      })
    );
  });

  it("saves imported credentials", async () => {
    const deps = makeDeps();
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    const saved = await manager.save({
      credentialId: "cred-import",
      publicKey: Buffer.alloc(65, 4),
      nickname: "Imported",
      contractId: "CCONTRACT",
    });

    expect(deps.storage.save).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: "cred-import",
        contractId: "CCONTRACT",
        nickname: "Imported",
        deploymentStatus: "pending",
      })
    );
    expect(saved).toEqual(
      expect.objectContaining({
        credentialId: "cred-import",
        contractId: "CCONTRACT",
        nickname: "Imported",
        deploymentStatus: "pending",
      })
    );
    expect(saved.isPrimary).toBeUndefined();
  });

  it("stores trusted secondary provenance only when supplied explicitly", async () => {
    const deps = makeDeps();
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    const saved = await manager.save({
      credentialId: "cred-secondary",
      publicKey: Buffer.alloc(65, 4),
      contractId: "CCONTRACT",
      isPrimary: false,
    });

    expect(saved.isPrimary).toBe(false);
    expect(deps.storage.save).toHaveBeenCalledWith(
      expect.objectContaining({ isPrimary: false })
    );
  });

  it("deploys a wallet and optionally auto-submits it", async () => {
    const credentialId = base64url.encode("credential-deploy");
    const credential = {
      credentialId,
      publicKey: Buffer.alloc(65, 5),
      contractId: "",
      createdAt: 1,
      deploymentStatus: "pending" as const,
    };
    const deps = makeDeps([credential]);
    const signed = { toXDR: vi.fn().mockReturnValue("signed-xdr") };
    const deployTx = { signed } as any;

    deps.deriveContractAddress.mockReturnValue("CCONTRACT");
    deps.buildDeployTransaction.mockResolvedValue(deployTx);
    deps.signWithDeployer.mockResolvedValue(undefined);
    deps.submitDeploymentTx.mockResolvedValue({ success: true, hash: "tx-1" });
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    const result = await manager.deploy(credentialId, {
      autoSubmit: true,
      forceMethod: "rpc",
    });

    expect(deps.buildDeployTransaction).toHaveBeenCalled();
    expect(deps.signWithDeployer).toHaveBeenCalledWith(deployTx);
    expect(deps.setConnectedState).toHaveBeenCalledWith("CCONTRACT", credentialId);
    expect(deps.initializeWallet).toHaveBeenCalledWith("CCONTRACT");
    expect(deps.submitDeploymentTx).toHaveBeenCalledWith(
      deployTx,
      credentialId,
      { forceMethod: "rpc" }
    );
    expect(result).toEqual({
      contractId: "CCONTRACT",
      signedTransaction: "signed-xdr",
      submitResult: { success: true, hash: "tx-1" },
    });
  });

  it("does not connect when deployment is manual or fails", async () => {
    const credentialId = base64url.encode("credential-not-deployed");
    const credential = {
      credentialId,
      publicKey: Buffer.alloc(65, 5),
      contractId: "",
      createdAt: 1,
      deploymentStatus: "pending" as const,
    };
    const deps = makeDeps([credential]);
    const deployTx = {
      signed: { toXDR: vi.fn().mockReturnValue("signed-xdr") },
    } as any;
    deps.deriveContractAddress.mockReturnValue("CCONTRACT");
    deps.buildDeployTransaction.mockResolvedValue(deployTx);
    deps.signWithDeployer.mockResolvedValue(undefined);
    deps.submitDeploymentTx.mockResolvedValue({
      success: false,
      error: new Error("deployment failed"),
    });
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    await manager.deploy(credentialId);
    await manager.deploy(credentialId, { autoSubmit: true });

    expect(deps.setConnectedState).not.toHaveBeenCalled();
    expect(deps.initializeWallet).not.toHaveBeenCalled();
    expect(deps.events.emit).not.toHaveBeenCalledWith(
      "walletConnected",
      expect.anything()
    );
  });

  it("threads deploy() policies through to buildDeployTransaction", async () => {
    const credentialId = base64url.encode("credential-policies");
    const credential = {
      credentialId,
      publicKey: Buffer.alloc(65, 7),
      contractId: "",
      createdAt: 1,
      deploymentStatus: "pending" as const,
    };
    const deps = makeDeps([credential]);
    const deployTx = { signed: { toXDR: vi.fn().mockReturnValue("signed-xdr") } } as any;
    deps.deriveContractAddress.mockReturnValue("CCONTRACT");
    deps.buildDeployTransaction.mockResolvedValue(deployTx);
    deps.signWithDeployer.mockResolvedValue(undefined);
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    const policies = [{ address: "CPOLICY", type: "threshold" as const, installParams: { threshold: 2 } }];
    await manager.deploy(credentialId, { policies });

    // Regression: deploy() must honor its policies option (previously dropped by
    // the dependency wiring, silently deploying with no constructor policies).
    expect(deps.buildDeployTransaction).toHaveBeenCalledWith(
      expect.any(Buffer),
      credential.publicKey,
      policies
    );
  });

  it("syncs deployed credentials and leaves pending ones alone", async () => {
    const deployed = {
      credentialId: "cred-1",
      publicKey: Buffer.alloc(65, 1),
      contractId: "CCONTRACT",
      createdAt: 1,
      deploymentStatus: "deployed" as const,
      birthWasmHash: "ab".repeat(32),
      creationTransactionHash: "12".repeat(32),
      creationLedger: 123,
      birthConstructorArgsHash: "cd".repeat(32),
    };
    const pending = {
      credentialId: "cred-2",
      publicKey: Buffer.alloc(65, 2),
      contractId: "COTHER",
      createdAt: 2,
    };
    const deps = makeDeps([deployed, pending]);
    deps.deriveContractAddress.mockReturnValue("CCONTRACT");
    deps.rpc.getContractData.mockImplementation(async (_contractId: string) => {
      if (_contractId === "CCONTRACT") {
        return {};
      }
      throw new Error("missing");
    });
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    await expect(manager.sync("cred-1")).resolves.toBe(true);
    await expect(manager.sync("cred-2")).resolves.toBe(false);

    expect(deps.storage.delete).not.toHaveBeenCalled();
  });

  it("keeps a secondary credential during syncAll", async () => {
    const credential = {
      credentialId: base64url.encode("secondary-credential"),
      publicKey: Buffer.alloc(65, 1),
      contractId: "CPARENT",
      createdAt: 1,
      isPrimary: false,
    };
    const storage = new MemoryStorage();
    await storage.save(credential);
    const deps = makeDeps();
    deps.deriveContractAddress.mockReturnValue("CDERIVED");
    deps.rpc.getContractData.mockResolvedValue({});
    const manager = new CredentialManager({
      ...deps,
      storage,
      rpName: "App",
    });

    await manager.syncAll();
    await expect(storage.get(credential.credentialId)).resolves.toEqual({
      ...credential,
      deploymentStatus: "occupied",
      deploymentError:
        "The derived address is occupied, but wallet birth is unverified.",
    });
  });

  it("marks an empty-contract pending credential occupied at its derived address", async () => {
    const credential = {
      credentialId: base64url.encode("pending-credential"),
      publicKey: Buffer.alloc(65, 2),
      contractId: "",
      createdAt: 2,
      deploymentStatus: "pending" as const,
    };
    const storage = new MemoryStorage();
    await storage.save(credential);
    const deps = makeDeps();
    deps.deriveContractAddress.mockReturnValue("CDERIVED");
    deps.rpc.getContractData.mockImplementation(async (contractId: string) => {
      if (contractId === "CDERIVED") return {};
      throw new Error("missing");
    });
    const manager = new CredentialManager({
      ...deps,
      storage,
      rpName: "App",
    });

    await expect(manager.syncAll()).resolves.toEqual({
      deployed: 0,
      pending: 1,
      failed: 0,
    });
    expect(deps.rpc.getContractData).toHaveBeenCalledWith(
      "CDERIVED",
      expect.anything()
    );
    await expect(storage.get(credential.credentialId)).resolves.toMatchObject({
      deploymentStatus: "occupied",
    });
  });

  it("counts deployed, pending, and failed credentials in syncAll", async () => {
    const deps = makeDeps([
      {
        credentialId: "cred-1",
        publicKey: Buffer.alloc(65, 1),
        contractId: "CCONTRACT",
        createdAt: 1,
        deploymentStatus: "deployed",
        birthWasmHash: "ab".repeat(32),
        creationTransactionHash: "12".repeat(32),
        creationLedger: 123,
        birthConstructorArgsHash: "cd".repeat(32),
      },
      {
        credentialId: "cred-2",
        publicKey: Buffer.alloc(65, 2),
        contractId: "COTHER",
        createdAt: 2,
        deploymentStatus: "failed",
      },
      {
        credentialId: "cred-3",
        publicKey: Buffer.alloc(65, 3),
        contractId: "CUNKNOWN",
        createdAt: 3,
      },
    ]);
    deps.rpc.getContractData.mockImplementation(async (contractId: string) => {
      if (contractId === "CCONTRACT") {
        return {};
      }
      throw new Error("missing");
    });
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    await expect(manager.syncAll()).resolves.toEqual({
      deployed: 1,
      pending: 1,
      failed: 1,
    });
  });

  it("deletes a deployed credential only after confirming it is not on-chain", async () => {
    const deps = makeDeps([
      {
        credentialId: "cred-1",
        publicKey: Buffer.alloc(65, 1),
        contractId: "CCONTRACT",
        createdAt: 1,
        deploymentStatus: "deployed",
        birthWasmHash: "ab".repeat(32),
        creationTransactionHash: "12".repeat(32),
        creationLedger: 123,
        birthConstructorArgsHash: "cd".repeat(32),
      },
    ]);
    deps.rpc.getContractData.mockRejectedValue(new Error("missing"));
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    await manager.delete("cred-1");

    expect(deps.storage.delete).toHaveBeenCalledWith("cred-1");
  });

  it("refuses to delete deployed credentials", async () => {
    const deps = makeDeps([
      {
        credentialId: "cred-1",
        publicKey: Buffer.alloc(65, 1),
        contractId: "CCONTRACT",
        createdAt: 1,
        deploymentStatus: "deployed",
        birthWasmHash: "ab".repeat(32),
        creationTransactionHash: "12".repeat(32),
        creationLedger: 123,
        birthConstructorArgsHash: "cd".repeat(32),
      },
    ]);
    deps.rpc.getContractData.mockResolvedValue({});
    const manager = new CredentialManager({
      ...deps,
      getContractId: vi.fn().mockReturnValue(undefined),
      rpName: "App",
    });

    await expect(manager.delete("cred-1")).rejects.toThrow(
      "Cannot delete a deployed credential. The wallet exists on-chain."
    );
  });
});
