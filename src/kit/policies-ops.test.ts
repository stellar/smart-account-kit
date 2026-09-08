import { describe, expect, it } from "vitest";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Client as SmartAccountClient } from "smart-account-kit-bindings";
import {
  createDefaultContext,
  createSpendingLimitParams,
  createThresholdParams,
  createWebAuthnSigner,
  createWeightedThresholdParams,
} from "../builders";
import {
  buildConstructorPolicies,
  convertPolicyParams,
  sortPolicyMap,
} from "./policies-ops";
import { SmartAccountErrorCode, ValidationError } from "../errors";
import { compareScVal } from "./auth-payload";

function makeClient() {
  return new SmartAccountClient({
    contractId: "CCWODDOZPWGUCYXFKFQTCBVU2USQ75Q3V7XWPARAXTL56WP723PRMB7B",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  });
}

function makePasskeySigner() {
  return createWebAuthnSigner(
    "CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU",
    Uint8Array.from([4, ...new Array(64).fill(1)]),
    "cred123"
  );
}

describe("convertPolicyParams", () => {
  it("encodes threshold params for add_policy", () => {
    const client = makeClient();
    const params = convertPolicyParams("threshold", createThresholdParams(1));

    expect(params).toBeInstanceOf(xdr.ScVal);
    expect(() =>
      client.spec.funcArgsToScVals("add_policy", {
        context_rule_id: 0,
        policy: "CB2WQXF2XXDGUV2CTVQ23RLN3ESI3IY5KKX3KVXWBNRTTWDHZM76NVKJ",
        install_param: params,
      })
    ).not.toThrow();
  });

  it("encodes spending-limit params for add_policy", () => {
    const client = makeClient();
    const params = convertPolicyParams(
      "spending_limit",
      createSpendingLimitParams(1_000_000n, 100)
    );

    expect(params).toBeInstanceOf(xdr.ScVal);
    expect(() =>
      client.spec.funcArgsToScVals("add_policy", {
        context_rule_id: 0,
        policy: "CBBZ2XP4LBDEO2EELTZKJSPQZDREFKCULL6CKIUQO53S42RZABOYQUK3",
        install_param: params,
      })
    ).not.toThrow();
  });

  it("encodes weighted-threshold params for add_context_rule", () => {
    const client = makeClient();
    const signer = makePasskeySigner();
    const weights = new Map([[signer, 1]]);
    const params = convertPolicyParams(
      "weighted_threshold",
      createWeightedThresholdParams(1, weights)
    );

    expect(params).toBeInstanceOf(xdr.ScVal);
    expect(() =>
      client.spec.funcArgsToScVals("add_context_rule", {
        context_type: createDefaultContext(),
        name: "Weighted Rule",
        valid_until: undefined,
        signers: [signer],
        policies: new Map([
          ["CCF65VXVORNOZBRR3EG3GZYSFS3ALDG44CDYN5T5KRWKYX6RXLKLXER4", params],
        ]),
      })
    ).not.toThrow();
  });

  it("throws a ValidationError instead of silently returning unconverted params", () => {
    // A threshold param shape that cannot be encoded as the UDT.
    expect(() =>
      convertPolicyParams("threshold", { not_a_threshold: "nope" })
    ).toThrow(ValidationError);
  });

  it("accepts decimal numeric strings for u32/i128 params (parity with the spec)", () => {
    // threshold (u32) as a string encodes identically to the numeric form.
    expect(convertPolicyParams("threshold", { threshold: "3" }).toXDR("base64")).toBe(
      convertPolicyParams("threshold", { threshold: 3 }).toXDR("base64")
    );

    // spending_limit mixes a u32 (period_ledgers) and an i128 (spending_limit);
    // both accept numeric strings.
    expect(
      convertPolicyParams("spending_limit", {
        period_ledgers: "100",
        spending_limit: "1000000",
      }).toXDR("base64")
    ).toBe(
      convertPolicyParams("spending_limit", {
        period_ledgers: 100,
        spending_limit: 1_000_000n,
      }).toXDR("base64")
    );
  });

  it("rejects non-numeric or out-of-range string params", () => {
    expect(() => convertPolicyParams("threshold", { threshold: "3.5" })).toThrow(ValidationError);
    expect(() => convertPolicyParams("threshold", { threshold: "-1" })).toThrow(ValidationError);
    expect(() =>
      convertPolicyParams("threshold", { threshold: "4294967296" })
    ).toThrow(ValidationError);
  });
});

describe("buildConstructorPolicies", () => {
  const POLICY_A = "CB2WQXF2XXDGUV2CTVQ23RLN3ESI3IY5KKX3KVXWBNRTTWDHZM76NVKJ";
  const POLICY_B = "CBBZ2XP4LBDEO2EELTZKJSPQZDREFKCULL6CKIUQO53S42RZABOYQUK3";

  it("converts known policy types into a Map<Address, ScVal>", () => {
    const map = buildConstructorPolicies([
      { address: POLICY_A, type: "threshold", installParams: createThresholdParams(1) },
      {
        address: POLICY_B,
        type: "spending_limit",
        installParams: createSpendingLimitParams(1_000_000n, 100),
      },
    ]);

    expect(map.size).toBe(2);
    expect(map.get(POLICY_A)).toBeInstanceOf(xdr.ScVal);
    expect(map.get(POLICY_B)).toBeInstanceOf(xdr.ScVal);
  });

  it("sorts two constructor policies by Soroban address order", () => {
    const map = buildConstructorPolicies([
      { address: POLICY_B, type: "threshold", installParams: createThresholdParams(2) },
      { address: POLICY_A, type: "threshold", installParams: createThresholdParams(1) },
    ]);
    const expected = [POLICY_B, POLICY_A].sort((left, right) =>
      compareScVal(new Address(left).toScVal(), new Address(right).toScVal())
    );

    expect([...map.keys()]).toEqual(expected);
  });

  it("passes through an xdr.ScVal for custom policies", () => {
    const custom = xdr.ScVal.scvVoid();
    const map = buildConstructorPolicies([
      { address: POLICY_A, type: "custom", installParams: custom },
    ]);
    expect(map.get(POLICY_A)).toBe(custom);
  });

  it("throws for a custom policy whose installParams is not an ScVal", () => {
    expect(() =>
      buildConstructorPolicies([
        { address: POLICY_A, type: "custom", installParams: { foo: 1 } },
      ])
    ).toThrow(ValidationError);
  });

  it("returns an empty map for no policies", () => {
    expect(buildConstructorPolicies([]).size).toBe(0);
  });
});

describe("sortPolicyMap", () => {
  it("reports an invalid policy address as a ValidationError", () => {
    try {
      sortPolicyMap(new Map([["not-a-contract-address", xdr.ScVal.scvVoid()]]));
      throw new Error("Expected sortPolicyMap to reject the invalid address");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(
        SmartAccountErrorCode.INVALID_ADDRESS
      );
    }
  });
});

describe("convertPolicyParams encoding (no embedded spec blobs)", () => {
  it("encodes threshold params to the pinned ScVal (byte-identical to the contract spec)", () => {
    const scv = convertPolicyParams("threshold", createThresholdParams(3));
    expect(scv.toXDR("base64")).toBe(
      "AAAAEQAAAAEAAAABAAAADwAAAAl0aHJlc2hvbGQAAAAAAAADAAAAAw=="
    );
  });

  it("encodes spending-limit params to the pinned ScVal", () => {
    const scv = convertPolicyParams(
      "spending_limit",
      createSpendingLimitParams(1_000_000n, 100)
    );
    expect(scv.toXDR("base64")).toBe(
      "AAAAEQAAAAEAAAACAAAADwAAAA5wZXJpb2RfbGVkZ2VycwAAAAAAAwAAAGQAAAAPAAAADnNwZW5kaW5nX2xpbWl0AAAAAAAKAAAAAAAAAAAAAAAAAA9CQA=="
    );
  });

  it("round-trips weighted params through scValToNative", () => {
    const signer = makePasskeySigner();
    const scv = convertPolicyParams(
      "weighted_threshold",
      createWeightedThresholdParams(1, new Map([[signer, 1]]))
    );
    const native = scValToNative(scv);
    expect(native.threshold).toBe(1);
  });
});
