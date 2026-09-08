/**
 * Client-side validation of contract limits.
 *
 * Mirrors the deployed stellar-accounts contract constraints (scratchpad #576
 * §A/§E) so callers get clear {@link ValidationError}s before submission instead
 * of opaque on-chain failures (TooManySigners, NameTooLong, KeyDataTooLarge, …).
 *
 * @packageDocumentation
 */

import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import {
  MAX_EXTERNAL_KEY_SIZE,
  MAX_NAME_SIZE,
  MAX_POLICIES,
  MAX_SIGNERS,
} from "./constants.js";
import { SmartAccountErrorCode, ValidationError } from "./errors.js";
import { isDefaultDeployer } from "./utils.js";

/** UTF-8 byte length of a string. */
function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Validate a context rule name against the contract's `MAX_NAME_SIZE` (20 UTF-8
 * bytes — byte length, not character count).
 *
 * @throws {ValidationError} If the name is empty or exceeds the byte limit
 */
export function validateContextRuleName(name: string): void {
  const byteLength = utf8ByteLength(name);
  if (byteLength === 0) {
    throw new ValidationError(
      "Context rule name must not be empty",
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "name" }
    );
  }
  if (byteLength > MAX_NAME_SIZE) {
    throw new ValidationError(
      `Context rule name must be at most ${MAX_NAME_SIZE} UTF-8 bytes (got ${byteLength})`,
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "name", byteLength, maxBytes: MAX_NAME_SIZE }
    );
  }
}

/**
 * Validate an External signer's key data against `MAX_EXTERNAL_KEY_SIZE`.
 *
 * @throws {ValidationError} If the key data exceeds the byte limit
 */
export function validateExternalKeySize(keyData: Uint8Array | Buffer): void {
  if (keyData.length > MAX_EXTERNAL_KEY_SIZE) {
    throw new ValidationError(
      `External signer key data must be at most ${MAX_EXTERNAL_KEY_SIZE} bytes (got ${keyData.length})`,
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "keyData", length: keyData.length, maxBytes: MAX_EXTERNAL_KEY_SIZE }
    );
  }
}

/**
 * Validate a single signer: External signers must have key data within
 * `MAX_EXTERNAL_KEY_SIZE`.
 *
 * @throws {ValidationError} If the signer is malformed
 */
export function validateSigner(signer: ContractSigner): void {
  if (signer.tag === "Delegated" && isDefaultDeployer(signer.values[0] as string)) {
    throw new ValidationError(
      "The shared default deployer cannot be a delegated signer",
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "signer" }
    );
  }
  if (signer.tag === "External") {
    const keyData = signer.values[1];
    validateExternalKeySize(Buffer.from(keyData as Uint8Array | Buffer));
  }
}

/**
 * Validate a set of signers being added to (or already on) a context rule.
 *
 * @param signers - Signers to validate
 * @param existingCount - Signers already on the rule (default 0)
 * @throws {ValidationError} If the total exceeds `MAX_SIGNERS` or any signer is invalid
 */
export function validateSigners(
  signers: ContractSigner[],
  existingCount = 0
): void {
  const total = existingCount + signers.length;
  if (total > MAX_SIGNERS) {
    throw new ValidationError(
      `A context rule may have at most ${MAX_SIGNERS} signers (would have ${total})`,
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "signers", total, max: MAX_SIGNERS }
    );
  }
  for (const signer of signers) {
    validateSigner(signer);
  }
}

/**
 * Validate a policy count against `MAX_POLICIES`.
 *
 * @param policyCount - Number of policies being added
 * @param existingCount - Policies already on the rule (default 0)
 * @throws {ValidationError} If the total exceeds `MAX_POLICIES`
 */
export function validatePolicyCount(policyCount: number, existingCount = 0): void {
  const total = existingCount + policyCount;
  if (total > MAX_POLICIES) {
    throw new ValidationError(
      `A context rule may have at most ${MAX_POLICIES} policies (would have ${total})`,
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "policies", total, max: MAX_POLICIES }
    );
  }
}

/**
 * Validate a `valid_until` expiration ledger: must be at or after the current
 * ledger when provided (the contract rejects a past `valid_until`).
 *
 * @param validUntil - Expiration ledger, or undefined for no expiration
 * @param currentLedger - Current ledger sequence (omit to skip the past check)
 * @throws {ValidationError} If `valid_until` is not a valid future u32
 */
export function validateValidUntil(
  validUntil: number | undefined,
  currentLedger?: number
): void {
  if (validUntil === undefined) {
    return;
  }
  if (!Number.isInteger(validUntil) || validUntil < 0 || validUntil > 0xffffffff) {
    throw new ValidationError(
      "valid_until must be a u32 ledger sequence",
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "valid_until", value: validUntil }
    );
  }
  if (currentLedger !== undefined && validUntil < currentLedger) {
    throw new ValidationError(
      `valid_until (${validUntil}) is in the past (current ledger ${currentLedger})`,
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "valid_until", validUntil, currentLedger }
    );
  }
}

/**
 * Validate the full set of arguments for adding a context rule.
 *
 * @throws {ValidationError} On any limit violation
 */
export function validateContextRule(args: {
  name: string;
  signers: ContractSigner[];
  policyCount: number;
  validUntil?: number;
  currentLedger?: number;
}): void {
  validateContextRuleName(args.name);
  validateSigners(args.signers);
  validatePolicyCount(args.policyCount);
  validateValidUntil(args.validUntil, args.currentLedger);
  if (args.signers.length === 0 && args.policyCount === 0) {
    throw new ValidationError(
      "A context rule must have at least one signer or policy",
      SmartAccountErrorCode.INVALID_INPUT,
      { field: "signers" }
    );
  }
}
