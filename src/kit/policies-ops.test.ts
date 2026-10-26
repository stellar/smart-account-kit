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
  buildPoliciesScVal,
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

/**
 * An ScVal as another copy of `@stellar/stellar-sdk` hands it over: not an
 * instance of the kit's `xdr.ScVal`, with a `toXDR()` that returns plain bytes.
 */
function foreignScVal(value: xdr.ScVal): { toXDR: () => Uint8Array } {
  const bytes = Uint8Array.from(value.toXDR());
  return { toXDR: () => bytes };
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
    ).toThrow(/different @stellar\/stellar-sdk copy/);
  });

  it("re-decodes an ScVal from another @stellar/stellar-sdk copy", () => {
    const original = xdr.ScVal.scvVec([xdr.ScVal.scvU32(7), xdr.ScVal.scvSymbol("cap")]);
    const map = buildConstructorPolicies([
      { address: POLICY_A, type: "custom", installParams: foreignScVal(original) },
      { address: POLICY_B, installParams: foreignScVal(xdr.ScVal.scvVoid()) },
    ]);
    const decoded = map.get(POLICY_A);
    expect(decoded).toBeInstanceOf(xdr.ScVal);
    expect(decoded!.toXDR("base64")).toBe(original.toXDR("base64"));
    expect(map.get(POLICY_B)).toBeInstanceOf(xdr.ScVal);
  });

  it.each([
    ["bytes that are not an ScVal", () => Uint8Array.from([0xff, 0xff, 0xff, 0xff])],
    ["a toXDR() that is not bytes", () => "AAAAAQ==" as unknown as Uint8Array],
    [
      "a toXDR() that throws",
      () => {
        throw new Error("boom");
      },
    ],
  ])("refuses a foreign object with %s", (_label, toXDR) => {
    let caught: unknown;
    try {
      buildConstructorPolicies([
        { address: POLICY_A, type: "custom", installParams: { toXDR } },
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).code).toBe(SmartAccountErrorCode.INVALID_INPUT);
    expect((caught as ValidationError).message).toMatch(
      /does not encode an xdr\.ScVal\. It may come from a different @stellar\/stellar-sdk copy/
    );
  });

  it.each([
    [
      "a toXDR getter that throws",
      () =>
        Object.defineProperty({}, "toXDR", {
          get() {
            throw new Error("getter boom");
          },
        }),
    ],
    [
      "a toXDR() that throws a null-prototype object",
      () => ({
        toXDR() {
          throw Object.create(null);
        },
      }),
    ],
  ])("refuses a hostile foreign object with %s as a ValidationError", (_label, make) => {
    for (const build of [
      () => buildConstructorPolicies([{ address: POLICY_A, type: "custom", installParams: make() }]),
      () =>
        buildPoliciesScVal(
          makeClient(),
          new Map<string, unknown>([[POLICY_A, make()]]),
          new Map([[POLICY_A, "custom" as const]])
        ),
    ]) {
      let caught: unknown;
      try {
        build();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).code).toBe(SmartAccountErrorCode.INVALID_INPUT);
    }
  });

  it("calls a foreign encoder once, with its own receiver", () => {
    const original = xdr.ScVal.scvU32(9);
    let calls = 0;
    const foreign = {
      bytes: original.toXDR(),
      toXDR(this: { bytes: Uint8Array }) {
        calls += 1;
        return this.bytes;
      },
    };
    const map = buildConstructorPolicies([
      { address: POLICY_A, type: "custom", installParams: foreign },
    ]);
    expect(calls).toBe(1);
    expect(map.get(POLICY_A)!.toXDR("base64")).toBe(original.toXDR("base64"));
  });

  it("returns an empty map for no policies", () => {
    expect(buildConstructorPolicies([]).size).toBe(0);
  });
});

describe("buildPoliciesScVal", () => {
  const POLICY = "CB2WQXF2XXDGUV2CTVQ23RLN3ESI3IY5KKX3KVXWBNRTTWDHZM76NVKJ";

  it("re-decodes a custom ScVal from another @stellar/stellar-sdk copy", () => {
    const original = xdr.ScVal.scvU32(42);
    const result = buildPoliciesScVal(
      makeClient(),
      new Map<string, unknown>([[POLICY, foreignScVal(original)]]),
      new Map([[POLICY, "custom" as const]])
    );
    const [entry] = result.map()!;
    expect(entry.val()).toBeInstanceOf(xdr.ScVal);
    expect(entry.val().toXDR("base64")).toBe(original.toXDR("base64"));
  });

  it("refuses a foreign object whose toXDR() is not an ScVal", () => {
    expect(() =>
      buildPoliciesScVal(
        makeClient(),
        new Map<string, unknown>([
          [POLICY, { toXDR: () => Uint8Array.from([0xff, 0xff, 0xff, 0xff]) }],
        ]),
        new Map([[POLICY, "custom" as const]])
      )
    ).toThrow(/different @stellar\/stellar-sdk copy/);
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
