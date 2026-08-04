import { describe, expect, it } from "vitest";
import { SmartAccountError as AccountErrorSpec } from "smart-account-kit-bindings";
import {
  CONTRACT_ERROR_REGISTRY,
  contractErrorFromCode,
  decodeContractError,
  failedTransaction,
  simulationFailure,
  submissionFailure,
} from "./contract-errors";
import {
  ContractError,
  SimulationError,
  SubmissionError,
  ValidationError,
  SmartAccountErrorCode,
} from "./errors";

describe("decodeContractError", () => {
  it("decodes a contract error from a simulation-style diagnostic string", () => {
    const error = decodeContractError(
      "HostError: Error(Contract, #3010) ... TooManySigners"
    );
    expect(error).toBeInstanceOf(ContractError);
    expect(error?.contractCode).toBe(3010);
    expect(error?.contractErrorName).toBe("TooManySigners");
    expect(error?.family).toBe("SmartAccount");
    expect(error?.code).toBe(SmartAccountErrorCode.CONTRACT_ERROR);
    expect(error?.message).toContain("15 signers");
  });

  it.each([
    [3000, "ContextRuleNotFound", "SmartAccount"],
    [3016, "UnauthorizedSigner", "SmartAccount"],
    [3114, "ChallengeInvalid", "WebAuthn"],
    [3201, "InvalidThreshold", "SimpleThreshold"],
    [3211, "InvalidThreshold", "WeightedThreshold"],
    [3221, "SpendingLimitExceeded", "SpendingLimit"],
    [3227, "OnlyCallContractAllowed", "SpendingLimit"],
  ])("decodes #%i as %s (%s)", (code, name, family) => {
    const error = decodeContractError(`Error(Contract, #${code})`);
    expect(error?.contractCode).toBe(code);
    expect(error?.contractErrorName).toBe(name);
    expect(error?.family).toBe(family);
  });

  it("handles whitespace variations in the marker", () => {
    expect(decodeContractError("Error(Contract,#3007)")?.contractErrorName).toBe(
      "DuplicateSigner"
    );
    expect(decodeContractError("Error(Contract,   #3007)")?.contractErrorName).toBe(
      "DuplicateSigner"
    );
  });

  it("decodes from an Error object's message", () => {
    const error = decodeContractError(new Error("Error(Contract, #3221)"));
    expect(error?.contractErrorName).toBe("SpendingLimitExceeded");
  });

  it("returns null when there is no contract marker", () => {
    expect(decodeContractError("some unrelated error")).toBeNull();
    expect(decodeContractError("")).toBeNull();
    expect(decodeContractError(null)).toBeNull();
    expect(decodeContractError(undefined)).toBeNull();
  });

  it("returns null for an unknown contract code", () => {
    expect(decodeContractError("Error(Contract, #9999)")).toBeNull();
  });
});

describe("contractErrorFromCode", () => {
  it("builds a ContractError for a known code", () => {
    const error = contractErrorFromCode(3005);
    expect(error).toBeInstanceOf(ContractError);
    expect(error?.contractErrorName).toBe("PastValidUntil");
  });

  it("returns null for an unknown code", () => {
    expect(contractErrorFromCode(1234)).toBeNull();
  });
});

describe("CONTRACT_ERROR_REGISTRY", () => {
  /**
   * `unwrapContractResult` maps a contract Err back to a typed error by matching
   * the Err's message against this registry. The SDK builds that message from the
   * spec's doc string (`errorCases()[n].doc()`), so for the codes reachable
   * through a wrapped call site the registry text must equal the doc verbatim —
   * otherwise the mapping silently degrades to an untyped Error.
   *
   * Only these three are reachable today: ContextRuleNotFound via the
   * get_context_rule fallback, SignerNotFound via get_signer_id, PolicyNotFound
   * via get_policy_id. The rest of the registry is deliberately paraphrased for
   * users and is not required to match.
   */
  it("keeps the translated codes' messages identical to the spec doc strings", async () => {
    const { Client } = await import("smart-account-kit-bindings");
    const client = new Client({
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://example.invalid",
    });
    const docs = new Map<number, string>(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).spec.errorCases().map((c: any) => [c.value(), c.doc().toString()])
    );

    for (const code of [3000, 3006, 3008]) {
      expect(docs.get(code), `spec is missing code ${code}`).toBeDefined();
      expect(
        CONTRACT_ERROR_REGISTRY[code].message,
        `registry message for ${code} drifted from the bindings doc string, so ` +
          `unwrapContractResult can no longer type it`
      ).toBe(docs.get(code));
    }
  });

  it("stays in sync with the generated bindings' SmartAccountError map", () => {
    // The account contract family (3000-3016) is the source of truth in the
    // generated bindings; a regen must not drift from this table.
    const bindingsEntries = Object.entries(
      AccountErrorSpec as Record<string, { message: string }>
    );
    expect(bindingsEntries.length).toBeGreaterThan(0);

    for (const [codeStr, { message: name }] of bindingsEntries) {
      const code = Number(codeStr);
      const info = CONTRACT_ERROR_REGISTRY[code];
      expect(info, `registry missing SmartAccount code ${code}`).toBeDefined();
      expect(info.name).toBe(name);
      expect(info.family).toBe("SmartAccount");
    }
  });

  it("does not claim code 3001 (absent by design)", () => {
    expect(CONTRACT_ERROR_REGISTRY[3001]).toBeUndefined();
  });

  it("keeps every entry's key aligned with its code field", () => {
    for (const [key, info] of Object.entries(CONTRACT_ERROR_REGISTRY)) {
      expect(info.code).toBe(Number(key));
    }
  });
});

describe("transaction failure helpers", () => {
  it("failedTransaction exposes the error code via error.code and omits an empty hash", () => {
    const failure = failedTransaction(new ValidationError("bad input"));
    expect(failure.success).toBe(false);
    expect(failure.error).toBeInstanceOf(ValidationError);
    expect(failure.error.code).toBe(SmartAccountErrorCode.INVALID_INPUT);
    expect(failure.hash).toBeUndefined();
  });

  it("failedTransaction preserves a provided hash", () => {
    const failure = failedTransaction(new SubmissionError("boom"), "abc123");
    expect(failure.hash).toBe("abc123");
  });

  it("simulationFailure decodes a contract error when present", () => {
    const failure = simulationFailure("Error(Contract, #3221)");
    expect(failure.error).toBeInstanceOf(ContractError);
    expect(failure.error.code).toBe(SmartAccountErrorCode.CONTRACT_ERROR);
  });

  it("simulationFailure falls back to SimulationError", () => {
    const failure = simulationFailure("host is unreachable");
    expect(failure.error).toBeInstanceOf(SimulationError);
    expect(failure.error.message).toContain("host is unreachable");
  });

  it("submissionFailure falls back to SubmissionError and keeps the hash", () => {
    const failure = submissionFailure("rejected", "tx-hash");
    expect(failure.error).toBeInstanceOf(SubmissionError);
    expect(failure.hash).toBe("tx-hash");
  });
});
