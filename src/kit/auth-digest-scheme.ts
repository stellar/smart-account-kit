/**
 * Authorization digest schemes of the smart-account builds the SDK signs for.
 *
 * `legacy-concat` (stellar-contracts before #868, including the Protocol 27
 * deployment `1b5f4534…`):
 *
 *   auth_digest = sha256(signature_payload ++ scvVec(context_rule_ids).toXDR())
 *   Delegated signers authorize `__check_auth(auth_digest)`.
 *
 * `preimage-v1` (stellar-contracts #868 and later):
 *
 *   preimage    = AuthDigestPreimage { account, signature_payload, context_rule_ids }
 *   auth_digest = sha256(preimage.toXDR())
 *   Delegated signers authorize `__check_auth(preimage)`.
 *
 * The scheme follows the code a wallet currently runs, and an upgrade changes
 * it. The SDK therefore reads the wallet's WASM hash before every signature
 * instead of caching the scheme on the session.
 */

import { rpc, xdr } from "@stellar/stellar-sdk";
import {
  AuthDigestSchemeError,
  SmartAccountErrorCode,
  ValidationError,
} from "../errors.js";
import { normalizeHashHex, readInstanceWasmHash } from "../utils.js";

export type AuthDigestScheme = "legacy-concat" | "preimage-v1";

export const AUTH_DIGEST_SCHEMES: readonly AuthDigestScheme[] = [
  "legacy-concat",
  "preimage-v1",
];

/**
 * Canonical account builds whose digest scheme needs no configuration.
 * Keys are lowercase hex WASM hashes of `multisig-account-example`, built with
 * `stellar contract build --locked --optimize=true` and Rust 1.91.1 on
 * aarch64-apple-darwin.
 */
export const KNOWN_AUTH_DIGEST_SCHEMES: Readonly<Record<string, AuthDigestScheme>> =
  Object.freeze({
    // stellar-contracts@1e513890 (Stellar CLI 27.0.0), deployed to testnet and
    // mainnet on 2026-07-09. Predates the GHSA-jpg9-m7w4-c7wc fix.
    "1b5f4534a76322da2ad7c745f6900857a6802b0ca79850c35a03561df997785a": "legacy-concat",
    // stellar-accounts v0.7.3 (Stellar CLI 27.0.0): 1e513890 plus the
    // GHSA-jpg9-m7w4-c7wc fix, on the same digest and storage.
    "203e2970d9fed24fb5fca2e0aeebb3c1e4648b76dd6601567178e6474c9fec6f": "legacy-concat",
    // stellar-accounts v0.8.0 (Stellar CLI 28.1.0).
    "c514d35ea67eaea9bfc1fb3327854c0c06111bc1ddebd4fe217c504c1004b9e1": "preimage-v1",
  });

/**
 * Throw unless `schemes` maps `wasmHash`.
 *
 * Called before an action that puts a wallet on `wasmHash` (deploy, upgrade),
 * so the SDK never leaves a wallet on code it cannot sign for.
 *
 * @throws {ValidationError} If `wasmHash` has no known digest scheme
 */
export function assertKnownAuthDigestScheme(
  schemes: ReadonlyMap<string, AuthDigestScheme>,
  wasmHash: string,
  field: "accountWasmHash" | "newWasmHash"
): void {
  const normalizedHash = wasmHash.toLowerCase();
  if (!schemes.has(normalizedHash)) {
    throw new ValidationError(
      `${field} ${normalizedHash} has no known authorization digest scheme, so the SDK could not sign for a wallet running it. Map it in \`authDigestSchemes\`.`,
      field === "accountWasmHash"
        ? SmartAccountErrorCode.INVALID_CONFIG
        : SmartAccountErrorCode.INVALID_INPUT,
      { field, wasmHash: normalizedHash }
    );
  }
}

export function isAuthDigestScheme(value: unknown): value is AuthDigestScheme {
  return AUTH_DIGEST_SCHEMES.includes(value as AuthDigestScheme);
}

/**
 * Merge configured WASM-hash-to-scheme entries over the built-in table.
 *
 * @throws {ValidationError} If a key is not a 32-byte hex hash or a value is
 *   not a known scheme
 */
export function buildAuthDigestSchemeTable(
  overrides?: Readonly<Record<string, AuthDigestScheme>>
): ReadonlyMap<string, AuthDigestScheme> {
  const table = new Map<string, AuthDigestScheme>(
    Object.entries(KNOWN_AUTH_DIGEST_SCHEMES)
  );

  for (const [wasmHash, scheme] of Object.entries(overrides ?? {})) {
    const normalizedHash = normalizeHashHex(wasmHash);
    if (!normalizedHash) {
      throw new ValidationError(
        `authDigestSchemes key must be a 32-byte hex WASM hash (got "${wasmHash}")`,
        SmartAccountErrorCode.INVALID_CONFIG,
        { wasmHash }
      );
    }
    if (!isAuthDigestScheme(scheme)) {
      throw new ValidationError(
        `authDigestSchemes value for ${normalizedHash} must be one of ${AUTH_DIGEST_SCHEMES.join(", ")} (got "${String(scheme)}")`,
        SmartAccountErrorCode.INVALID_CONFIG,
        { wasmHash: normalizedHash, scheme }
      );
    }
    table.set(normalizedHash, scheme);
  }

  return table;
}

/**
 * Resolve the digest scheme of the code a smart account currently runs.
 *
 * @throws {AuthDigestSchemeError} If the account runs no WASM or a WASM hash
 *   missing from `schemes`
 */
export async function resolveAuthDigestScheme(
  deps: {
    rpc: Pick<rpc.Server, "getContractData">;
    schemes: ReadonlyMap<string, AuthDigestScheme>;
  },
  contractId: string
): Promise<AuthDigestScheme> {
  const instance = await deps.rpc.getContractData(
    contractId,
    xdr.ScVal.scvLedgerKeyContractInstance()
  );
  const wasmHash = readInstanceWasmHash(instance);
  if (!wasmHash) {
    throw new AuthDigestSchemeError(contractId, "not-a-wasm-contract");
  }

  const scheme = deps.schemes.get(wasmHash);
  if (!scheme) {
    throw new AuthDigestSchemeError(contractId, wasmHash);
  }
  return scheme;
}
