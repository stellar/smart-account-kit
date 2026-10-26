import { Address, xdr } from "@stellar/stellar-sdk";
import type { Client as SmartAccountClient, Signer as ContractSigner } from "smart-account-kit-bindings";
import { SmartAccountErrorCode, ValidationError, WalletNotConnectedError } from "../errors.js";
import type { PolicyConfig } from "../types.js";
import type {
  SimpleThresholdAccountParams,
  SpendingLimitAccountParams,
  WeightedThresholdAccountParams,
} from "../contract-types.js";
import { compareScVal, signerToScVal } from "./auth-payload.js";
import { buildI128ScVal } from "./tx-ops.js";

const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);

type XdrEncodable = { toXDR: (format?: "raw") => Uint8Array };

function isXdrEncodable(value: unknown): value is XdrEncodable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toXDR?: unknown }).toXDR === "function"
  );
}

/**
 * Return custom policy params as an `xdr.ScVal` from the kit's SDK, or
 * `undefined` when the value is not an XDR object.
 *
 * An app on another copy of `@stellar/stellar-sdk` (for example an older
 * 16.x next to the kit's own copy) passes an `xdr.ScVal` that fails
 * `instanceof`. The wire format is the same, so re-decode its bytes with the
 * kit's SDK.
 *
 * @throws {ValidationError} If the object's `toXDR()` does not give ScVal bytes
 */
function toKitScVal(value: unknown, address: string): xdr.ScVal | undefined {
  if (value instanceof xdr.ScVal) {
    return value;
  }
  if (!isXdrEncodable(value)) {
    return undefined;
  }
  try {
    const bytes = value.toXDR();
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError("toXDR() did not return bytes");
    }
    return xdr.ScVal.fromXDR(Buffer.from(bytes));
  } catch (error) {
    throw new ValidationError(
      `Policy ${address}: custom policy installParams has toXDR() but does not encode an ` +
        `xdr.ScVal. It may come from a different @stellar/stellar-sdk copy; pass an ` +
        `xdr.ScVal whose toXDR() returns valid ScVal bytes.`,
      SmartAccountErrorCode.INVALID_INPUT,
      { address, cause: error instanceof Error ? error.message : String(error) }
    );
  }
}

function policyAddressToScVal(address: string): xdr.ScVal {
  try {
    return new Address(address).toScVal();
  } catch (error) {
    throw new ValidationError(
      `Invalid policy address: ${address}`,
      SmartAccountErrorCode.INVALID_ADDRESS,
      {
        address,
        cause: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/** Return a new policy map in the Soroban host's ScAddress key order. */
export function sortPolicyMap<T>(policies: Map<string, T>): Map<string, T> {
  const entries = [...policies.entries()].map(([address, value]) => ({
    address,
    value,
    key: policyAddressToScVal(address),
  }));

  entries.sort((left, right) => compareScVal(left.key, right.key));
  return new Map(entries.map(({ address, value }) => [address, value]));
}

function symbolEntry(key: string, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
}

function requireU32(value: unknown, field: string): number {
  // Accept numbers, bigints, and decimal numeric strings (the generated spec's
  // stringToScVal accepts string numerics for large ints, so callers reasonably
  // pass e.g. "8640" for period_ledgers).
  let big: bigint;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${field} must be a u32`);
    }
    big = BigInt(value);
  } else if (typeof value === "bigint") {
    big = value;
  } else if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    big = BigInt(value.trim());
  } else {
    throw new Error(`${field} must be a u32`);
  }
  if (big < 0n || big > 0xffffffffn) {
    throw new Error(`${field} must be a u32`);
  }
  return Number(big);
}

function requireI128(value: unknown, field: string): bigint {
  let big: bigint;
  if (typeof value === "bigint") {
    big = value;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new Error(`${field} must be an integer, bigint, or numeric string`);
    }
    big = BigInt(value);
  } else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    big = BigInt(value.trim());
  } else {
    throw new Error(`${field} must be an integer, bigint, or numeric string`);
  }
  if (big < I128_MIN || big > I128_MAX) {
    throw new Error(`${field} is out of i128 range`);
  }
  return big;
}

function encodeThresholdParams(params: unknown): xdr.ScVal {
  const { threshold } = params as SimpleThresholdAccountParams;
  return xdr.ScVal.scvMap([
    symbolEntry("threshold", xdr.ScVal.scvU32(requireU32(threshold, "threshold"))),
  ]);
}

function encodeSpendingLimitParams(params: unknown): xdr.ScVal {
  const { period_ledgers, spending_limit } = params as SpendingLimitAccountParams;
  // Struct field order (period_ledgers < spending_limit) is the canonical map order.
  return xdr.ScVal.scvMap([
    symbolEntry("period_ledgers", xdr.ScVal.scvU32(requireU32(period_ledgers, "period_ledgers"))),
    symbolEntry("spending_limit", buildI128ScVal(requireI128(spending_limit, "spending_limit"))),
  ]);
}

function encodeWeightedThresholdParams(params: unknown): xdr.ScVal {
  const { signer_weights, threshold } = params as WeightedThresholdAccountParams;
  if (!(signer_weights instanceof Map)) {
    throw new Error("signer_weights must be a Map<Signer, number>");
  }
  const weightEntries: xdr.ScMapEntry[] = [];
  for (const [signer, weight] of signer_weights) {
    weightEntries.push(
      new xdr.ScMapEntry({
        key: signerToScVal(signer as ContractSigner),
        val: xdr.ScVal.scvU32(requireU32(weight, "signer weight")),
      })
    );
  }
  // Signer (vector) keys must be in Soroban host-sort order, not XDR-hex order:
  // same-verifier signers differ only in variable-length keyData, where the two
  // orders diverge and the host would reject the map. See compareScVal.
  weightEntries.sort((a, b) => compareScVal(a.key(), b.key()));
  return xdr.ScVal.scvMap([
    symbolEntry("signer_weights", xdr.ScVal.scvMap(weightEntries)),
    symbolEntry("threshold", xdr.ScVal.scvU32(requireU32(threshold, "threshold"))),
  ]);
}

const POLICY_PARAM_ENCODERS: Record<
  "threshold" | "spending_limit" | "weighted_threshold",
  (params: unknown) => xdr.ScVal
> = {
  threshold: encodeThresholdParams,
  spending_limit: encodeSpendingLimitParams,
  weighted_threshold: encodeWeightedThresholdParams,
};

/**
 * Convert policy install params into the ScVal the contract expects.
 *
 * The three example policies' param structs are encoded directly (no embedded
 * base64 contract spec blobs). The output is byte-identical to the generated
 * spec's encoding — see policies-ops.test.ts.
 *
 * @throws {ValidationError} If the params don't match the expected shape
 */
export function convertPolicyParams(
  policyType: "threshold" | "spending_limit" | "weighted_threshold",
  params: unknown
): xdr.ScVal {
  try {
    return POLICY_PARAM_ENCODERS[policyType](params);
  } catch (error) {
    // Never silently fall back to unconverted params: shipping the wrong ScVal
    // shape on-chain is a correctness hazard. Surface a typed error instead.
    throw new ValidationError(
      `Failed to convert ${policyType} policy parameters into an ScVal. ` +
        `Check that the params match the expected shape.`,
      SmartAccountErrorCode.INVALID_INPUT,
      {
        policyType,
        cause: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Convert a list of {@link PolicyConfig} into the `Map<Address, Val>` the smart
 * account `__constructor` expects.
 *
 * Known policy types are converted via {@link convertPolicyParams}; `"custom"`
 * (or omitted-type) policies must supply an `xdr.ScVal` directly. An ScVal
 * from another `@stellar/stellar-sdk` copy is re-decoded with the kit's SDK.
 *
 * @throws {ValidationError} If a custom policy's installParams is not an ScVal
 */
export function buildConstructorPolicies(
  policies: PolicyConfig[]
): Map<string, xdr.ScVal> {
  const map = new Map<string, xdr.ScVal>();
  for (const policy of policies) {
    let scParams: xdr.ScVal;
    if (policy.type && policy.type !== "custom") {
      scParams = convertPolicyParams(policy.type, policy.installParams);
    } else {
      const custom = toKitScVal(policy.installParams, policy.address);
      if (!custom) {
        throw new ValidationError(
          `Policy ${policy.address}: custom policies must provide installParams as an xdr.ScVal ` +
            `(or set a known 'type'). An xdr.ScVal from a different @stellar/stellar-sdk copy ` +
            `must still provide toXDR().`,
          SmartAccountErrorCode.INVALID_INPUT,
          { address: policy.address }
        );
      }
      scParams = custom;
    }
    map.set(policy.address, scParams);
  }
  return sortPolicyMap(map);
}

export function buildPoliciesScVal(
  wallet: SmartAccountClient | undefined,
  policies: Map<string, unknown>,
  policyTypes: Map<string, "threshold" | "spending_limit" | "weighted_threshold" | "custom">
): xdr.ScVal {
  if (!wallet) {
    throw new WalletNotConnectedError();
  }

  const entries: xdr.ScMapEntry[] = [];

  for (const [address, params] of policies) {
    const scAddress = policyAddressToScVal(address);

    const policyType = policyTypes.get(address);
    let scParams: xdr.ScVal;
    const customScVal =
      policyType && policyType !== "custom" ? undefined : toKitScVal(params, address);

    if (policyType && policyType !== "custom") {
      scParams = convertPolicyParams(policyType, params);
    } else if (customScVal) {
      scParams = customScVal;
    } else {
      // Custom (or unknown-type) policy: convert via the wallet spec. Never
      // silently fall back to Void — shipping the wrong ScVal shape on-chain is
      // a correctness hazard, so surface a typed error instead (mirrors
      // convertPolicyParams / buildConstructorPolicies).
      const walletObj = wallet as unknown as Record<string, unknown>;
      const spec = walletObj.spec as { nativeToScVal?: (val: unknown, type: xdr.ScSpecTypeDef) => xdr.ScVal } | undefined;
      if (!spec || typeof spec.nativeToScVal !== "function") {
        throw new ValidationError(
          `Policy ${address}: custom policy params could not be converted — provide installParams as an xdr.ScVal or set a known policy 'type'. ` +
            `An xdr.ScVal from a different @stellar/stellar-sdk copy must still provide toXDR().`,
          SmartAccountErrorCode.INVALID_INPUT,
          { address }
        );
      }
      try {
        scParams = spec.nativeToScVal(params, xdr.ScSpecTypeDef.scSpecTypeVal());
      } catch (error) {
        throw new ValidationError(
          `Policy ${address}: failed to convert custom policy params into an ScVal. ` +
            `If you passed an xdr.ScVal, it may come from a different @stellar/stellar-sdk copy.`,
          SmartAccountErrorCode.INVALID_INPUT,
          { address, cause: error instanceof Error ? error.message : String(error) }
        );
      }
    }

    entries.push(new xdr.ScMapEntry({
      key: scAddress,
      val: scParams,
    }));
  }

  // Address keys are fixed-width, but use the shared host-order comparator for
  // consistency and to avoid locale-sensitive string comparison.
  entries.sort((a, b) => compareScVal(a.key(), b.key()));

  return xdr.ScVal.scvMap(entries);
}
