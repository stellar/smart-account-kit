/** Fail-closed Cloudflare proxy for Smart Account Kit relayer submissions. */

import { Hono } from "hono";
import {
  ChannelsClient,
  PluginExecutionError,
  PluginTransportError,
} from "@openzeppelin/relayer-plugin-channels";
import {
  Account,
  Address,
  Contract,
  hash,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { Api as RpcApi, Server as RpcServer } from "@stellar/stellar-sdk/rpc";
import {
  API_KEY_FIELD_NAMES,
  API_KEY_MAX_LENGTH,
  API_KEY_MIN_LENGTH,
  API_KEY_PREFIX,
  DEFAULT_MAX_RESOURCE_FEE_STROOPS,
  DEFAULT_RATE_LIMIT_GLOBAL,
  DEFAULT_RATE_LIMIT_PER_IP,
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  DEFAULT_WALLET_FUNCTIONS,
  FRIENDBOT_URL,
  IP_HEADERS,
  MISSING_ACCOUNT_PATTERN,
  SERVICE_NAME,
  SIMULATION_SOURCE,
  TESTNET_RETRY_DURATION_MS,
  UNKNOWN_IP,
} from "./constants";

interface StoredApiKey {
  apiKey: string;
  createdAt: number;
}

interface ApiKeyReadResult {
  storedKey: StoredApiKey;
  needsMigration: boolean;
}

interface RateState {
  windowStartedAt: number;
  count: number;
}

interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

type SubmissionBody =
  | { mode: "xdr"; xdr: string }
  | { mode: "func"; func: string; auth: string[] };

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
  }
}

const GLOBAL_RATE_LIMITER = "global";
const MAX_AUTH_ENTRIES = 8;
const RATE_KEY = "rate";
const DEPLOYER_SEED = "openzeppelin-smart-account-kit";

/** Derived from the SDK's public deterministic seed; never a fee source. */
export const SHARED_DEPLOYER = Keypair.fromRawEd25519Seed(
  hash(new TextEncoder().encode(DEPLOYER_SEED))
).publicKey();

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && !csvSet(c.env.ALLOWED_ORIGINS).has(origin)) {
    return c.json({ success: false, error: "Origin is not allowed" }, 403);
  }
  if (c.req.method === "OPTIONS") {
    const response = new Response(null, { status: 204 });
    if (origin) setCorsHeaders(response.headers, origin);
    return response;
  }
  await next();
  if (origin) setCorsHeaders(c.res.headers, origin);
});

app.onError((error, c) => {
  console.error("Unhandled worker error:", error);
  return c.json({ success: false, error: "Internal server error" }, 500);
});

function setCorsHeaders(headers: Headers, origin: string): void {
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.append("Vary", "Origin");
}

function csvSet(value: string | undefined, lowercase = false): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (lowercase ? item.toLowerCase() : item))
  );
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RequestError(`${name} must be a positive integer`, 500);
  }
  return parsed;
}

function maxResourceFee(env: Env): bigint {
  try {
    const value =
      env.MAX_RESOURCE_FEE_STROOPS === undefined
        ? DEFAULT_MAX_RESOURCE_FEE_STROOPS
        : BigInt(env.MAX_RESOURCE_FEE_STROOPS);
    if (value < 0n) throw new Error("negative");
    return value;
  } catch {
    throw new RequestError(
      "MAX_RESOURCE_FEE_STROOPS must be a non-negative integer",
      500
    );
  }
}

function networkPassphrase(env: Env): string {
  if (env.NETWORK === "testnet") return Networks.TESTNET;
  if (env.NETWORK === "mainnet") return Networks.PUBLIC;
  throw new RequestError("NETWORK must be testnet or mainnet", 500);
}

function allowedWasmHashes(env: Env): Set<string> {
  const hashes = csvSet(env.ALLOWED_ACCOUNT_WASM_HASHES, true);
  for (const value of hashes) {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new RequestError(
        "ALLOWED_ACCOUNT_WASM_HASHES contains an invalid hash",
        500
      );
    }
  }
  return hashes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, i) => byte === right[i]);
}

export function getClientIP(request: Request): string {
  return request.headers.get(IP_HEADERS.CF_CONNECTING_IP)?.trim() || UNKNOWN_IP;
}

function getKVKey(ip: string): string {
  return `${API_KEY_PREFIX}${ip}`;
}

function isValidApiKey(apiKey: string): boolean {
  const length = apiKey.trim().length;
  return length >= API_KEY_MIN_LENGTH && length <= API_KEY_MAX_LENGTH;
}

function isStoredApiKey(value: unknown): value is StoredApiKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredApiKey>;
  return (
    typeof candidate.apiKey === "string" &&
    typeof candidate.createdAt === "number" &&
    isValidApiKey(candidate.apiKey)
  );
}

async function readStoredApiKey(
  env: Env,
  kvKey: string
): Promise<ApiKeyReadResult | null> {
  try {
    const raw = await env.API_KEYS.get(kvKey);
    if (!raw) return null;
    const trimmed = raw.trim();
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isStoredApiKey(parsed)) {
        return { storedKey: parsed, needsMigration: false };
      }
      if (typeof parsed === "string" && isValidApiKey(parsed)) {
        return {
          storedKey: { apiKey: parsed.trim(), createdAt: Date.now() },
          needsMigration: true,
        };
      }
    } catch {
      if (isValidApiKey(trimmed)) {
        return {
          storedKey: { apiKey: trimmed, createdAt: Date.now() },
          needsMigration: true,
        };
      }
    }
    await env.API_KEYS.delete(kvKey);
    return null;
  } catch (error) {
    console.error(`Failed reading API key from KV for ${kvKey}:`, error);
    return null;
  }
}

async function generateApiKey(env: Env): Promise<string | null> {
  try {
    const response = await fetch(`${env.RELAYER_BASE_URL}/gen`);
    const text = await response.text();
    if (!response.ok) return null;
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      const apiKey = API_KEY_FIELD_NAMES.map((name) => data[name]).find(Boolean);
      return typeof apiKey === "string" && isValidApiKey(apiKey)
        ? apiKey.trim()
        : null;
    } catch {
      return isValidApiKey(text) ? text.trim() : null;
    }
  } catch (error) {
    console.error("Error generating API key:", error);
    return null;
  }
}

async function getOrCreateApiKey(
  env: Env,
  ip: string
): Promise<StoredApiKey | null> {
  const kvKey = getKVKey(ip);
  const cached = await readStoredApiKey(env, kvKey);
  if (cached) {
    if (cached.needsMigration) {
      await env.API_KEYS.put(kvKey, JSON.stringify(cached.storedKey));
    }
    return cached.storedKey;
  }
  const apiKey = await generateApiKey(env);
  if (!apiKey) return null;
  const storedKey = { apiKey, createdAt: Date.now() };
  await env.API_KEYS.put(kvKey, JSON.stringify(storedKey));
  return storedKey;
}

/** Atomic fixed-window limiter, addressed once globally and once per IP. */
export class RequestRateLimiter implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit"));
    const windowMs = Number(url.searchParams.get("windowMs"));
    if (
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs <= 0
    ) {
      return Response.json({ error: "Invalid rate-limit configuration" }, { status: 500 });
    }

    const decision = await this.state.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const stored = await this.state.storage.get<RateState>(RATE_KEY);
      const current =
        !stored || now - stored.windowStartedAt >= windowMs
          ? { windowStartedAt: now, count: 0 }
          : stored;
      if (current.count >= limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((current.windowStartedAt + windowMs - now) / 1000)
          ),
        } satisfies RateDecision;
      }
      current.count += 1;
      await this.state.storage.put(RATE_KEY, current);
      return { allowed: true, retryAfterSeconds: 0 } satisfies RateDecision;
    });
    return Response.json(decision);
  }
}

async function rateDecision(
  env: Env,
  name: string,
  limit: number,
  windowMs: number
): Promise<RateDecision> {
  const stub = env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(name));
  const url = new URL("https://rate-limiter/check");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("windowMs", String(windowMs));
  const response = await stub.fetch(url);
  if (!response.ok) throw new RequestError("Rate limiter is unavailable", 503);
  return response.json<RateDecision>();
}

async function enforceRateLimit(env: Env, ip: string): Promise<number | null> {
  const windowMs =
    positiveInteger(
      env.RATE_LIMIT_WINDOW_SECONDS,
      DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
      "RATE_LIMIT_WINDOW_SECONDS"
    ) * 1000;
  const [globalDecision, ipDecision] = await Promise.all([
    rateDecision(
      env,
      GLOBAL_RATE_LIMITER,
      positiveInteger(
        env.RATE_LIMIT_GLOBAL,
        DEFAULT_RATE_LIMIT_GLOBAL,
        "RATE_LIMIT_GLOBAL"
      ),
      windowMs
    ),
    rateDecision(
      env,
      `ip:${ip}`,
      positiveInteger(
        env.RATE_LIMIT_PER_IP,
        DEFAULT_RATE_LIMIT_PER_IP,
        "RATE_LIMIT_PER_IP"
      ),
      windowMs
    ),
  ]);
  if (globalDecision.allowed && ipDecision.allowed) return null;
  return Math.max(
    globalDecision.retryAfterSeconds,
    ipDecision.retryAfterSeconds
  );
}

function parseSubmissionBody(text: string): SubmissionBody {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError("Invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("Request body must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body);
  const hasXdr = typeof body.xdr === "string" && body.xdr.length > 0;
  const hasFuncAuth =
    typeof body.func === "string" &&
    body.func.length > 0 &&
    Array.isArray(body.auth) &&
    body.auth.length > 0 &&
    body.auth.every((entry) => typeof entry === "string" && entry.length > 0);
  if (!hasXdr && !hasFuncAuth) {
    throw new RequestError(
      "Request must include 'xdr' OR ('func' and 'auth')"
    );
  }
  if (hasXdr && hasFuncAuth) {
    throw new RequestError(
      "Request must include 'xdr' OR ('func' and 'auth'), not both"
    );
  }
  if (hasXdr) {
    if (keys.some((key) => key !== "xdr")) {
      throw new RequestError("The xdr mode accepts only the 'xdr' field");
    }
    return { mode: "xdr", xdr: body.xdr as string };
  }
  if (keys.some((key) => key !== "func" && key !== "auth")) {
    throw new RequestError("The func mode accepts only 'func' and 'auth'");
  }
  if ((body.auth as string[]).length > MAX_AUTH_ENTRIES) {
    throw new RequestError(`At most ${MAX_AUTH_ENTRIES} auth entries are allowed`);
  }
  return {
    mode: "func",
    func: body.func as string,
    auth: body.auth as string[],
  };
}

async function walletContractIsAllowed(
  env: Env,
  contractId: string
): Promise<boolean> {
  if (csvSet(env.ALLOWED_WALLET_CONTRACT_IDS).has(contractId)) return true;
  const hashes = allowedWasmHashes(env);
  if (hashes.size === 0) return false;
  if (!env.STELLAR_RPC_URL) {
    throw new RequestError("STELLAR_RPC_URL is required for wallet verification", 500);
  }
  try {
    const response = await new RpcServer(env.STELLAR_RPC_URL).getLedgerEntries(
      new Contract(contractId).getFootprint()
    );
    const entry = response.entries[0];
    if (!entry) return false;
    const executable = entry.val.contractData().val().instance().executable();
    return (
      executable.switch().name === "contractExecutableWasm" &&
      hashes.has(toHex(executable.wasmHash()))
    );
  } catch (error) {
    console.error("Wallet allowlist RPC verification failed:", error);
    throw new RequestError("Could not verify wallet contract", 503);
  }
}

function validateAuthorizedInvocation(
  invocation: xdr.SorobanAuthorizedInvocation,
  contractId: string
): void {
  const fn = invocation.function();
  if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new RequestError(
      "Auth entries may authorize only wallet contract calls",
      403
    );
  }
  const invokedContract = Address.fromScAddress(
    fn.contractFn().contractAddress()
  ).toString();
  if (invokedContract !== contractId) {
    throw new RequestError("Auth entry targets a non-allowlisted contract", 403);
  }
  for (const child of invocation.subInvocations()) {
    validateAuthorizedInvocation(child, contractId);
  }
}

function validateDeployFunction(
  env: Env,
  func: xdr.HostFunction,
  requireAllowedDeployer = true
): string {
  if (func.switch().name !== "hostFunctionTypeCreateContractV2") {
    throw new RequestError("Only createContractV2 deployments are allowed", 403);
  }
  const deploy = func.createContractV2();
  const executable = deploy.executable();
  if (executable.switch().name !== "contractExecutableWasm") {
    throw new RequestError("Deploy executable must be approved WASM", 403);
  }
  if (!allowedWasmHashes(env).has(toHex(executable.wasmHash()))) {
    throw new RequestError("Deploy WASM hash is not allowlisted", 403);
  }
  const preimage = deploy.contractIdPreimage();
  if (preimage.switch().name !== "contractIdPreimageFromAddress") {
    throw new RequestError("Deploy must use an address contract-id preimage", 403);
  }
  const deployer = Address.fromScAddress(
    preimage.fromAddress().address()
  ).toString();
  if (
    requireAllowedDeployer &&
    !csvSet(env.ALLOWED_DEPLOYER_ADDRESSES).has(deployer)
  ) {
    throw new RequestError("Deploy preimage address is not allowlisted", 403);
  }
  return deployer;
}

async function validateWalletInvocation(
  env: Env,
  invoke: xdr.InvokeContractArgs,
  auth: xdr.SorobanAuthorizationEntry[]
): Promise<void> {
  const contractId = Address.fromScAddress(invoke.contractAddress()).toString();
  if (!(await walletContractIsAllowed(env, contractId))) {
    throw new RequestError("Wallet contract is not allowlisted", 403);
  }
  const functions = csvSet(
    env.ALLOWED_WALLET_FUNCTIONS ?? DEFAULT_WALLET_FUNCTIONS.join(",")
  );
  if (!functions.has(invoke.functionName().toString())) {
    throw new RequestError("Wallet function is not allowlisted", 403);
  }
  for (const entry of auth) {
    const credentials = entry.credentials();
    if (credentials.switch().name !== "sorobanCredentialsAddressV2") {
      throw new RequestError(
        "Only address-bound V2 wallet credentials are allowed",
        403
      );
    }
    const signer = Address.fromScAddress(
      credentials.addressV2().address()
    ).toString();
    if (signer !== contractId) {
      throw new RequestError("Auth credential is not for the invoked wallet", 403);
    }
    validateAuthorizedInvocation(entry.rootInvocation(), contractId);
    if (
      !bytesEqual(
        entry.rootInvocation().function().contractFn().toXDR(),
        invoke.toXDR()
      )
    ) {
      throw new RequestError("Auth root invocation does not match func", 403);
    }
  }
}

async function validateDirectTokenTransfer(
  env: Env,
  invoke: xdr.InvokeContractArgs,
  auth: xdr.SorobanAuthorizationEntry[]
): Promise<void> {
  // Deliberately NOT allowlisting the token contract. The abuse control here is
  // the AUTHORIZER, not the asset: the transfer must be authorized by a genuine
  // smart account (verified on-chain WASM below) spending its own balance, and
  // fee-drain is bounded by the fee cap + rate limits. Allowlisting tokens would
  // not stop an attacker (they can spam an allowlisted token from their own
  // wallet just as easily) while breaking legitimate transfers of any other
  // asset — a wallet must be able to move arbitrary tokens.
  const args = invoke.args();
  if (args.length !== 3 || args[0].switch().name !== "scvAddress") {
    throw new RequestError("Token transfer has an invalid argument shape", 403);
  }
  const from = Address.fromScAddress(args[0].address()).toString();
  for (const entry of auth) {
    const credentials = entry.credentials();
    if (credentials.switch().name !== "sorobanCredentialsAddressV2") {
      throw new RequestError(
        "Only address-bound V2 wallet credentials are allowed",
        403
      );
    }
    const wallet = Address.fromScAddress(
      credentials.addressV2().address()
    ).toString();
    const root = entry.rootInvocation();
    const rootFn = root.function();
    if (
      wallet !== from ||
      !(await walletContractIsAllowed(env, wallet)) ||
      root.subInvocations().length !== 0 ||
      rootFn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn" ||
      !bytesEqual(rootFn.contractFn().toXDR(), invoke.toXDR())
    ) {
      throw new RequestError(
        "Transfer auth does not exactly match func and wallet",
        403
      );
    }
  }
}

async function validateFuncSubmission(
  env: Env,
  body: Extract<SubmissionBody, { mode: "func" }>
): Promise<void> {
  let func: xdr.HostFunction;
  let auth: xdr.SorobanAuthorizationEntry[];
  try {
    func = xdr.HostFunction.fromXDR(body.func, "base64");
    auth = body.auth.map((entry) =>
      xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64")
    );
  } catch {
    throw new RequestError("func/auth contains invalid XDR");
  }

  if (func.switch().name === "hostFunctionTypeCreateContractV2") {
    if (auth.length !== 1) {
      throw new RequestError("Deploy must contain exactly one auth entry", 403);
    }
    const deployer = validateDeployFunction(env, func);
    const entry = auth[0];
    const credentials = entry.credentials();
    if (credentials.switch().name !== "sorobanCredentialsAddress") {
      throw new RequestError("Deploy requires legacy V1 address credentials", 403);
    }
    const signer = Address.fromScAddress(credentials.address().address()).toString();
    const root = entry.rootInvocation();
    const rootFunction = root.function();
    if (
      signer !== deployer ||
      root.subInvocations().length !== 0 ||
      rootFunction.switch().name !==
        "sorobanAuthorizedFunctionTypeCreateContractV2HostFn" ||
      !bytesEqual(
        rootFunction.createContractV2HostFn().toXDR(),
        func.createContractV2().toXDR()
      )
    ) {
      throw new RequestError(
        "Deploy auth does not exactly match func and deployer",
        403
      );
    }
  } else if (func.switch().name === "hostFunctionTypeInvokeContract") {
    const invoke = func.invokeContract();
    if (invoke.functionName().toString() === "transfer") {
      await validateDirectTokenTransfer(env, invoke, auth);
    } else {
      await validateWalletInvocation(env, invoke, auth);
    }
  } else {
    throw new RequestError(
      "Only invokeContract and createContractV2 host functions are allowed",
      403
    );
  }

  if (!env.STELLAR_RPC_URL) {
    throw new RequestError("STELLAR_RPC_URL is required for fee validation", 500);
  }
  const simulationTx = new TransactionBuilder(new Account(SIMULATION_SOURCE, "0"), {
    fee: "100",
    networkPassphrase: networkPassphrase(env),
  })
    .addOperation(Operation.invokeHostFunction({ func, auth }))
    .setTimeout(30)
    .build();
  const simulation = await new RpcServer(env.STELLAR_RPC_URL).simulateTransaction(
    simulationTx
  );
  if (
    !RpcApi.isSimulationSuccess(simulation) ||
    RpcApi.isSimulationRestore(simulation)
  ) {
    throw new RequestError("Submission simulation failed");
  }
  if (BigInt(simulation.minResourceFee) > maxResourceFee(env)) {
    throw new RequestError("Resource fee exceeds configured maximum", 413);
  }
}

function validateSourceSignature(transaction: Transaction): void {
  let source: Keypair;
  try {
    source = Keypair.fromPublicKey(transaction.source);
  } catch {
    throw new RequestError("Deploy transaction source must be a G-address", 403);
  }
  const txHash = transaction.hash();
  if (
    !transaction.signatures.some((signature) =>
      source.verify(txHash, signature.signature())
    )
  ) {
    throw new RequestError("Deploy transaction lacks a valid source signature", 403);
  }
}

function validateXdrSubmission(
  env: Env,
  body: Extract<SubmissionBody, { mode: "xdr" }>
): void {
  let transaction: Transaction;
  try {
    const decoded = TransactionBuilder.fromXDR(body.xdr, networkPassphrase(env));
    if (!(decoded instanceof Transaction)) throw new Error("fee bump");
    transaction = decoded;
  } catch {
    throw new RequestError("xdr must be a signed transaction envelope");
  }
  if (transaction.source === SHARED_DEPLOYER) {
    throw new RequestError("Shared deployer may not source signed xdr", 403);
  }
  if (transaction.operations.length !== 1) {
    throw new RequestError("Deploy transaction must contain exactly one operation", 403);
  }
  validateSourceSignature(transaction);
  const operation = transaction.operations[0];
  if (operation.type !== "invokeHostFunction") {
    throw new RequestError("Only invokeHostFunction deploy operations are allowed", 403);
  }
  if (operation.source && operation.source !== transaction.source) {
    throw new RequestError("Operation source must match transaction source", 403);
  }
  const deployer = validateDeployFunction(
    env,
    (operation as Operation.InvokeHostFunction).func,
    false
  );
  if (deployer !== transaction.source) {
    throw new RequestError(
      "Deploy preimage address is not the allowlisted source",
      403
    );
  }
  let resourceFee: bigint;
  try {
    const envelope = transaction.toEnvelope();
    if (envelope.switch().name !== "envelopeTypeTx") throw new Error("not v1");
    const ext = envelope.v1().tx().ext();
    if (ext.switch() !== 1) throw new Error("missing Soroban data");
    resourceFee = ext.sorobanData().resourceFee().toBigInt();
  } catch {
    throw new RequestError("Deploy transaction is missing Soroban resource data");
  }
  if (resourceFee > maxResourceFee(env)) {
    throw new RequestError("Resource fee exceeds configured maximum", 413);
  }
}

async function validateSubmission(env: Env, body: SubmissionBody): Promise<void> {
  if (body.mode === "xdr") validateXdrSubmission(env, body);
  else await validateFuncSubmission(env, body);
}

function createClient(env: Env, apiKey: string): ChannelsClient {
  return new ChannelsClient({ baseUrl: env.RELAYER_BASE_URL, apiKey });
}

export function extractMissingAccount(errorMessage: string): string | null {
  return errorMessage.match(MISSING_ACCOUNT_PATTERN)?.[1] ?? null;
}

async function fundWithFriendbot(account: string): Promise<boolean> {
  try {
    return (
      await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(account)}`)
    ).ok;
  } catch (error) {
    console.error("Friendbot funding failed:", error);
    return false;
  }
}

app.get("/", (c) =>
  c.json({ status: "ok", service: SERVICE_NAME, network: c.env.NETWORK })
);

app.post("/", async (c) => {
  try {
    const ip = getClientIP(c.req.raw);
    if (ip === UNKNOWN_IP) {
      throw new RequestError("Cloudflare client IP is required");
    }
    const retryAfter = await enforceRateLimit(c.env, ip);
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter));
      return c.json({ success: false, error: "Rate limit exceeded" }, 429);
    }

    const body = parseSubmissionBody(await c.req.text());
    await validateSubmission(c.env, body);

    // Security invariant: validation and fee checks precede key read/mint/use.
    const storedKey = await getOrCreateApiKey(c.env, ip);
    if (!storedKey) {
      throw new RequestError(
        "Could not obtain API key. Service may be misconfigured.",
        500
      );
    }

    const client = createClient(c.env, storedKey.apiKey);
    const isTestnet = c.env.NETWORK === "testnet";
    const deadline = isTestnet ? Date.now() + TESTNET_RETRY_DURATION_MS : 0;
    const fundedAccounts = new Set<string>();

    while (true) {
      try {
        const result =
          body.mode === "xdr"
            ? await client.submitTransaction({ xdr: body.xdr })
            : await client.submitSorobanTransaction({
                func: body.func,
                auth: body.auth,
              });
        return c.json({
          success: true,
          data: {
            transactionId: result.transactionId,
            hash: result.hash,
            status: result.status,
          },
        });
      } catch (submitError) {
        const message =
          submitError instanceof Error ? submitError.message : String(submitError);
        const missingAccount = extractMissingAccount(message);
        if (
          !missingAccount ||
          !isTestnet ||
          deadline <= Date.now() ||
          missingAccount === SHARED_DEPLOYER
        ) {
          throw submitError;
        }
        if (!fundedAccounts.has(missingAccount)) {
          if (await fundWithFriendbot(missingAccount)) {
            fundedAccounts.add(missingAccount);
          }
        }
      }
    }
  } catch (error) {
    console.error("Relayer submission error:", error);
    if (error instanceof RequestError) {
      return c.json(
        { success: false, error: error.message },
        error.status as 400 | 403 | 413 | 500 | 503
      );
    }
    if (error instanceof PluginExecutionError) {
      return c.json(
        {
          success: false,
          error: error.message,
          data: {
            code: error.errorDetails?.code,
            details: error.errorDetails?.details,
          },
        },
        400
      );
    }
    if (error instanceof PluginTransportError) {
      return c.json(
        { success: false, error: error.message },
        (error.statusCode || 500) as 400 | 401 | 403 | 404 | 500 | 502 | 503
      );
    }
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Relayer request failed",
      },
      500
    );
  }
});

app.get("/status", async (c) => {
  try {
    const ip = getClientIP(c.req.raw);
    const apiKey = await readStoredApiKey(c.env, getKVKey(ip));
    return c.json({
      success: true,
      data: {
        clientIP: ip,
        network: c.env.NETWORK,
        hasKey: !!apiKey,
        keyCreatedAt: apiKey?.storedKey.createdAt,
      },
    });
  } catch (error) {
    console.error("Status endpoint failed:", error);
    return c.json({ success: false, error: "Could not read status" }, 500);
  }
});

export default { fetch: app.fetch };
