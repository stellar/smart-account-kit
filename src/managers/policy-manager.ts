/**
 * Policy Manager
 *
 * Manages policies attached to context rules.
 * Policies provide additional authorization constraints beyond signers.
 */

import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { PolicyNotFoundError } from "../errors.js";
import { unwrapContractResult } from "../contract-errors.js";

/** Dependencies required by PolicyManager */
export interface PolicyManagerDeps {
  /** Get the connected wallet client, throws if not connected */
  requireWallet: () => {
    wallet: {
      add_policy: (args: {
        context_rule_id: number;
        policy: string;
        install_param: unknown;
      }) => Promise<AssembledTransaction<number>>;
      get_policy_id: (args: { policy: string }) => Promise<AssembledTransaction<number>>;
      remove_policy: (args: {
        context_rule_id: number;
        policy_id: number;
      }) => Promise<AssembledTransaction<null>>;
    };
  };
}

/**
 * Manages policies for smart account context rules.
 *
 * Policies are contracts that enforce additional authorization constraints.
 * Common policy types include:
 * - Threshold policies (require N-of-M signers)
 * - Weighted threshold policies (signers have different weights)
 * - Spending limit policies (restrict transaction amounts)
 *
 * @example
 * ```typescript
 * import { createThresholdParams } from "smart-account-kit";
 *
 * // Add a 2-of-3 threshold policy
 * const params = createThresholdParams(2);
 * const tx = await kit.policies.add(
 *   contextRuleId,
 *   thresholdPolicyAddress,
 *   params
 * );
 * await tx.signAndSend();
 * ```
 */
export class PolicyManager {
  constructor(private deps: PolicyManagerDeps) {}

  /**
   * Add a policy to a context rule.
   *
   * @param contextRuleId - The numeric ID of the context rule to add the policy to
   * @param policyAddress - The contract address of the policy to add
   * @param installParams - Policy-specific installation parameters
   * @returns Assembled transaction that adds the policy when signed and sent
   * @throws Error if not connected to a wallet
   */
  async add(contextRuleId: number, policyAddress: string, installParams: unknown) {
    return this.deps.requireWallet().wallet.add_policy({
      context_rule_id: contextRuleId,
      policy: policyAddress,
      install_param: installParams,
    });
  }

  /**
   * Remove a policy from a context rule.
   *
   * @param contextRuleId - The numeric ID of the context rule to remove the policy from
   * @param policyAddress - The contract address of the policy to remove
   * @returns Assembled transaction that removes the policy when signed and sent
   * @throws Error if not connected to a wallet
   */
  async remove(contextRuleId: number, policyAddress: string) {
    const { wallet } = this.deps.requireWallet();
    const policyId = unwrapContractResult(
      (await wallet.get_policy_id({ policy: policyAddress })).result,
      (error) =>
        error.contractCode === 3008
          ? new PolicyNotFoundError(policyAddress, contextRuleId)
          : error
    );

    if (policyId === undefined || policyId === null) {
      throw new PolicyNotFoundError(policyAddress, contextRuleId);
    }

    return wallet.remove_policy({
      context_rule_id: contextRuleId,
      policy_id: policyId,
    });
  }

  /**
   * Resolve the stable on-chain policy ID for a policy address (get_policy_id).
   *
   * @param policyAddress - The policy contract address to look up
   * @returns The policy's numeric ID
   * @throws {PolicyNotFoundError} If the policy is not registered
   * @throws Error if not connected to a wallet
   */
  async idOf(policyAddress: string): Promise<number> {
    const { wallet } = this.deps.requireWallet();
    const policyId = unwrapContractResult(
      (await wallet.get_policy_id({ policy: policyAddress })).result,
      (error) =>
        error.contractCode === 3008
          ? new PolicyNotFoundError(policyAddress)
          : error
    );
    if (policyId === undefined || policyId === null) {
      throw new PolicyNotFoundError(policyAddress);
    }
    return policyId;
  }
}
