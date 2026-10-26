/**
 * Cross-SDK input boundary for Soroban authorization entries.
 *
 * The kit runs on its own copy of `@stellar/stellar-sdk`. An app on another
 * copy (for example SDK 17, which rebuilt the XDR layer) cannot hand its own
 * XDR objects to code that calls SDK 16 accessors such as `entry.credentials()`.
 * The XDR wire format is the same across these versions, so base64 XDR is a
 * safe boundary: decode it here with the kit's own SDK.
 *
 * @packageDocumentation
 */

import { xdr } from "@stellar/stellar-sdk";
import { SmartAccountErrorCode, ValidationError } from "../errors.js";

/**
 * A Soroban authorization entry as the public signing API accepts it: a
 * base64-encoded `SorobanAuthorizationEntry` XDR string, or an
 * `xdr.SorobanAuthorizationEntry` from the kit's `@stellar/stellar-sdk`.
 *
 * Apps on a different SDK major (for example SDK 17) should pass
 * `entry.toXdr("base64")`.
 */
export type AuthEntryInput = string | xdr.SorobanAuthorizationEntry;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Message of an untrusted thrown value, or undefined. Never throws. */
function safeCauseMessage(error: unknown): string | undefined {
  try {
    return error instanceof Error ? String(error.message) : undefined;
  } catch {
    return undefined;
  }
}

function invalidEntry(fieldName: string, detail: string, cause?: unknown): ValidationError {
  const causeMessage = safeCauseMessage(cause);
  return new ValidationError(
    `Invalid ${fieldName}: ${detail}. Pass a base64-encoded SorobanAuthorizationEntry ` +
      `XDR string (for example entry.toXdr("base64") on Stellar SDK 17) or an ` +
      `xdr.SorobanAuthorizationEntry.`,
    SmartAccountErrorCode.INVALID_INPUT,
    {
      field: fieldName,
      ...(causeMessage === undefined ? {} : { cause: causeMessage }),
    }
  );
}

/**
 * Normalize an authorization entry to the kit's own SDK XDR type.
 *
 * - A kit `xdr.SorobanAuthorizationEntry` is returned unchanged (same object).
 * - A string is decoded as base64 XDR with the kit's SDK.
 * - An XDR object from another copy of `@stellar/stellar-sdk` (for example
 *   SDK 17) is re-encoded with its own `toXDR()` and decoded with the kit's SDK.
 *
 * @param input - The entry as a base64 XDR string or an XDR object
 * @param fieldName - Name used in the error message
 * @returns An `xdr.SorobanAuthorizationEntry` from the kit's SDK
 * @throws {ValidationError} If the input is not a valid authorization entry
 */
export function toAuthEntry(
  input: AuthEntryInput,
  fieldName: string = "entry"
): xdr.SorobanAuthorizationEntry {
  // Treat the input as untrusted: JavaScript callers can pass anything.
  const value: unknown = input;
  if (value instanceof xdr.SorobanAuthorizationEntry) {
    return value;
  }

  if (typeof value === "string") {
    const encoded = value.trim();
    if (encoded.length === 0 || !BASE64_PATTERN.test(encoded)) {
      throw invalidEntry(fieldName, "the string is not valid base64");
    }
    let decoded: xdr.SorobanAuthorizationEntry;
    try {
      decoded = xdr.SorobanAuthorizationEntry.fromXDR(encoded, "base64");
    } catch (error) {
      throw invalidEntry(
        fieldName,
        "the base64 string does not decode to a SorobanAuthorizationEntry",
        error
      );
    }
    // The pattern allows nonzero unused bits before the padding (for example
    // `AB==` decodes like `AA==`). Accept only the one canonical encoding.
    if (decoded.toXDR("base64") !== encoded) {
      throw invalidEntry(fieldName, "the string is not canonical base64 XDR");
    }
    return decoded;
  }

  // An XDR object from another copy of the SDK. The wire format is the same,
  // so re-decode its bytes with the kit's SDK. Read the encoder once, inside
  // a guard, because a hostile getter can throw.
  let encode: unknown;
  if (typeof value === "object" && value !== null) {
    try {
      encode = (value as { toXDR?: unknown }).toXDR;
    } catch (error) {
      throw invalidEntry(fieldName, "the object could not be encoded as XDR", error);
    }
  }
  if (typeof encode === "function") {
    let bytes: unknown;
    try {
      bytes = encode.call(value);
    } catch (error) {
      throw invalidEntry(fieldName, "the object could not be encoded as XDR", error);
    }
    if (!(bytes instanceof Uint8Array)) {
      throw invalidEntry(fieldName, "the object's toXDR() did not return bytes");
    }
    try {
      return xdr.SorobanAuthorizationEntry.fromXDR(Buffer.from(bytes));
    } catch (error) {
      throw invalidEntry(
        fieldName,
        "the object does not encode a SorobanAuthorizationEntry",
        error
      );
    }
  }

  throw invalidEntry(
    fieldName,
    `expected a string or an XDR object, got ${value === null ? "null" : typeof value}`
  );
}
