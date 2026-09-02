import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { Client as SmartAccountClient } from "smart-account-kit-bindings";
import {
  buildDeployTransaction,
  confirmSubmittedDeployment,
  isAuthEntryDeployment,
  prepareDeploymentArtifacts,
  submitDeploymentTx,
} from "./deploy-ops";
import { SmartAccountError, SmartAccountErrorCode } from "../errors";
import { buildSignaturePreimage, getAddressCredentials } from "./auth-payload";
import { deriveContractAddress } from "../utils";

function makeDeps() {
  return {
    storage: {
      delete: vi.fn(),
      update: vi.fn(),
    },
    rpc: {
      pollTransaction: vi.fn(),
    },
    relayer: {
      send: vi.fn(),
      sendXdr: vi.fn(),
    },
    deployerKeypair: { publicKey: () => "GDEPLOYER" },
    // Default to a custom deployer so existing tests never trip the shared-
    // deployer fee guard; guard tests override these explicitly.
    usingSharedDeployer: false,
    networkPassphrase: "Test SDF Network ; September 2015",
    confirmDeployment: vi.fn().mockResolvedValue(undefined),
  };
}

function makeAuthEntryDeployment() {
  return {
    kind: "auth-entry" as const,
    func: { toXDR: vi.fn(() => "func-xdr") },
    auth: [{ toXDR: vi.fn(() => "auth-xdr") }],
  };
}

function makeCreateSimulation(
  deployer: string,
  salt: Buffer,
  subInvocations: xdr.SorobanAuthorizedInvocation[] = []
) {
  const operation = Operation.createCustomContract({
    address: Address.fromString(deployer),
    wasmHash: Buffer.alloc(32, 2),
    salt,
    constructorArgs: [],
    auth: [],
  });
  const func = operation.body().invokeHostFunctionOp().hostFunction();
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
        func.createContractV2()
      ),
    subInvocations,
  });
  const discoveredAuth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation,
  });
  return {
    func,
    assembled: {
      built: {
        operations: [{ type: "invokeHostFunction", func }],
      },
      simulation: { latestLedger: 100 },
      simulationData: { result: { auth: [discoveredAuth] } },
    },
  };
}

function makeTx(sendResult?: {
  sendTransactionResponse?: { hash?: string };
  getTransactionResponse?: { status?: string; ledger?: number };
}) {
  return {
    signed: { toXDR: vi.fn(() => "signed-xdr") },
    send: vi.fn().mockResolvedValue(
      sendResult ?? {
        sendTransactionResponse: { hash: "rpc-hash" },
        getTransactionResponse: { status: "SUCCESS", ledger: 456 },
      }
    ),
  };
}

describe("confirmSubmittedDeployment", () => {
  it("rejects a relayer envelope that contains another deployment", async () => {
    const deployer = Keypair.random();
    const expectedOperation = Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: Buffer.alloc(32, 2),
      salt: Buffer.alloc(32, 3),
      constructorArgs: [],
    });
    const actualOperation = Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: Buffer.alloc(32, 2),
      salt: Buffer.alloc(32, 4),
      constructorArgs: [],
    });
    const transaction = new TransactionBuilder(
      new Account(Keypair.random().publicKey(), "0"),
      { fee: "100", networkPassphrase: Networks.TESTNET }
    )
      .addOperation(actualOperation)
      .setTimeout(0)
      .build();
    const expectedFunc = expectedOperation
      .body()
      .invokeHostFunctionOp()
      .hostFunction();
    const deployment = {
      built: {
        operations: [{ type: "invokeHostFunction", func: expectedFunc }],
      },
    };
    const transactionHash = transaction.hash().toString("hex");
    const rpc = {
      getTransaction: vi.fn().mockResolvedValue({
        status: Api.GetTransactionStatus.SUCCESS,
        ledger: 123,
        envelopeXdr: transaction.toEnvelope(),
      }),
    };

    await expect(
      confirmSubmittedDeployment(
        rpc as never,
        Networks.TESTNET,
        deployment as never,
        transactionHash,
        123
      )
    ).rejects.toThrow(/expected wallet deployment/i);
  });
});

describe("submitDeploymentTx", () => {
  it("submits deployments through relayer when relayer succeeds", async () => {
    const deps = makeDeps();
    const tx = makeTx();

    deps.relayer.sendXdr.mockResolvedValue({ success: true, hash: "relayer-hash" });
    deps.rpc.pollTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 123 });

    const result = await submitDeploymentTx(deps as never, tx as never, "cred-1");

    expect(deps.relayer.sendXdr).toHaveBeenCalledWith(tx.signed);
    expect(tx.send).not.toHaveBeenCalled();
    expect(deps.rpc.pollTransaction).toHaveBeenCalledWith("relayer-hash", { attempts: 10 });
    expect(deps.storage.update).toHaveBeenCalledWith("cred-1", {
      deploymentStatus: "deployed",
      deploymentError: undefined,
      deploymentTransactionHash: "relayer-hash",
      creationTransactionHash: "relayer-hash",
      creationLedger: 123,
    });
    expect(result).toEqual({
      success: true,
      hash: "relayer-hash",
      ledger: 123,
    });
  });

  it.each([
    ["FAILED", "failed"],
    ["NOT_FOUND", "pending"],
  ] as const)(
    "does not confirm a relayer deployment with %s status",
    async (status, deploymentStatus) => {
      const deps = makeDeps();
      const tx = makeTx();
      deps.relayer.sendXdr.mockResolvedValue({
        success: true,
        hash: "relayer-hash",
      });
      deps.rpc.pollTransaction.mockResolvedValue({ status });

      const result = await submitDeploymentTx(
        deps as never,
        tx as never,
        "cred-unconfirmed"
      );

      expect(result.success).toBe(false);
      expect(result).toMatchObject({ hash: "relayer-hash" });
      expect(deps.storage.delete).not.toHaveBeenCalled();
      expect(deps.storage.update).toHaveBeenCalledWith("cred-unconfirmed", {
        deploymentStatus,
        deploymentError: expect.stringMatching(/failed|timed out/i),
        deploymentTransactionHash: "relayer-hash",
      });
    }
  );

  it.each([
    ["FAILED", "failed"],
    ["NOT_FOUND", "pending"],
  ] as const)(
    "does not confirm a direct RPC deployment with %s status",
    async (status, deploymentStatus) => {
      const deps = makeDeps();
      deps.relayer = null as never;
      const tx = makeTx({
        sendTransactionResponse: { hash: "rpc-hash" },
        getTransactionResponse: { status },
      });

      const result = await submitDeploymentTx(
        deps as never,
        tx as never,
        "cred-rpc-unconfirmed"
      );

      expect(result.success).toBe(false);
      expect(result).toMatchObject({ hash: "rpc-hash" });
      expect(deps.storage.delete).not.toHaveBeenCalled();
      expect(deps.storage.update).toHaveBeenCalledWith(
        "cred-rpc-unconfirmed",
        {
          deploymentStatus,
          deploymentError: expect.stringMatching(/failed|timed out/i),
          deploymentTransactionHash: "rpc-hash",
        }
      );
    }
  );

  it("does not confirm a custom-relayer deployment without a hash", async () => {
    const deps = makeDeps();
    const tx = makeTx();
    deps.relayer.sendXdr.mockResolvedValue({ success: true });

    const result = await submitDeploymentTx(
      deps as never,
      tx as never,
      "cred-no-relayer-hash"
    );

    expect(result.success).toBe(false);
    expect(deps.rpc.pollTransaction).not.toHaveBeenCalled();
    expect(deps.storage.delete).not.toHaveBeenCalled();
    expect(deps.storage.update).toHaveBeenCalledWith("cred-no-relayer-hash", {
      deploymentStatus: "failed",
      deploymentError: "Relayer submission returned no transaction hash",
    });
  });

  it("does not confirm a direct RPC deployment without a hash", async () => {
    const deps = makeDeps();
    deps.relayer = null as never;
    const tx = makeTx({
      sendTransactionResponse: {},
      getTransactionResponse: { status: "SUCCESS", ledger: 456 },
    });

    const result = await submitDeploymentTx(
      deps as never,
      tx as never,
      "cred-no-rpc-hash"
    );

    expect(result.success).toBe(false);
    expect(deps.storage.delete).not.toHaveBeenCalled();
    expect(deps.storage.update).toHaveBeenCalledWith("cred-no-rpc-hash", {
      deploymentStatus: "failed",
      deploymentError: "Transaction submission returned no hash",
    });
  });

  it("falls back to rpc for deployments when relayer submission fails", async () => {
    const deps = makeDeps();
    const tx = makeTx();

    deps.relayer.sendXdr.mockResolvedValue({
      success: false,
      error: "Transaction fee must be equal to the resource fee",
    });

    const result = await submitDeploymentTx(deps as never, tx as never, "cred-2");

    expect(deps.relayer.sendXdr).toHaveBeenCalledWith(tx.signed);
    expect(tx.send).toHaveBeenCalledTimes(1);
    expect(deps.rpc.pollTransaction).not.toHaveBeenCalled();
    expect(deps.storage.update).toHaveBeenCalledWith("cred-2", {
      deploymentStatus: "deployed",
      deploymentError: undefined,
      deploymentTransactionHash: "rpc-hash",
      creationTransactionHash: "rpc-hash",
      creationLedger: 456,
    });
    expect(result).toEqual({
      success: true,
      hash: "rpc-hash",
      ledger: 456,
    });
  });

  it("does not fall back when relayer is explicitly forced", async () => {
    const deps = makeDeps();
    const tx = makeTx();

    deps.relayer.sendXdr.mockResolvedValue({
      success: false,
      error: "Transaction fee must be equal to the resource fee",
    });

    const result = await submitDeploymentTx(
      deps as never,
      tx as never,
      "cred-3",
      { forceMethod: "relayer" }
    );

    expect(tx.send).not.toHaveBeenCalled();
    expect(deps.storage.delete).not.toHaveBeenCalled();
    expect(deps.storage.update).toHaveBeenCalledWith("cred-3", {
      deploymentStatus: "failed",
      deploymentError: "Transaction fee must be equal to the resource fee",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(SmartAccountError);
      expect(result.error.message).toBe(
        "Transaction fee must be equal to the resource fee"
      );
      expect(result.error.code).toBe(
        SmartAccountErrorCode.CREDENTIAL_DEPLOYMENT_FAILED
      );
    }
  });

  describe("shared default deployer auth-entry route", () => {
    it("refuses RPC or a missing relayer", async () => {
      const deps = makeDeps();
      deps.usingSharedDeployer = true;
      const deployment = makeAuthEntryDeployment();
      const noRelayer = { ...deps, relayer: null };

      await expect(
        submitDeploymentTx(noRelayer as never, deployment as never, "cred-guard")
      ).rejects.toThrow(/sign-only/);

      expect(deps.storage.update).not.toHaveBeenCalled();
      expect(deps.storage.delete).not.toHaveBeenCalled();

      await expect(
        submitDeploymentTx(deps as never, deployment as never, "cred-guard", {
          forceMethod: "rpc",
        })
      ).rejects.toThrow(/sign-only/);
    });

    it("submits only func + signed auth through the relayer", async () => {
      const deps = makeDeps();
      deps.usingSharedDeployer = true;
      const deployment = makeAuthEntryDeployment();
      deps.relayer.send.mockResolvedValue({ success: true, hash: "relayer-hash" });
      deps.rpc.pollTransaction.mockResolvedValue({ status: "SUCCESS", ledger: 123 });

      const result = await submitDeploymentTx(
        deps as never,
        deployment as never,
        "cred-relayer"
      );

      expect(deps.relayer.send).toHaveBeenCalledWith("func-xdr", ["auth-xdr"]);
      expect(deps.relayer.sendXdr).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, hash: "relayer-hash", ledger: 123 });
    });

    it("does not confirm a shared deployment after polling times out", async () => {
      const deps = makeDeps();
      deps.usingSharedDeployer = true;
      const deployment = makeAuthEntryDeployment();
      deps.relayer.send.mockResolvedValue({
        success: true,
        hash: "relayer-hash",
      });
      deps.rpc.pollTransaction.mockResolvedValue({ status: "NOT_FOUND" });

      const result = await submitDeploymentTx(
        deps as never,
        deployment as never,
        "cred-timeout"
      );

      expect(result.success).toBe(false);
      expect(result).toMatchObject({ hash: "relayer-hash" });
      expect(deps.storage.delete).not.toHaveBeenCalled();
      expect(deps.storage.update).toHaveBeenCalledWith("cred-timeout", {
        deploymentStatus: "pending",
        deploymentError: "Transaction confirmation timed out",
        deploymentTransactionHash: "relayer-hash",
      });
    });

    it("does not confirm a shared deployment without a hash", async () => {
      const deps = makeDeps();
      deps.usingSharedDeployer = true;
      const deployment = makeAuthEntryDeployment();
      deps.relayer.send.mockResolvedValue({ success: true });

      const result = await submitDeploymentTx(
        deps as never,
        deployment as never,
        "cred-no-shared-hash"
      );

      expect(result.success).toBe(false);
      expect(deps.rpc.pollTransaction).not.toHaveBeenCalled();
      expect(deps.storage.delete).not.toHaveBeenCalled();
      expect(deps.storage.update).toHaveBeenCalledWith("cred-no-shared-hash", {
        deploymentStatus: "failed",
        deploymentError: "Relayer submission returned no transaction hash",
      });
    });

    it("does not fall back to an envelope submission when the relayer fails", async () => {
      const deps = makeDeps();
      deps.usingSharedDeployer = true;
      const deployment = makeAuthEntryDeployment();

      deps.relayer.send.mockResolvedValue({ success: false, error: "relayer 503" });

      const result = await submitDeploymentTx(
        deps as never,
        deployment as never,
        "cred-fallback"
      );

      expect(deps.relayer.sendXdr).not.toHaveBeenCalled();
      expect(deps.storage.update).toHaveBeenCalledWith("cred-fallback", {
        deploymentStatus: "failed",
        deploymentError: "relayer 503",
      });
      expect(result.success).toBe(false);
    });

    it("still falls back to RPC on relayer failure for a NON-shared deployer", async () => {
      const deps = makeDeps(); // usingSharedDeployer: false
      const tx = makeTx();
      deps.relayer.sendXdr.mockResolvedValue({ success: false, error: "relayer 503" });

      const result = await submitDeploymentTx(deps as never, tx as never, "cred-ok-fallback");

      expect(tx.send).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

  });
});

it("serializes shared deploy auth without requesting an envelope signature", async () => {
  const signWithDeployer = vi.fn();
  await expect(
    prepareDeploymentArtifacts(makeAuthEntryDeployment() as never, signWithDeployer)
  ).resolves.toEqual({
    relayerPayload: { func: "func-xdr", auth: ["auth-xdr"] },
  });
  expect(signWithDeployer).not.toHaveBeenCalled();
});

describe("buildDeployTransaction", () => {
  afterEach(() => vi.restoreAllMocks());

  const networkPassphrase = "Test SDF Network ; September 2015";
  const verifier = StrKey.encodeContract(Buffer.alloc(32, 9));
  const credentialId = Buffer.from("credential-id");
  const publicKey = new Uint8Array(65).fill(7);

  it("BUILDS a shared deploy without a relayer (submit is what's guarded)", async () => {
    // Producing the {func, auth} payload only signs an auth entry — it spends
    // nothing and the signature confers no privilege (the key is public). An
    // integrator running their own submission infrastructure must be able to
    // build here and source/pay from a funded account of their choosing.
    const deployerKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
    const salt = hash(credentialId);
    const { assembled } = makeCreateSimulation(deployerKeypair.publicKey(), salt);
    vi.spyOn(SmartAccountClient, "deploy").mockResolvedValue(assembled as never);

    const result = await buildDeployTransaction(
      {
        accountWasmHash: "11".repeat(32),
        webauthnVerifierAddress: verifier,
        networkPassphrase,
        rpcUrl: "https://rpc.example",
        deployerKeypair,
        usingSharedDeployer: true,
        timeoutInSeconds: 30,
      },
      credentialId,
      publicKey
    );

    expect(isAuthEntryDeployment(result)).toBe(true);
  });

  it("builds and signs an auth-entry deploy for the shared deployer without sourcing from it", async () => {
    const deployerKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
    const salt = hash(credentialId);
    const { assembled } = makeCreateSimulation(deployerKeypair.publicKey(), salt);
    const deploy = vi
      .spyOn(SmartAccountClient, "deploy")
      .mockResolvedValue(assembled as never);

    const result = await buildDeployTransaction(
      {
        accountWasmHash: "11".repeat(32),
        webauthnVerifierAddress: verifier,
        networkPassphrase,
        rpcUrl: "https://rpc.example",
        deployerKeypair,
        usingSharedDeployer: true,
        timeoutInSeconds: 30,
      },
      credentialId,
      publicKey
    );

    expect(isAuthEntryDeployment(result)).toBe(true);
    if (!isAuthEntryDeployment(result)) throw new Error("expected auth-entry deploy");

    const [constructorArgs, options] = deploy.mock.calls[0];
    expect(constructorArgs.signers[0].values[0]).toBe(verifier);
    expect(Buffer.from(constructorArgs.signers[0].values[1] as Uint8Array)).toEqual(
      Buffer.concat([Buffer.from(publicKey), credentialId])
    );
    expect(constructorArgs.policies).toEqual(new Map());
    expect(options.address).toBe(deployerKeypair.publicKey());
    expect(options.publicKey).toBeUndefined();
    expect(Buffer.from(options.salt ?? [])).toEqual(salt);

    const fromAddress = result.func
      .createContractV2()
      .contractIdPreimage()
      .fromAddress();
    expect(Address.fromScAddress(fromAddress.address()).toString()).toBe(
      deployerKeypair.publicKey()
    );
    expect(Buffer.from(fromAddress.salt())).toEqual(salt);
    const contractIdPreimage = result.func.createContractV2().contractIdPreimage();
    const contractId = StrKey.encodeContract(
      hash(
        xdr.HashIdPreimage.envelopeTypeContractId(
          new xdr.HashIdPreimageContractId({
            networkId: hash(Buffer.from(networkPassphrase)),
            contractIdPreimage,
          })
        ).toXDR()
      )
    );
    expect(contractId).toBe(
      deriveContractAddress(credentialId, deployerKeypair.publicKey(), networkPassphrase)
    );

    const entry = result.auth[0];
    expect(entry.credentials().switch().name).toBe("sorobanCredentialsAddress");
    const credentials = getAddressCredentials(entry.credentials());
    expect(Address.fromScAddress(credentials.address()).toString()).toBe(
      deployerKeypair.publicKey()
    );
    const signature = Buffer.from(
      credentials.signature().vec()?.[0].map()?.[1].val().bytes() ?? []
    );
    expect(
      deployerKeypair.verify(
        hash(
          buildSignaturePreimage(
            networkPassphrase,
            entry,
            credentials.signatureExpirationLedger()
          ).toXDR()
        ),
        signature
      )
    ).toBe(true);
  });

  it("refuses to sign a deploy auth entry carrying sub-invocations", async () => {
    const deployerKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
    const salt = hash(credentialId);
    // A hostile simulation RPC returns the correct create-contract root with an
    // extra child hanging off it. The deployer signs the whole tree, so the
    // child would be authorized under its address credentials too.
    const child = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(verifier).toScAddress(),
          functionName: "transfer",
          args: [],
        })
      ),
      subInvocations: [],
    });
    const { assembled } = makeCreateSimulation(deployerKeypair.publicKey(), salt, [child]);
    vi.spyOn(SmartAccountClient, "deploy").mockResolvedValue(assembled as never);

    await expect(
      buildDeployTransaction(
        {
          accountWasmHash: "11".repeat(32),
          webauthnVerifierAddress: verifier,
          networkPassphrase,
          rpcUrl: "https://rpc.example",
          deployerKeypair,
          usingSharedDeployer: true,
          timeoutInSeconds: 30,
        },
        credentialId,
        publicKey
      )
    ).rejects.toThrow(/wrong deployer/);
  });

  it("keeps a custom deployer on the existing self-source route", async () => {
    const deployerKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4));
    const assembled = { signed: undefined };
    const deploy = vi
      .spyOn(SmartAccountClient, "deploy")
      .mockResolvedValue(assembled as never);

    const result = await buildDeployTransaction(
      {
        accountWasmHash: "22".repeat(32),
        webauthnVerifierAddress: verifier,
        networkPassphrase,
        rpcUrl: "https://rpc.example",
        deployerKeypair,
        usingSharedDeployer: false,
        timeoutInSeconds: 30,
      },
      credentialId,
      publicKey
    );

    expect(result).toBe(assembled);
    const [, options] = deploy.mock.calls[0];
    expect(options.publicKey).toBe(deployerKeypair.publicKey());
    expect(options.address).toBeUndefined();
  });
});
