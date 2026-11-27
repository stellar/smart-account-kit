/**
 * Typed clients for the three example policies (threshold, weighted-threshold,
 * spending-limit).
 *
 * - Getters are read-only and run via simulation against the policy contract.
 * - Setters require the smart account's authorization, so they are routed
 *   through the account's `execute()` (which calls the policy from within the
 *   smart-account context); the returned {@link AssembledTransaction} is signed
 *   and submitted like any other smart-account operation.
 *
 * Setters take the FULL {@link ContextRule} struct (not just its id), matching
 * the deployed contract signatures (scratchpad #576 §G).
 *
 * @remarks
 * CAVEAT: threshold policies are NOT auto-notified when a context rule's signer
 * set changes. After adding/removing signers you must call {@link
 * SimpleThresholdPolicyClient.setThreshold} /
 * {@link WeightedThresholdPolicyClient.setSignerWeight} to keep the policy
 * consistent, or authorization may break.
 *
 * @packageDocumentation
 */

import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  hash,
  scValToNative,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import type { ContextRule, Signer as ContractSigner } from "smart-account-kit-bindings";
import type { SpendingLimitData } from "./contract-types.js";
import { parseSignerScVal, signerToScVal } from "./kit/auth-payload.js";
import { buildI128ScVal } from "./kit/tx-ops.js";
import { SimulationError } from "./errors.js";
import { decodeContractError } from "./contract-errors.js";

/** Deterministic, well-known read-only source account for getter simulation. */
const READ_ONLY_SIM_ACCOUNT = new Account(
  Keypair.fromRawEd25519Seed(
    hash(new TextEncoder().encode("smart-account-kit-policy-read"))
  ).publicKey(),
  "0"
);

/** The generated ContextRule UDT type, used to encode setter arguments. */
const CONTEXT_RULE_TYPE = xdr.ScSpecTypeDef.scSpecTypeUdt(
  new xdr.ScSpecTypeUdt({ name: "ContextRule" })
);

/**
 * Dependencies a policy client needs from the SDK.
 */
export interface PolicyClientDeps {
  rpc: rpc.Server;
  networkPassphrase: string;
  timeoutInSeconds: number;
  /** The connected smart account contract id (throws if not connected). */
  getSmartAccount: () => string;
  /** Encode a ContextRule to ScVal via the account bindings spec. */
  encodeContextRule: (rule: ContextRule) => xdr.ScVal;
  /**
   * Build a smart-account-mediated `execute()` AssembledTransaction so the
   * policy setter runs with the smart account's authorization.
   */
  execute: (
    target: string,
    targetFn: string,
    targetArgs: unknown[]
  ) => Promise<AssembledTransaction<unknown>>;
}

abstract class PolicyClientBase {
  constructor(
    public readonly policyAddress: string,
    protected readonly deps: PolicyClientDeps
  ) {}

  protected smartAccountScVal(): xdr.ScVal {
    return xdr.ScVal.scvAddress(
      Address.fromString(this.deps.getSmartAccount()).toScAddress()
    );
  }

  /** Simulate a read-only policy getter and return the raw result ScVal. */
  protected async simulateGetter(
    fnName: string,
    args: xdr.ScVal[]
  ): Promise<xdr.ScVal> {
    const tx = new TransactionBuilder(READ_ONLY_SIM_ACCOUNT, {
      fee: BASE_FEE,
      networkPassphrase: this.deps.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(this.policyAddress).toScAddress(),
              functionName: fnName,
              args,
            })
          ),
          auth: [],
        })
      )
      .setTimeout(this.deps.timeoutInSeconds)
      .build();

    const sim = await this.deps.rpc.simulateTransaction(tx);
    if ("error" in sim && sim.error) {
      throw (
        decodeContractError(sim.error) ??
        new SimulationError(`${fnName} simulation failed: ${sim.error}`)
      );
    }
    const retval = "result" in sim ? sim.result?.retval : undefined;
    if (!retval) {
      throw new SimulationError(`${fnName} returned no result`);
    }
    return retval;
  }

  /** Route a policy setter through the smart account's execute(). */
  protected setter(
    fnName: string,
    args: xdr.ScVal[]
  ): Promise<AssembledTransaction<unknown>> {
    return this.deps.execute(this.policyAddress, fnName, args);
  }
}

/**
 * Typed client for the simple threshold policy.
 */
export class SimpleThresholdPolicyClient extends PolicyClientBase {
  /** Read the current N-of-M threshold for a context rule. */
  async getThreshold(contextRuleId: number): Promise<number> {
    const retval = await this.simulateGetter("get_threshold", [
      xdr.ScVal.scvU32(contextRuleId),
      this.smartAccountScVal(),
    ]);
    return Number(scValToNative(retval));
  }

  /**
   * Set the threshold. Returns an AssembledTransaction to sign and submit.
   * Call this after changing a rule's signer set.
   */
  setThreshold(
    threshold: number,
    contextRule: ContextRule
  ): Promise<AssembledTransaction<unknown>> {
    return this.setter("set_threshold", [
      xdr.ScVal.scvU32(threshold),
      this.deps.encodeContextRule(contextRule),
      this.smartAccountScVal(),
    ]);
  }
}

/**
 * Typed client for the weighted threshold policy.
 *
 * The contract enforces `threshold <= total signer weight` on every individual
 * `set_threshold` / `set_signer_weight` call, so reconfiguration is
 * order-sensitive (see the method docs). Calls made in the wrong order revert
 * with `InvalidThreshold`.
 */
export class WeightedThresholdPolicyClient extends PolicyClientBase {
  /** Read the current total-weight threshold for a context rule. */
  async getThreshold(contextRuleId: number): Promise<number> {
    const retval = await this.simulateGetter("get_threshold", [
      xdr.ScVal.scvU32(contextRuleId),
      this.smartAccountScVal(),
    ]);
    return Number(scValToNative(retval));
  }

  /** Read the per-signer weights for a context rule. */
  async getSignerWeights(
    contextRule: ContextRule
  ): Promise<Map<ContractSigner, number>> {
    const retval = await this.simulateGetter("get_signer_weights", [
      this.deps.encodeContextRule(contextRule),
      this.smartAccountScVal(),
    ]);
    return decodeSignerWeights(retval);
  }

  /**
   * Set the total-weight threshold.
   *
   * The contract requires `threshold <= total signer weight` at the time of
   * this call, so when raising the threshold above the current total weight,
   * raise signer weights first ({@link setSignerWeight}); otherwise this
   * reverts with `InvalidThreshold`.
   */
  setThreshold(
    threshold: number,
    contextRule: ContextRule
  ): Promise<AssembledTransaction<unknown>> {
    return this.setter("set_threshold", [
      xdr.ScVal.scvU32(threshold),
      this.deps.encodeContextRule(contextRule),
      this.smartAccountScVal(),
    ]);
  }

  /**
   * Set an individual signer's weight.
   *
   * The contract requires `threshold <= total signer weight` at the time of
   * this call, so when lowering or zeroing a weight (e.g. before removing a
   * signer), lower the threshold first ({@link setThreshold}) if the reduction
   * would drop the total weight below it; otherwise this reverts with
   * `InvalidThreshold`.
   */
  setSignerWeight(
    signer: ContractSigner,
    weight: number,
    contextRule: ContextRule
  ): Promise<AssembledTransaction<unknown>> {
    return this.setter("set_signer_weight", [
      signerToScVal(signer),
      xdr.ScVal.scvU32(weight),
      this.deps.encodeContextRule(contextRule),
      this.smartAccountScVal(),
    ]);
  }
}

/**
 * Typed client for the spending limit policy.
 */
export class SpendingLimitPolicyClient extends PolicyClientBase {
  /** Read the full spending-limit state for a context rule. */
  async getSpendingLimitData(contextRuleId: number): Promise<SpendingLimitData> {
    const retval = await this.simulateGetter("get_spending_limit_data", [
      xdr.ScVal.scvU32(contextRuleId),
      this.smartAccountScVal(),
    ]);
    return scValToNative(retval) as SpendingLimitData;
  }

  /** Set the spending limit (stroops). */
  setSpendingLimit(
    spendingLimit: bigint,
    contextRule: ContextRule
  ): Promise<AssembledTransaction<unknown>> {
    return this.setter("set_spending_limit", [
      buildI128ScVal(spendingLimit),
      this.deps.encodeContextRule(contextRule),
      this.smartAccountScVal(),
    ]);
  }
}

/**
 * Decode a `Map<Signer, u32>` result ScVal into a JS Map keyed by contract
 * signer (Signer keys are ScVal vectors, not scalars, so `scValToNative` can't
 * key them directly).
 */
function decodeSignerWeights(retval: xdr.ScVal): Map<ContractSigner, number> {
  if (retval.type !== "scvMap") {
    throw new SimulationError("get_signer_weights did not return a map");
  }
  const weights = new Map<ContractSigner, number>();
  for (const entry of retval.map ?? []) {
    weights.set(parseSignerScVal(entry.key), Number(scValToNative(entry.val)));
  }
  return weights;
}

/** The ContextRule UDT type used to encode setter arguments. */
export const CONTEXT_RULE_SPEC_TYPE = CONTEXT_RULE_TYPE;
