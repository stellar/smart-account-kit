/**
 * Contract error decoding.
 *
 * Maps on-chain contract failure codes (surfaced in simulation/submission
 * diagnostics as `Error(Contract, #NNNN)`) to typed {@link ContractError}s with
 * the enum variant name and a human-readable message.
 *
 * Codes mirror the deployed OpenZeppelin stellar-accounts contracts:
 * - SmartAccount        3000-3016
 * - WebAuthn verifier   3110-3119
 * - SimpleThreshold     3200-3203
 * - WeightedThreshold   3210-3214
 * - SpendingLimit       3220-3227
 *
 * The SmartAccount family (3000-3016) is the source of truth in the generated
 * bindings' `SmartAccountError` map; `contract-errors.test.ts` asserts this
 * table stays in sync with it so a bindings regen surfaces any drift.
 *
 * @packageDocumentation
 */

import {
  ContractError,
  SimulationError,
  SubmissionError,
  SmartAccountError,
} from "./errors.js";
import type { TransactionFailure } from "./types.js";

/**
 * Contract families that expose custom error codes.
 */
export type ContractErrorFamily =
  | "SmartAccount"
  | "WebAuthn"
  | "SimpleThreshold"
  | "WeightedThreshold"
  | "SpendingLimit";

/**
 * A single contract error entry: code, enum variant name, family, and a
 * human-readable message.
 */
export interface ContractErrorInfo {
  code: number;
  name: string;
  family: ContractErrorFamily;
  message: string;
}

function entry(
  code: number,
  name: string,
  family: ContractErrorFamily,
  message: string
): [number, ContractErrorInfo] {
  return [code, { code, name, family, message }];
}

/**
 * Registry of every known contract error code, keyed by numeric code.
 */
export const CONTRACT_ERROR_REGISTRY: Readonly<Record<number, ContractErrorInfo>> =
  Object.freeze(
    Object.fromEntries([
      // --- SmartAccount (3000-3016; 3001 intentionally absent) ---
      entry(3000, "ContextRuleNotFound", "SmartAccount", "The specified context rule does not exist."),
      entry(3002, "UnvalidatedContext", "SmartAccount", "The provided context could not be validated against any rule."),
      entry(3003, "ExternalVerificationFailed", "SmartAccount", "External signature verification failed."),
      entry(3004, "NoSignersAndPolicies", "SmartAccount", "A context rule must retain at least one signer or policy."),
      entry(3005, "PastValidUntil", "SmartAccount", "The valid_until ledger is already in the past."),
      entry(3006, "SignerNotFound", "SmartAccount", "The specified signer was not found."),
      entry(3007, "DuplicateSigner", "SmartAccount", "The signer already exists in the context rule."),
      entry(3008, "PolicyNotFound", "SmartAccount", "The specified policy was not found."),
      entry(3009, "DuplicatePolicy", "SmartAccount", "The policy already exists in the context rule."),
      entry(3010, "TooManySigners", "SmartAccount", "The context rule exceeds the maximum of 15 signers."),
      entry(3011, "TooManyPolicies", "SmartAccount", "The context rule exceeds the maximum of 5 policies."),
      entry(3012, "MathOverflow", "SmartAccount", "An internal ID counter reached its maximum value."),
      entry(3013, "KeyDataTooLarge", "SmartAccount", "The external signer key data exceeds the maximum of 256 bytes."),
      entry(3014, "ContextRuleIdsLengthMismatch", "SmartAccount", "The number of context rule IDs does not match the number of auth contexts."),
      entry(3015, "NameTooLong", "SmartAccount", "The context rule name exceeds the maximum of 20 bytes."),
      entry(3016, "UnauthorizedSigner", "SmartAccount", "A provided signer is not part of any validated context rule."),

      // --- WebAuthn verifier (3110-3119) ---
      entry(3110, "SignaturePayloadInvalid", "WebAuthn", "The signature payload was malformed."),
      entry(3111, "ClientDataTooLong", "WebAuthn", "The WebAuthn clientDataJSON exceeded the 1024-byte limit."),
      entry(3112, "JsonParseError", "WebAuthn", "The WebAuthn clientDataJSON could not be parsed."),
      entry(3113, "TypeFieldInvalid", "WebAuthn", "The clientData `type` was not \"webauthn.get\"."),
      entry(3114, "ChallengeInvalid", "WebAuthn", "The clientData challenge did not match the auth digest."),
      entry(3115, "AuthDataFormatInvalid", "WebAuthn", "The authenticator data was shorter than the required 37 bytes."),
      entry(3116, "PresentBitNotSet", "WebAuthn", "The authenticator User Present (UP) flag was not set."),
      entry(3117, "VerifiedBitNotSet", "WebAuthn", "The authenticator User Verified (UV) flag was not set."),
      entry(3118, "BackupEligibilityAndStateNotSet", "WebAuthn", "The authenticator backup eligibility/state flags were rejected."),
      entry(3119, "KeyDataInvalid", "WebAuthn", "The external signer key data was not a valid secp256r1 public key."),

      // --- SimpleThreshold policy (3200-3203) ---
      entry(3200, "SmartAccountNotInstalled", "SimpleThreshold", "The threshold policy is not installed for this smart account."),
      entry(3201, "InvalidThreshold", "SimpleThreshold", "The threshold must be greater than zero and at most the signer count."),
      entry(3202, "NotAllowed", "SimpleThreshold", "The caller is not allowed to perform this policy operation."),
      entry(3203, "AlreadyInstalled", "SimpleThreshold", "The threshold policy is already installed for this smart account."),

      // --- WeightedThreshold policy (3210-3214) ---
      entry(3210, "SmartAccountNotInstalled", "WeightedThreshold", "The weighted-threshold policy is not installed for this smart account."),
      entry(3211, "InvalidThreshold", "WeightedThreshold", "The threshold must be greater than zero and at most the sum of signer weights."),
      entry(3212, "MathOverflow", "WeightedThreshold", "Summing signer weights overflowed."),
      entry(3213, "NotAllowed", "WeightedThreshold", "The caller is not allowed to perform this policy operation."),
      entry(3214, "AlreadyInstalled", "WeightedThreshold", "The weighted-threshold policy is already installed for this smart account."),

      // --- SpendingLimit policy (3220-3227) ---
      entry(3220, "SmartAccountNotInstalled", "SpendingLimit", "The spending-limit policy is not installed for this smart account."),
      entry(3221, "SpendingLimitExceeded", "SpendingLimit", "The transfer would exceed the spending limit for the current period."),
      entry(3222, "InvalidLimitOrPeriod", "SpendingLimit", "The spending limit and period ledgers must both be greater than zero."),
      entry(3223, "NotAllowed", "SpendingLimit", "The caller is not allowed to perform this policy operation."),
      entry(3224, "HistoryCapacityExceeded", "SpendingLimit", "The spending history exceeded its maximum capacity."),
      entry(3225, "AlreadyInstalled", "SpendingLimit", "The spending-limit policy is already installed for this smart account."),
      entry(3226, "LessThanZero", "SpendingLimit", "The transfer amount was negative."),
      entry(3227, "OnlyCallContractAllowed", "SpendingLimit", "The spending-limit policy only applies to CallContract context rules."),
    ])
  );

/**
 * Matches the host's rendering of a contract error, e.g. `Error(Contract, #3010)`.
 */
const CONTRACT_ERROR_PATTERN = /Error\(Contract,\s*#(\d+)\)/;

function diagnosticToString(diagnostic: unknown): string {
  if (diagnostic == null) return "";
  if (typeof diagnostic === "string") return diagnostic;
  if (diagnostic instanceof Error) return diagnostic.message;
  try {
    return JSON.stringify(diagnostic);
  } catch {
    return String(diagnostic);
  }
}

/**
 * Build a {@link ContractError} for a known contract code, or `null` if the code
 * is not in the registry.
 *
 * @param code - Raw contract error code (e.g. 3010)
 * @param context - Optional extra context to attach (e.g. the raw diagnostic)
 */
export function contractErrorFromCode(
  code: number,
  context?: Record<string, unknown>
): ContractError | null {
  const info = CONTRACT_ERROR_REGISTRY[code];
  if (!info) return null;
  return new ContractError(info.code, info.name, info.family, info.message, {
    context,
  });
}

/**
 * Decode a simulation/submission diagnostic into a typed {@link ContractError}.
 *
 * Scans the (stringified) diagnostic for an `Error(Contract, #NNNN)` marker and
 * looks the code up in {@link CONTRACT_ERROR_REGISTRY}. Returns `null` when no
 * contract code is present or the code is unknown, letting callers fall back to
 * a generic {@link SimulationError}/{@link SubmissionError}.
 *
 * @param diagnostic - A diagnostic string, Error, or any value to stringify
 */
export function decodeContractError(diagnostic: unknown): ContractError | null {
  const text = diagnosticToString(diagnostic);
  const match = text.match(CONTRACT_ERROR_PATTERN);
  if (!match) return null;
  const code = Number.parseInt(match[1], 10);
  return contractErrorFromCode(code, { diagnostic: text });
}

/** Structural check for the SDK's `Ok`/`Err` rust-result wrappers. */
function isRustResult<T>(
  value: unknown
): value is { isErr(): boolean; unwrap(): T; unwrapErr(): { message: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "isErr" in value &&
    "unwrap" in value &&
    "unwrapErr" in value
  );
}

/**
 * Unwrap an SDK rust result, translating a known `Err` through the registry.
 *
 * A contract method whose spec declares error cases does **not** throw when it
 * reverts: the SDK wires `errorTypes` from the spec, so `parseError` returns an
 * `Err` and `.result` resolves with it. Reading `.result` directly therefore
 * yields an `Err` object where a value is expected. Route those reads through
 * here.
 *
 * The `Err` carries only a message — the spec's doc string — so that is the
 * only key available for mapping it back to a code. When the message is not
 * recognised we fall through to `unwrap()`, which throws; an `Err` can never
 * continue on as data.
 */
export function unwrapContractResult<T>(
  result: T,
  mapError: (error: ContractError) => Error = (error) => error
): T {
  if (!isRustResult<T>(result)) return result;
  if (!result.isErr()) return result.unwrap();

  const message = result.unwrapErr().message;
  const info = Object.values(CONTRACT_ERROR_REGISTRY).find(
    (entry) => entry.message === message
  );
  const error = info && contractErrorFromCode(info.code, { diagnostic: message });
  if (error) throw mapError(error);

  return result.unwrap();
}

/**
 * Build a {@link TransactionFailure} from an already-typed error.
 */
export function failedTransaction(
  error: SmartAccountError,
  hash?: string
): TransactionFailure {
  return {
    success: false,
    error,
    ...(hash ? { hash } : {}),
  };
}

/**
 * Build a {@link TransactionFailure} from a simulation diagnostic, decoding a
 * contract error when present and otherwise wrapping the diagnostic in a
 * {@link SimulationError}.
 */
export function simulationFailure(
  diagnostic: unknown,
  hash?: string
): TransactionFailure {
  const error =
    decodeContractError(diagnostic) ??
    new SimulationError(diagnosticToString(diagnostic) || "Simulation failed");
  return failedTransaction(error, hash);
}

/**
 * Build a {@link TransactionFailure} from a submission diagnostic, decoding a
 * contract error when present and otherwise wrapping the diagnostic in a
 * {@link SubmissionError}.
 */
export function submissionFailure(
  diagnostic: unknown,
  hash?: string
): TransactionFailure {
  const error =
    decodeContractError(diagnostic) ??
    new SubmissionError(
      diagnosticToString(diagnostic) || "Submission failed",
      hash
    );
  return failedTransaction(error, hash);
}
