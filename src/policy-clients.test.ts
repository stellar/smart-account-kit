import { describe, expect, it, vi } from "vitest";
import { Address, Keypair, StrKey, hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Client as SmartAccountClient } from "smart-account-kit-bindings";
import type { ContextRule, Signer as ContractSigner } from "smart-account-kit-bindings";
import {
  SimpleThresholdPolicyClient,
  WeightedThresholdPolicyClient,
  SpendingLimitPolicyClient,
  CONTEXT_RULE_SPEC_TYPE,
} from "./policy-clients";
import type { PolicyClientDeps } from "./policy-clients";

const NETWORK = "Test SDF Network ; September 2015";
const SMART_ACCOUNT = "CDANWYENKH6PTTY6GDTMDAMYRHMU4SBRPX5NUDYDMTYVOIF32ASZFU4Y";
const POLICY = StrKey.encodeContract(hash(Buffer.from("policy")));

const SPEC = new SmartAccountClient({
  contractId: SMART_ACCOUNT,
  rpcUrl: "https://x",
  networkPassphrase: NETWORK,
}).spec;

function gAddress(seed: number): string {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();
}

function delegatedSigner(seed: number): ContractSigner {
  return { tag: "Delegated", values: [gAddress(seed)] };
}

function makeRule(signers: ContractSigner[]): ContextRule {
  return {
    id: 2,
    context_type: { tag: "Default", values: undefined },
    name: "rule",
    signers,
    signer_ids: signers.map((_, i) => i),
    policies: [],
    policy_ids: [],
    valid_until: null,
  };
}

function makeDeps(overrides: Partial<PolicyClientDeps> = {}): PolicyClientDeps & {
  rpc: { simulateTransaction: ReturnType<typeof vi.fn> };
  execute: ReturnType<typeof vi.fn>;
} {
  const simulateTransaction = vi.fn();
  const execute = vi.fn(async () => ({}) as never);
  return {
    rpc: { simulateTransaction } as never,
    networkPassphrase: NETWORK,
    timeoutInSeconds: 30,
    getSmartAccount: () => SMART_ACCOUNT,
    encodeContextRule: (rule) => SPEC.nativeToScVal(rule, CONTEXT_RULE_SPEC_TYPE),
    execute,
    ...overrides,
  } as never;
}

/** Extract (fnName, decoded args) from the tx handed to simulateTransaction. */
function simulatedCall(deps: ReturnType<typeof makeDeps>) {
  const tx = deps.rpc.simulateTransaction.mock.calls[0][0];
  const op = tx.operations[0];
  const invoke = op.func.invokeContract;
  return {
    fnName: invoke.functionName.toString(),
    args: invoke.args as xdr.ScVal[],
  };
}

describe("SimpleThresholdPolicyClient", () => {
  it("reads the threshold via simulation with (u32 rule id, smart account)", async () => {
    const deps = makeDeps();
    deps.rpc.simulateTransaction.mockResolvedValue({
      result: { retval: xdr.ScVal.scvU32(3) },
    });
    const client = new SimpleThresholdPolicyClient(POLICY, deps);

    await expect(client.getThreshold(2)).resolves.toBe(3);

    const { fnName, args } = simulatedCall(deps);
    expect(fnName).toBe("get_threshold");
    expect(scValToNative(args[0])).toBe(2);
    expect(args[1].type).toBe("scvAddress");
    if (args[1].type === "scvAddress") {
      expect(Address.fromScAddress(args[1].address).toString()).toBe(SMART_ACCOUNT);
    }
  });

  it("routes set_threshold through execute() with the full ContextRule", async () => {
    const deps = makeDeps();
    const client = new SimpleThresholdPolicyClient(POLICY, deps);
    const rule = makeRule([delegatedSigner(1)]);

    await client.setThreshold(2, rule);

    expect(deps.execute).toHaveBeenCalledTimes(1);
    const [target, fnName, args] = deps.execute.mock.calls[0];
    expect(target).toBe(POLICY);
    expect(fnName).toBe("set_threshold");
    expect(scValToNative(args[0])).toBe(2);
    expect(args[1].type).toBe("scvMap"); // encoded ContextRule
    expect(args[2].type).toBe("scvAddress");
    expect(Address.fromScAddress(args[2].address).toString()).toBe(SMART_ACCOUNT);
  });
});

describe("WeightedThresholdPolicyClient", () => {
  it("decodes get_signer_weights into a Map keyed by signer", async () => {
    const deps = makeDeps();
    const signer = delegatedSigner(5);
    const weightsScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvVec([
          xdr.ScVal.scvSymbol("Delegated"),
          xdr.ScVal.scvAddress(Address.fromString(signer.values[0]).toScAddress()),
        ]),
        val: xdr.ScVal.scvU32(4),
      }),
    ]);
    deps.rpc.simulateTransaction.mockResolvedValue({ result: { retval: weightsScVal } });
    const client = new WeightedThresholdPolicyClient(POLICY, deps);

    const weights = await client.getSignerWeights(makeRule([signer]));

    expect(weights.size).toBe(1);
    const [[key, weight]] = [...weights.entries()];
    expect(key).toEqual(signer);
    expect(weight).toBe(4);
  });

  it("routes set_signer_weight through execute()", async () => {
    const deps = makeDeps();
    const client = new WeightedThresholdPolicyClient(POLICY, deps);
    const signer = delegatedSigner(1);

    await client.setSignerWeight(signer, 3, makeRule([signer]));

    const [target, fnName, args] = deps.execute.mock.calls[0];
    expect(target).toBe(POLICY);
    expect(fnName).toBe("set_signer_weight");
    expect(args[0].type).toBe("scvVec"); // encoded Signer
    expect(scValToNative(args[1])).toBe(3); // weight
  });
});

describe("SpendingLimitPolicyClient", () => {
  it("decodes get_spending_limit_data", async () => {
    const deps = makeDeps();
    const data = xdr.ScVal.scvMap([
      entry("cached_total_spent", i128(500n)),
      entry("period_ledgers", xdr.ScVal.scvU32(100)),
      entry("spending_history", xdr.ScVal.scvVec([
        xdr.ScVal.scvMap([
          entry("amount", i128(500n)),
          entry("ledger_sequence", xdr.ScVal.scvU32(42)),
        ]),
      ])),
      entry("spending_limit", i128(1000n)),
    ]);
    deps.rpc.simulateTransaction.mockResolvedValue({ result: { retval: data } });
    const client = new SpendingLimitPolicyClient(POLICY, deps);

    const result = await client.getSpendingLimitData(2);

    expect(result.spending_limit).toBe(1000n);
    expect(result.period_ledgers).toBe(100);
    expect(result.cached_total_spent).toBe(500n);
    expect(result.spending_history).toEqual([{ amount: 500n, ledger_sequence: 42 }]);
  });

  it("routes set_spending_limit through execute() with an i128", async () => {
    const deps = makeDeps();
    const client = new SpendingLimitPolicyClient(POLICY, deps);

    await client.setSpendingLimit(1_000_000n, makeRule([delegatedSigner(1)]));

    const [target, fnName, args] = deps.execute.mock.calls[0];
    expect(target).toBe(POLICY);
    expect(fnName).toBe("set_spending_limit");
    expect(scValToNative(args[0])).toBe(1_000_000n);
  });
});

function entry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

function i128(amount: bigint): xdr.ScVal {
  return xdr.ScVal.scvI128(
    new xdr.Int128Parts({
      lo: xdr.Uint64.fromString((amount & BigInt("0xFFFFFFFFFFFFFFFF")).toString()),
      hi: xdr.Int64.fromString((amount >> BigInt(64)).toString()),
    })
  );
}
