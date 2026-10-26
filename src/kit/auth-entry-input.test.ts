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

/** A base64 auth entry whose encoding ends with exactly `padding`. */
function entryWithPadding(padding: "=" | "=="): string {
  // XDR pads strings to 4 bytes, so each 4-character step in the function
  // name moves the entry length by 4 bytes and cycles the base64 padding.
  for (const name of ["transfer", "transfer1234", "transfer12345678"]) {
    const entry = makeAddressAuthEntry(makeContract(1));
    entry.rootInvocation().function().contractFn().functionName(name);
    const encoded = entry.toXDR("base64");
    if (encoded.endsWith(padding) && !encoded.endsWith(`=${padding}`)) {
      return encoded;
    }
  }
  throw new Error(`no fixture ends with ${padding}`);
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

  describe("rejects nonzero unused bits before the padding", () => {
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    /** Set an unused low bit in the last data character before the padding. */
    function setUnusedBit(encoded: string): string {
      const index = encoded.indexOf("=") - 1;
      const value = ALPHABET.indexOf(encoded[index]);
      // "==" leaves 4 unused bits in that character, "=" leaves 2.
      expect(value & (encoded.endsWith("==") ? 0b1111 : 0b11)).toBe(0);
      return encoded.slice(0, index) + ALPHABET[value | 1] + encoded.slice(index + 1);
    }

    for (const padding of ["==", "="] as const) {
      it(`with "${padding}" padding`, () => {
        const canonical = entryWithPadding(padding);
        const altered = setUnusedBit(canonical);

        expect(altered).not.toBe(canonical);
        // Both strings carry the same bytes.
        expect(Buffer.from(altered, "base64")).toEqual(Buffer.from(canonical, "base64"));
        expect(toAuthEntry(canonical).toXDR("base64")).toBe(canonical);
        expectInvalidEntry(() => toAuthEntry(altered), /not canonical base64/);
      });
    }
  });

  it("rejects the URL-safe alphabet, missing padding, and inner whitespace", () => {
    const canonical = entryWithPadding("=");

    expectInvalidEntry(
      () => toAuthEntry(canonical.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")),
      /not valid base64/
    );
    expectInvalidEntry(() => toAuthEntry(canonical.replace(/=+$/, "")), /not valid base64/);
    expectInvalidEntry(
      () => toAuthEntry(`${canonical.slice(0, 8)}\n${canonical.slice(8)}`),
      /not valid base64/
    );
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

  it("rejects a toXDR getter that throws with a ValidationError", () => {
    const hostile = Object.defineProperty({}, "toXDR", {
      get() {
        throw new Error("getter boom");
      },
    });
    expectInvalidEntry(
      () => toAuthEntry(hostile as unknown as string),
      /could not be encoded as XDR/
    );
  });

  it("rejects a toXDR() that throws a null-prototype object with a ValidationError", () => {
    const hostile = {
      toXDR() {
        throw Object.create(null);
      },
    };
    expectInvalidEntry(
      () => toAuthEntry(hostile as unknown as string),
      /could not be encoded as XDR/
    );
  });

  it("rejects a thrown Error whose message getter throws with a ValidationError", () => {
    const thrown = new Error("x");
    Object.defineProperty(thrown, "message", {
      get() {
        throw new Error("message boom");
      },
    });
    const hostile = {
      toXDR() {
        throw thrown;
      },
    };
    expectInvalidEntry(
      () => toAuthEntry(hostile as unknown as string),
      /could not be encoded as XDR/
    );
  });

  it("calls a foreign encoder once, with its own receiver", () => {
    const entry = makeAddressAuthEntry(makeContract(1));
    let calls = 0;
    const foreign = {
      bytes: entry.toXDR(),
      toXDR(this: { bytes: Uint8Array }) {
        calls += 1;
        return this.bytes;
      },
    };
    const decoded = toAuthEntry(foreign as unknown as string);
    expect(calls).toBe(1);
    expect(decoded.toXDR("base64")).toBe(entry.toXDR("base64"));
  });

  it("names the field in the error", () => {
    expectInvalidEntry(() => toAuthEntry("!", "authEntry"), /^Invalid authEntry:/);
  });
});
