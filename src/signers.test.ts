import { describe, expect, it } from "vitest";
import { Keypair, hash, xdr } from "@stellar/stellar-sdk";
import { Address, xdr as stellarXdr } from "@stellar/stellar-sdk";
import { buildAuthDigest, getAddressCredentials, readAuthPayload } from "./kit/auth-payload";
import {
  Ed25519Signer,
  computeEntryAuthDigest,
  signAuthEntryWithSigners,
} from "./signers";
import { ValidationError } from "./errors";
import { signersEqual } from "./signer-utils";
import { makeAddressAuthEntry, makeContract } from "./managers/test-utils";

const TESTNET = "Test SDF Network ; September 2015";

/** Independent re-implementation of the documented auth-digest formula. */
function referenceAuthDigest(signaturePayload: Buffer, contextRuleIds: number[]): Buffer {
  const idsXdr = xdr.ScVal
    .scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id)))
    .toXDR();
  return hash(Buffer.concat([signaturePayload, idsXdr]));
}

describe("buildAuthDigest", () => {
  it("matches the documented sha256(payload ++ scvVec(ids).toXDR()) formula", () => {
    const payload = Buffer.alloc(32, 7);
    const ids = [0, 5, 42];
    expect(buildAuthDigest(payload, ids)).toEqual(referenceAuthDigest(payload, ids));
  });

  it("pins golden digest vectors (regression guard for the Rust formula)", () => {
    const payload = Buffer.alloc(32, 7);
    expect(buildAuthDigest(payload, [0, 5, 42]).toString("hex")).toBe(
      "5c00edbcad5ec543c2f3b7ad37ccf4878342d8e59c560fbe9256eba049668706"
    );
    expect(buildAuthDigest(payload, []).toString("hex")).toBe(
      "0f0b7265fdbecfcb83f0ed792c9bfd1a03439eb289cd39767128e845e9437c6d"
    );
  });

  it("binds the context rule ids: different ids produce different digests", () => {
    const payload = Buffer.alloc(32, 1);
    expect(buildAuthDigest(payload, [1]).toString("hex")).not.toBe(
      buildAuthDigest(payload, [2]).toString("hex")
    );
    expect(buildAuthDigest(payload, [1, 2]).toString("hex")).not.toBe(
      buildAuthDigest(payload, [2, 1]).toString("hex")
    );
  });

  it("always produces a 32-byte digest", () => {
    expect(buildAuthDigest(Buffer.alloc(32, 9), [3])).toHaveLength(32);
  });
});

describe("computeEntryAuthDigest", () => {
  it("returns a 32-byte digest consistent with buildAuthDigest", () => {
    const contractId = makeContract(1);
    const entry = makeAddressAuthEntry(contractId);
    const ids = [0, 3];

    const { signaturePayload, authDigest } = computeEntryAuthDigest(
      TESTNET,
      entry,
      100,
      ids
    );

    expect(authDigest).toHaveLength(32);
    expect(signaturePayload).toHaveLength(32);
    expect(authDigest).toEqual(buildAuthDigest(signaturePayload, ids));
  });

  it("writes the expiration onto the entry as a side effect", () => {
    const entry = makeAddressAuthEntry(makeContract(2));
    computeEntryAuthDigest(TESTNET, entry, 12345, [1]);
    expect(entry.credentials().address().signatureExpirationLedger()).toBe(12345);
  });

  it("changes the digest when expiration changes", () => {
    const entry = makeAddressAuthEntry(makeContract(3));
    const a = computeEntryAuthDigest(TESTNET, entry, 100, [1]).authDigest.toString("hex");
    const b = computeEntryAuthDigest(TESTNET, entry, 200, [1]).authDigest.toString("hex");
    expect(a).not.toBe(b);
  });
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
      [3]
    );
    expect(keypairA.verify(authDigest, sig)).toBe(true);
    expect(
      keypairA.verify(
        computeEntryAuthDigest(
          TESTNET,
          stellarXdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR()),
          500,
          [4]
        ).authDigest,
        sig
      )
    ).toBe(false);
  });

  it("adds a second signer to a partially signed entry without dropping the first", async () => {
    const entry = makeAddressAuthEntry(contractId);
    const first = await signAuthEntryWithSigners(entry, [signerA], {
      networkPassphrase: TESTNET,
      contextRuleIds: [3],
      expiration: 500,
    });
    // Second signer reads ids and expiration from the payload; no options needed.
    const second = await signAuthEntryWithSigners(first, [signerB], {
      networkPassphrase: TESTNET,
    });

    const payload = readAuthPayload(getAddressCredentials(second.credentials()).signature());
    expect(payload.context_rule_ids).toEqual([3]);
    expect(payload.signers.size).toBe(2);
  });

  it("replaces a repeated signer instead of duplicating it", async () => {
    const entry = makeAddressAuthEntry(contractId);
    const signed = await signAuthEntryWithSigners(entry, [signerA, signerA], {
      networkPassphrase: TESTNET,
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
          contextRuleIds: [0],
          expiration: 500,
        })
      ).rejects.toThrow(ValidationError);
    }
  });

  it("refuses a rule-id mismatch with an already signed payload", async () => {
    const first = await signAuthEntryWithSigners(makeAddressAuthEntry(contractId), [signerA], {
      networkPassphrase: TESTNET,
      contextRuleIds: [3],
      expiration: 500,
    });
    await expect(
      signAuthEntryWithSigners(first, [signerB], {
        networkPassphrase: TESTNET,
        contextRuleIds: [4],
      })
    ).rejects.toThrow(/different context rule IDs/);
  });

  it("requires rule ids, an expiration, and at least one signer", async () => {
    const entry = makeAddressAuthEntry(contractId);
    getAddressCredentials(entry.credentials()).signatureExpirationLedger(0);

    await expect(
      signAuthEntryWithSigners(entry, [signerA], { networkPassphrase: TESTNET, expiration: 500 })
    ).rejects.toThrow(/contextRuleIds are required/);
    await expect(
      signAuthEntryWithSigners(entry, [signerA], { networkPassphrase: TESTNET, contextRuleIds: [1] })
    ).rejects.toThrow(/expiration ledger is required/);
    await expect(
      signAuthEntryWithSigners(entry, [], {
        networkPassphrase: TESTNET,
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
      contextRuleIds: [7],
      expiration: 600,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(32);
    const payload = readAuthPayload(getAddressCredentials(signed.credentials()).signature());
    expect(Array.from(payload.signers.values())[0]).toEqual(Buffer.alloc(64, 9));
  });
});
