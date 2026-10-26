/**
 * Type-level tests for the public signing API overloads.
 *
 * Vitest typechecks this file (see vitest.config.ts and
 * tsconfig.typetest.json); it does not run it. A type error here fails
 * `pnpm test --run`.
 */
import { describe, expectTypeOf, test } from "vitest";
import type { xdr } from "@stellar/stellar-sdk";
import type { SmartAccountKit } from "./kit.js";
import type { AuthEntryInput } from "./kit/auth-entry-input.js";
import {
  computeEntryAuthDigest,
  signAuthEntryWithSigners,
  type AuthDigestSigner,
  type EntryAuthDigest,
  type SignAuthEntryWithSignersOptions,
} from "./signers.js";

type Entry = xdr.SorobanAuthorizationEntry;

declare const kit: SmartAccountKit;
declare const signers: readonly AuthDigestSigner[];
declare const options: SignAuthEntryWithSignersOptions;
declare const anyEntry: any;
declare const stringEntry: string;
declare const objectEntry: Entry;
declare const unionEntry: AuthEntryInput;

describe("kit.signAuthEntry overloads", () => {
  test("an any-typed entry keeps the object return type", () => {
    expectTypeOf(kit.signAuthEntry(anyEntry)).resolves.toEqualTypeOf<Entry>();
  });

  test("a string entry returns a string", () => {
    expectTypeOf(kit.signAuthEntry(stringEntry)).resolves.toEqualTypeOf<string>();
  });

  test("an object entry returns an object", () => {
    expectTypeOf(kit.signAuthEntry(objectEntry)).resolves.toEqualTypeOf<Entry>();
  });

  test("a union entry returns the union", () => {
    expectTypeOf(kit.signAuthEntry(unionEntry)).resolves.toEqualTypeOf<
      string | Entry
    >();
  });
});

describe("signAuthEntryWithSigners overloads", () => {
  test("an any-typed entry keeps the object return type", () => {
    expectTypeOf(
      signAuthEntryWithSigners(anyEntry, signers, options)
    ).resolves.toEqualTypeOf<Entry>();
  });

  test("a string entry returns a string", () => {
    expectTypeOf(
      signAuthEntryWithSigners(stringEntry, signers, options)
    ).resolves.toEqualTypeOf<string>();
  });

  test("an object entry returns an object", () => {
    expectTypeOf(
      signAuthEntryWithSigners(objectEntry, signers, options)
    ).resolves.toEqualTypeOf<Entry>();
  });

  test("a union entry returns the union", () => {
    expectTypeOf(
      signAuthEntryWithSigners(unionEntry, signers, options)
    ).resolves.toEqualTypeOf<string | Entry>();
  });
});

describe("computeEntryAuthDigest", () => {
  test("accepts every entry form", () => {
    expectTypeOf(computeEntryAuthDigest).parameter(1).toEqualTypeOf<AuthEntryInput>();
    expectTypeOf(computeEntryAuthDigest).returns.toEqualTypeOf<EntryAuthDigest>();
  });
});
