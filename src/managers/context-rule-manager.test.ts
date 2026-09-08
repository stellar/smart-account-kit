import { describe, expect, it, vi } from "vitest";
import { ContextRuleManager } from "./context-rule-manager";
import { getFilteredContextRules, listContextRules, readContextRule } from "../kit/context-rules";
import { makeDelegatedSigner } from "./test-utils";

vi.mock("../kit/context-rules", () => ({
  listContextRules: vi.fn(),
  getFilteredContextRules: vi.fn(),
  readContextRule: vi.fn(),
}));

function makeDeps() {
  const wallet = {
    add_context_rule: vi.fn(),
    get_context_rule: vi.fn(),
    get_context_rules_count: vi.fn(),
    remove_context_rule: vi.fn(),
    update_context_rule_name: vi.fn(),
    update_context_rule_valid_until: vi.fn(),
  };
  const requireWallet = vi.fn(() => ({ wallet, contractId: "CCONTRACT" }));
  const getContractDetailsFromIndexer = vi.fn();
  const probeRuleIds = { maxRuleId: 8, maxConsecutiveMisses: 3 };

  return {
    wallet,
    requireWallet,
    rpc: {} as never,
    networkPassphrase: "Test SDF Network ; September 2015",
    timeoutInSeconds: 30,
    getContractDetailsFromIndexer,
    probeRuleIds,
  };
}

describe("ContextRuleManager", () => {
  it("adds a context rule through the wallet client", async () => {
    const deps = makeDeps();
    deps.wallet.add_context_rule.mockResolvedValue({ result: { id: 7 } });
    const manager = new ContextRuleManager(deps);
    const signers = [makeDelegatedSigner(1)];
    const policies = new Map<string, unknown>([[
      "CB2WQXF2XXDGUV2CTVQ23RLN3ESI3IY5KKX3KVXWBNRTTWDHZM76NVKJ",
      { threshold: 2 },
    ]]);

    const result = await manager.add(
      { tag: "Default", values: undefined },
      "Rule",
      signers,
      policies,
      123
    );

    expect(deps.requireWallet).toHaveBeenCalledTimes(1);
    expect(deps.wallet.add_context_rule).toHaveBeenCalledWith({
      context_type: { tag: "Default", values: undefined },
      name: "Rule",
      valid_until: 123,
      signers,
      policies,
    });
    expect(result).toEqual({ result: { id: 7 } });
  });

  it("validates the rule before submitting (rejects an over-long name)", async () => {
    const deps = makeDeps();
    const manager = new ContextRuleManager(deps);

    await expect(
      manager.add(
        { tag: "Default", values: undefined },
        "a".repeat(21),
        [makeDelegatedSigner(1)],
        new Map()
      )
    ).rejects.toThrow();
    expect(deps.wallet.add_context_rule).not.toHaveBeenCalled();
  });

  it("returns the context rule count", async () => {
    const deps = makeDeps();
    deps.wallet.get_context_rules_count.mockResolvedValue({ result: 3 });
    const manager = new ContextRuleManager(deps);

    await expect(manager.count()).resolves.toBe(3);
    expect(deps.wallet.get_context_rules_count).toHaveBeenCalled();
  });

  it("gets a context rule by id", async () => {
    const deps = makeDeps();
    vi.mocked(readContextRule).mockResolvedValue({ id: 9 } as never);
    const manager = new ContextRuleManager(deps);

    const result = await manager.get(9);

    expect(readContextRule).toHaveBeenCalledWith(deps.wallet, 9, {
      rpc: deps.rpc,
      contractId: "CCONTRACT",
      networkPassphrase: deps.networkPassphrase,
      timeoutInSeconds: deps.timeoutInSeconds,
    });
    expect(result).toEqual({ result: { id: 9 } });
  });

  it("lists active context rules through the shared helper", async () => {
    const deps = makeDeps();
    const rules = [{ id: 1 }, { id: 2 }];
    vi.mocked(listContextRules).mockResolvedValue(rules as never);
    const manager = new ContextRuleManager(deps);

    await expect(manager.list()).resolves.toEqual(rules);

    expect(listContextRules).toHaveBeenCalledWith(deps.wallet, {
      getContractDetailsFromIndexer: deps.getContractDetailsFromIndexer,
      probeRuleIds: deps.probeRuleIds,
      rpc: deps.rpc,
      contractId: "CCONTRACT",
      networkPassphrase: deps.networkPassphrase,
      timeoutInSeconds: deps.timeoutInSeconds,
    });
  });

  it("filters rules by context type through the shared helper", async () => {
    const deps = makeDeps();
    const rules = [{ id: 3 }];
    vi.mocked(getFilteredContextRules).mockResolvedValue(rules as never);
    const manager = new ContextRuleManager(deps);
    const contextType = { tag: "CallContract", values: ["C".repeat(56)] } as const;

    await expect(manager.getAll(contextType)).resolves.toEqual(rules);

    expect(getFilteredContextRules).toHaveBeenCalledWith(deps.wallet, contextType, {
      getContractDetailsFromIndexer: deps.getContractDetailsFromIndexer,
      probeRuleIds: deps.probeRuleIds,
      rpc: deps.rpc,
      contractId: "CCONTRACT",
      networkPassphrase: deps.networkPassphrase,
      timeoutInSeconds: deps.timeoutInSeconds,
    });
  });

  it("removes, renames, and updates context rules", async () => {
    const deps = makeDeps();
    deps.wallet.remove_context_rule.mockResolvedValue({ result: null });
    deps.wallet.update_context_rule_name.mockResolvedValue({ result: { id: 4 } });
    deps.wallet.update_context_rule_valid_until.mockResolvedValue({ result: { id: 4 } });
    const manager = new ContextRuleManager(deps);

    await expect(manager.remove(4)).resolves.toEqual({ result: null });
    await expect(manager.updateName(4, "New Name")).resolves.toEqual({ result: { id: 4 } });
    await expect(manager.updateExpiration(4, 456)).resolves.toEqual({ result: { id: 4 } });
    await expect(manager.updateExpiration(4)).resolves.toEqual({ result: { id: 4 } });

    expect(deps.wallet.remove_context_rule).toHaveBeenCalledWith({ context_rule_id: 4 });
    expect(deps.wallet.update_context_rule_name).toHaveBeenCalledWith({
      context_rule_id: 4,
      name: "New Name",
    });
    expect(deps.wallet.update_context_rule_valid_until).toHaveBeenLastCalledWith({
      context_rule_id: 4,
      valid_until: undefined,
    });
  });
});
