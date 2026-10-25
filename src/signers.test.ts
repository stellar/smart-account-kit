import { describe, expect, it, vi } from "vitest";
import { Keypair, hash, xdr } from "@stellar/stellar-sdk";
import { Address, xdr as stellarXdr } from "@stellar/stellar-sdk";
import {
  buildAuthDigestPreimage,
  buildLegacyAuthDigest,
  buildPreimageAuthDigest,
  getAddressCredentials,
  readAuthPayload,
  writeAuthPayload,
} from "./kit/auth-payload";
import { AUTH_DIGEST_SCHEMES, type AuthDigestScheme } from "./kit/auth-digest-scheme";
import {
  Ed25519Signer,
  computeEntryAuthDigest,
  signAuthEntryWithSigners,
} from "./signers";
import { ValidationError } from "./errors";
import { signersEqual } from "./signer-utils";
import { makeAddressAuthEntry, makeContract } from "./managers/test-utils";

const TESTNET = "Test SDF Network ; September 2015";
const SCHEMES = AUTH_DIGEST_SCHEMES;

/** Independent re-implementation of the documented legacy auth-digest formula. */
function referenceLegacyAuthDigest(signaturePayload: Buffer, contextRuleIds: number[]): Buffer {
  const idsXdr = xdr.ScVal
    .scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id)))
    .toXDR();
  return hash(Buffer.concat([signaturePayload, idsXdr]));
}

describe("buildLegacyAuthDigest", () => {
  it("matches the documented sha256(payload ++ scvVec(ids).toXDR()) formula", () => {
    const payload = Buffer.alloc(32, 7);
    const ids = [0, 5, 42];
    expect(buildLegacyAuthDigest(payload, ids)).toEqual(referenceLegacyAuthDigest(payload, ids));
  });

  it("pins golden digest vectors (regression guard for the Rust formula)", () => {
    const payload = Buffer.alloc(32, 7);
    expect(buildLegacyAuthDigest(payload, [0, 5, 42]).toString("hex")).toBe(
      "5c00edbcad5ec543c2f3b7ad37ccf4878342d8e59c560fbe9256eba049668706"
    );
    expect(buildLegacyAuthDigest(payload, []).toString("hex")).toBe(
      "0f0b7265fdbecfcb83f0ed792c9bfd1a03439eb289cd39767128e845e9437c6d"
    );
  });

  it("binds the context rule ids: different ids produce different digests", () => {
    const payload = Buffer.alloc(32, 1);
    expect(buildLegacyAuthDigest(payload, [1]).toString("hex")).not.toBe(
      buildLegacyAuthDigest(payload, [2]).toString("hex")
    );
    expect(buildLegacyAuthDigest(payload, [1, 2]).toString("hex")).not.toBe(
      buildLegacyAuthDigest(payload, [2, 1]).toString("hex")
    );
  });

  it("always produces a 32-byte digest", () => {
    expect(buildLegacyAuthDigest(Buffer.alloc(32, 9), [3])).toHaveLength(32);
  });
});

describe("buildAuthDigestPreimage", () => {
  // Generated with `AuthDigestPreimage { .. }.to_xdr()` and `.digest()` from
  // OpenZeppelin/stellar-contracts@6eb047d5 (packages/accounts).
  const account = "CC7EKIHQP3TN4CARQDND6CEOY2UXLWWC2X5GHTD5NLAT7BG5GPZIOM3F";
  const sequentialPayload = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  const vectors = [
    {
      name: "a single rule",
      payload: sequentialPayload,
      ids: [0],
      xdr:
        "0000001100000001000000030000000f000000076163636f756e74000000001200000001be4520f07ee6de081180da3f088ec6a975dac2d5fa63cc7d6ac13f84dd33f2870000000f00000010636f6e746578745f72756c655f69647300000010000000010000000100000003000000000000000f000000117369676e61747572655f7061796c6f61640000000000000d00000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      digest: "482afc1a8fe963383f72e4cad3b2c5c346cf19e1039eaa25e0afcabc7202e9e5",
    },
    {
      name: "multiple rules up to u32::MAX",
      payload: sequentialPayload,
      ids: [0, 7, 0xffffffff],
      xdr:
        "0000001100000001000000030000000f000000076163636f756e74000000001200000001be4520f07ee6de081180da3f088ec6a975dac2d5fa63cc7d6ac13f84dd33f2870000000f00000010636f6e746578745f72756c655f6964730000001000000001000000030000000300000000000000030000000700000003ffffffff0000000f000000117369676e61747572655f7061796c6f61640000000000000d00000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      digest: "5d759d6f69ffa32ca159f5675759d1cf9d64d35fa88cd2c17ce63d93a242eaaf",
    },
    {
      name: "no rules",
      payload: Buffer.alloc(32, 0xab),
      ids: [],
      xdr:
        "0000001100000001000000030000000f000000076163636f756e74000000001200000001be4520f07ee6de081180da3f088ec6a975dac2d5fa63cc7d6ac13f84dd33f2870000000f00000010636f6e746578745f72756c655f6964730000001000000001000000000000000f000000117369676e61747572655f7061796c6f61640000000000000d00000020abababababababababababababababababababababababababababababababab",
      digest: "6c91c8b7e1fd05d933f47fec210e6965cb96d7f7a5cff42a7a4365b1479a24aa",
    },
  ];

  for (const vector of vectors) {
    it(`matches the contract encoding and digest for ${vector.name}`, () => {
      const preimage = buildAuthDigestPreimage(account, vector.payload, vector.ids);
      expect(preimage.toXDR("hex")).toBe(vector.xdr);
      expect(buildPreimageAuthDigest(preimage).toString("hex")).toBe(vector.digest);
    });
  }

  it("binds the smart account address", () => {
    const payload = Buffer.alloc(32, 1);
    const a = buildPreimageAuthDigest(buildAuthDigestPreimage(makeContract(1), payload, [0]));
    const b = buildPreimageAuthDigest(buildAuthDigestPreimage(makeContract(2), payload, [0]));
    expect(a.toString("hex")).not.toBe(b.toString("hex"));
  });

  it("binds the context rule ids", () => {
    const payload = Buffer.alloc(32, 1);
    const digest = (ids: number[]) =>
      buildPreimageAuthDigest(buildAuthDigestPreimage(account, payload, ids)).toString("hex");
    expect(digest([1])).not.toBe(digest([2]));
    expect(digest([1, 2])).not.toBe(digest([2, 1]));
  });

  it("rejects a signature payload that is not 32 bytes", () => {
    expect(() => buildAuthDigestPreimage(account, Buffer.alloc(31), [0])).toThrow(
      "Signature payload must be 32 bytes"
    );
  });
});

describe("computeEntryAuthDigest", () => {
  it("computes the legacy-concat digest and delegated digest argument", () => {
    const contractId = makeContract(1);
    const entry = makeAddressAuthEntry(contractId);
    const ids = [0, 3];

    const { signaturePayload, authDigest, delegatedAuthArgs } = computeEntryAuthDigest(
      TESTNET,
      entry,
      100,
      ids,
      "legacy-concat"
    );

    expect(authDigest).toHaveLength(32);
    expect(signaturePayload).toHaveLength(32);
    expect(authDigest).toEqual(buildLegacyAuthDigest(signaturePayload, ids));
    expect(delegatedAuthArgs.map((arg) => arg.toXDR("hex"))).toEqual([
      xdr.ScVal.scvBytes(authDigest).toXDR("hex"),
    ]);
  });

  it("computes the preimage-v1 digest over the entry's smart account", () => {
    const contractId = makeContract(1);
    const entry = makeAddressAuthEntry(contractId);
    const ids = [0, 3];

    const { signaturePayload, authDigest, delegatedAuthArgs } = computeEntryAuthDigest(
      TESTNET,
      entry,
      100,
      ids,
      "preimage-v1"
    );

    const preimage = buildAuthDigestPreimage(contractId, signaturePayload, ids);
    expect(authDigest).toEqual(hash(preimage.toXDR()));
    // Delegated signers authorize the struct itself, not its digest.
    expect(delegatedAuthArgs.map((arg) => arg.toXDR("hex"))).toEqual([
      preimage.toXDR("hex"),
    ]);
  });

  it("produces a different digest per scheme for the same entry", () => {
    const entry = makeAddressAuthEntry(makeContract(4));
    const legacy = computeEntryAuthDigest(TESTNET, entry, 100, [1], "legacy-concat");
    const preimage = computeEntryAuthDigest(TESTNET, entry, 100, [1], "preimage-v1");
    expect(legacy.signaturePayload).toEqual(preimage.signaturePayload);
    expect(legacy.authDigest.toString("hex")).not.toBe(preimage.authDigest.toString("hex"));
  });

  it("rejects an unknown or missing scheme", () => {
    const entry = makeAddressAuthEntry(makeContract(5));
    expect(() =>
      computeEntryAuthDigest(TESTNET, entry, 100, [1], "preimage-v2" as AuthDigestScheme)
    ).toThrow(ValidationError);
    expect(() =>
      computeEntryAuthDigest(
        TESTNET,
        entry,
        100,
        [1],
        undefined as unknown as AuthDigestScheme
      )
    ).toThrow(ValidationError);
  });

  for (const scheme of SCHEMES) {
    it(`writes the expiration onto the entry as a side effect (${scheme})`, () => {
      const entry = makeAddressAuthEntry(makeContract(2));
      computeEntryAuthDigest(TESTNET, entry, 12345, [1], scheme);
      expect(entry.credentials().address().signatureExpirationLedger()).toBe(12345);
    });

    it(`changes the digest when expiration changes (${scheme})`, () => {
      const entry = makeAddressAuthEntry(makeContract(3));
      const a = computeEntryAuthDigest(TESTNET, entry, 100, [1], scheme).authDigest.toString("hex");
      const b = computeEntryAuthDigest(TESTNET, entry, 200, [1], scheme).authDigest.toString("hex");
      expect(a).not.toBe(b);
    });
  }
});

describe("Ed25519Signer", () => {
  const verifier = makeContract(9);
  const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));

  it("exposes an External(verifier, 32-byte pubkey) signer identity", () => {
    const signer = new Ed25519Signer(keypair, verifier);
    expect(signer.signer.tag).toBe("External");
    expect(signer.signer.values[0]).toBe(verifier);
    const keyData = signer.signer.values[1] as Buffer;
    expect(keyData).toHaveLength(32);
    expect(Buffer.from(keyData)).toEqual(Buffer.from(keypair.rawPublicKey()));
    expect(signer.publicKey).toEqual(Buffer.from(keypair.rawPublicKey()));
    expect(signer.address).toBe(keypair.publicKey());
    expect(signer.verifier).toBe(verifier);
  });

  it("signs the auth digest, producing a verifiable 64-byte signature", () => {
    const signer = new Ed25519Signer(keypair, verifier);
    const authDigest = Buffer.alloc(32, 3);

    const signature = signer.signAuthDigest(authDigest);

    expect(signature).toHaveLength(64);
    // The deployed ed25519 verifier checks the raw 32-byte digest against the key.
    expect(keypair.verify(authDigest, signature)).toBe(true);
    // A different digest must not verify against this signature.
    expect(keypair.verify(Buffer.alloc(32, 4), signature)).toBe(false);
  });

  it("builds from a secret key", () => {
    const signer = Ed25519Signer.fromSecret(keypair.secret(), verifier);
    expect(signer.address).toBe(keypair.publicKey());
  });

  it("rejects an invalid secret key with a ValidationError", () => {
    expect(() => Ed25519Signer.fromSecret("not-a-secret", verifier)).toThrow(
      ValidationError
    );
  });
});

describe("signAuthEntryWithSigners", () => {
  const verifier = makeContract(20);
  const contractId = makeContract(21);
  const keypairA = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12));
  const keypairB = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 13));
  const signerA = new Ed25519Signer(keypairA, verifier);
  const signerB = new Ed25519Signer(keypairB, verifier);

  function makeMutationEntry(functionName: string): stellarXdr.SorobanAuthorizationEntry {
    return new stellarXdr.SorobanAuthorizationEntry({
      credentials: makeAddressAuthEntry(contractId).credentials(),
      rootInvocation: new stellarXdr.SorobanAuthorizedInvocation({
        function: stellarXdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new stellarXdr.InvokeContractArgs({
            contractAddress: Address.fromString(contractId).toScAddress(),
            functionName,
            args: [],
          })
        ),
        subInvocations: [],
      }),
    });
  }

  it("returns a signed copy carrying the rule ids and a verifiable signature", async () => {
    const entry = makeAddressAuthEntry(contractId);
    const before = entry.toXDR("base64");

    const signed = await signAuthEntryWithSigners(entry, [signerA], {
      networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
      contextRuleIds: [3],
      expiration: 500,
    });

    // Input untouched; output is a distinct signed entry.
    expect(entry.toXDR("base64")).toBe(before);
    expect(signed.toXDR("base64")).not.toBe(before);

    const credentials = getAddressCredentials(signed.credentials());
    expect(credentials.signatureExpirationLedger()).toBe(500);

    const payload = readAuthPayload(credentials.signature());
    expect(payload.context_rule_ids).toEqual([3]);
    expect(payload.signers.size).toBe(1);
    const [[signer, sig]] = Array.from(payload.signers.entries());
    expect(signersEqual(signer, signerA.signer)).toBe(true);

    // The signature is over the P27 auth digest bound to [3] and expiration 500.
    const { authDigest } = computeEntryAuthDigest(
      TESTNET,
      stellarXdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR()),
      500,
      [3],
      "legacy-concat"
    );
    expect(keypairA.verify(authDigest, sig)).toBe(true);
    expect(
      keypairA.verify(
        computeEntryAuthDigest(
          TESTNET,
          stellarXdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR()),
          500,
          [4],
      "legacy-concat"
        ).authDigest,
        sig
      )
    ).toBe(false);
  });

  it("adds a second signer to a partially signed entry without dropping the first", async () => {
    const entry = makeAddressAuthEntry(contractId);
    const first = await signAuthEntryWithSigners(entry, [signerA], {
      networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
      contextRuleIds: [3],
      expiration: 500,
    });
    // The second signer confirms the rule IDs and retains the existing expiration.
    const second = await signAuthEntryWithSigners(first, [signerB], {
      networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
      contextRuleIds: [3],
    });

    const payload = readAuthPayload(getAddressCredentials(second.credentials()).signature());
    expect(payload.context_rule_ids).toEqual([3]);
    expect(payload.signers.size).toBe(2);
  });

  it("replaces a repeated signer instead of duplicating it", async () => {
    const entry = makeAddressAuthEntry(contractId);
    const signed = await signAuthEntryWithSigners(entry, [signerA, signerA], {
      networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
      contextRuleIds: [3],
      expiration: 500,
    });
    const payload = readAuthPayload(getAddressCredentials(signed.credentials()).signature());
    expect(payload.signers.size).toBe(1);
  });

  it("refuses smart-account mutations", async () => {
    for (const fn of ["execute", "add_signer", "add_policy", "upgrade"]) {
      await expect(
        signAuthEntryWithSigners(makeMutationEntry(fn), [signerA], {
          networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
          contextRuleIds: [0],
          expiration: 500,
        })
      ).rejects.toThrow(ValidationError);
    }
  });

  it("refuses a rule-id mismatch with an already signed payload", async () => {
    const first = await signAuthEntryWithSigners(makeAddressAuthEntry(contractId), [signerA], {
      networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
      contextRuleIds: [3],
      expiration: 500,
    });
    await expect(
      signAuthEntryWithSigners(first, [signerB], {
        networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
        contextRuleIds: [4],
      })
    ).rejects.toThrow(/different context rule IDs/);
  });

  it("rejects supplied rule IDs without an explicit caller choice", async () => {
    const entry = makeAddressAuthEntry(contractId);
    getAddressCredentials(entry.credentials()).signature(writeAuthPayload({
      context_rule_ids: [0],
      signers: new Map(),
    }));
    const signAuthDigest = vi.fn(async () => Buffer.alloc(64));

    await expect(signAuthEntryWithSigners(entry, [{ signer: signerA.signer, signAuthDigest }], {
      networkPassphrase: TESTNET,
      authDigestScheme: "preimage-v1",
    })).rejects.toThrow(/contextRuleIds are required/);
    expect(signAuthDigest).not.toHaveBeenCalled();
  });

  it("requires rule ids, an expiration, and at least one signer", async () => {
    const entry = makeAddressAuthEntry(contractId);
    getAddressCredentials(entry.credentials()).signatureExpirationLedger(0);

    await expect(
      signAuthEntryWithSigners(entry, [signerA], { networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat", expiration: 500 })
    ).rejects.toThrow(/contextRuleIds are required/);
    await expect(
      signAuthEntryWithSigners(entry, [signerA], { networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat", contextRuleIds: [1] })
    ).rejects.toThrow(/expiration ledger is required/);
    await expect(
      signAuthEntryWithSigners(entry, [], {
        networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
        contextRuleIds: [1],
        expiration: 500,
      })
    ).rejects.toThrow(/At least one signer/);
  });

  it("rejects source-account and delegated credential types", async () => {
    const sourceEntry = new stellarXdr.SorobanAuthorizationEntry({
      credentials: stellarXdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: makeAddressAuthEntry(contractId).rootInvocation(),
    });
    await expect(
      signAuthEntryWithSigners(sourceEntry, [signerA], {
        networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
        contextRuleIds: [1],
        expiration: 500,
      })
    ).rejects.toThrow(/address-credential/);
  });

  it("accepts any AuthDigestSigner, not only Ed25519", async () => {
    const calls: Buffer[] = [];
    const custom = {
      signer: signerB.signer,
      signAuthDigest: async (digest: Buffer) => {
        calls.push(digest);
        return Buffer.alloc(64, 9);
      },
    };
    const signed = await signAuthEntryWithSigners(makeAddressAuthEntry(contractId), [custom], {
      networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
      contextRuleIds: [7],
      expiration: 600,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(32);
    const payload = readAuthPayload(getAddressCredentials(signed.credentials()).signature());
    expect(Array.from(payload.signers.values())[0]).toEqual(Buffer.alloc(64, 9));
  });
  it("signs the preimage-v1 digest for a v0.8.0 wallet", async () => {
    const entry = makeAddressAuthEntry(contractId);
    const signed = await signAuthEntryWithSigners(entry, [signerA], {
      networkPassphrase: TESTNET,
      authDigestScheme: "preimage-v1",
      contextRuleIds: [3],
      expiration: 500,
    });
    const payload = readAuthPayload(getAddressCredentials(signed.credentials()).signature());
    const [sig] = Array.from(payload.signers.values());
    const digest = (scheme: AuthDigestScheme) =>
      computeEntryAuthDigest(
        TESTNET,
        stellarXdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR()),
        500,
        [3],
        scheme
      ).authDigest;

    expect(keypairA.verify(digest("preimage-v1"), sig)).toBe(true);
    expect(keypairA.verify(digest("legacy-concat"), sig)).toBe(false);
  });

  it("refuses an unknown digest scheme", async () => {
    await expect(
      signAuthEntryWithSigners(makeAddressAuthEntry(contractId), [signerA], {
        networkPassphrase: TESTNET,
        authDigestScheme: "preimage-v2" as AuthDigestScheme,
        contextRuleIds: [3],
        expiration: 500,
      })
    ).rejects.toThrow(/authDigestScheme must be one of/);
  });

  it("refuses to change the expiration of a partially signed entry", async () => {
    const first = await signAuthEntryWithSigners(makeAddressAuthEntry(contractId), [signerA], {
      networkPassphrase: TESTNET,
      authDigestScheme: "legacy-concat",
      contextRuleIds: [3],
      expiration: 500,
    });
    await expect(
      signAuthEntryWithSigners(first, [signerB], {
        networkPassphrase: TESTNET,
        authDigestScheme: "legacy-concat",
        contextRuleIds: [3],
        expiration: 600,
      })
    ).rejects.toThrow(/different expiration ledger/);
    await expect(
      signAuthEntryWithSigners(first, [signerB], {
        networkPassphrase: TESTNET,
        authDigestScheme: "legacy-concat",
        contextRuleIds: [3],
        expiration: 500,
      })
    ).resolves.toBeDefined();
  });
});
