import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  hash,
  Keypair,
  nativeToScVal,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import {
  PluginExecutionError,
  PluginTransportError,
} from "@openzeppelin/relayer-plugin-channels";
import worker, {
  extractMissingAccount,
  getClientIP,
  RequestRateLimiter,
  SHARED_DEPLOYER,
} from "./index";

const { submitSorobanTransaction, submitTransaction } = vi.hoisted(() => ({
  submitSorobanTransaction: vi.fn(),
  submitTransaction: vi.fn(),
}));

vi.mock("@openzeppelin/relayer-plugin-channels", () => {
  class PluginExecutionError extends Error {
    errorDetails?: { code?: unknown; details?: unknown };
    constructor(message: string, errorDetails?: { code?: unknown; details?: unknown }) {
      super(message);
      this.errorDetails = errorDetails;
    }
  }
  class PluginTransportError extends Error {
    constructor(
      message: string,
      readonly statusCode?: number
    ) {
      super(message);
    }
  }
  class ChannelsClient {
    submitSorobanTransaction = submitSorobanTransaction;
    submitTransaction = submitTransaction;
  }
  return { ChannelsClient, PluginExecutionError, PluginTransportError };
});

const CLIENT_IP = "203.0.113.7";
const API_KEY = "unit-test-api-value";
const KV_KEY = `api-key:${CLIENT_IP}`;
const DEPLOYER_KEYPAIR = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(3));
const DEPLOYER = DEPLOYER_KEYPAIR.publicKey();
const OTHER_DEPLOYER = Keypair.fromRawEd25519Seed(
  new Uint8Array(32).fill(7)
).publicKey();
const WALLET = Address.contract(new Uint8Array(32).fill(1)).toString();
const OTHER_WALLET = Address.contract(new Uint8Array(32).fill(2)).toString();
const TOKEN = Address.contract(new Uint8Array(32).fill(5)).toString();
const WASM_HASH = "84".repeat(32);
const MISSING_CHANNEL = `G${"A".repeat(55)}`;

function createKV(initial: Record<string, string> = {}, onGet?: () => void) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => {
      onGet?.();
      return store.get(key) ?? null;
    }),
    put: vi.fn(async (key: string, value: string) => void store.set(key, value)),
    delete: vi.fn(async (key: string) => void store.delete(key)),
  };
}

type FakeKV = ReturnType<typeof createKV>;

function seededKV(onGet?: () => void) {
  return createKV(
    { [KV_KEY]: JSON.stringify({ apiKey: API_KEY, createdAt: 1000 }) },
    onGet
  );
}

function makeRateLimitDO(
  decisions: Record<string, { allowed: boolean; retryAfterSeconds: number }> = {}
) {
  const names: string[] = [];
  return {
    names,
    idFromName: vi.fn((name: string) => {
      names.push(name);
      return name;
    }),
    get: vi.fn((name: string) => ({
      fetch: vi.fn(async () =>
        Response.json(
          decisions[name] ?? { allowed: true, retryAfterSeconds: 0 }
        )
      ),
    })),
  };
}

function makeEnv(
  opts: {
    kv?: FakeKV;
    network?: "testnet" | "mainnet";
    origins?: string;
    allowedDeployers?: string;
    allowedHashes?: string;
    allowedWallets?: string;
    allowedWalletFunctions?: string;
    maxFee?: string;
    rateLimitDO?: ReturnType<typeof makeRateLimitDO>;
  } = {}
) {
  const network = opts.network ?? "testnet";
  return {
    API_KEYS: opts.kv ?? seededKV(),
    RATE_LIMIT_DO: opts.rateLimitDO ?? makeRateLimitDO(),
    NETWORK: network,
    RELAYER_BASE_URL:
      network === "testnet"
        ? "https://channels.openzeppelin.com/testnet"
        : "https://channels.openzeppelin.com",
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    ALLOWED_ORIGINS: opts.origins ?? "https://demo.example",
    ALLOWED_DEPLOYER_ADDRESSES: opts.allowedDeployers ?? DEPLOYER,
    ALLOWED_ACCOUNT_WASM_HASHES: opts.allowedHashes ?? WASM_HASH,
    ALLOWED_WALLET_CONTRACT_IDS: opts.allowedWallets ?? WALLET,
    ALLOWED_WALLET_FUNCTIONS:
      opts.allowedWalletFunctions ??
      "execute,upgrade,add_policy,remove_policy,add_signer,remove_signer,add_context_rule,remove_context_rule,batch_add_signer,update_context_rule_name,update_context_rule_valid_until",
    MAX_RESOURCE_FEE_STROOPS: opts.maxFee ?? "1000000",
    RATE_LIMIT_WINDOW_SECONDS: "60",
    RATE_LIMIT_PER_IP: "10",
    RATE_LIMIT_GLOBAL: "100",
  } as any;
}

function makeRequest(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    ip?: string | null;
    origin?: string;
  } = {}
) {
  const headers: Record<string, string> = {};
  if (opts.ip !== null) headers["CF-Connecting-IP"] = opts.ip ?? CLIENT_IP;
  if (opts.origin) headers.Origin = opts.origin;
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body =
      typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  return new Request(`http://localhost${path}`, init);
}

const ctx = () =>
  ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as any;

function contractInvocation() {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(WALLET).toScAddress(),
      functionName: "transfer",
      args: [],
    })
  );
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

const DEPLOY_CREDENTIAL_ID = Buffer.from("relayer-test-credential");

function deployConstructorArgs(extraSigner = false): xdr.ScVal[] {
  const publicKey = Buffer.alloc(65, 7);
  publicKey[0] = 0x04;
  const signer = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(WALLET).toScVal(),
    xdr.ScVal.scvBytes(
      Buffer.concat([publicKey, DEPLOY_CREDENTIAL_ID])
    ),
  ]);
  return [
    xdr.ScVal.scvVec(extraSigner ? [signer, signer] : [signer]),
    xdr.ScVal.scvMap([]),
  ];
}

function deploySubmission(
  opts: {
    deployer?: string;
    wasmHash?: string;
    authDeployer?: string;
    authWasmHash?: string;
    v2Credentials?: boolean;
    extraAuth?: boolean;
    subInvocation?: boolean;
    assetPreimage?: boolean;
    sacExecutable?: boolean;
    invalidConstructor?: boolean;
    extraSigner?: boolean;
  } = {}
) {
  const deployer = opts.deployer ?? DEPLOYER;
  const makeFunc = (wasmHash: string) =>
    Operation.createCustomContract({
      address: Address.fromString(deployer),
      wasmHash: hexBytes(wasmHash),
      salt: opts.invalidConstructor
        ? new Uint8Array(32).fill(4)
        : hash(DEPLOY_CREDENTIAL_ID),
      constructorArgs: opts.invalidConstructor
        ? [xdr.ScVal.scvVoid()]
        : deployConstructorArgs(opts.extraSigner),
    })
      .body()
      .invokeHostFunctionOp()
      .hostFunction();
  const func = opts.assetPreimage || opts.sacExecutable
    ? xdr.HostFunction.hostFunctionTypeCreateContractV2(
        new xdr.CreateContractArgsV2({
          contractIdPreimage: opts.assetPreimage
            ? xdr.ContractIdPreimage.contractIdPreimageFromAsset(
                xdr.Asset.assetTypeNative()
              )
            : makeFunc(WASM_HASH).createContractV2().contractIdPreimage(),
          executable: opts.sacExecutable
            ? xdr.ContractExecutable.contractExecutableStellarAsset()
            : xdr.ContractExecutable.contractExecutableWasm(
                hexBytes(opts.wasmHash ?? WASM_HASH)
              ),
          constructorArgs: [],
        })
      )
    : makeFunc(opts.wasmHash ?? WASM_HASH);
  const authorizedFunc = makeFunc(opts.authWasmHash ?? opts.wasmHash ?? WASM_HASH);
  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(opts.authDeployer ?? deployer).toScAddress(),
    nonce: xdr.Int64.fromString("1"),
    signatureExpirationLedger: 100,
    signature: xdr.ScVal.scvVoid(),
  });
  const credentials = opts.v2Credentials
    ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
    : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials);
  const subInvocations = opts.subInvocation
    ? [
        new xdr.SorobanAuthorizedInvocation({
          function:
            xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              contractInvocation().invokeContract()
            ),
          subInvocations: [],
        }),
      ]
    : [];
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(
          authorizedFunc.createContractV2()
        ),
      subInvocations,
    }),
  }).toXDR("base64");
  return {
    func: func.toXDR("base64"),
    auth: opts.extraAuth ? [auth, auth] : [auth],
  };
}

function walletSubmission(
  opts: {
    contract?: string;
    functionName?: string;
    credential?: string;
    v1Credentials?: boolean;
    rootContract?: string;
    rootFunctionName?: string;
    subInvocationContract?: string;
    args?: xdr.ScVal[];
  } = {}
) {
  const contract = opts.contract ?? WALLET;
  const functionName = opts.functionName ?? "execute";
  const invoke = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contract).toScAddress(),
    functionName,
    args: opts.args ?? [xdr.ScVal.scvVoid()],
  });
  const root = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(opts.rootContract ?? contract).toScAddress(),
    functionName: opts.rootFunctionName ?? functionName,
    args: opts.args ?? [xdr.ScVal.scvVoid()],
  });
  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(opts.credential ?? contract).toScAddress(),
    nonce: xdr.Int64.fromString("1"),
    signatureExpirationLedger: 100,
    signature: xdr.ScVal.scvVoid(),
  });
  const credentials = opts.v1Credentials
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials)
    : xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials);
  const subInvocations = opts.subInvocationContract
    ? [
        new xdr.SorobanAuthorizedInvocation({
          function:
            xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              new xdr.InvokeContractArgs({
                contractAddress: Address.fromString(
                  opts.subInvocationContract
                ).toScAddress(),
                functionName,
                args: [],
              })
            ),
          subInvocations: [],
        }),
      ]
    : [];
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials,
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(root),
      subInvocations,
    }),
  });
  return {
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(invoke).toXDR("base64"),
    auth: [auth.toXDR("base64")],
  };
}

function transferSubmission(
  opts: { token?: string; wallet?: string; v1Credentials?: boolean } = {}
) {
  const wallet = opts.wallet ?? WALLET;
  return walletSubmission({
    contract: opts.token ?? TOKEN,
    functionName: "transfer",
    credential: wallet,
    v1Credentials: opts.v1Credentials,
    args: [
      xdr.ScVal.scvAddress(Address.fromString(wallet).toScAddress()),
      xdr.ScVal.scvAddress(Address.fromString(DEPLOYER).toScAddress()),
      nativeToScVal(1_000_000n, { type: "i128" }),
    ],
  });
}

function unsupportedSubmission() {
  return {
    ...walletSubmission(),
    func: xdr.HostFunction.hostFunctionTypeUploadContractWasm(
      hexBytes(WASM_HASH)
    ).toXDR("base64"),
  };
}

function deployXdr(
  keypair = DEPLOYER_KEYPAIR,
  resourceFee = 5_000n,
  wasmHash = WASM_HASH,
  sign = true
) {
  const transaction = new TransactionBuilder(new Account(keypair.publicKey(), "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.createCustomContract({
        address: Address.fromString(keypair.publicKey()),
        wasmHash: hexBytes(wasmHash),
        salt: hash(DEPLOY_CREDENTIAL_ID),
        constructorArgs: deployConstructorArgs(),
      })
    )
    .setSorobanData(
      new SorobanDataBuilder().setResourceFee(resourceFee).build()
    )
    .setTimeout(30)
    .build();
  if (sign) transaction.sign(keypair);
  return transaction.toXDR();
}

function nonDeployXdr() {
  const transaction = new TransactionBuilder(new Account(DEPLOYER, "0"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();
  transaction.sign(DEPLOYER_KEYPAIR);
  return transaction.toXDR();
}

function stubFetch(handlers: { gen?: () => Response; friendbot?: () => Response }) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/gen")) return handlers.gen?.() ?? Response.json({});
    if (url.includes("friendbot")) {
      return handlers.friendbot?.() ?? new Response("ok");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function post(body: unknown, env = makeEnv()) {
  return worker.fetch(makeRequest("/", { method: "POST", body }), env, ctx());
}

beforeEach(() => {
  vi.spyOn(RpcServer.prototype, "simulateTransaction").mockResolvedValue({
    transactionData: {},
    minResourceFee: "5000",
  } as any);
  submitSorobanTransaction.mockResolvedValue({
    transactionId: "tx1",
    hash: "hash1",
    status: "confirmed",
  });
  submitTransaction.mockResolvedValue({
    transactionId: "tx-xdr",
    hash: "hash-xdr",
    status: "confirmed",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("request boundary", () => {
  it("trusts only Cloudflare's client-IP header", () => {
    expect(
      getClientIP(
        new Request("http://x", { headers: { "CF-Connecting-IP": "1.1.1.1" } })
      )
    ).toBe("1.1.1.1");
    expect(
      getClientIP(
        new Request("http://x", { headers: { "X-Forwarded-For": "2.2.2.2" } })
      )
    ).toBe("unknown");
  });

  it("echoes an allowed CORS origin without a wildcard", async () => {
    const res = await worker.fetch(
      makeRequest("/", { origin: "https://demo.example" }),
      makeEnv(),
      ctx()
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://demo.example"
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("rejects a disallowed preflight origin", async () => {
    const res = await worker.fetch(
      makeRequest("/", { method: "OPTIONS", origin: "https://evil.example" }),
      makeEnv(),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects missing Cloudflare IP", async () => {
    const res = await worker.fetch(
      makeRequest("/", { method: "POST", body: deploySubmission(), ip: null }),
      makeEnv(),
      ctx()
    );
    expect(res.status).toBe(400);
  });
});

describe("sign-only deployment validation", () => {
  async function expectRejected(
    body: unknown,
    error: string,
    status = 403,
    envOptions: Parameters<typeof makeEnv>[0] = {}
  ) {
    const kv = seededKV();
    const res = await post(body, makeEnv({ ...envOptions, kv }));
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({ success: false, error });
    expect(kv.get).not.toHaveBeenCalled();
    expect(submitSorobanTransaction).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
  }

  it("accepts exactly one matching V1 createContractV2 auth entry", async () => {
    const body = deploySubmission();
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(submitSorobanTransaction).toHaveBeenCalledWith(body);
  });

  it("accepts the configured shared deployer without making it a fee source", async () => {
    const body = deploySubmission({ deployer: SHARED_DEPLOYER });
    const res = await post(
      body,
      makeEnv({ allowedDeployers: SHARED_DEPLOYER })
    );
    expect(res.status).toBe(200);
    expect(submitSorobanTransaction).toHaveBeenCalledWith(body);
  });

  it("rejects malformed XDR and multiple deploy auth entries before API-key access", async () => {
    await expectRejected("{bad json", "Invalid JSON body", 400);
    await expectRejected(
      { func: "bad", auth: ["bad"] },
      "func/auth contains invalid XDR",
      400
    );
    await expectRejected(
      { xdr: "AAAA" },
      "xdr must be a signed transaction envelope",
      400
    );
    await expectRejected(
      deploySubmission({ extraAuth: true }),
      "Deploy must contain exactly one auth entry"
    );
  });

  it("rejects unsupported host functions", async () => {
    await expectRejected(
      unsupportedSubmission(),
      "Only invokeContract and createContractV2 host functions are allowed"
    );
  });

  it("rejects deployers outside the allowlist", async () => {
    await expectRejected(
      deploySubmission({ deployer: OTHER_DEPLOYER }),
      "Deploy preimage address is not allowlisted"
    );
  });

  it("rejects non-allowlisted WASM", async () => {
    await expectRejected(
      deploySubmission({ wasmHash: "99".repeat(32) }),
      "Deploy WASM hash is not allowlisted"
    );
  });

  it("requires a WASM executable and from-address preimage", async () => {
    await expectRejected(
      deploySubmission({ sacExecutable: true }),
      "Deploy executable must be approved WASM"
    );
    await expectRejected(
      deploySubmission({ assetPreimage: true }),
      "Deploy must use an address contract-id preimage"
    );
  });

  it("requires the SDK constructor shape and one initial signer", async () => {
    await expectRejected(
      deploySubmission({ invalidConstructor: true }),
      "Deploy constructor has an invalid argument shape"
    );
    await expectRejected(
      deploySubmission({ extraSigner: true }),
      "Deploy must contain exactly one initial signer"
    );
  });

  it("requires legacy V1 credentials", async () => {
    await expectRejected(
      deploySubmission({ v2Credentials: true }),
      "Deploy requires legacy V1 address credentials"
    );
  });

  it("requires the credential address to match the deployer", async () => {
    await expectRejected(
      deploySubmission({ authDeployer: OTHER_DEPLOYER }),
      "Deploy auth does not exactly match func and deployer"
    );
  });

  it("requires byte-equal auth and forbids sub-invocations", async () => {
    await expectRejected(
      deploySubmission({ authWasmHash: "99".repeat(32) }),
      "Deploy auth does not exactly match func and deployer"
    );
    await expectRejected(
      deploySubmission({ subInvocation: true }),
      "Deploy auth does not exactly match func and deployer"
    );
  });

  it("enforces the simulated resource-fee ceiling before API-key access", async () => {
    vi.mocked(RpcServer.prototype.simulateTransaction).mockResolvedValueOnce({
      transactionData: {},
      minResourceFee: "1001",
    } as any);
    await expectRejected(
      deploySubmission(),
      "Resource fee exceeds configured maximum",
      413,
      { maxFee: "1000" }
    );
  });

  it("accesses the API key only after simulation succeeds", async () => {
    const order: string[] = [];
    vi.mocked(RpcServer.prototype.simulateTransaction).mockImplementationOnce(
      async () => {
        order.push("validated");
        return { transactionData: {}, minResourceFee: "5000" } as any;
      }
    );
    const kv = seededKV(() => order.push("key"));
    const res = await post(deploySubmission(), makeEnv({ kv }));
    expect(res.status).toBe(200);
    expect(order).toEqual(["validated", "key"]);
  });
});

describe("wallet invocation validation", () => {
  async function expectRejected(
    body: unknown,
    error: string,
    envOptions: Parameters<typeof makeEnv>[0] = {},
    status = 403
  ) {
    const kv = seededKV();
    const res = await post(body, makeEnv({ ...envOptions, kv }));
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toEqual({ success: false, error });
    expect(kv.get).not.toHaveBeenCalled();
    expect(submitSorobanTransaction).not.toHaveBeenCalled();
  }

  it("accepts an allowlisted wallet invocation", async () => {
    const body = walletSubmission();
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(submitSorobanTransaction).toHaveBeenCalledWith(body);
  });

  it("accepts the SDK's direct wallet-authorized token transfer", async () => {
    const body = transferSubmission();
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(submitSorobanTransaction).toHaveBeenCalledWith(body);
  });

  it("rejects a non-allowlisted wallet contract", async () => {
    await expectRejected(
      walletSubmission({ contract: OTHER_WALLET, credential: OTHER_WALLET }),
      "Wallet contract is not allowlisted",
      { allowedHashes: "" }
    );
  });

  it("rejects a non-allowlisted wallet function", async () => {
    await expectRejected(
      walletSubmission({ functionName: "unsupported" }),
      "Wallet function is not allowlisted"
    );
  });

  it("rejects V1 credentials for wallet invocations", async () => {
    await expectRejected(
      walletSubmission({ v1Credentials: true }),
      "Only address-bound V2 wallet credentials are allowed"
    );
  });

  it("requires recursive wallet-only auth and root byte-equality", async () => {
    await expectRejected(
      walletSubmission({ subInvocationContract: OTHER_WALLET }),
      "Auth entry targets a non-allowlisted contract"
    );
    await expectRejected(
      walletSubmission({ rootFunctionName: "upgrade" }),
      "Auth root invocation does not match func"
    );
  });

  it("accepts a transfer of ANY token when the wallet authorizes it", async () => {
    // Wallet authorization and fee controls apply without a token allowlist.
    const body = transferSubmission({ token: OTHER_WALLET });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(submitSorobanTransaction).toHaveBeenCalledWith(body);
  });

  it("applies the simulated fee ceiling to wallet invocations", async () => {
    vi.mocked(RpcServer.prototype.simulateTransaction).mockResolvedValueOnce({
      transactionData: {},
      minResourceFee: "1001",
    } as any);
    await expectRejected(
      walletSubmission(),
      "Resource fee exceeds configured maximum",
      { maxFee: "1000" },
      413
    );
  });
});

describe("signed xdr validation", () => {
  it("accepts a source-signed dedicated-deployer deployment", async () => {
    const xdrValue = deployXdr();
    const res = await post(
      { xdr: xdrValue },
      makeEnv({ allowedDeployers: SHARED_DEPLOYER })
    );
    expect(res.status).toBe(200);
    expect(submitTransaction).toHaveBeenCalledWith({ xdr: xdrValue });
    expect(submitSorobanTransaction).not.toHaveBeenCalled();
  });

  it("rejects the shared deployer as an xdr transaction source", async () => {
    const sharedKeypair = Keypair.fromRawEd25519Seed(
      hash(new TextEncoder().encode("openzeppelin-smart-account-kit"))
    );
    const kv = seededKV();
    const res = await post(
      { xdr: deployXdr(sharedKeypair) },
      makeEnv({ allowedDeployers: SHARED_DEPLOYER, kv })
    );
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      success: false,
      error: "Shared deployer may not source signed xdr",
    });
    expect(kv.get).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
  });

  it("rejects unsigned and non-deployment xdr", async () => {
    const unsigned = await post({
      xdr: deployXdr(DEPLOYER_KEYPAIR, 5_000n, WASM_HASH, false),
    });
    expect(unsigned.status).toBe(403);
    await expect(unsigned.json()).resolves.toMatchObject({
      error: "Deploy transaction lacks a valid source signature",
    });

    const nonDeploy = await post({ xdr: nonDeployXdr() });
    expect(nonDeploy.status).toBe(403);
    await expect(nonDeploy.json()).resolves.toMatchObject({
      error: "Only invokeHostFunction deploy operations are allowed",
    });
  });

  it("enforces the embedded xdr resource-fee ceiling", async () => {
    const kv = seededKV();
    const res = await post(
      { xdr: deployXdr(DEPLOYER_KEYPAIR, 1001n) },
      makeEnv({ maxFee: "1000", kv })
    );
    expect(res.status).toBe(413);
    expect(kv.get).not.toHaveBeenCalled();
    expect(submitTransaction).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("checks both global and per-IP limits", async () => {
    const rateLimitDO = makeRateLimitDO({
      global: { allowed: false, retryAfterSeconds: 30 },
    });
    const kv = seededKV();
    const res = await post(deploySubmission(), makeEnv({ rateLimitDO, kv }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(rateLimitDO.names).toEqual(["global", `ip:${CLIENT_IP}`]);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it("atomically rejects requests above a fixed-window limit", async () => {
    const store = new Map<string, unknown>();
    const state = {
      storage: {
        get: vi.fn(async (key: string) => store.get(key)),
        put: vi.fn(async (key: string, value: unknown) => void store.set(key, value)),
      },
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    } as any;
    const limiter = new RequestRateLimiter(state);
    const request = new Request("https://rate/check?limit=1&windowMs=60000");
    await expect(limiter.fetch(request).then((res) => res.json())).resolves.toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    await expect(limiter.fetch(request).then((res) => res.json())).resolves.toMatchObject({
      allowed: false,
    });
  });
});

describe("Friendbot retry", () => {
  it("funds a missing channel account and retries", async () => {
    const fetchMock = stubFetch({ friendbot: () => new Response("funded") });
    submitSorobanTransaction
      .mockRejectedValueOnce(new Error(`Account not found: ${MISSING_CHANNEL}`))
      .mockResolvedValueOnce({ transactionId: "tx2", hash: "hash2", status: "ok" });
    const res = await post(deploySubmission());
    expect(res.status).toBe(200);
    expect(submitSorobanTransaction).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("friendbot"))
    ).toBe(true);
  });

  it("derives and never funds the shared deterministic deployer", async () => {
    expect(SHARED_DEPLOYER).toBe(
      Keypair.fromRawEd25519Seed(
        hash(new TextEncoder().encode("openzeppelin-smart-account-kit"))
      ).publicKey()
    );
    expect(SHARED_DEPLOYER).toBe(
      "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N"
    );
    const fetchMock = stubFetch({});
    submitSorobanTransaction.mockRejectedValueOnce(
      new Error(`Account not found: ${SHARED_DEPLOYER}`)
    );
    const res = await post(deploySubmission());
    expect(res.status).toBe(500);
    expect(submitSorobanTransaction).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("friendbot"))
    ).toBe(false);
  });
});

describe("existing proxy behavior", () => {
  it("mints a key only for a validated request", async () => {
    const kv = createKV();
    const fetchMock = stubFetch({
      gen: () => Response.json({ apiKey: "unit-test-generated-value" }),
    });
    const res = await post(deploySubmission(), makeEnv({ kv }));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/gen"))).toBe(
      true
    );
    expect(JSON.parse(kv.store.get(KV_KEY)!).apiKey).toBe(
      "unit-test-generated-value"
    );
  });

  it("maps plugin errors", async () => {
    submitSorobanTransaction.mockRejectedValueOnce(
      new PluginExecutionError("bad deploy", { code: "E1", details: "nope" })
    );
    const execution = await post(deploySubmission());
    expect(execution.status).toBe(400);

    submitSorobanTransaction.mockRejectedValueOnce(
      new PluginTransportError("upstream", 502)
    );
    const transport = await post(deploySubmission());
    expect(transport.status).toBe(502);
  });

  it("reports health and stored-key status", async () => {
    const health = await worker.fetch(makeRequest("/"), makeEnv(), ctx());
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      service: "smart-account-relayer-proxy",
      network: "testnet",
    });
    const status = await worker.fetch(makeRequest("/status"), makeEnv(), ctx());
    await expect(status.json()).resolves.toMatchObject({
      success: true,
      data: { clientIP: CLIENT_IP, hasKey: true, keyCreatedAt: 1000 },
    });
  });

  it("extracts missing account errors", () => {
    expect(extractMissingAccount(`Account not found: ${MISSING_CHANNEL}`)).toBe(
      MISSING_CHANNEL
    );
    expect(extractMissingAccount("other")).toBeNull();
  });
});
