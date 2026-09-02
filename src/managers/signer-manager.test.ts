import { describe, expect, it, vi } from "vitest";
import { SignerManager } from "./signer-manager";
import { buildKeyData } from "../utils";
import { makeAccount, makeDelegatedSigner } from "./test-utils";

function makeDeps() {
  const wallet = {
    add_signer: vi.fn(),
    batch_add_signer: vi.fn(),
    get_signer_id: vi.fn(),
    remove_signer: vi.fn(),
  };
  const storage = {
    save: vi.fn(),
    get: vi.fn(),
  };
  const events = {
    emit: vi.fn(),
  };
  const requireWallet = vi.fn(() => ({ wallet, contractId: "CCONTRACT" }));
  const getVerifiedCredential = vi.fn().mockResolvedValue({
    credentialId: "primary",
    publicKey: Buffer.alloc(65, 1),
    contractId: "CCONTRACT",
    createdAt: 1,
    deploymentStatus: "deployed",
    birthWasmHash: "ab".repeat(32),
    creationTransactionHash: "12".repeat(32),
    creationLedger: 123,
    birthConstructorArgsHash: "cd".repeat(32),
  });

  return {
    wallet,
    storage,
    events,
    requireWallet,
    getVerifiedCredential,
  };
}

describe("SignerManager", () => {
  it("adds a passkey signer and stores the credential", async () => {
    const deps = makeDeps();
    const publicKey = Buffer.alloc(65, 9);
    const credentialId = Buffer.from("credential-passkey").toString("base64url");
    deps.wallet.add_signer.mockResolvedValue({ result: 31 });
    const createPasskey = vi.fn().mockResolvedValue({
      rawResponse: { response: { transports: ["internal"] } },
      credentialId,
      publicKey,
    });
    const manager = new SignerManager({
      ...deps,
      createPasskey,
      webauthnVerifierAddress: "CCAAAAA",
    });

    const result = await manager.addPasskey(7, "App", "User", { nickname: "Backup" });

    expect(createPasskey).toHaveBeenCalledWith("App", "User");
    expect(deps.storage.save).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId,
        publicKey,
        contractId: "CCONTRACT",
        nickname: "Backup",
        contextRuleId: 7,
        deploymentStatus: "deployed",
        associationVerified: true,
        birthWasmHash: "ab".repeat(32),
        creationTransactionHash: "12".repeat(32),
        creationLedger: 123,
        birthConstructorArgsHash: "cd".repeat(32),
      })
    );
    expect(deps.events.emit).toHaveBeenCalledWith(
      "credentialCreated",
      expect.objectContaining({
        credential: expect.objectContaining({ credentialId, contractId: "CCONTRACT" }),
      })
    );
    expect(deps.wallet.add_signer).toHaveBeenCalledWith({
      context_rule_id: 7,
      signer: {
        tag: "External",
        values: ["CCAAAAA", buildKeyData(publicKey, credentialId)],
      },
    });
    expect(result).toEqual({
      credentialId,
      publicKey,
      transaction: { result: 31 },
    });
  });

  it("checks wallet birth before creating a secondary passkey", async () => {
    const deps = makeDeps();
    const createPasskey = vi.fn();
    deps.getVerifiedCredential.mockResolvedValue(undefined);
    const manager = new SignerManager({
      ...deps,
      createPasskey,
      webauthnVerifierAddress: "CCAAAAA",
    });

    await expect(manager.addPasskey(7, "App", "User")).rejects.toThrow(
      /wallet birth is verified/i
    );

    expect(createPasskey).not.toHaveBeenCalled();
    expect(deps.storage.save).not.toHaveBeenCalled();
  });

  it("adds a delegated signer", async () => {
    const deps = makeDeps();
    deps.wallet.add_signer.mockResolvedValue({ result: 44 });
    const manager = new SignerManager({
      ...deps,
      createPasskey: vi.fn(),
      webauthnVerifierAddress: "CCAAAAA",
    });
    const publicKey = makeAccount(11);

    const result = await manager.addDelegated(2, publicKey);

    expect(deps.wallet.add_signer).toHaveBeenCalledWith({
      context_rule_id: 2,
      signer: makeDelegatedSigner(11),
    });
    expect(result).toEqual({ result: 44 });
  });

  it("removes a signer by resolving the global signer id", async () => {
    const deps = makeDeps();
    const signer = makeDelegatedSigner(7);
    deps.wallet.get_signer_id.mockResolvedValue({ result: 55 });
    deps.wallet.remove_signer.mockResolvedValue({ result: null });
    const manager = new SignerManager({
      ...deps,
      createPasskey: vi.fn(),
      webauthnVerifierAddress: "CCAAAAA",
    });

    const result = await manager.remove(3, signer);

    expect(deps.wallet.get_signer_id).toHaveBeenCalledWith({ signer });
    expect(deps.wallet.remove_signer).toHaveBeenCalledWith({
      context_rule_id: 3,
      signer_id: 55,
    });
    expect(result).toEqual({ result: null });
  });

  it("adds a batch of signers via batch_add_signer", async () => {
    const deps = makeDeps();
    deps.wallet.batch_add_signer.mockResolvedValue({ result: null });
    const manager = new SignerManager({
      ...deps,
      createPasskey: vi.fn(),
      webauthnVerifierAddress: "CCAAAAA",
    });
    const signers = [makeDelegatedSigner(1), makeDelegatedSigner(2)];

    await manager.addBatch(4, signers);

    expect(deps.wallet.batch_add_signer).toHaveBeenCalledWith({
      context_rule_id: 4,
      signers,
    });
  });

  it("rejects a batch that would exceed MAX_SIGNERS before submitting", async () => {
    const deps = makeDeps();
    const manager = new SignerManager({
      ...deps,
      createPasskey: vi.fn(),
      webauthnVerifierAddress: "CCAAAAA",
    });
    const signers = Array.from({ length: 16 }, (_, i) => makeDelegatedSigner(i));

    await expect(manager.addBatch(4, signers)).rejects.toThrow();
    expect(deps.wallet.batch_add_signer).not.toHaveBeenCalled();
  });

  it("resolves a signer id via idOf", async () => {
    const deps = makeDeps();
    const signer = makeDelegatedSigner(9);
    deps.wallet.get_signer_id.mockResolvedValue({ result: 12 });
    const manager = new SignerManager({
      ...deps,
      createPasskey: vi.fn(),
      webauthnVerifierAddress: "CCAAAAA",
    });

    await expect(manager.idOf(signer)).resolves.toBe(12);
    expect(deps.wallet.get_signer_id).toHaveBeenCalledWith({ signer });
  });

  it("throws SignerNotFoundError from idOf when unregistered", async () => {
    const deps = makeDeps();
    deps.wallet.get_signer_id.mockResolvedValue({ result: null });
    const manager = new SignerManager({
      ...deps,
      createPasskey: vi.fn(),
      webauthnVerifierAddress: "CCAAAAA",
    });

    await expect(manager.idOf(makeDelegatedSigner(1))).rejects.toThrow();
  });
});
