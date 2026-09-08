import { describe, expect, it } from "vitest";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import {
  validateContextRule,
  validateContextRuleName,
  validateExternalKeySize,
  validatePolicyCount,
  validateSigner,
  validateSigners,
  validateValidUntil,
} from "./validation";
import { ValidationError } from "./errors";
import { MAX_EXTERNAL_KEY_SIZE, MAX_POLICIES, MAX_SIGNERS } from "./constants";
import { DEFAULT_DEPLOYER_PUBLIC_KEY } from "./utils";

function delegated(seed: number): ContractSigner {
  return { tag: "Delegated", values: [`G${"A".repeat(55)}`.slice(0, 56) + seed] };
}

function external(keyLen: number): ContractSigner {
  return { tag: "External", values: ["CVERIFIER", Buffer.alloc(keyLen, 1)] };
}

describe("validateContextRuleName", () => {
  it("accepts a name at the 20-byte boundary", () => {
    expect(() => validateContextRuleName("a".repeat(20))).not.toThrow();
  });

  it("rejects a name over 20 bytes", () => {
    expect(() => validateContextRuleName("a".repeat(21))).toThrow(ValidationError);
  });

  it("counts UTF-8 bytes, not characters (multi-byte boundary)", () => {
    // "é" is 2 UTF-8 bytes; 10 of them = 20 bytes (ok), 11 = 22 bytes (too long).
    expect(() => validateContextRuleName("é".repeat(10))).not.toThrow();
    expect(() => validateContextRuleName("é".repeat(11))).toThrow(ValidationError);
    // A 4-byte emoji: 5 = 20 bytes ok, 6 = 24 bytes too long.
    expect(() => validateContextRuleName("😀".repeat(5))).not.toThrow();
    expect(() => validateContextRuleName("😀".repeat(6))).toThrow(ValidationError);
  });

  it("rejects an empty name", () => {
    expect(() => validateContextRuleName("")).toThrow(ValidationError);
  });
});

describe("validateExternalKeySize", () => {
  it("accepts key data at the max size", () => {
    expect(() => validateExternalKeySize(Buffer.alloc(MAX_EXTERNAL_KEY_SIZE))).not.toThrow();
  });

  it("rejects key data over the max size", () => {
    expect(() => validateExternalKeySize(Buffer.alloc(MAX_EXTERNAL_KEY_SIZE + 1))).toThrow(
      ValidationError
    );
  });
});

describe("validateSigners", () => {
  it("accepts up to MAX_SIGNERS", () => {
    const signers = Array.from({ length: MAX_SIGNERS }, () => external(65));
    expect(() => validateSigners(signers)).not.toThrow();
  });

  it("rejects more than MAX_SIGNERS", () => {
    const signers = Array.from({ length: MAX_SIGNERS + 1 }, () => external(65));
    expect(() => validateSigners(signers)).toThrow(ValidationError);
  });

  it("accounts for existing signers", () => {
    expect(() => validateSigners([external(65)], MAX_SIGNERS)).toThrow(ValidationError);
  });

  it("rejects a signer with oversized key data", () => {
    expect(() => validateSigners([external(MAX_EXTERNAL_KEY_SIZE + 1)])).toThrow(
      ValidationError
    );
  });

  it("rejects the shared default deployer as a delegated signer", () => {
    expect(() =>
      validateSigner({
        tag: "Delegated",
        values: [DEFAULT_DEPLOYER_PUBLIC_KEY],
      })
    ).toThrow(ValidationError);
  });
});

describe("validatePolicyCount", () => {
  it("accepts up to MAX_POLICIES", () => {
    expect(() => validatePolicyCount(MAX_POLICIES)).not.toThrow();
  });

  it("rejects more than MAX_POLICIES", () => {
    expect(() => validatePolicyCount(MAX_POLICIES + 1)).toThrow(ValidationError);
    expect(() => validatePolicyCount(1, MAX_POLICIES)).toThrow(ValidationError);
  });
});

describe("validateValidUntil", () => {
  it("allows undefined (no expiration)", () => {
    expect(() => validateValidUntil(undefined)).not.toThrow();
  });

  it("allows a future ledger", () => {
    expect(() => validateValidUntil(200, 100)).not.toThrow();
    expect(() => validateValidUntil(100, 100)).not.toThrow();
  });

  it("rejects a past ledger", () => {
    expect(() => validateValidUntil(50, 100)).toThrow(ValidationError);
  });

  it("rejects a non-u32 value", () => {
    expect(() => validateValidUntil(-1)).toThrow(ValidationError);
    expect(() => validateValidUntil(0x1_0000_0000)).toThrow(ValidationError);
  });
});

describe("validateContextRule", () => {
  it("rejects a rule with no signers and no policies", () => {
    expect(() =>
      validateContextRule({ name: "empty", signers: [], policyCount: 0 })
    ).toThrow(ValidationError);
  });

  it("accepts a rule with a policy but no signers", () => {
    expect(() =>
      validateContextRule({ name: "ok", signers: [], policyCount: 1 })
    ).not.toThrow();
  });

  it("accepts a valid rule", () => {
    expect(() =>
      validateContextRule({
        name: "primary",
        signers: [delegated(1)],
        policyCount: 0,
      })
    ).not.toThrow();
  });
});
