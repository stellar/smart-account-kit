import {
  Address,
  Keypair,
  buildAuthorizationEntryPreimage,
  buildWithDelegatesEntry,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { AuthPayload, Signer } from "smart-account-kit-bindings";
import {
  buildAuthDigest,
  buildAddressSignatureScVal,
  buildSignaturePreimage,
  buildSignaturePayload,
  buildWebAuthnSignatureBytes,
  compareScVal,
  createAddressCredentials,
  getAddressCredentials,
  readAuthPayload,
  signerToScVal,
  upsertAuthPayloadSigner,
  writeAuthPayload,
} from "./auth-payload";

describe("buildWebAuthnSignatureBytes", () => {
  it("encodes WebAuthnSigData to the pinned ScVal XDR (sorted authenticator_data/client_data/signature)", () => {
    const bytes = buildWebAuthnSignatureBytes({
      authenticator_data: Buffer.alloc(4, 1),
      client_data: Buffer.alloc(4, 2),
      signature: Buffer.alloc(64, 3),
    });
    expect(bytes.toString("hex")).toBe(
      "0000001100000001000000030000000f0000001261757468656e74696361746f725f6461746100000000000d00000004010101010000000f0000000b636c69656e745f64617461000000000d00000004020202020000000f000000097369676e61747572650000000000000d0000004003030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303"
    );
  });
});

function makeDelegatedSigner(address: string): Signer {
  return {
    tag: "Delegated",
    values: [address],
  };
}

function makeAccount(seedByte: number): string {
  return Keypair.fromRawEd25519Seed(Buffer.alloc(32, seedByte)).publicKey();
}

function makeAuthEntry(address: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: createAddressCredentials(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(address).toScAddress(),
        nonce: xdr.Int64.fromString("7"),
        signatureExpirationLedger: 1,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: xdr.ScAddress.scAddressTypeContract(
            hash(Buffer.from("contract"))
          ),
          functionName: "do_it",
          args: [],
        })
      ),
      subInvocations: [],
    }),
  });
}

describe("auth-payload", () => {
  it("round-trips AuthPayload with signer map and context rule ids", () => {
    const signer = makeDelegatedSigner(
      makeAccount(1)
    );
    const payload: AuthPayload = {
      context_rule_ids: [3, 9],
      signers: new Map([[signer, Buffer.from("deadbeef", "hex")]]),
    };

    const encoded = writeAuthPayload(payload);
    const decoded = readAuthPayload(encoded);

    expect(decoded.context_rule_ids).toEqual([3, 9]);
    expect(decoded.signers.size).toBe(1);

    const [decodedSigner, decodedSignature] = Array.from(decoded.signers.entries())[0];
    expect(decodedSigner).toEqual(signer);
    expect(decodedSignature).toEqual(Buffer.from("deadbeef", "hex"));
  });

  it("replaces an existing signer entry instead of duplicating it", () => {
    const signer = makeDelegatedSigner(
      makeAccount(2)
    );
    const payload: AuthPayload = {
      context_rule_ids: [],
      signers: new Map([[signer, Buffer.from("aa", "hex")]]),
    };

    upsertAuthPayloadSigner(payload, signer, Buffer.from("bb", "hex"));

    expect(payload.signers.size).toBe(1);
    expect(Array.from(payload.signers.values())[0]).toEqual(Buffer.from("bb", "hex"));
  });

  it("binds context rule ids into the auth digest", () => {
    const signaturePayload = hash(Buffer.from("payload"));

    const digestA = buildAuthDigest(signaturePayload, [1]);
    const digestB = buildAuthDigest(signaturePayload, [2]);

    expect(digestA.equals(digestB)).toBe(false);

    const expected = hash(
      Buffer.concat([
        signaturePayload,
        xdr.ScVal.scvVec([xdr.ScVal.scvU32(1)]).toXDR(),
      ])
    );
    expect(digestA).toEqual(expected);
  });

  it("builds a canonical address-signature ScVal envelope", () => {
    const publicKey = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).rawPublicKey();
    const signature = Buffer.from("deadbeef", "hex");

    const scVal = buildAddressSignatureScVal(publicKey, signature);
    const items = scVal.vec();
    expect(items).toHaveLength(1);

    const entries = items?.[0].map();
    expect(entries).toHaveLength(2);
    expect(entries?.[0].key().sym().toString()).toBe("public_key");
    expect(Buffer.from(entries?.[0].val().bytes() ?? [])).toEqual(Buffer.from(publicKey));
    expect(entries?.[1].key().sym().toString()).toBe("signature");
    expect(Buffer.from(entries?.[1].val().bytes() ?? [])).toEqual(signature);
  });

  it("unwraps address credentials through the shared helper", () => {
    const account = makeAccount(4);
    const entry = makeAuthEntry(account);
    const credentials = getAddressCredentials(entry.credentials());

    expect(entry.credentials().switch().name).toBe("sorobanCredentialsAddress");
    expect(credentials.nonce().toString()).toBe("7");
    expect(Address.fromScAddress(credentials.address()).toString()).toBe(account);
  });

  it("always builds V1 ADDRESS credentials (classic G-account authorizers)", () => {
    const credentials = getAddressCredentials(makeAuthEntry(makeAccount(5)).credentials());

    expect(createAddressCredentials(credentials).switch().name).toBe(
      "sorobanCredentialsAddress"
    );
  });

  it("matches the SDK auth preimage helper for legacy ADDRESS credentials", () => {
    const networkPassphrase = "Test SDF Network ; September 2015";
    const entry = makeAuthEntry(makeAccount(7));
    const expectedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    const preimage = buildSignaturePreimage(networkPassphrase, entry, 123);
    const expected = buildAuthorizationEntryPreimage(expectedEntry, 123, networkPassphrase);

    expect(preimage.toXDR()).toEqual(expected.toXDR());
    expect(preimage.switch().name).toBe("envelopeTypeSorobanAuthorization");
    expect(getAddressCredentials(entry.credentials()).signatureExpirationLedger()).toBe(123);
  });

  it("matches the SDK auth preimage helper for ADDRESS_V2 credentials", () => {
    const networkPassphrase = "Test SDF Network ; September 2015";
    const baseEntry = makeAuthEntry(makeAccount(8));
    // V2 credentials are never built by the SDK — they come back from
    // simulation for smart-account (contract) authorizers — so construct one
    // directly to pin that the preimage helper still handles them.
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        getAddressCredentials(baseEntry.credentials())
      ),
      rootInvocation: baseEntry.rootInvocation(),
    });
    const expectedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    const preimage = buildSignaturePreimage(networkPassphrase, entry, 123);
    const expected = buildAuthorizationEntryPreimage(expectedEntry, 123, networkPassphrase);

    expect(preimage.toXDR()).toEqual(expected.toXDR());
    expect(preimage.switch().name).toBe("envelopeTypeSorobanAuthorizationWithAddress");
    expect(buildSignaturePayload(networkPassphrase, entry, 123)).toHaveLength(32);
    expect(getAddressCredentials(entry.credentials()).signatureExpirationLedger()).toBe(123);
  });

  it("matches the SDK auth preimage helper for ADDRESS_WITH_DELEGATES credentials", () => {
    const networkPassphrase = "Test SDF Network ; September 2015";
    const delegatedEntry = buildWithDelegatesEntry({
      entry: makeAuthEntry(makeAccount(14)),
      validUntilLedgerSeq: 123,
      delegates: [{ address: makeAccount(15) }],
    });
    const expectedEntry = xdr.SorobanAuthorizationEntry.fromXDR(delegatedEntry.toXDR());
    const preimage = buildSignaturePreimage(networkPassphrase, delegatedEntry, 123);
    const expected = buildAuthorizationEntryPreimage(expectedEntry, 123, networkPassphrase);

    expect(delegatedEntry.credentials().switch().name).toBe(
      "sorobanCredentialsAddressWithDelegates"
    );
    expect(preimage.toXDR()).toEqual(expected.toXDR());
    expect(preimage.switch().name).toBe("envelopeTypeSorobanAuthorizationWithAddress");
  });

  it("keeps the submitted expiration in sync with the signed payload", () => {
    const entry = makeAuthEntry(makeAccount(16));
    const payload = buildSignaturePayload("Test SDF Network ; September 2015", entry, 123);

    expect(payload).toHaveLength(32);
    expect(getAddressCredentials(entry.credentials()).signatureExpirationLedger()).toBe(123);
  });

  it("rounds fractional signature expirations up before XDR serialization", () => {
    const entry = makeAuthEntry(makeAccount(17));
    const payload = buildSignaturePayload("Test SDF Network ; September 2015", entry, 123.2);

    expect(payload).toHaveLength(32);
    expect(getAddressCredentials(entry.credentials()).signatureExpirationLedger()).toBe(124);
  });

  it("rejects non-finite signature expirations without mutating the entry", () => {
    const entry = makeAuthEntry(makeAccount(18));

    expect(() =>
      buildSignaturePayload("Test SDF Network ; September 2015", entry, Number.NaN)
    ).toThrow("Signature expiration ledger must be a finite number");
    expect(getAddressCredentials(entry.credentials()).signatureExpirationLedger()).toBe(1);
  });

  it("rejects out-of-range signature expirations without mutating the entry", () => {
    const negativeEntry = makeAuthEntry(makeAccount(19));
    const negativeFractionEntry = makeAuthEntry(makeAccount(21));
    const oversizedEntry = makeAuthEntry(makeAccount(20));

    expect(() =>
      buildSignaturePayload("Test SDF Network ; September 2015", negativeEntry, -1)
    ).toThrow("Signature expiration ledger must fit in u32");
    expect(getAddressCredentials(negativeEntry.credentials()).signatureExpirationLedger()).toBe(1);

    expect(() =>
      buildSignaturePayload("Test SDF Network ; September 2015", negativeFractionEntry, -0.5)
    ).toThrow("Signature expiration ledger must fit in u32");
    expect(
      getAddressCredentials(negativeFractionEntry.credentials()).signatureExpirationLedger()
    ).toBe(1);

    expect(() =>
      buildSignaturePayload("Test SDF Network ; September 2015", oversizedEntry, 0x1_0000_0000)
    ).toThrow("Signature expiration ledger must fit in u32");
    expect(getAddressCredentials(oversizedEntry.credentials()).signatureExpirationLedger()).toBe(1);
  });
});

describe("compareScVal (Soroban host key order)", () => {
  // A shared webauthn verifier: two passkey signers on one contract carry the
  // same verifier address, so their Signer keys differ only in the trailing
  // variable-length keyData Bytes — exactly where host order and XDR order can
  // diverge.
  const VERIFIER = "CCF65VXVORNOZBRR3EG3GZYSFS3ALDG44CDYN5T5KRWKYX6RXLKLXER4";

  function externalKey(keyData: Buffer): xdr.ScVal {
    return signerToScVal({ tag: "External", values: [VERIFIER, keyData] });
  }

  it("orders same-verifier keys by keyData content, diverging from XDR-hex length order", () => {
    // keyData chosen so XDR-hex (length-major) and host (content-major) disagree:
    // 81 bytes of 0x02 vs 97 bytes of 0x01. buildKeyData (65-byte pubkey +
    // variable-length credential id) makes such mixed-length pairs realistic.
    const shorterHigher = Buffer.alloc(81, 0x02);
    const longerLower = Buffer.alloc(97, 0x01);
    const keyA = externalKey(shorterHigher);
    const keyB = externalKey(longerLower);

    // XDR-hex order (the old sort) is length-major: the 4-byte length prefix
    // 0x00000051 (81) < 0x00000061 (97), so the shorter key sorts first
    // regardless of content.
    const xdrOrder = [keyA, keyB].sort((a, b) =>
      a.toXDR("hex").localeCompare(b.toXDR("hex"))
    );
    expect(xdrOrder[0]).toBe(keyA);

    // Host order compares keyData content first: 0x01 < 0x02, so the longer,
    // content-lower key sorts FIRST — the opposite order. The host would reject
    // an ScMap ordered the old (XDR-hex) way.
    const hostOrder = [keyA, keyB].sort(compareScVal);
    expect(hostOrder[0]).toBe(keyB);

    // The comparator reduces to a content comparison of the keyData bytes.
    expect(Buffer.compare(shorterHigher, longerLower)).toBe(1);
    expect(compareScVal(keyA, keyB)).toBe(1);
  });

  it("treats a shorter keyData that prefixes a longer one as smaller (Rust slice order)", () => {
    const prefix = Buffer.alloc(81, 0x05);
    const longer = Buffer.concat([Buffer.alloc(81, 0x05), Buffer.alloc(16, 0x05)]);
    expect(compareScVal(externalKey(prefix), externalKey(longer))).toBeLessThan(0);
  });

  it("orders the Delegated variant before External by the variant symbol", () => {
    const delegated = signerToScVal({ tag: "Delegated", values: [makeAccount(4)] });
    expect(compareScVal(delegated, externalKey(Buffer.alloc(65, 1)))).toBeLessThan(0);
  });

  it("writeAuthPayload emits the signer map in ascending host order", () => {
    const signerA: Signer = { tag: "External", values: [VERIFIER, Buffer.alloc(81, 0x02)] };
    const signerB: Signer = { tag: "External", values: [VERIFIER, Buffer.alloc(97, 0x01)] };

    // Insert in XDR-hex order [A, B]; the encoder must re-sort to host order.
    const payload: AuthPayload = {
      context_rule_ids: [],
      signers: new Map([
        [signerA, Buffer.from("aa", "hex")],
        [signerB, Buffer.from("bb", "hex")],
      ]),
    };

    const encoded = writeAuthPayload(payload);
    const signersEntry = (encoded.map() ?? []).find(
      (entry) => entry.key().sym().toString() === "signers"
    );
    const signerKeys = (signersEntry?.val().map() ?? []).map((entry) => entry.key());

    // Host order puts the content-lower (longer) key first.
    expect(signerKeys[0].toXDR("hex")).toBe(signerToScVal(signerB).toXDR("hex"));
    expect(signerKeys[1].toXDR("hex")).toBe(signerToScVal(signerA).toXDR("hex"));
    expect(compareScVal(signerKeys[0], signerKeys[1])).toBeLessThan(0);
  });
});
