import {
  Address,
  buildAuthorizationEntryPreimage,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  AuthPayload,
  Signer as ContractSigner,
} from "smart-account-kit-bindings";
import { signersEqual } from "../signer-utils.js";
import type { WebAuthnSigData } from "../contract-types.js";

export function buildSignaturePayload(
  networkPassphrase: string,
  entry: xdr.SorobanAuthorizationEntry,
  expiration: number
): Buffer {
  return hash(buildSignaturePreimage(networkPassphrase, entry, expiration).toXDR());
}

export function buildSignaturePreimage(
  networkPassphrase: string,
  entry: xdr.SorobanAuthorizationEntry,
  expiration: number
): xdr.HashIdPreimage {
  const credentials = getAddressCredentials(entry.credentials());
  const normalizedExpiration = normalizeSignatureExpirationLedger(expiration);
  credentials.signatureExpirationLedger(normalizedExpiration);
  return buildAuthorizationEntryPreimage(
    entry,
    normalizedExpiration,
    networkPassphrase
  );
}

export function normalizeSignatureExpirationLedger(expiration: number): number {
  if (!Number.isFinite(expiration)) {
    throw new Error("Signature expiration ledger must be a finite number");
  }
  if (expiration < 0) {
    throw new Error("Signature expiration ledger must fit in u32");
  }

  const normalizedExpiration = Math.ceil(expiration);
  if (normalizedExpiration > 0xffffffff) {
    throw new Error("Signature expiration ledger must fit in u32");
  }

  return normalizedExpiration;
}

export function getAddressCredentials(
  credentials: xdr.SorobanCredentials
): xdr.SorobanAddressCredentials {
  switch (credentials.switch().name) {
    case "sorobanCredentialsAddress":
      return credentials.address();
    case "sorobanCredentialsAddressV2":
      return credentials.addressV2();
    case "sorobanCredentialsAddressWithDelegates":
      return credentials.addressWithDelegates().addressCredentials();
  }

  throw new Error(`Soroban credentials do not contain address credentials: ${credentials.switch().name}`);
}

export function getAuthEntryAddress(entry: xdr.SorobanAuthorizationEntry): string {
  return Address.fromScAddress(getAddressCredentials(entry.credentials()).address()).toString();
}

/**
 * Wrap address credentials as V1 `SorobanCredentials`.
 *
 * V1 — not CAP-0071-02 V2 — is the correct and only shape here: every caller
 * authorizes with a classic `G…` account (the deployer, a wallet signer, or the
 * temporary funding key), whose signature the host validates against the
 * account's signer set rather than an address-bound payload. Smart-account
 * (contract) authorizations use V2, but those credentials come back from
 * simulation and are never built here.
 */
export function createAddressCredentials(
  credentials: xdr.SorobanAddressCredentials
): xdr.SorobanCredentials {
  return xdr.SorobanCredentials.sorobanCredentialsAddress(credentials);
}

export function buildAuthDigest(
  signaturePayload: Buffer,
  contextRuleIds: number[]
): Buffer {
  const ruleIdsXdr = xdr.ScVal.scvVec(
    contextRuleIds.map((contextRuleId) => xdr.ScVal.scvU32(contextRuleId))
  ).toXDR();

  return hash(Buffer.concat([signaturePayload, ruleIdsXdr]));
}

export function buildWebAuthnSignatureBytes(sigData: WebAuthnSigData): Buffer {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("authenticator_data"),
      val: xdr.ScVal.scvBytes(sigData.authenticator_data),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("client_data"),
      val: xdr.ScVal.scvBytes(sigData.client_data),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signature"),
      val: xdr.ScVal.scvBytes(sigData.signature),
    }),
  ]).toXDR();
}

export function buildAddressSignatureScVal(
  publicKeyBytes: Uint8Array | Buffer,
  signatureBytes: Uint8Array | Buffer
): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("public_key"),
        val: xdr.ScVal.scvBytes(Buffer.from(publicKeyBytes)),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signature"),
        val: xdr.ScVal.scvBytes(Buffer.from(signatureBytes)),
      }),
    ]),
  ]);
}

export function emptyAuthPayload(): AuthPayload {
  return {
    context_rule_ids: [],
    signers: new Map(),
  };
}

export function readAuthPayload(signature: xdr.ScVal): AuthPayload {
  if (signature.switch().name === "scvVoid") {
    return emptyAuthPayload();
  }

  if (signature.switch().name !== "scvMap") {
    throw new Error("Smart account auth signature is not encoded as AuthPayload");
  }

  const payload = emptyAuthPayload();

  for (const entry of signature.map() ?? []) {
    const key = entry.key();
    if (key.switch().name !== "scvSymbol") {
      continue;
    }

    const field = key.sym().toString();
    if (field === "context_rule_ids") {
      const value = entry.val();
      if (value.switch().name !== "scvVec") {
        throw new Error("AuthPayload.context_rule_ids is not a vector");
      }

      payload.context_rule_ids = (value.vec() ?? []).map((item) => {
        if (item.switch().name !== "scvU32") {
          throw new Error("AuthPayload.context_rule_ids contains a non-u32 value");
        }
        return item.u32();
      });
    }

    if (field === "signers") {
      const value = entry.val();
      if (value.switch().name !== "scvMap") {
        throw new Error("AuthPayload.signers is not a map");
      }

      for (const signerEntry of value.map() ?? []) {
        const signer = parseSignerScVal(signerEntry.key());
        const signerValue = signerEntry.val();
        if (signerValue.switch().name !== "scvBytes") {
          throw new Error("AuthPayload.signers contains a non-bytes signature value");
        }

        payload.signers.set(signer, Buffer.from(signerValue.bytes()));
      }
    }
  }

  return payload;
}

/**
 * Compare two ScVals in the order the Soroban host uses when it validates that
 * an ScMap is sorted by key (host `metered_map::from_map`, which rejects an
 * unsorted map with `InvalidInput`).
 *
 * This is deliberately NOT a comparison of the XDR byte encodings. XDR prefixes
 * every variable-length payload (Bytes, Symbol, String, Vec) with a 4-byte
 * length, so `toXDR("hex")` sorting is length-major; the host instead compares
 * those payloads element-wise by content (Rust slice `Ord`), where a shorter
 * value that is a prefix of a longer one sorts first. For two same-verifier
 * External signer keys whose `keyData` differs only in length, the two orders
 * diverge and the host rejects the installed/authorized map — see the tests.
 *
 * Only the shapes that appear as signer/policy map keys are handled precisely
 * (Vec, Symbol, String, Bytes, Address). All other shapes are same-type here
 * (the discriminant is compared first), so their fixed-width XDR encodings sort
 * order-equivalently to the host.
 */
export function compareScVal(a: xdr.ScVal, b: xdr.ScVal): number {
  const aType = a.switch().value;
  const bType = b.switch().value;
  if (aType !== bType) {
    return aType < bType ? -1 : 1;
  }

  switch (a.switch().name) {
    case "scvVec": {
      const av = a.vec() ?? [];
      const bv = b.vec() ?? [];
      const len = Math.min(av.length, bv.length);
      for (let i = 0; i < len; i += 1) {
        const cmp = compareScVal(av[i], bv[i]);
        if (cmp !== 0) return cmp;
      }
      return av.length - bv.length;
    }
    case "scvMap": {
      const am = a.map() ?? [];
      const bm = b.map() ?? [];
      const len = Math.min(am.length, bm.length);
      for (let i = 0; i < len; i += 1) {
        const keyCmp = compareScVal(am[i].key(), bm[i].key());
        if (keyCmp !== 0) return keyCmp;
        const valCmp = compareScVal(am[i].val(), bm[i].val());
        if (valCmp !== 0) return valCmp;
      }
      return am.length - bm.length;
    }
    case "scvSymbol":
      return Buffer.compare(
        Buffer.from(a.sym().toString(), "utf8"),
        Buffer.from(b.sym().toString(), "utf8")
      );
    case "scvString":
      return Buffer.compare(
        Buffer.from(a.str().toString(), "utf8"),
        Buffer.from(b.str().toString(), "utf8")
      );
    case "scvBytes":
      return Buffer.compare(Buffer.from(a.bytes()), Buffer.from(b.bytes()));
    case "scvAddress":
      // ScAddress is a type discriminant plus a fixed-width key, so a byte
      // comparison of the encoding matches the host's (type, key) ordering.
      return Buffer.compare(a.address().toXDR(), b.address().toXDR());
    default:
      // Same-type scalar (or any unhandled shape): its XDR encoding is
      // fixed-width for a given type, so a byte comparison is order-equivalent.
      return Buffer.compare(a.toXDR(), b.toXDR());
  }
}

export function writeAuthPayload(payload: AuthPayload): xdr.ScVal {
  const signerEntries = Array.from(payload.signers.entries()).map(
    ([signer, signatureBytes]) =>
      new xdr.ScMapEntry({
        key: signerToScVal(signer),
        val: xdr.ScVal.scvBytes(signatureBytes),
      })
  );

  // Host order (see compareScVal): the smart account converts this signer map
  // to a host object and rejects it if the keys are not in host-sort order.
  signerEntries.sort((a, b) => compareScVal(a.key(), b.key()));

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(
        payload.context_rule_ids.map((contextRuleId) => xdr.ScVal.scvU32(contextRuleId))
      ),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap(signerEntries),
    }),
  ]);
}

export function upsertAuthPayloadSigner(
  payload: AuthPayload,
  signer: ContractSigner,
  signatureBytes: Buffer
): void {
  for (const existingSigner of payload.signers.keys()) {
    if (signersEqual(existingSigner, signer)) {
      payload.signers.delete(existingSigner);
      break;
    }
  }

  payload.signers.set(signer, signatureBytes);
}

/**
 * Generate a cryptographically random signed 64-bit nonce for an address-credential
 * auth entry. The nonce must be unique among the address's live nonces; a timestamp
 * (`Date.now()`) collides when two entries are built in the same millisecond
 * (multiple smart-account auth entries in one transaction) or across two
 * transactions signed by the same address in the same millisecond. A random
 * i64 makes a collision astronomically unlikely, matching the SDK's own
 * `authorizeEntry` nonce strategy.
 */
export function randomAuthEntryNonce(): xdr.Int64 {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  // DataView, not Buffer#readBigInt64BE: common bundler `buffer` polyfills
  // (Next.js ships a pre-6.x feross/buffer) lack the BigInt accessors, which
  // crashed every browser flow that builds an auth entry.
  return xdr.Int64.fromString(
    new DataView(bytes.buffer).getBigInt64(0, false).toString(),
  );
}

export function signerToScVal(signer: ContractSigner): xdr.ScVal {
  if (signer.tag === "Delegated") {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Delegated"),
      xdr.ScVal.scvAddress(Address.fromString(signer.values[0]).toScAddress()),
    ]);
  }

  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    xdr.ScVal.scvAddress(Address.fromString(signer.values[0]).toScAddress()),
    xdr.ScVal.scvBytes(signer.values[1]),
  ]);
}

export function parseSignerScVal(value: xdr.ScVal): ContractSigner {
  if (value.switch().name !== "scvVec") {
    throw new Error("Signer key is not encoded as a vector");
  }

  const items = value.vec() ?? [];
  if (items.length < 2 || items[0].switch().name !== "scvSymbol") {
    throw new Error("Signer key is not a valid enum encoding");
  }

  const variant = items[0].sym().toString();
  if (variant === "Delegated") {
    if (items[1].switch().name !== "scvAddress") {
      throw new Error("Delegated signer is missing an address");
    }

    return {
      tag: "Delegated",
      values: [Address.fromScAddress(items[1].address()).toString()],
    };
  }

  if (variant === "External") {
    if (
      items.length < 3 ||
      items[1].switch().name !== "scvAddress" ||
      items[2].switch().name !== "scvBytes"
    ) {
      throw new Error("External signer is missing required verifier or key data");
    }

    return {
      tag: "External",
      values: [
        Address.fromScAddress(items[1].address()).toString(),
        Buffer.from(items[2].bytes()),
      ],
    };
  }

  throw new Error(`Unknown signer variant: ${variant}`);
}
