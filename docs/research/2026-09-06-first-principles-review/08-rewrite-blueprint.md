# Rewrite blueprint — smart-account-kit from first principles

> This reconciles the "first-principles recommendations" from the six area reviews into one design. Where the reviews proposed different shapes for the same thing (a class-based `SmartAccount.send()` vs. functional `authorize()/submit()`; plugin interfaces mirroring the Rust traits vs. a closed signer union) the choice below is explained. Everything here is a proposal for Tyler to accept, amend, or reject; the decisions it depends on are called out as **[D<n>]** and listed in [09-decisions.md](09-decisions.md).

## 1. Design principles

1. **The contract's vocabulary is the SDK's vocabulary.** `SmartAccount`, `Rule` (context rule), `Signer`, `Policy`, `Verifier`, `Scope` (context rule type). No "wallet" except in the passkey profile's user-facing helpers; no "credential" outside the passkey module; `address`, not `contractId`.
2. **Model the account, not the passkey wallet, at the core.** The core connects to any `SmartAccount`-conformant contract with any signer mix and any birth. The fail-closed passkey wallet is a *profile* (`/passkey`) built on the core, not an assumption inside it. **[D4]**
3. **A signer is a value, not a mode.** One `Signer` interface, three built-in implementations (passkey, Ed25519, delegated), one plugin path for custom verifiers and nested accounts. No `multiSigners`, no `SelectedSigner`, no `needsMultiSigner()`. Single-passkey is the n = 1 case of the same pipeline.
4. **Intent-bound signing.** Nothing is signed that the intent doesn't explain. The RPC is trusted for *state*, never for *what to sign*. **[D1]**
5. **Trust boundaries are types.** `TrustedRpc`, `UntrustedSimulationAuth`, `UntrustedIndexer`, `UntrustedRelayer`, `UntrustedHistory`. Verification functions are pure over already-fetched facts; the I/O adapters are thin.
6. **Parity is a build artefact.** Bindings, error tables, event decoders and limits for all six WASMs are generated from the pinned contract specs in one `pnpm gen` step and diffed in CI. Hand-written mirrors are forbidden.
7. **Lean on stellar-sdk v16.** `contract.Client` + `Spec` for everything contract-shaped, `authorizeEntry`/`authorizeInvocation` for G-address signatures, `AssembledTransaction` as the transaction carrier, `SAC_SPEC` for token calls. The only host behaviour stellar-sdk lacks — host-order `ScMap` sorting — lives in one 60-line module until upstreamed. **[D20]**
8. **Isomorphic core, platform subpaths.** Root entry is `Uint8Array`-only, no DOM types, no `Buffer` in public types, injected `fetch`/`crypto` with global defaults. Browser and Node code live behind `exports` subpaths.
9. **Throw typed errors; return receipts.** One `SmartAccountError` with a string-union `code`; `ContractError` for decoded on-chain codes; `send()` returns `{ hash, ledger, returnValue, events }`. No result unions, no `console.*` in library code.
10. **Branded identifiers at the boundary.** `ContractAddress`, `AccountAddress`, `CredentialId` (one canonical byte form), `Hash32`, `RuleId`, `Stroops`. Parse once at the edge; never re-validate inside.
11. **Values, not sessions.** `SmartAccount` is an immutable handle; signers are explicit arguments to `authorize`/`send`; dropping the reference is disconnecting. Session persistence is a small optional store the profile uses, not global mutable state on the client.
12. **~25 root exports.** Everything else is a subpath, private, or deleted.

## 2. Public API

The ergonomic surface is a class (`SmartAccount`) because integrators want `account.transfer(...)` in one line; underneath it is a set of pure functions (`authorize`, `submit`, `confirm`, `planAuth`) that are also exported for advanced and server-side use. The class is sugar; the functions are the design.

### 2.1 Configuration and networks

```ts
export interface NetworkConfig {
  passphrase: string;
  rpcUrl: string;
  horizonUrl?: string;                       // history fallback for birth verification
  upstreamCommit: string;                    // OZ stellar-contracts commit the artefacts were built from
  account: { wasmHash: Hash32; acceptedWasmHashes?: Hash32[] };
  verifiers: { webauthn: ContractAddress; ed25519: ContractAddress };
  policies: { threshold: ContractAddress; weightedThreshold: ContractAddress; spendingLimit: ContractAddress };
  deployer: AccountAddress;                  // shared salt-identity (sign-only, never funded)
  nativeToken: ContractAddress;
}
export const networks: { testnet: NetworkConfig; mainnet: NetworkConfig }; // generated from deployments/protocol-27.json

export interface Config {
  network: "testnet" | "mainnet" | NetworkConfig;
  sponsor?: Sponsor;                         // fee payer; default: throws on first send with a clear message
  discovery?: Discovery | false;             // credential → contract reverse lookup; default: none (no vendor default) [D16]
  storage?: KeyValueStorage;                 // default: memory
  defaults?: { txTimeoutSec?: number; signatureLifetimeLedgers?: number; sessionTtlMs?: number };
  allowHttp?: boolean;                       // applies to every URL (rpc, horizon, sponsor, discovery)
  fetch?: typeof fetch; crypto?: Crypto;     // injection for tests / exotic runtimes
}
export interface KeyValueStorage { get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void>; delete(k: string): Promise<void> }
```

`sponsor` replaces `relayerUrl` + `deployerSecret` + `forceMethod` (SEC-F13, API-F6). `discovery` replaces `indexerUrl` + `indexerAuthToken` + `contextRuleProbe` (SVC-F13/F14). `defaults.signatureLifetimeLedgers` is clamped to a hard maximum (SEC-F8).

### 2.2 Signers

```ts
export type SignerKey =                                            // = the contract's Signer enum, Uint8Array not Buffer
  | { kind: "delegated"; address: AccountAddress | ContractAddress }
  | { kind: "external"; verifier: ContractAddress; keyData: Uint8Array };

export interface SignInput { authDigest: Hash32; entry: xdr.SorobanAuthorizationEntry; expiration: number; ruleIds: RuleId[] }
export type Signature =
  | { kind: "external"; sigData: Uint8Array }                      // bytes the verifier accepts
  | { kind: "delegated"; entry: xdr.SorobanAuthorizationEntry };   // nested __check_auth(digest) entry

export interface Signer {
  readonly key: SignerKey;
  readonly label: string;                                          // "passkey", "ed25519", "delegated", or a custom verifier name
  sign(input: SignInput): Promise<Signature>;
}

export class Ed25519Signer implements Signer {
  static fromSecret(secret: string, verifier?: ContractAddress): Ed25519Signer;   // verifier defaults from network
  static fromKeypair(kp: Keypair, verifier?: ContractAddress): Ed25519Signer;
}
export class DelegatedSigner implements Signer {                   // Delegated(G…) via stellar-sdk authorizeInvocation
  static fromKeypair(kp: Keypair): DelegatedSigner;
  static fromCallback(address: AccountAddress, sign: SigningCallback): DelegatedSigner;  // wallet adapters
  static fromAccount(inner: SmartAccount, signers: Signer[]): DelegatedSigner;         // Delegated(C…), nested account [D9]
}
export function customSigner(verifier: ContractAddress, keyData: Uint8Array, sign: (digest: Hash32) => Promise<Uint8Array>): Signer;
// PasskeySigner lives in "smart-account-kit/passkey"
```

This is the reconciliation of ARCH's two interfaces (`ExternalSigner`/`DelegatedSigner`) and API's single `Signer`: one interface whose `Signature` is a discriminated union, so the pipeline has one loop and delegated signers produce their nested entry inside `sign()` (PAR-F5/F6). A `Verifier`-plugin registry (PAR §rec 2) is not needed for signing when the signer carries its own `sign`; it *is* useful for *describing* unknown on-chain signers, so a small `describeSigner(key, network)` helper is kept.

### 2.3 Rules, scopes, policies

```ts
export type Scope = { kind: "default" } | { kind: "call"; contract: ContractAddress } | { kind: "create"; wasmHash: Hash32 };
export const scope: { default(): Scope; call(c: ContractAddress): Scope; create(h: Hash32 | string): Scope };

export interface PolicyInstall { address: ContractAddress; params: xdr.ScVal; describe(): string }
export const policy: {
  threshold(n: number, address?: ContractAddress): PolicyInstall;
  weightedThreshold(threshold: number, weights: Array<[Signer | SignerKey, number]>, address?: ContractAddress): PolicyInstall;
  spendingLimit(o: { limit: Stroops | string; periodLedgers: number }, address?: ContractAddress): PolicyInstall;
  custom(address: ContractAddress, params: xdr.ScVal, describe?: string): PolicyInstall;
};

export interface Rule { id: RuleId; name: string; scope: Scope; signers: SignerKey[]; signerIds: number[]; policies: ContractAddress[]; policyIds: number[]; validUntil?: number }
export interface RuleSpec { scope: Scope; name: string; signers: Array<Signer | SignerKey>; policies?: PolicyInstall[]; validUntil?: number }
```

One value type for policies, accepted identically by `create`, `rules.add`, and `policies.add` (API-F5). Encoding and host-order sorting happen in exactly one module (PAR-F1). The three built-ins default to the network's deployed addresses **[D15]**.

### 2.4 The account

```ts
export interface Receipt<T = unknown> { hash: string; ledger: number; returnValue: T; events: DecodedEvent[] }
export interface SendOptions { signers?: Signer[]; ruleIds?: RuleId[] | ((entry: xdr.SorobanAuthorizationEntry, i: number) => RuleId[]); expiration?: number; sponsor?: Sponsor }

export class SmartAccount {
  // construction (no I/O)
  static at(cfg: Config, address: ContractAddress, signers?: Signer[]): SmartAccount;
  // deployment — general primitive [D8]; the passkey one-liner is in /passkey
  static deployPayload(cfg: Config, spec: { signers: Array<Signer | SignerKey>; policies?: PolicyInstall[]; deployer?: AccountAddress }): Promise<DeployPayload>;
  static create(cfg: Config, spec: { signers: Signer[]; policies?: PolicyInstall[] }): Promise<SmartAccount>;   // deployPayload + sponsor.submit + confirm

  readonly address: ContractAddress;
  readonly network: NetworkConfig;
  readonly signers: readonly Signer[];
  with(signers: Signer[]): SmartAccount;           // new value with a different signer set
  readonly raw: contract.Client;                   // generated client; documented escape hatch

  // reads (RPC only — ledger entries, no indexer, no probe)  (SVC-F12)
  rules: {
    list(): Promise<Rule[]>;                       // exact: NextId/Count from instance storage + ContextRuleData(0..nextId)
    get(id: RuleId): Promise<Rule>;
    count(): Promise<{ active: number; nextId: number }>;
    add(spec: RuleSpec): Promise<AssembledTransaction<Rule>>;
    remove(id: RuleId): Promise<AssembledTransaction<null>>;
    rename(id: RuleId, name: string): Promise<AssembledTransaction<Rule>>;
    setValidUntil(id: RuleId, ledger: number | null): Promise<AssembledTransaction<Rule>>;
  };
  signers: {
    add(ruleId: RuleId, ...s: Array<Signer | SignerKey>): Promise<AssembledTransaction<number[]>>;   // add_signer or batch_add_signer per WASM profile [D11]
    remove(ruleId: RuleId, s: Signer | SignerKey): Promise<AssembledTransaction<null>>;
    idOf(s: Signer | SignerKey): Promise<number>;
  };
  policies: {
    add(ruleId: RuleId, p: PolicyInstall): Promise<AssembledTransaction<number>>;
    remove(ruleId: RuleId, address: ContractAddress): Promise<AssembledTransaction<null>>;
    idOf(address: ContractAddress): Promise<number>;
    threshold(address?: ContractAddress): ThresholdClient;                // get(ruleId) / set(ruleId, n) — reads the rule itself
    weightedThreshold(address?: ContractAddress): WeightedThresholdClient; // get / weights / set / setWeight
    spendingLimit(address?: ContractAddress): SpendingLimitClient;         // get / set
    register<P, S>(plugin: PolicyPlugin<P, S>): void;                      // custom policies: encode, read, preflight, setters, decodeEvent
  };
  token(address: ContractAddress): { transfer(to: AccountAddress | ContractAddress, amount: Stroops | string): Promise<AssembledTransaction<null>>; balance(): Promise<Stroops>; decimals(): Promise<number> };
  call(target: ContractAddress, fn: string, args: xdr.ScVal[] | ((spec: contract.Spec) => xdr.ScVal[])): Promise<AssembledTransaction<unknown>>;  // account.execute
  upgrade(wasmHash: Hash32 | string): Promise<AssembledTransaction<null>>;

  // the pipeline
  plan<T>(tx: AssembledTransaction<T>, o?: SendOptions): Promise<AuthPlan>;               // pure planning result: per-entry candidate rules, usable signers, ambiguities, lockout warnings
  prepare<T>(tx: AssembledTransaction<T>, o?: SendOptions): Promise<Transaction>;        // authorize + resimulate + assemble; not sent (agents, offline multi-party)
  send<T>(tx: AssembledTransaction<T>, o?: SendOptions): Promise<Receipt<T>>;            // prepare + sponsor.submit + confirm
  transfer(token: ContractAddress, to: AccountAddress | ContractAddress, amount: Stroops | string, o?: SendOptions): Promise<Receipt<null>>;
}
```

`plan()` is the public face of the pure `planAuth(entry, rules, signers)` (SEC-F12, PAR-F7): it returns every matching rule with a reason, marks ambiguity, and never silently prefers one. `send()` auto-selects only when exactly one candidate contains a usable signer; otherwise it throws `RULE_AMBIGUOUS` with the plan attached. **[D5]** `plan()` also runs the pure pre-flight mirrors (threshold vs. usable signers, weight sums, spending-limit window, lockout — PAR-F12, PAR §5.7) before any biometric prompt.

### 2.5 Pipeline functions (also exported)

```ts
export type Intent =
  | { kind: "invoke"; fn: xdr.InvokeContractArgs; allowSubInvocation?: (s: xdr.SorobanAuthorizedInvocation) => boolean }
  | { kind: "deploy"; create: xdr.CreateContractArgsV2 };

export function authorize<T>(tx: AssembledTransaction<T>, o: { account: SmartAccount; signers: Signer[]; intent: Intent; ruleIds?: ...; expiration?: number }): Promise<AssembledTransaction<T>>;
export function submit(tx: Transaction | DeployPayload, sponsor: Sponsor): Promise<{ hash: string }>;
export function confirm(cfg: Config, hash: string, intent: Intent): Promise<Receipt>;     // fetch envelope, hash-bind, match op to intent, decode return + events
export function planAuth(entry: xdr.SorobanAuthorizationEntry, rules: Rule[], signers: Signer[]): AuthPlanEntry;  // pure
```

`Intent` is produced by the same function that builds the host function (`token().transfer`, `call()`, `rules.add()`…) so the two cannot drift; `authorize` refuses any simulation-returned entry whose root invocation ≠ intent (SEC-F1, SEC-F6), signs only entries for `account.address`, hands G-address entries to delegated signers, and clamps expiration once per session (SEC-F8). `confirm` is used by *every* submission, not just deploys (SEC-F3).

### 2.6 Sponsor and Discovery

```ts
export interface Sponsor {
  submit(req: { kind: "invoke" | "deploy"; func: xdr.HostFunction; auth: xdr.SorobanAuthorizationEntry[]; key: string } | { kind: "envelope"; xdr: string; key: string }): Promise<{ hash: string }>;
  recover?(key: string): Promise<{ hash: string } | null>;          // idempotent recovery after timeout (SVC-F7)
}
export function httpSponsor(url: string, o?: { fetch?: typeof fetch }): Sponsor;   // speaks smart-account-kit/relayer-protocol
export function keypairSponsor(cfg: Config, kp: Keypair): Sponsor;                 // Node/backends: builds, fee-pays, submits, polls
export function customSponsor(fn: Sponsor["submit"]): Sponsor;

export interface Discovery {
  byCredential(credentialId: CredentialId): Promise<Array<{ address: ContractAddress; creationTxHash?: string }>>;
  bySigner?(address: AccountAddress): Promise<ContractAddress[]>;
}
export function httpDiscovery(url: string): Discovery;      // the 2-route spec in §6
export function eventsDiscovery(cfg: Config): Discovery;    // RPC getEvents on signer_registered / context_rule_added (recent wallets)
export function localDiscovery(storage: KeyValueStorage): Discovery;
// mercuryDiscovery(...) as an adapter if Mercury serves the minimal routes [D16]
```

### 2.7 Errors

```ts
export type ErrorCode =
  | "INVALID_INPUT" | "NOT_SUPPORTED" | "RULE_NOT_FOUND" | "SIGNER_NOT_FOUND" | "POLICY_NOT_FOUND" | "RULE_AMBIGUOUS"
  | "INTENT_MISMATCH" | "LOCKOUT_RISK" | "SIMULATION_FAILED" | "SUBMISSION_FAILED" | "CONFIRMATION_FAILED" | "TIMEOUT"
  | "RPC_UNAVAILABLE" | "WEBAUTHN" | "PROVENANCE" | "OWNERSHIP" | "CODE_NOT_ACCEPTED" | "CONTRACT";
export class SmartAccountError extends Error { code: ErrorCode; hash?: string; plan?: AuthPlan; cause?: unknown; context?: Record<string, unknown> }
export class ContractError extends SmartAccountError { contractCode: number; name: string; family: "SmartAccount" | "WebAuthn" | "Ed25519" | "SimpleThreshold" | "WeightedThreshold" | "SpendingLimit" | "Custom" }
```

Contract errors are decoded from the diagnostic (`Error(Contract, #N)`) via the generated registry; never by doc-string match (PAR-F9). Host-level errors this contract family actually produces (`Auth/InvalidAction`, `Object/InvalidInput`, `Crypto/InvalidInput`, budget) get typed wrappers.

### 2.8 The passkey profile — `smart-account-kit/passkey`

```ts
export class PasskeySigner implements Signer {
  static register(o: { user: string; rp?: { id?: string; name?: string }; verifier?: ContractAddress }): Promise<PasskeySigner>;   // userVerification & residentKey "required"; user.id = 32 random bytes; key validated by WebCrypto import + one verified assertion
  static authenticate(o?: { allow?: CredentialId[] }): Promise<{ signer: PasskeySigner; assertion: Assertion }>;                  // discoverable credential
  readonly credentialId: CredentialId; readonly publicKey: Uint8Array;
}
export function createPasskeyWallet(cfg: Config, o: { user: string; policies?: PolicyInstall[] }): Promise<{ account: SmartAccount; signer: PasskeySigner }>;   // the one-liner
export function connect(cfg: Config, o: { signer: PasskeySigner; address?: ContractAddress; assertion?: Assertion; mode?: "strict" | "live" }): Promise<SmartAccount>;  // fail-closed pipeline, see §4 [D3]
export function restore(cfg: Config): Promise<{ account: SmartAccount; signer: PasskeySigner } | null>;   // from session storage, re-verified
export function discover(cfg: Config, signer: PasskeySigner): Promise<Array<{ address: ContractAddress; verified: boolean; policies: PolicyInstall[] }>>;   // candidates for the app to present; never auto-selects >1
export function saveSession(cfg: Config, account: SmartAccount, signer: PasskeySigner): Promise<void>;
export { indexedDbStorage, localStorageStorage } from "./storage";
```

### 2.9 Other subpaths

`smart-account-kit/node` (re-exports `Ed25519Signer`, `DelegatedSigner.fromKeypair`, `keypairSponsor`, a file-backed `KeyValueStorage`); `smart-account-kit/wallets` (`DelegatedSigner.fromStellarWalletsKit(swk)` against a 3-method local interface — no jsr dependency, TEST-F14); `smart-account-kit/relayer-protocol` (§6); `smart-account-kit/testing` (`fakeRpc`, `fakeAuthenticator`, `fakeSponsor` — the same doubles the SDK's own tests use, TEST rec 3); `smart-account-kit/testnet` (`fund(account)` friendbot helper — the 194-line `fund-ops.ts` reduced to one `send()`).

### 2.10 Quick start (browser, passkey) — the 15-line bar

```ts
import { SmartAccount, Ed25519Signer, scope, policy, httpSponsor } from "smart-account-kit";
import { createPasskeyWallet, restore, PasskeySigner, discover, connect } from "smart-account-kit/passkey";

const cfg = { network: "testnet", sponsor: httpSponsor("https://relay.example") } as const;

let session = await restore(cfg);
if (!session) session = await createPasskeyWallet(cfg, { user: "alice@example.com" });
const { account, signer } = session;

await account.transfer(account.network.nativeToken, "GRECIPIENT…", "10");           // 10 XLM, signed by the passkey

const backup = Ed25519Signer.fromSecret("S…");                                        // 2-of-2 rule guarded by a threshold policy
await account.send(await account.rules.add({ scope: scope.default(), name: "2-of-2", signers: [signer, backup], policies: [policy.threshold(2)] }));
await account.with([signer, backup]).transfer(account.network.nativeToken, "GRECIPIENT…", "5", { ruleIds: [1] });
```

Node/agent variant: `const account = SmartAccount.at(cfg, address, [Ed25519Signer.fromSecret(process.env.KEY)])` with `sponsor: keypairSponsor(cfg, feeKp)` — no passkey import, no browser, no indexer (API-F1).

### 2.11 Root export list (target ≈ 25)

`SmartAccount`, `networks`, `Ed25519Signer`, `DelegatedSigner`, `customSigner`, `scope`, `policy`, `authorize`, `submit`, `confirm`, `planAuth`, `httpSponsor`, `keypairSponsor`, `customSponsor`, `httpDiscovery`, `eventsDiscovery`, `localDiscovery`, `SmartAccountError`, `ContractError`, `parseUnits`/`formatUnits`, `LEDGERS_PER_HOUR/DAY/WEEK`; types `Config`, `NetworkConfig`, `Signer`, `SignerKey`, `Rule`, `RuleSpec`, `Scope`, `PolicyInstall`, `Receipt`, `AuthPlan`, `Intent`, `Sponsor`, `Discovery`, `KeyValueStorage`, `ErrorCode`, `DecodedEvent`; re-export `AssembledTransaction`.

**Deleted from the public surface** (API-F9, ARCH-F23): `SmartAccountKit`, all `*Manager`s, `ExternalSignerManager`, `SelectedSigner`, `ExternalSigner`, `AuthDigestSigner`, `computeEntryAuthDigest`, `PolicyConfig`, `StoredCredential`, `StoredSession`, `CredentialDeploymentStatus`, `StorageAdapter` (→ `KeyValueStorage`), `convertPolicyParams`, `buildPoliciesScVal`, `create*Params`, `create*Signer`/`create*Context` builders, all `validate*`, `truncateAddress`/`describeSignerType`/`formatSignerForDisplay`/`formatContextType`, `signFeePayer`/`resimulateAndAssemble`/`buildI128ScVal`/`readTokenDecimals`/`resolveTokenAmount`/`tokenAmountToRawUnits`/`buildDirectTokenTransfer`/`signerToScVal`/`parseSignerScVal`, `PolicyClientDeps`, `RelayerClient`/`IndexerClient`/`RelayerErrorCodes`/`DEFAULT_INDEXER_URLS`/all 12 `Indexed*` types, `SmartAccountEventEmitter` + event types, `SubmitOptions`/`SubmissionOptions`/`SignOptions`/`SignAndSubmitOptions`, 11 error subclasses, `wrapError`, `CONTRACT_ERROR_REGISTRY`/`contractErrorFromCode`/`decodeContractError` (internal), `xlmToStroops`/`stroopsToXlm`/`validateAddress`/`validateAmount`/`generateChallenge`, `WEBAUTHN_TIMEOUT_MS`/`STROOPS_PER_XLM`/`FRIENDBOT_RESERVE_XLM`/`MAX_*`/`ED25519_*_SIZE`/`BASE_FEE`, `StellarWalletsKitAdapter` (→ `/wallets`), `MemoryStorage`/`LocalStorageAdapter`/`IndexedDBStorage` (→ `/passkey`, `/node`).

## 3. Module layout and budget

One package, `exports` map with six subpaths, ESM-only, `sideEffects: false`, `types` first in every condition (TEST-F12).

```
src/
  core/
    ids.ts              brands + parse/encode: ContractAddress, AccountAddress, CredentialId, Hash32, RuleId, Stroops     ~90
    errors.ts           SmartAccountError, ContractError, host-error wrappers                                              ~70
    network.ts          Config → resolved { rpc, passphrase, fetch, crypto, allowHttp } ; https enforcement               ~50
    networks.ts         GENERATED from deployments/protocol-27.json                                                       (gen)
    generated/          GENERATED per WASM: spec + Client + types + errors + events + limits, for account, 3 policies, 2 verifiers   (gen)
  auth/                 PURE, zero I/O, KAT-tested (SEC rec 1, TEST rec 1)
    digest.ts           signaturePayload(network, entry, expiration), authDigest(payload, ruleIds)                          ~30
    payload.ts          AuthPayload / WebAuthnSigData encode+decode via generated spec, host-sorted                        ~80
    scval-order.ts      compareScVal, sortedScMap  (until upstreamed) [D20]                                                ~60
    der.ts              derToCompactLowS  (or @noble/curves p256.Signature) + property tests                              ~50
    contexts.ts         contextsOf(entry): Scope[] — switch over the three real XDR arms (ARCH-F13)                       ~40
    intent.ts           assertEntryMatchesIntent(entry, intent, address)                                                  ~50
    expiration.ts       resolveExpiration(latest, requested, existing) with clamp                                          ~25
    signer-key.ts       SignerKey validation: sizes, verifier-specific key shape, shared-deployer rejection (SEC-F7)       ~60
    plan.ts             planAuth(entry, rules, signers) → candidates/ambiguity/prune ; preflight mirrors (PAR-F7/F12)      ~140
  signers/
    types.ts            Signer, Signature, SignInput ; describeSigner                                                      ~50
    ed25519.ts          Ed25519Signer                                                                                       ~40
    delegated.ts        DelegatedSigner: keypair / callback (authorizeInvocation) / nested account (recursive __check_auth) ~90
  account/
    account.ts          SmartAccount: at/with/raw; rules/signers/policies namespaces; token(); call(); upgrade()           ~260
    reads.ts            rules.list via getLedgerEntries(instance → ContextRuleData(0..nextId) → SignerData/PolicyData) (SVC-F12) ; get/count ; decode #[contracttype] entries   ~150
    encode.ts           RuleSpec/PolicyInstall/SignerKey → ScVal, host-sorted, in ONE place (PAR-F1)                     ~70
  policies/
    install.ts          policy.threshold / weightedThreshold / spendingLimit / custom                                      ~70
    clients.ts          typed getters/setters over generated clients + account.call()                                     ~120
    plugin.ts           PolicyPlugin<P,S> interface + registry + preflight hooks                                           ~60
  pipeline/
    authorize.ts        the one sign loop: intent check → plan → per-entry per-signer sign → write payload → resimulate → assemble   ~160
    submit.ts           Sponsor interface; httpSponsor (relayer-protocol) ; keypairSponsor ; customSponsor                 ~150
    confirm.ts          fetch envelope by hash, hash-bind, unwrap fee-bump, match op to intent, decode return + events (SEC-F3)   ~110
    events.ts           decodeEvent(xdr.ContractEvent) via generated event specs; SignerRegistry fold (PAR-F3)             ~90
  deploy/
    address.ts          deriveAddress(network, deployer, salt) ; salt policy [D2]                                          ~40
    deploy.ts           deployPayload({signers, policies, deployer}) → {address, func, auth} | signed tx ; confirmDeployment   ~140
  verify/               PURE checks over fetched facts (SEC rec 5)
    birth.ts            verifyBirth(envelope, expected) ; constructor description                                          ~120
    code.ts             verifyCode(instance, accepted)                                                                     ~20
    live.ts             verifyLiveSigner(rules, key, ledger)                                                               ~40
    assertion.ts        verifyAssertion(response, challenge, rpId, key) (WebCrypto) + flag checks mirroring the verifier   ~110
  discovery/
    types.ts            Discovery interface                                                                                 ~15
    http.ts             httpDiscovery (2 routes, §6)                                                                      ~60
    events.ts           eventsDiscovery via rpc.getEvents                                                                 ~70
    local.ts            localDiscovery over KeyValueStorage                                                                ~30
  index.ts              root entry                                                                                          ~40
  passkey/              entry "smart-account-kit/passkey" (browser)
    authenticator.ts    navigator.credentials create/get; COSE→raw P-256 (proper CBOR); DER→compact; JSON conversion (drop @simplewebauthn) ~160
    signer.ts           PasskeySigner                                                                                       ~60
    wallet.ts           createPasskeyWallet, connect (pipeline of verify/*), restore, discover, saveSession                ~180
    storage.ts          indexedDbStorage, localStorageStorage as KeyValueStorage                                            ~90
    index.ts                                                                                                                ~20
  node/index.ts         Ed25519Signer, DelegatedSigner.fromKeypair, keypairSponsor, fileStorage                            ~40
  wallets/index.ts      DelegatedSigner.fromStellarWalletsKit against a local 3-method interface                          ~50
  relayer-protocol/     entry: request/response/error types, parse/validate helpers, describeDeployment/Invocation        ~150
  testing/              fakeRpc (~150), fakeAuthenticator (~80), fakeSponsor (~30)                                        ~260
  testnet/index.ts      fund(account) via friendbot + send()                                                               ~40
```

**Budget: ~3,100 code LOC** hand-written (+ generated), vs. 8,580 today. The three reviews that estimated independently landed at 2,900 (ARCH), "~25 exports" (API), and "worker ~250 lines" (SVC); this layout is the union with the plugin surfaces added. Tests: ~4,000 lines, mostly table-driven and property-based, with the WASM-in-the-loop conformance suite as the merge gate.

Dependency arrows (all one-way; `core/` imports nothing internal; `auth/` imports only `core/`):

```
passkey/ node/ wallets/ ──▶ signers/ ──▶ auth/ ──▶ core/
verify/ discovery/ ────────▶ account/ ──▶ auth/, core/
pipeline/ ─────────────────▶ signers/, account/, auth/, core/
deploy/ ───────────────────▶ auth/, core/
policies/ ─────────────────▶ account/, core/
relayer-protocol/ ─────────▶ auth/ (describe*), core/   — no stellar-sdk runtime beyond xdr
```

## 4. Trust model

| Source | Trusted for | Not trusted for | Enforced by |
|---|---|---|---|
| Stellar RPC (`TrustedRpc`) | ledger state (`getLedgerEntries`, `getContractData`, `getLatestLedger`), simulation *resources*, `getTransaction` status | auth entries returned by simulation; which rules exist for signing | `assertEntryMatchesIntent` in `authorize`; rules read from ledger entries, not from indexer; `confirm` after every submission |
| Simulation output (`UntrustedSimulationAuth`) | nothing | anything | byte-equality of root invocation with intent; no sub-invocations unless intent allows; only entries for `account.address` are signed |
| Horizon (`UntrustedHistory`) | nothing on its own | `successful`, ledger | envelope is hash-bound; used only when RPC returns `NOT_FOUND`; under [D2] the address itself commits to the birth |
| Indexer / Discovery (`UntrustedIndexer`) | hints (candidate addresses, creation tx hash) | anything about state, freshness, collisions, derived address | every candidate re-verified from RPC; `discover()` never auto-selects >1; no vendor default |
| Relayer / Sponsor (`UntrustedRelayer`) | delivering a submission | the returned hash meaning success | `confirm(hash, intent)` fetches and matches the envelope; idempotency key for recovery |
| Authenticator (`navigator.credentials`) | producing signatures | key extraction from attestation | WebCrypto import + one verified assertion before any deploy (SEC-F5); UV/UP/BE/BS flag checks mirroring the verifier |
| The app / integrator | config, choosing a candidate, rendering the intent | — | `Intent` is renderable so the app can show what the biometric prompt authorizes |

Residual trust that must be documented in `SECURITY.md`: the RPC is a root of trust for *state*; an integrator who wants more runs their own or requires two RPCs to agree on `getLedgerEntries`. The passkey's security boundary is the browser-enforced `rpId` scope; the contract does not check origin or `rpId`, so any origin under the `rpId` or any XSS on it can sign (SEC-F15). Signatures are portable and live until `expiration`; the default lifetime is short and the maximum is hard-clamped.

**Connect pipeline (passkey profile).** `connect = fetch(rpc, history?, discovery?) |> verifyBirth |> verifyCode |> verifyLiveSigner |> verifyOwnership(assertion)`; each step is a pure function returning a typed result; local approval is scoped to the `(credentialId, address)` pair (SEC-F18); transport errors never mutate stored state (SEC-F17). `mode: "strict"` requires the birth proof; `mode: "live"` (the default under [D3] if accepted) requires accepted code + a live unexpired rule containing exactly this passkey + a fresh assertion, and presents the account's current policies to the app.

**Address derivation [D2].** Recommended: `salt = sha256(wasmHash ‖ xdr(constructorArgs))` (constructor args = the host-sorted signers vector + policies map). Consequences: squatting requires deploying the victim's exact wallet; the "occupied" state cannot exist; `verifyBirth` reduces to "recompute the address from the birth tx's create args"; `expectedDeployer/Salt/Policies` and the relayer's constructor-shape check disappear; per-call `policies` no longer break recovery (SEC-F10). Cost: the address is no longer a function of the credential ID alone, so discovery from a bare credential ID needs a `Discovery` source (already true in v0.7.0), and two apps that install different constructor policies for the same passkey get different wallets (arguably correct). The shared deployer stays, sign-only, as a namespace key. Fallback if rejected: keep the current salt and keep the compensating provenance layer, but still make it a pure pipeline.

## 5. Contract parity as a build step

`contracts/` holds the OZ repo as a submodule pinned to `upstreamCommit` (or the six optimized `.wasm` files by hash) **[D13]**. `pnpm gen` produces, into `src/core/generated/`:

- one `spec.ts` + `Client` + types per WASM (`stellar contract bindings typescript` output, post-processed: no `export * from "@stellar/stellar-sdk"`, no `window.Buffer`, `Uint8Array` not `Buffer`, `sideEffects: false`) — for the account **and** the three policies **and** the two verifiers (ARCH-F11, ARCH-F16);
- `errors.ts` from every spec's `errorCases()` — code, variant, family, doc (PAR-F9);
- `events.ts` decoders from every spec's `ScSpecEntryEventV0` (PAR-F3);
- `limits.ts` from `mod.rs` `pub const`s (a regex + CI diff, or a tiny Rust exporter);
- `profiles.ts`: per accepted WASM hash, which example-only entry points exist (`__constructor(signers, policies)`, `batch_add_signer`, `upgrade`) so wrappers are feature-gated rather than assumed (PAR-F11) **[D11]**.

CI: a nightly job diffs `packages/accounts` + `examples/multisig-smart-account` between `upstreamCommit` and OZ `main` and fails on any change to `#[contracttrait]`, `#[contracterror]`, `#[contractevent]`, or `pub const` lines. As of 2026-09-04 the only delta is `MAX_HISTORY_ENTRIES 1000 → 815`.

The semantics the SDK relies on and cannot generate are kept in one short `docs/contract-semantics.md` with `storage.rs` line references and a golden-snippet test: context matching is exact-id lookup with `Default` as a wildcard (no precedence); a rule with policies has no signer quorum of its own; every payload signer must belong to a selected rule; `valid_until` is inclusive; `Count` is the active count; `execute` bypasses token-scoped rules by construction (PAR §4).

## 6. Services

**Topology.** RPC is the only hard dependency. Horizon is optional (birth history beyond RPC retention). Sponsor is optional and pluggable. Discovery is optional and pluggable. `connect({ address })` and `rules.list()` work from RPC alone.

**Relayer protocol** (`smart-account-kit/relayer-protocol`, SVC rec): versioned discriminated `RelayRequest` (`invoke` | `deploy` | `envelope`, each with an idempotency `key = sha256(func ‖ auth)`), `RelayResponse` (`ok` + hash/status/ledger, or `code` from a closed `RelayErrorCode` union + `retryAfterSeconds`), `RELAY_HEADERS`, `parseRelayRequest()`, `describeDeployment(func, auth)` / `describeInvocation(func, auth)` / `assertAuthRootMatches`. `GET /relay/:key` for recovery. Both the SDK's `httpSponsor` and the worker import this module; a contract test drives the in-process worker with the real client, including preflight (SVC-F1/F9).

**Reference sponsor.** A ~250-line worker (or plain Hono server — `examples/06-sponsor-endpoint.ts`) **[D6]**: `env.ts`, `limits.ts` (token bucket keyed by IP pre-validation and by wallet post-validation, with a per-wallet daily stroop budget), `validate.ts` (SDK helpers + operator predicates: allowlisted WASM hashes, allowlisted deployer, fee cap on both `resourceFee` and envelope `fee`), `upstream.ts` (one `submit()` with bounded exponential backoff), `index.ts` (Hono + `cors()`). One operator secret. No per-IP key minting. No request-path friendbot; post-reset channel funding and deployer hardening are an ops script (`scripts/harden-deployer.mjs --network testnet`, SVC-F20). Threat model stated in one paragraph at the top of its README: this is a rate-limited faucet with shape checks.

**Discovery spec** (replaces schema-2, SVC-F13): two routes — `GET /v1/credential/:hex → [{ address, creationTxHash }]`, `GET /v1/signer/:address → [{ address }]`. Reference implementation ~200 lines: `getEvents` on topics `signer_registered` and `context_rule_added` network-wide, cursor persisted, SQLite, backfill from a ledger data lake documented as the one place a hosted provider adds value. The SDK verifies everything else itself. `MercuryDiscovery` remains as an adapter if Mercury serves the two routes **[D16]**. No default discovery URL — sending credential IDs to a third party is opt-in.

**Manifests.** `deployments/protocol-27.json` is the single source; `src/core/networks.ts`, the worker's config, the examples, and the spec-drift test all read it (SVC-F19). CHANGELOG entries name the manifest and upstream commit each SDK version targets.

**Examples** (`examples/`, each ≤100 lines, no env vars, `pnpm example <n>`): `01-create-and-transfer` (browser), `02-add-device` (browser), `03-threshold-multisig` (passkey + Ed25519 + G-address, 2-of-3), `04-spending-limit-agent` (`scope.call(token)` rule + Ed25519 agent key + spending limit; within-limit succeeds, over-limit fails with the decoded `ContractError`), `05-node-backend-agent` (Node only: `Ed25519Signer`, `keypairSponsor`, RPC-only `rules.list()`), `06-sponsor-endpoint` (60-line relay server). `apps/console/` keeps the current demo's admin surface, consuming the same API with none of the helpers in SVC-F17 left inside it.

## 7. Test strategy

Four layers, one command (`pnpm check` = `tsc --noEmit` on all projects *including tests* · `biome check` · `vitest run --coverage` with an 80 % branch threshold on `auth/`, `verify/`, `pipeline/` · `publint` · `verify-esm` on the packed tarball), and one PR job that runs it plus the conformance suite (TEST recs 1–5):

1. **`auth/` and `verify/`: known-answer vectors generated from the Rust side.** A `#[test]` in a sibling crate pinned to `upstreamCommit` prints, for fixed inputs, `signature_payload`, `context_rule_ids`, `auth_digest`, the expected WebAuthn `challenge` string, a `WebAuthnSigData` XDR that `verify` accepts, an `AuthPayload` XDR with two same-verifier signers in host order, `Signer` XDR for all variants, and contract-id derivation; checked in as JSON. Property tests (`fast-check`): payload encode/decode round-trip, `compareScVal` is a total order consistent with XDR round-trip, `derToCompactLowS(der(r,s)) == (r, min(s, n−s))`, base64url round-trip, key-data split. Every rejecting branch of `verifyAssertion`, `verifyBirth`, `contextsOf` is a table row. This replaces golden vectors produced by the code under test (TEST-F3d) and the 50 %-flaky low-S coverage (TEST-F4).
2. **Real `SmartAccount` against fake infrastructure.** `smart-account-kit/testing` provides `fakeRpc` (in-memory ledger entries, canned simulation auth, `sendTransaction`/`getTransaction`), `fakeAuthenticator` (WebCrypto P-256, UV set, real DER), `fakeSponsor`. Tests construct the real object and assert on the XDR that reaches `sendTransaction` — never on which private method was called (TEST-F7/F8). The connect pipeline is one parametrised table `{stored, discovery, birthTx, liveRule, assertion} → outcome` asserting both the error and that no session was saved (TEST-F2).
3. **WASM-in-the-loop conformance, in PR CI.** `stellar container start` (quickstart) or `stellar-cli` local network; upload the six pinned WASMs; create an account with a WebCrypto key; through the public API only: `execute`, direct token `transfer` under a spending-limit rule (within and over limit), `add_signer` with a delegated co-signer, a `CreateContract`-scoped rule, an Ed25519-only account, a 2-of-3 threshold. Assert against the ledger. ≈60–90 s with a cached image. This is the only test that proves "the digest the SDK signs is what the contract verifies" **[D18]**.
4. **Nightly.** Playwright + CDP virtual authenticator against `apps/console` on the local network; bindings/spec drift (`stellar-cli` from GitHub releases); OZ `main` diff; `check-mainnet-deployer`; `pnpm audit --prod --audit-level=high`.

Delete: `scripts/build.sh`, `publish.sh`, `sync-version.js`, `src/version.ts`, `scripts/bindings/{build,publish}.sh` + template, `browser-comprehensive-audit.sh`, `webauthn-browser-probe.sh`, `testnet-passkey-smoke.sh`, `agent-browser-webauthn-helper.mjs`, `relayer-proxy/pnpm-lock.yaml`, `relayer-proxy/worker-configuration.d.ts` (use `@cloudflare/workers-types` + a 20-line `env.d.ts`), `indexer/demo/`, `packages/` (TEST-F16/F17, SVC-F15). Keep `verify-esm.mjs` (on the tarball), `bindings/verify.sh` (nightly), `check-mainnet-deployer.mjs` (nightly).

**Release.** Tag-triggered workflow, `npm publish --provenance` under OIDC trusted publishing, version via Changesets; `permissions: contents: read`, SHA-pinned actions, `timeout-minutes`, Node 22/24 matrix **[D19]**. `tsconfig`: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride` + `verbatimModuleSyntax` + `noEmitOnError`; `typescript ^5.9 || ^6`. Peer `@stellar/stellar-sdk: ^16` only — never also a dependency (TEST-F13). Zero other runtime dependencies (`base64url`, `@simplewebauthn/browser`, `buffer`, `@types/node` removed; `@noble/curves` optional for DER).

## 8. Build order

Not a migration (there is nothing to migrate to), but a sequence that keeps each step shippable and lets the conformance harness catch drift early.

0. **Stop-the-bleeding on `main`** (independent of the rewrite; see summary §8): CORS headers, worker dependency, sorted policy maps, `CreateContract` accessors, `userVerification: "required"`, shared-deployer signer guard, attestation key validation, expiration clamp, `count()` docs, README/JSDoc examples — each with a test.
1. **Foundations.** `deployments/protocol-27.json` → `networks.ts`; `contracts/` submodule + `pnpm gen` for all six WASMs; `core/ids`, `core/errors`; `auth/*` with Rust-generated vectors and property tests; `testing/fakeRpc` + `fakeAuthenticator`; the local-network conformance harness (empty at first). Decisions D1, D2, D13 needed here.
2. **Account and pipeline.** `signers/*`, `account/*` (ledger-entry reads), `policies/*`, `pipeline/*` (intent-bound `authorize`, `submit`, `confirm`, events). Conformance: Ed25519-only account end-to-end through `send()`. Decisions D4, D5, D8.
3. **Deploy and passkey profile.** `deploy/*` (salt policy per D2), `verify/*` as pure functions, `passkey/*` (authenticator over `navigator.credentials`, `PasskeySigner`, `connect` pipeline, sessions). Conformance: passkey wallet via `fakeAuthenticator`; Playwright smoke via virtual authenticator. Decisions D3, D7.
4. **Services and examples.** `relayer-protocol/`, reference sponsor, `httpSponsor` contract test, discovery spec + reference impl + `eventsDiscovery`, six examples, `apps/console` on the new API. Decisions D6, D16.
5. **Delete.** Everything in §2.11's deleted list, the old `src/`, `packages/`, `indexer/demo`, the shell scripts; publish 1.0 with provenance; `SECURITY.md` gains the trust-model table.

## 9. What this blueprint does not decide

Host `auth_contexts` ordering for nested trees with mixed rule ids (assumed pre-order; verify in the conformance suite — SEC open Q1); which hash (outer/inner) the OZ channels plugin returns for fee-bumped envelopes (accept either, normalise to inner — SEC-F19); whether `Delegated(C…)` recursion ships in 1.0 or 1.1 (**[D9]**); whether CAP-71 `AddressWithDelegates` entries are supported (**[D10]** — OZ rejected `delegate_account_auth` for the account; the SDK should refuse such entries with a typed error until there is a contract-side reason); and everything in [09-decisions.md](09-decisions.md).
