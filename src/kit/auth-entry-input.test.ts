import { describe, expect, it } from "vitest";
import { Address, xdr } from "@stellar/stellar-sdk";
import { toAuthEntry } from "./auth-entry-input";
import { SmartAccountErrorCode, ValidationError } from "../errors";
import {
  ForeignXdrObject,
  SDK17_TRANSFER_ENTRY_BASE64,
  makeAddressAuthEntry,
  makeContract,
} from "../managers/test-utils";

function expectInvalidEntry(fn: () => unknown, message: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  expect((caught as ValidationError).code).toBe(SmartAccountErrorCode.INVALID_INPUT);
  expect((caught as ValidationError).message).toMatch(message);
}

describe("toAuthEntry", () => {
  it("returns a kit XDR object unchanged", () => {
    const entry = makeAddressAuthEntry(makeContract(1));
    expect(toAuthEntry(entry)).toBe(entry);
  });

  it("decodes a base64 string into an equal kit XDR object", () => {
    const entry = makeAddressAuthEntry(makeContract(1));
    const decoded = toAuthEntry(entry.toXDR("base64"));

    expect(decoded).toBeInstanceOf(xdr.SorobanAuthorizationEntry);
    expect(decoded).not.toBe(entry);
    expect(decoded.toXDR("base64")).toBe(entry.toXDR("base64"));
  });

  it("ignores surrounding whitespace in a base64 string", () => {
    const entry = makeAddressAuthEntry(makeContract(1));
    const decoded = toAuthEntry(`  ${entry.toXDR("base64")}\n`);
    expect(decoded.toXDR("base64")).toBe(entry.toXDR("base64"));
  });

  it("decodes a base64 entry produced by @stellar/stellar-sdk 17.4.0", () => {
    const decoded = toAuthEntry(SDK17_TRANSFER_ENTRY_BASE64);

    expect(decoded.credentials().switch().name).toBe("sorobanCredentialsAddress");
    const credentials = decoded.credentials().address();
    expect(credentials.nonce().toString()).toBe("42");
    expect(Address.fromScAddress(credentials.address()).toString()).toBe(makeContract(1));
    const fn = decoded.rootInvocation().function().contractFn();
    expect(Address.fromScAddress(fn.contractAddress()).toString()).toBe(makeContract(2));
    expect(fn.functionName().toString()).toBe("transfer");
    expect(fn.args()).toHaveLength(3);
    // Round-trips to the same bytes, so the wire format matches SDK 17.
    expect(decoded.toXDR("base64")).toBe(SDK17_TRANSFER_ENTRY_BASE64);
  });

  it("re-decodes an XDR object from another SDK copy through its bytes", () => {
    const entry = makeAddressAuthEntry(makeContract(1));
    const foreign = new ForeignXdrObject(entry.toXDR());

    const decoded = toAuthEntry(foreign as unknown as xdr.SorobanAuthorizationEntry);

    expect(decoded).toBeInstanceOf(xdr.SorobanAuthorizationEntry);
    expect(decoded.toXDR("base64")).toBe(entry.toXDR("base64"));
  });

  it("rejects malformed base64 with a ValidationError", () => {
    expectInvalidEntry(() => toAuthEntry("not base64!!"), /not valid base64/);
    expectInvalidEntry(() => toAuthEntry("AAAA="), /not valid base64/);
    expectInvalidEntry(() => toAuthEntry(""), /not valid base64/);
    expectInvalidEntry(() => toAuthEntry("   "), /not valid base64/);
  });

  it("rejects valid base64 that is not a SorobanAuthorizationEntry", () => {
    expectInvalidEntry(
      () => toAuthEntry("AAAA"),
      /does not decode to a SorobanAuthorizationEntry/
    );
    expectInvalidEntry(
      () => toAuthEntry(xdr.ScVal.scvU32(5).toXDR("base64")),
      /does not decode to a SorobanAuthorizationEntry/
    );
  });

  it("rejects an entry with trailing bytes", () => {
    const entry = makeAddressAuthEntry(makeContract(1));
    const padded = Buffer.concat([entry.toXDR(), Buffer.alloc(4)]).toString("base64");
    expectInvalidEntry(
      () => toAuthEntry(padded),
      /does not decode to a SorobanAuthorizationEntry/
    );
  });

  it("rejects a foreign object that does not encode an auth entry", () => {
    const foreign = new ForeignXdrObject(xdr.ScVal.scvU32(5).toXDR());
    expectInvalidEntry(
      () => toAuthEntry(foreign as unknown as xdr.SorobanAuthorizationEntry),
      /does not encode a SorobanAuthorizationEntry/
    );
  });

  it("rejects values that are not strings or XDR objects", () => {
    for (const value of [undefined, null, 42, {}, { toXDR: () => "AAAA" }]) {
      expectInvalidEntry(
        () => toAuthEntry(value as unknown as string),
        /Invalid entry/
      );
    }
  });

  it("names the field in the error", () => {
    expectInvalidEntry(() => toAuthEntry("!", "authEntry"), /^Invalid authEntry:/);
  });
});
