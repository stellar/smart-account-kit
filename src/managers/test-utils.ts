import { Address, Keypair, StrKey, hash, xdr } from "@stellar/stellar-sdk";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import { buildKeyData } from "../utils.js";

export function makeAccount(seed: number): string {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey();
}

export function makeContract(seed: number): string {
  return StrKey.encodeContract(hash(Buffer.from(`contract-${seed}`)));
}

export function makeDelegatedSigner(seed: number): ContractSigner {
  return {
    tag: "Delegated",
    values: [makeAccount(seed)],
  };
}

export function makeExternalSigner(
  verifierSeed: number,
  publicKeySeed: number,
  credentialSeed: number
): ContractSigner {
  const verifierAddress = makeContract(verifierSeed);
  const publicKey = Buffer.alloc(65, publicKeySeed);
  const credentialId = Buffer.alloc(20, credentialSeed);

  return {
    tag: "External",
    values: [verifierAddress, buildKeyData(publicKey, credentialId)],
  };
}

export function makeAddressAuthEntry(contractId: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(contractId).toScAddress(),
        nonce: xdr.Int64.fromString("1"),
        signatureExpirationLedger: 1,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(contractId).toScAddress(),
          functionName: "__check_auth",
          args: [],
        })
      ),
      subInvocations: [],
    }),
  });
}

/**
 * A base64 `SorobanAuthorizationEntry` built with @stellar/stellar-sdk 17.4.0
 * only (`xdr.SorobanAuthorizationEntry.fromJson(...).toXdr("base64")`): the
 * smart account `makeContract(1)` authorizes `transfer(account, makeContract(3),
 * 1_000_000)` on the token `makeContract(2)` with nonce 42 and no expiration.
 */
export const SDK17_TRANSFER_ENTRY_BASE64 =
  "AAAAAQAAAAHwNp/MwcLIYRcZeueEMnItMe1gDQ47b2vWkI/Xn5HXkwAAAAAAAAAqAAAAAAAAAAEAAAAAAAAAAQasx0lVCs1iO5Iejv9EjSBsYlZWm17++jsqPqNed00WAAAACHRyYW5zZmVyAAAAAwAAABIAAAAB8DafzMHCyGEXGXrnhDJyLTHtYA0OO29r1pCP15+R15MAAAASAAAAAbMne7PWqe6GX5i3/AdH+5OaerH5Fm0eLT5QIt3/i9aVAAAACgAAAAAAAAAAAAAAAAAPQkAAAAAA";

/**
 * Stands in for an XDR object from another copy of @stellar/stellar-sdk (for
 * example SDK 17). It has no SDK 16 accessor methods; only `toXDR()` bytes.
 */
export class ForeignXdrObject {
  // SDK 17 exposes union arms as properties, not as `.credentials()` methods.
  readonly credentials = { type: "sorobanCredentialsAddress" };

  constructor(private readonly bytes: Uint8Array) {}

  toXDR(): Uint8Array {
    return new Uint8Array(this.bytes);
  }

  toXdr(): Uint8Array {
    return this.toXDR();
  }
}
