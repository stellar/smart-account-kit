import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import base64url from "../base64url.js";
import type {
  ContextRule,
  ContextRuleType,
  Signer as ContractSigner,
} from "smart-account-kit-bindings";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import {
  collectUniqueSigners,
  getCredentialIdFromSigner,
  signersEqual,
} from "../signer-utils.js";
import type { ContractDetailsResponse } from "../indexer.js";
import { decodeContractError } from "../contract-errors.js";
import {
  DEFAULT_MAX_CONSECUTIVE_PROBE_MISSES,
  DEFAULT_MAX_PROBED_RULE_ID,
  DEFAULT_READ_TIMEOUT_SECONDS,
} from "../constants.js";

type ContextRuleQueryClient = {
  get_context_rule: (args: { context_rule_id: number }) => Promise<AssembledTransaction<ContextRule>>;
  get_policy_id?: (args: { policy: string }) => Promise<AssembledTransaction<number>>;
  get_signer_id?: (args: { signer: ContractSigner }) => Promise<AssembledTransaction<number>>;
  /** Generated contract spec, used to decode raw getter results. */
  spec?: { funcResToNative: (name: string, val: xdr.ScVal | string) => unknown };
};

type ContextRuleReadDeps = {
  rpc?: rpc.Server;
  contractId?: string;
  networkPassphrase?: string;
  timeoutInSeconds?: number;
};

type ContextRuleDiscoveryDeps = {
  getContractDetailsFromIndexer?: () => Promise<ContractDetailsResponse | null>;
  probeRuleIds?: {
    maxRuleId?: number;
    maxConsecutiveMisses?: number;
  };
} & ContextRuleReadDeps;

const READ_ONLY_SIM_ACCOUNT = new Account(
  Keypair.fromRawEd25519Seed(hash(Buffer.from("smart-account-kit-context-rule-read")))
    .publicKey(),
  "0"
);

export function contextRuleTypeKey(contextType: ContextRuleType): string {
  if (contextType.tag === "Default") {
    return "Default";
  }

  if (contextType.tag === "CallContract") {
    return `CallContract:${contextType.values[0]}`;
  }

  return `CreateContract:${Buffer.from(contextType.values[0]).toString("hex")}`;
}

export function contextRuleTypeMatches(
  ruleType: ContextRuleType,
  requiredType: ContextRuleType
): boolean {
  return (
    ruleType.tag === "Default" ||
    contextRuleTypeKey(ruleType) === contextRuleTypeKey(requiredType)
  );
}

export function buildInvocationContextTypes(
  entry: xdr.SorobanAuthorizationEntry
): ContextRuleType[] {
  const contexts: ContextRuleType[] = [];

  const walk = (invocation: xdr.SorobanAuthorizedInvocation) => {
    const fn = invocation.function();
    const switchName = fn.switch().name;

    if (switchName === "sorobanAuthorizedFunctionTypeContractFn") {
      const args = fn.contractFn();
      contexts.push({
        tag: "CallContract",
        values: [Address.fromScAddress(args.contractAddress()).toString()],
      });
    } else if (switchName.startsWith("sorobanAuthorizedFunctionTypeCreateContract")) {
      const wasmHash = extractCreateContractWasmHash(fn);
      if (!wasmHash) {
        throw new Error("Unable to extract WASM hash from create-contract authorization entry");
      }

      contexts.push({
        tag: "CreateContract",
        values: [wasmHash],
      });
    }

    for (const sub of invocation.subInvocations()) {
      walk(sub);
    }
  };

  walk(entry.rootInvocation());
  return contexts;
}

function hasRpcReadConfig(
  deps?: ContextRuleReadDeps
): deps is Required<Pick<ContextRuleReadDeps, "rpc" | "contractId" | "networkPassphrase">> &
  ContextRuleReadDeps {
  return Boolean(deps?.rpc && deps.contractId && deps.networkPassphrase);
}

async function hydrateContextRuleIds(
  wallet: ContextRuleQueryClient,
  rule: ContextRule
): Promise<ContextRule> {
  const needsPolicyIds = rule.policies.length > 0 && rule.policy_ids.length !== rule.policies.length;
  const needsSignerIds = rule.signers.length > 0 && rule.signer_ids.length !== rule.signers.length;

  if (!needsPolicyIds && !needsSignerIds) {
    return rule;
  }

  const [policyIds, signerIds] = await Promise.all([
    needsPolicyIds
      ? wallet.get_policy_id
        ? Promise.all(
            rule.policies.map(async (policy) => {
              const result = (await wallet.get_policy_id?.({ policy }))?.result;
              if (result === undefined || result === null) {
                throw new Error(`Failed to resolve policy ID for ${policy}`);
              }
              return result;
            })
          )
        : Promise.resolve(rule.policy_ids)
      : Promise.resolve(rule.policy_ids),
    needsSignerIds
      ? wallet.get_signer_id
        ? Promise.all(
            rule.signers.map(async (signer) => {
              const result = (await wallet.get_signer_id?.({ signer }))?.result;
              if (result === undefined || result === null) {
                throw new Error(`Failed to resolve signer ID for hydrated context rule ${rule.id}`);
              }
              return result;
            })
          )
        : Promise.resolve(rule.signer_ids)
      : Promise.resolve(rule.signer_ids),
  ]);

  return {
    ...rule,
    policy_ids: policyIds,
    signer_ids: signerIds,
  };
}

async function readContextRuleFromRpc(
  wallet: ContextRuleQueryClient,
  contextRuleId: number,
  deps: Required<Pick<ContextRuleReadDeps, "rpc" | "contractId" | "networkPassphrase">> &
    ContextRuleReadDeps
): Promise<ContextRule> {
  const tx = new TransactionBuilder(READ_ONLY_SIM_ACCOUNT, {
    fee: BASE_FEE,
    networkPassphrase: deps.networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(deps.contractId).toScAddress(),
            functionName: "get_context_rule",
            args: [xdr.ScVal.scvU32(contextRuleId)],
          })
        ),
        auth: [],
      })
    )
    .setTimeout(deps.timeoutInSeconds ?? DEFAULT_READ_TIMEOUT_SECONDS)
    .build();

  const sim = await deps.rpc.simulateTransaction(tx);
  if ("error" in sim && sim.error) {
    throw new Error(`Failed to fetch context rule ${contextRuleId}: ${sim.error}`);
  }

  const retval = "result" in sim ? sim.result?.retval : undefined;
  if (!retval) {
    throw new Error(`Context rule ${contextRuleId} returned no result`);
  }

  // Decode via the generated contract spec rather than a hand-rolled ScVal
  // walker. The bindings spec is the source of truth for the ContextRule shape.
  if (!wallet.spec) {
    throw new Error(
      "Context rule decoding requires the generated contract spec on the wallet client"
    );
  }
  return decodeContextRuleWithSpec(wallet.spec, retval);
}

/**
 * Decode a `get_context_rule` result ScVal using the generated bindings spec.
 *
 * The canonical Protocol 27 build (`1b5f4534…`) returns the aligned
 * `signer_ids`/`policy_ids` fields and decodes directly. Wallets deployed from
 * older account builds omit those fields, which makes a plain
 * `funcResToNative` fail; for those we inject empty id vectors so the spec can
 * decode the (complex, nested) remainder, and {@link hydrateContextRuleIds}
 * then resolves the real ids via `get_signer_id`/`get_policy_id`.
 */
function decodeContextRuleWithSpec(
  spec: NonNullable<ContextRuleQueryClient["spec"]>,
  retval: xdr.ScVal
): ContextRule {
  let toDecode = retval;

  if (retval.switch().name === "scvMap") {
    const entries = retval.map() ?? [];
    const presentKeys = new Set(
      entries
        .filter((entry) => entry.key().switch().name === "scvSymbol")
        .map((entry) => entry.key().sym().toString())
    );

    const injected = [...entries];
    for (const field of ["signer_ids", "policy_ids"]) {
      if (!presentKeys.has(field)) {
        injected.push(
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(field),
            val: xdr.ScVal.scvVec([]),
          })
        );
      }
    }

    if (injected.length !== entries.length) {
      // Struct maps are keyed by symbols in ascending bytewise order, matching
      // the generated spec's field order. The spec reads fields positionally, so
      // the map must be sorted this way or decoding a later field's ScVal
      // against the wrong slot fails. Use a bytewise comparison, NOT
      // localeCompare: a locale-tailored collation (e.g. Lithuanian, where 'y'
      // sorts near 'i') can reorder field names like policies/policy_ids and
      // misalign the positional decode.
      injected.sort((a, b) => {
        const aKey = a.key().sym().toString();
        const bKey = b.key().sym().toString();
        return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
      });
      toDecode = xdr.ScVal.scvMap(injected);
    }
  }

  // Pass the base64 XDR (not the ScVal object) so the spec deserializes with its
  // own js-xdr instance — XDR bytes are instance-agnostic, avoiding dual-package
  // ScVal incompatibilities.
  const rule = spec.funcResToNative(
    "get_context_rule",
    toDecode.toXDR("base64")
  ) as ContextRule;
  // Normalize the Option<u32> void case to undefined for a consistent shape.
  if (rule.valid_until === null) {
    rule.valid_until = undefined;
  }
  return rule;
}

/**
 * Best-effort access to an AssembledTransaction's raw simulation return value.
 * Returns `undefined` when the transaction hasn't been simulated or the raw
 * retval isn't reachable (e.g. lightweight test doubles), so callers can fall
 * back to `.result`.
 */
function rawSimulationRetval(
  tx: AssembledTransaction<ContextRule>
): xdr.ScVal | undefined {
  try {
    const data = (tx as unknown as {
      simulationData?: { result?: { retval?: xdr.ScVal } };
    }).simulationData;
    return data?.result?.retval;
  } catch {
    return undefined;
  }
}

export async function readContextRule(
  wallet: ContextRuleQueryClient,
  contextRuleId: number,
  deps?: ContextRuleReadDeps
): Promise<ContextRule> {
  if (hasRpcReadConfig(deps)) {
    const rule = await readContextRuleFromRpc(wallet, contextRuleId, deps);
    return hydrateContextRuleIds(wallet, rule);
  }

  const ruleTx = await wallet.get_context_rule({ context_rule_id: contextRuleId });

  // Prefer the missing-id shim: `.result` runs the bindings' plain
  // funcResToNative, which FAILS against a deployed contract that omits the
  // aligned signer_ids/policy_ids fields. When the wallet client exposes its
  // spec and we can reach the raw retval, decode + hydrate through the same
  // shim the RPC path uses. Fall back to `.result` only when neither is
  // available (spec-conformant results and test doubles decode fine that way).
  if (wallet.spec) {
    const retval = rawSimulationRetval(ruleTx);
    if (retval) {
      const rule = decodeContextRuleWithSpec(wallet.spec, retval);
      return hydrateContextRuleIds(wallet, rule);
    }
  }
  return ruleTx.result;
}

export async function listContextRules(
  wallet: ContextRuleQueryClient,
  deps?: ContextRuleDiscoveryDeps
): Promise<ContextRule[]> {
  const probeConfig = deps?.probeRuleIds;
  let details: ContractDetailsResponse | null | undefined;

  try {
    details = await deps?.getContractDetailsFromIndexer?.();
  } catch (error) {
    // The indexer is a best-effort discovery source. When direct probing is
    // enabled, a transient indexer failure must not prevent fresh wallets from
    // resolving their low-numbered context rules on-chain.
    if (!probeConfig) {
      throw error;
    }
  }

  const discoveredRuleIds = new Set<number>(details?.contextRules.map((rule) => rule.context_rule_id) ?? []);
  // Cache rules read during probing so the final read phase can reuse them
  // instead of re-simulating + re-hydrating the same rule (behavior-preserving:
  // same function, same deps, same decode).
  const probedRules = new Map<number, ContextRule>();

  if (probeConfig) {
    const maxRuleId = probeConfig.maxRuleId ?? DEFAULT_MAX_PROBED_RULE_ID;
    const maxConsecutiveMisses =
      probeConfig.maxConsecutiveMisses ?? DEFAULT_MAX_CONSECUTIVE_PROBE_MISSES;
    let misses = 0;

    for (let contextRuleId = 0; contextRuleId <= maxRuleId; contextRuleId += 1) {
      try {
        const rule = await readContextRule(wallet, contextRuleId, deps);
        discoveredRuleIds.add(rule.id);
        probedRules.set(rule.id, rule);
        misses = 0;
      } catch {
        misses += 1;
        if (misses >= maxConsecutiveMisses) {
          break;
        }
      }
    }
  }

  if (discoveredRuleIds.size === 0) {
    if (details?.contextRules) {
      return [];
    }

    throw new Error(
      "Listing active context rules requires an indexer or an enabled on-chain probe that can discover a rule ID; the contract does not expose an iterator for active rule IDs."
    );
  }

  const contextRuleIds = [...discoveredRuleIds].sort((a, b) => a - b);
  const rules = await Promise.all(
    contextRuleIds.map(async (contextRuleId) => {
      // Reuse a rule already read during probing; only indexer-discovered ids
      // that were never probed need a fresh read here.
      const cached = probedRules.get(contextRuleId);
      if (cached) {
        return cached;
      }
      try {
        return await readContextRule(wallet, contextRuleId, deps);
      } catch (error) {
        if (isMissingContextRuleError(error)) {
          return null;
        }
        throw error;
      }
    })
  );

  return rules
    .filter((rule): rule is ContextRule => rule !== null)
    .sort((a, b) => a.id - b.id);
}

export async function getFilteredContextRules(
  wallet: ContextRuleQueryClient,
  contextRuleType: ContextRuleType,
  deps?: ContextRuleDiscoveryDeps
): Promise<ContextRule[]> {
  const rules = await listContextRules(wallet, deps);
  return rules.filter(
    (rule) => contextRuleTypeKey(rule.context_type) === contextRuleTypeKey(contextRuleType)
  );
}

export async function findWebAuthnSignerInRules(
  wallet: ContextRuleQueryClient,
  contextRuleIds: number[],
  credentialId: Buffer,
  deps?: ContextRuleReadDeps
): Promise<ContractSigner> {
  for (const contextRuleId of contextRuleIds) {
    const rule = await readContextRule(wallet, contextRuleId, deps);

    for (const signer of rule.signers) {
      if (signer.tag !== "External") {
        continue;
      }

      const keyData = signer.values[1] as Buffer;
      if (keyData.length <= credentialId.length) {
        continue;
      }

      const suffix = keyData.slice(keyData.length - credentialId.length);
      if (suffix.equals(credentialId)) {
        return signer;
      }
    }
  }

  throw new Error(
    `No signer found for credential ID ${base64url.encode(Buffer.from(credentialId))} in context rules ${contextRuleIds.join(", ")}`
  );
}

export async function findWebAuthnSignerForCredential(
  wallet: ContextRuleQueryClient,
  credentialId: string,
  deps?: ContextRuleDiscoveryDeps,
  /** Pre-fetched rules snapshot; skips a redundant listContextRules enumeration. */
  rules?: ContextRule[]
): Promise<ContractSigner> {
  const resolvedRules = rules ?? (await listContextRules(wallet, deps));
  const matchingSigners = collectUniqueSigners(
    resolvedRules.flatMap((rule) =>
      rule.signers.filter((signer) => getCredentialIdFromSigner(signer) === credentialId)
    )
  );

  if (matchingSigners.length === 1) {
    return matchingSigners[0];
  }

  if (matchingSigners.length === 0) {
    throw new Error(`No WebAuthn signer found for credential ID ${credentialId}`);
  }

  throw new Error(
    `Multiple WebAuthn signers matched credential ID ${credentialId}. Resolve the signer explicitly.`
  );
}

export async function resolveContextRuleIdsForEntry(
  wallet: ContextRuleQueryClient,
  entry: xdr.SorobanAuthorizationEntry,
  selectedSigners: ContractSigner[],
  deps?: ContextRuleDiscoveryDeps,
  /** Pre-fetched rules snapshot; skips a redundant listContextRules enumeration. */
  rulesSnapshot?: ContextRule[]
): Promise<number[]> {
  const rules = rulesSnapshot ?? (await listContextRules(wallet, deps));
  const contexts = buildInvocationContextTypes(entry);

  // The resolved rule id is committed into the signed digest, and the contract
  // validates only the selected rule — so when a rule scoped to the exact
  // context matches alongside a Default fallback, the specific rule must win,
  // otherwise its policies (e.g. spending limits) would be silently skipped.
  const preferSpecific = (matches: ContextRule[]): ContextRule[] => {
    const specific = matches.filter((rule) => rule.context_type.tag !== "Default");
    return specific.length > 0 ? specific : matches;
  };

  return contexts.map((contextType) => {
    const candidates = rules.filter((rule) => {
      if (!contextRuleTypeMatches(rule.context_type, contextType)) {
        return false;
      }

      return true;
    });

    if (candidates.length === 1) {
      return candidates[0].id;
    }

    const exactSignerMatches = preferSpecific(
      candidates.filter((rule) => {
        if (rule.signers.length !== selectedSigners.length) {
          return false;
        }

        return (
          selectedSigners.every((selectedSigner) =>
            rule.signers.some((ruleSigner) => signersEqual(ruleSigner, selectedSigner))
          ) &&
          rule.signers.every((ruleSigner) =>
            selectedSigners.some((selectedSigner) => signersEqual(ruleSigner, selectedSigner))
          )
        );
      })
    );

    if (exactSignerMatches.length === 1) {
      return exactSignerMatches[0].id;
    }

    const signerSubsetMatches = preferSpecific(
      candidates.filter((rule) => {
        if (rule.policies.length > 0) {
          return false;
        }

        return rule.signers.every((ruleSigner) =>
          selectedSigners.some((selectedSigner) => signersEqual(ruleSigner, selectedSigner))
        );
      })
    );

    if (signerSubsetMatches.length === 1) {
      return signerSubsetMatches[0].id;
    }

    const ids = candidates.map((candidate) => candidate.id).join(", ");
    throw new Error(
      `Unable to resolve a unique context rule for ${contextRuleTypeKey(contextType)}. ` +
      `Provide contextRuleIds explicitly. Matched ${candidates.length} rule(s)${ids ? `: ${ids}` : ""}.`
    );
  });
}

function extractCreateContractWasmHash(
  fn: xdr.SorobanAuthorizedFunction
): Buffer | null {
  const candidates: Array<unknown> = [];
  const fnAny = fn as unknown as {
    createContractHostFn?: () => unknown;
    createContractWithCtorHostFn?: () => unknown;
    createContractWithConstructorHostFn?: () => unknown;
  };

  if (typeof fnAny.createContractHostFn === "function") {
    candidates.push(fnAny.createContractHostFn());
  }
  if (typeof fnAny.createContractWithCtorHostFn === "function") {
    candidates.push(fnAny.createContractWithCtorHostFn());
  }
  if (typeof fnAny.createContractWithConstructorHostFn === "function") {
    candidates.push(fnAny.createContractWithConstructorHostFn());
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const ctx = candidate as { executable?: unknown };
    const executable = typeof ctx.executable === "function"
      ? (ctx.executable as () => unknown)()
      : ctx.executable;

    if (!executable || typeof executable !== "object") {
      continue;
    }

    const execAny = executable as {
      switch?: () => { name: string };
      wasm?: (() => Buffer) | Buffer;
    };
    const execSwitch = execAny.switch?.();

    if (execSwitch?.name !== "contractExecutableWasm") {
      continue;
    }

    const wasm = typeof execAny.wasm === "function" ? execAny.wasm() : execAny.wasm;
    if (wasm) {
      return Buffer.from(wasm);
    }
  }

  return null;
}

function isMissingContextRuleError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Prefer the centralized contract-error registry: a rendered
  // `Error(Contract, #3000)` decodes to the ContextRuleNotFound entry.
  if (decodeContractError(error.message)?.name === "ContextRuleNotFound") {
    return true;
  }

  // Text markers for paths that surface the miss as a plain Error before typed
  // decoding runs (the RPC read path and the test mock's "Rule N not found").
  return (
    /ContextRuleNotFound/i.test(error.message) ||
    /Rule \d+ not found/i.test(error.message)
  );
}
