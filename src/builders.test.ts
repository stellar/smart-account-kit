import { describe, expect, it } from "vitest";
import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import {
  createDelegatedSigner,
  createExternalSigner,
  createWebAuthnSigner,
  createEd25519Signer,
  createDefaultContext,
  createCallContractContext,
  createCreateContractContext,
  createCreateContractExternalRefContext,
  createThresholdParams,
  createWeightedThresholdParams,
  createSpendingLimitParams,
  truncateAddress,
  describeSignerType,
  formatSignerForDisplay,
  formatContextType,
} from "./builders";
import { ValidationError } from "./errors";

const G = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const C = StrKey.encodeContract(hash(Buffer.from("contract")));

describe("signer builders", () => {
  it("createDelegatedSigner validates the G-address", () => {
    expect(createDelegatedSigner(G)).toEqual({ tag: "Delegated", values: [G] });
    expect(() => createDelegatedSigner("nope")).toThrow(ValidationError);
    expect(() => createDelegatedSigner(C)).toThrow(ValidationError);
  });

  it("createExternalSigner wraps verifier + key data", () => {
    const keyData = Buffer.alloc(65, 4);
    const signer = createExternalSigner(C, keyData);
    expect(signer.tag).toBe("External");
    expect(signer.values[0]).toBe(C);
    expect(Buffer.from(signer.values[1] as Buffer)).toEqual(keyData);
  });

  it("createWebAuthnSigner concatenates pubkey and credential id", () => {
    const pubkey = new Uint8Array(65).fill(4);
    const signer = createWebAuthnSigner(C, pubkey, "credhex");
    expect(signer.tag).toBe("External");
    const keyData = signer.values[1] as Buffer;
    expect(keyData.length).toBeGreaterThan(65);
  });

  it("createEd25519Signer requires a 32-byte public key", () => {
    const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
    const signer = createEd25519Signer(C, kp.rawPublicKey());
    expect(signer.tag).toBe("External");
    expect((signer.values[1] as Buffer).length).toBe(32);
    expect(() => createEd25519Signer(C, Buffer.alloc(31))).toThrow(ValidationError);
  });
});

describe("context type builders", () => {
  it("creates Default / CallContract / CreateContract", () => {
    expect(createDefaultContext()).toEqual({ tag: "Default", values: undefined });
    expect(createCallContractContext(C)).toEqual({ tag: "CallContract", values: [C] });
    expect(() => createCallContractContext("nope")).toThrow(ValidationError);

    const wasm = "aa".repeat(32);
    const ctx = createCreateContractContext(wasm);
    expect(ctx.tag).toBe("CreateContract");
    expect((ctx.values[0] as Buffer).length).toBe(32);
  });

  it("creates CreateContractExternalRef for a contract owner and tag", () => {
    expect(createCreateContractExternalRefContext(C, "account-v1")).toEqual({
      tag: "CreateContractExternalRef",
      values: [C, "account-v1"],
    });
    expect(() => createCreateContractExternalRefContext(G, "account-v1")).toThrow(ValidationError);
    expect(() => createCreateContractExternalRefContext("nope", "account-v1")).toThrow(
      ValidationError
    );
    expect(() => createCreateContractExternalRefContext(C, 7 as never)).toThrow(ValidationError);
  });
});

describe("policy param builders", () => {
  it("createThresholdParams rejects thresholds below 1", () => {
    expect(createThresholdParams(2)).toEqual({ threshold: 2 });
    expect(() => createThresholdParams(0)).toThrow(ValidationError);
  });

  it("createWeightedThresholdParams builds the weights map", () => {
    const signer = createDelegatedSigner(G);
    const params = createWeightedThresholdParams(2, new Map([[signer, 2]]));
    expect(params.threshold).toBe(2);
    expect(params.signer_weights.get(signer)).toBe(2);
  });

  it("createSpendingLimitParams normalizes to bigint and validates", () => {
    const params = createSpendingLimitParams(1000, 100);
    expect(params.spending_limit).toBe(1000n);
    expect(params.period_ledgers).toBe(100);
    expect(() => createSpendingLimitParams(0n, 100)).toThrow(ValidationError);
  });
});

describe("display helpers", () => {
  it("truncateAddress shortens long addresses only", () => {
    expect(truncateAddress(G, 4)).toContain("...");
    expect(truncateAddress("short")).toBe("short");
  });

  it("describeSignerType classifies signers", () => {
    expect(describeSignerType(createDelegatedSigner(G))).toBe("Stellar Account");
    const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
    expect(describeSignerType(createEd25519Signer(C, kp.rawPublicKey()))).toBe("Ed25519");
    expect(describeSignerType(createWebAuthnSigner(C, new Uint8Array(65).fill(4), "cred"))).toBe(
      "Passkey (WebAuthn)"
    );
  });

  it("formatSignerForDisplay returns a typed display", () => {
    expect(formatSignerForDisplay(createDelegatedSigner(G)).type).toBe("G-Address");
  });

  it("formatContextType renders each context type", () => {
    expect(formatContextType(createDefaultContext())).toContain("Default");
    expect(formatContextType(createCallContractContext(C))).toContain("Call Contract");
    expect(formatContextType(createCreateContractContext("aa".repeat(32)))).toContain(
      "Create Contract"
    );
    expect(
      formatContextType(createCreateContractExternalRefContext(C, "account-v1"))
    ).toBe(`Create Contract from Ref: ${truncateAddress(C)} / account-v1`);
  });
});
