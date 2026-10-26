/**
 * Compare the Soroban data that a signed xdr envelope declares with the data
 * that the proxy's own simulation of that envelope returns.
 *
 * Simulation ignores the declared footprint and resources. Without this
 * comparison, a client can sign an envelope with an empty footprint and a
 * declared resource fee at the ceiling. Simulation succeeds, the transaction
 * fails on chain, and the sponsor pays.
 *
 * This module imports only the SDK, so a script can load it on its own.
 */

import type { xdr } from "@stellar/stellar-sdk";

/**
 * The declared resource fee may be at most
 * `2 * minResourceFee + DECLARED_RESOURCE_FEE_SLACK_STROOPS`.
 *
 * The kit's envelope comes from an `AssembledTransaction` simulation moments
 * before the proxy simulates it again, so the declared fee is the earlier
 * `minResourceFee`. Rent and write fees move with ledger state between the
 * two simulations; testnet deployments showed 128,608 declared against
 * 128,609 or 128,610 simulated. The factor of 2 allows 100% upward drift, or
 * a client that pads its fee. The constant (0.001 XLM) covers a very small
 * minimum, where 2x leaves no room for rounding. A declared fee below the
 * minimum is not refused: the drift goes both ways, and a lower declared fee
 * also lowers the most that the transaction can charge.
 */
export const DECLARED_RESOURCE_FEE_SLACK_STROOPS = 10_000n;

export function maxDeclaredResourceFee(minResourceFee: bigint): bigint {
  return 2n * minResourceFee + DECLARED_RESOURCE_FEE_SLACK_STROOPS;
}

function keySet(keys: xdr.LedgerKey[]): Set<string> {
  return new Set(keys.map((key) => key.toXDR("base64")));
}

/**
 * Return a refusal message, or null when the declared data covers the
 * simulation.
 *
 * - The declared resource fee stays within `maxDeclaredResourceFee`.
 * - Every simulated read-write key is a declared read-write key.
 * - Every simulated read-only key is a declared read-only or read-write key.
 *
 * Instruction and byte counts are not compared, because they drift between
 * two simulations of the same envelope. An envelope that declares too few
 * fails on chain, and the sponsor pays the inclusion fee and the
 * non-refundable part of the resource fee. The fee bound above, the
 * `MAX_TOTAL_FEE_STROOPS` ceiling, and the rate limits bound that loss.
 */
export function declaredSorobanDataProblem(
  declared: xdr.SorobanTransactionData,
  simulated: xdr.SorobanTransactionData,
  minResourceFee: bigint
): string | null {
  const declaredFee = declared.resourceFee().toBigInt();
  if (declaredFee > maxDeclaredResourceFee(minResourceFee)) {
    return "Declared resource fee is too far above the simulated minimum";
  }

  const declaredFootprint = declared.resources().footprint();
  const declaredReadWrite = keySet(declaredFootprint.readWrite());
  const declaredReadOnly = keySet(declaredFootprint.readOnly());
  const simulatedFootprint = simulated.resources().footprint();
  for (const key of simulatedFootprint.readWrite()) {
    if (!declaredReadWrite.has(key.toXDR("base64"))) {
      return "Declared footprint is missing a simulated read-write key";
    }
  }
  for (const key of simulatedFootprint.readOnly()) {
    const encoded = key.toXDR("base64");
    if (!declaredReadOnly.has(encoded) && !declaredReadWrite.has(encoded)) {
      return "Declared footprint is missing a simulated read-only key";
    }
  }
  return null;
}
