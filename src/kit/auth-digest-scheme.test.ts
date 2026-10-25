import { describe, expect, it, vi } from "vitest";
import { Address, xdr } from "@stellar/stellar-sdk";
import {
  KNOWN_AUTH_DIGEST_SCHEMES,
  assertKnownAuthDigestScheme,
  buildAuthDigestSchemeTable,
  isAuthDigestScheme,
  resolveAuthDigestScheme,
} from "./auth-digest-scheme";
import {
  AuthDigestSchemeError,
  SmartAccountErrorCode,
  ValidationError,
} from "../errors";
import { makeContract } from "../managers/test-utils";

const LEGACY_HASH = "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a";
const PREIMAGE_HASH = "ab".repeat(32);
const CONTRACT = makeContract(1);

function instanceEntry(executable: xdr.ContractExecutable) {
  return {
    val: xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: Address.fromString(CONTRACT).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(
          new xdr.ScContractInstance({ executable, storage: null })
        ),
      })
    ),
  };
}

function rpcReturning(executable: xdr.ContractExecutable) {
  return { getContractData: vi.fn(async () => instanceEntry(executable)) } as never;
}

describe("buildAuthDigestSchemeTable", () => {
  it("knows the canonical Protocol 27 build without configuration", () => {
    expect(KNOWN_AUTH_DIGEST_SCHEMES[LEGACY_HASH]).toBe("legacy-concat");
    expect(buildAuthDigestSchemeTable().get(LEGACY_HASH)).toBe("legacy-concat");
  });

  it("merges configured entries over the built-in table, normalizing hash case", () => {
    const table = buildAuthDigestSchemeTable({
      [PREIMAGE_HASH.toUpperCase()]: "preimage-v1",
      [LEGACY_HASH]: "preimage-v1",
    });
    expect(table.get(PREIMAGE_HASH)).toBe("preimage-v1");
    expect(table.get(LEGACY_HASH)).toBe("preimage-v1");
  });

  it("rejects a key that is not a 32-byte hex hash", () => {
    expect(() => buildAuthDigestSchemeTable({ abc: "preimage-v1" })).toThrow(ValidationError);
    expect(() => buildAuthDigestSchemeTable({ ["zz".repeat(32)]: "preimage-v1" })).toThrow(
      expect.objectContaining({ code: SmartAccountErrorCode.INVALID_CONFIG })
    );
  });

  it("rejects an unknown scheme value", () => {
    expect(() =>
      buildAuthDigestSchemeTable({ [PREIMAGE_HASH]: "preimage-v2" as never })
    ).toThrow(ValidationError);
  });
});

describe("assertKnownAuthDigestScheme", () => {
  const table = buildAuthDigestSchemeTable();

  it("accepts a mapped hash in any case", () => {
    expect(() =>
      assertKnownAuthDigestScheme(table, LEGACY_HASH.toUpperCase(), "newWasmHash")
    ).not.toThrow();
  });

  it("rejects an unmapped deploy hash as a config error", () => {
    expect(() => assertKnownAuthDigestScheme(table, PREIMAGE_HASH, "accountWasmHash")).toThrow(
      expect.objectContaining({ code: SmartAccountErrorCode.INVALID_CONFIG })
    );
  });

  it("rejects an unmapped upgrade target as an input error", () => {
    expect(() => assertKnownAuthDigestScheme(table, PREIMAGE_HASH, "newWasmHash")).toThrow(
      expect.objectContaining({ code: SmartAccountErrorCode.INVALID_INPUT })
    );
  });
});

describe("isAuthDigestScheme", () => {
  it("accepts only the known schemes", () => {
    expect(isAuthDigestScheme("legacy-concat")).toBe(true);
    expect(isAuthDigestScheme("preimage-v1")).toBe(true);
    expect(isAuthDigestScheme("preimage-v2")).toBe(false);
    expect(isAuthDigestScheme(undefined)).toBe(false);
  });
});

describe("resolveAuthDigestScheme", () => {
  const schemes = buildAuthDigestSchemeTable({ [PREIMAGE_HASH]: "preimage-v1" });

  it("maps the wallet's current WASM hash to its scheme", async () => {
    const legacyRpc = rpcReturning(
      xdr.ContractExecutable.contractExecutableWasm(Buffer.from(LEGACY_HASH, "hex"))
    );
    const preimageRpc = rpcReturning(
      xdr.ContractExecutable.contractExecutableWasm(Buffer.from(PREIMAGE_HASH, "hex"))
    );

    await expect(resolveAuthDigestScheme({ rpc: legacyRpc, schemes }, CONTRACT))
      .resolves.toBe("legacy-concat");
    await expect(resolveAuthDigestScheme({ rpc: preimageRpc, schemes }, CONTRACT))
      .resolves.toBe("preimage-v1");
  });

  it("reads the contract instance of the wallet being signed for", async () => {
    const rpc = rpcReturning(
      xdr.ContractExecutable.contractExecutableWasm(Buffer.from(LEGACY_HASH, "hex"))
    );
    await resolveAuthDigestScheme({ rpc, schemes }, CONTRACT);
    const getContractData = (rpc as { getContractData: ReturnType<typeof vi.fn> }).getContractData;
    expect(getContractData).toHaveBeenCalledWith(
      CONTRACT,
      xdr.ScVal.scvLedgerKeyContractInstance()
    );
  });

  it("fails closed for a WASM hash with no known scheme", async () => {
    const unknownHash = "cd".repeat(32);
    const rpc = rpcReturning(
      xdr.ContractExecutable.contractExecutableWasm(Buffer.from(unknownHash, "hex"))
    );

    const error = await resolveAuthDigestScheme({ rpc, schemes }, CONTRACT).catch((e) => e);
    expect(error).toBeInstanceOf(AuthDigestSchemeError);
    expect(error.code).toBe(SmartAccountErrorCode.AUTH_DIGEST_SCHEME_UNKNOWN);
    expect(error.context).toEqual({ contractId: CONTRACT, actual: unknownHash });
  });

  it("fails closed for a CAP-85 external executable reference", async () => {
    const rpc = rpcReturning(
      xdr.ContractExecutable.contractExecutableExternalRef(
        new xdr.ContractExecutableExternalRef({
          executableOwner: Address.fromString(makeContract(2)).toScAddress(),
          tag: "account-v1",
        })
      )
    );

    const error = await resolveAuthDigestScheme({ rpc, schemes }, CONTRACT).catch((e) => e);
    expect(error).toBeInstanceOf(AuthDigestSchemeError);
    expect(error.context).toEqual({ contractId: CONTRACT, actual: "not-a-wasm-contract" });
  });
});
