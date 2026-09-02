/**
 * Custom error classes for the Smart Account Kit SDK.
 *
 * These provide structured error handling with error codes and context.
 *
 * @packageDocumentation
 */

/**
 * Error codes for Smart Account Kit operations.
 */
export enum SmartAccountErrorCode {
  // Configuration errors (1xxx)
  INVALID_CONFIG = 1001,
  MISSING_CONFIG = 1002,

  // Wallet state errors (2xxx)
  WALLET_NOT_CONNECTED = 2001,
  WALLET_ALREADY_EXISTS = 2002,
  WALLET_NOT_FOUND = 2003,
  WALLET_CODE_NOT_ACCEPTED = 2004,
  WALLET_PROVENANCE_UNVERIFIED = 2005,
  WALLET_OWNERSHIP_UNVERIFIED = 2006,
  WALLET_AMBIGUOUS = 2007,

  // Credential errors (3xxx)
  CREDENTIAL_NOT_FOUND = 3001,
  CREDENTIAL_ALREADY_EXISTS = 3002,
  CREDENTIAL_INVALID = 3003,
  CREDENTIAL_DEPLOYMENT_FAILED = 3004,

  // WebAuthn errors (4xxx)
  WEBAUTHN_REGISTRATION_FAILED = 4001,
  WEBAUTHN_AUTHENTICATION_FAILED = 4002,
  WEBAUTHN_NOT_SUPPORTED = 4003,
  WEBAUTHN_CANCELLED = 4004,

  // Transaction errors (5xxx)
  TRANSACTION_SIMULATION_FAILED = 5001,
  TRANSACTION_SIGNING_FAILED = 5002,
  TRANSACTION_SUBMISSION_FAILED = 5003,
  TRANSACTION_TIMEOUT = 5004,

  // Signer errors (6xxx)
  SIGNER_NOT_FOUND = 6001,
  SIGNER_INVALID = 6002,
  POLICY_NOT_FOUND = 6003,

  // Validation errors (7xxx)
  INVALID_ADDRESS = 7001,
  INVALID_AMOUNT = 7002,
  INVALID_INPUT = 7003,

  // Storage errors (8xxx)
  STORAGE_READ_FAILED = 8001,
  STORAGE_WRITE_FAILED = 8002,

  // Session errors (9xxx)
  SESSION_EXPIRED = 9001,
  SESSION_INVALID = 9002,

  // Contract-level failures decoded from on-chain diagnostics (10xxx).
  // The raw contract code (e.g. 3010) is carried separately on ContractError;
  // this sentinel keeps the SDK-level code space from colliding with the
  // overlapping 3xxx contract range.
  CONTRACT_ERROR = 10000,
}

/**
 * Base error class for all Smart Account Kit errors.
 */
export class SmartAccountError extends Error {
  /** Error code for programmatic error handling */
  readonly code: SmartAccountErrorCode;

  /** Additional context about the error */
  readonly context?: Record<string, unknown>;

  /** Original error that caused this error */
  readonly cause?: Error;

  constructor(
    message: string,
    code: SmartAccountErrorCode,
    options?: {
      context?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = "SmartAccountError";
    this.code = code;
    this.context = options?.context;
    this.cause = options?.cause;

    // Maintain proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, SmartAccountError);
    }
  }

  /**
   * Create a formatted error message with code and context.
   */
  toDetailedString(): string {
    let msg = `[${this.code}] ${this.message}`;
    if (this.context) {
      msg += `\nContext: ${JSON.stringify(this.context, null, 2)}`;
    }
    if (this.cause) {
      msg += `\nCaused by: ${this.cause.message}`;
    }
    return msg;
  }
}

/**
 * Error thrown when wallet is not connected but operation requires it.
 */
export class WalletNotConnectedError extends SmartAccountError {
  constructor(operation?: string) {
    super(
      operation
        ? `Wallet must be connected to ${operation}`
        : "Wallet not connected",
      SmartAccountErrorCode.WALLET_NOT_CONNECTED,
      { context: operation ? { operation } : undefined }
    );
    this.name = "WalletNotConnectedError";
  }
}

/**
 * Error thrown when a credential cannot be found.
 */
export class CredentialNotFoundError extends SmartAccountError {
  constructor(credentialId: string) {
    super(
      `Credential not found: ${credentialId}`,
      SmartAccountErrorCode.CREDENTIAL_NOT_FOUND,
      { context: { credentialId } }
    );
    this.name = "CredentialNotFoundError";
  }
}

/**
 * Error thrown when a signer cannot be found.
 */
export class SignerNotFoundError extends SmartAccountError {
  constructor(identifier: string, hint?: string) {
    super(
      hint
        ? `No signer found for: ${identifier}. ${hint}`
        : `No signer found for: ${identifier}`,
      SmartAccountErrorCode.SIGNER_NOT_FOUND,
      { context: { identifier } }
    );
    this.name = "SignerNotFoundError";
  }
}

/**
 * Error thrown when a resolved smart account runs code that is not on the
 * accepted allowlist.
 *
 * Every connection checks current code identity.
 * Local storage and indexer data cannot bypass the accepted-code list.
 */
export class WalletCodeNotAcceptedError extends SmartAccountError {
  constructor(contractId: string, actual: string, accepted: readonly string[]) {
    super(
      `Smart account ${contractId} runs unaccepted code (${actual}). ` +
        "If this is a legitimate upgrade, add its WASM hash to `acceptedWasmHashes`.",
      SmartAccountErrorCode.WALLET_CODE_NOT_ACCEPTED,
      { context: { contractId, actual, accepted } }
    );
    this.name = "WalletCodeNotAcceptedError";
  }
}

/** Error thrown when immutable wallet birth cannot be verified. */
export class WalletProvenanceError extends SmartAccountError {
  constructor(
    contractId: string,
    message: string,
    context?: Record<string, unknown>
  ) {
    super(
      `Wallet ${contractId} has unverified birth provenance. ${message}`,
      SmartAccountErrorCode.WALLET_PROVENANCE_UNVERIFIED,
      { context: { contractId, ...context } }
    );
    this.name = "WalletProvenanceError";
  }
}

/** Error thrown when a passkey cannot prove control of a wallet signer. */
export class WalletOwnershipError extends SmartAccountError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, SmartAccountErrorCode.WALLET_OWNERSHIP_UNVERIFIED, {
      context,
    });
    this.name = "WalletOwnershipError";
  }
}

/** Error thrown when discovery requires an explicit wallet selection. */
export class WalletAmbiguousError extends SmartAccountError {
  constructor(contractIds: readonly string[]) {
    super(
      "Multiple wallet candidates require an explicit contract selection",
      SmartAccountErrorCode.WALLET_AMBIGUOUS,
      { context: { contractIds } }
    );
    this.name = "WalletAmbiguousError";
  }
}

/**
 * Error thrown when a policy cannot be found on a context rule.
 */
export class PolicyNotFoundError extends SmartAccountError {
  constructor(policyAddress: string, contextRuleId?: number) {
    super(
      contextRuleId !== undefined
        ? `Policy ${policyAddress} not found on context rule ${contextRuleId}`
        : `Policy not found: ${policyAddress}`,
      SmartAccountErrorCode.POLICY_NOT_FOUND,
      { context: { policyAddress, contextRuleId } }
    );
    this.name = "PolicyNotFoundError";
  }
}

/**
 * Error thrown when transaction simulation fails.
 */
export class SimulationError extends SmartAccountError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, SmartAccountErrorCode.TRANSACTION_SIMULATION_FAILED, {
      context: details,
    });
    this.name = "SimulationError";
  }
}

/**
 * Error thrown when transaction submission fails.
 */
export class SubmissionError extends SmartAccountError {
  constructor(message: string, hash?: string, details?: Record<string, unknown>) {
    super(message, SmartAccountErrorCode.TRANSACTION_SUBMISSION_FAILED, {
      context: { hash, ...details },
    });
    this.name = "SubmissionError";
  }
}

/**
 * Error thrown when input validation fails.
 */
export class ValidationError extends SmartAccountError {
  constructor(
    message: string,
    code:
      | SmartAccountErrorCode.INVALID_ADDRESS
      | SmartAccountErrorCode.INVALID_AMOUNT
      | SmartAccountErrorCode.INVALID_INPUT
      | SmartAccountErrorCode.INVALID_CONFIG
      | SmartAccountErrorCode.MISSING_CONFIG = SmartAccountErrorCode.INVALID_INPUT,
    context?: Record<string, unknown>
  ) {
    super(message, code, { context });
    this.name = "ValidationError";
  }
}

/**
 * Error thrown when WebAuthn operations fail.
 */
export class WebAuthnError extends SmartAccountError {
  constructor(
    message: string,
    code:
      | SmartAccountErrorCode.WEBAUTHN_REGISTRATION_FAILED
      | SmartAccountErrorCode.WEBAUTHN_AUTHENTICATION_FAILED
      | SmartAccountErrorCode.WEBAUTHN_NOT_SUPPORTED
      | SmartAccountErrorCode.WEBAUTHN_CANCELLED,
    cause?: Error
  ) {
    super(message, code, { cause });
    this.name = "WebAuthnError";
  }
}

/**
 * Error decoded from an on-chain contract failure code.
 *
 * Produced by {@link decodeContractError} when a simulation or submission
 * diagnostic reports an `Error(Contract, #NNNN)`. Carries both the raw contract
 * code and its enum variant name so callers can branch on the exact failure.
 *
 * @example
 * ```typescript
 * const result = await kit.transfer(...);
 * if (!result.success && result.error instanceof ContractError) {
 *   if (result.error.contractErrorName === "TooManySigners") { ... }
 * }
 * ```
 */
export class ContractError extends SmartAccountError {
  /** Raw contract error code (e.g. 3010). */
  readonly contractCode: number;

  /** Enum variant name from the contract (e.g. "TooManySigners"). */
  readonly contractErrorName: string;

  /** The contract family the code belongs to (e.g. "SmartAccount"). */
  readonly family: string;

  constructor(
    contractCode: number,
    contractErrorName: string,
    family: string,
    message: string,
    options?: {
      context?: Record<string, unknown>;
      cause?: Error;
    }
  ) {
    super(message, SmartAccountErrorCode.CONTRACT_ERROR, {
      context: { contractCode, contractErrorName, family, ...options?.context },
      cause: options?.cause,
    });
    this.name = "ContractError";
    this.contractCode = contractCode;
    this.contractErrorName = contractErrorName;
    this.family = family;
  }
}

/**
 * Error thrown when session is expired or invalid.
 */
export class SessionError extends SmartAccountError {
  constructor(
    message: string,
    code:
      | SmartAccountErrorCode.SESSION_EXPIRED
      | SmartAccountErrorCode.SESSION_INVALID = SmartAccountErrorCode.SESSION_INVALID
  ) {
    super(message, code);
    this.name = "SessionError";
  }
}

/**
 * Helper to wrap unknown errors in SmartAccountError.
 */
export function wrapError(
  err: unknown,
  defaultCode: SmartAccountErrorCode = SmartAccountErrorCode.INVALID_INPUT
): SmartAccountError {
  if (err instanceof SmartAccountError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err : undefined;

  return new SmartAccountError(message, defaultCode, { cause });
}
