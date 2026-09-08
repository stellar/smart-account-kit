import { describe, expect, it, vi } from "vitest";
import base64url from "base64url";
import { StrKey, hash } from "@stellar/stellar-sdk";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import {
  authenticatePasskey,
  createPasskey,
  signAuthEntry,
} from "./webauthn-ops";
import { readAuthPayload, getAddressCredentials } from "./auth-payload";
import { makeAddressAuthEntry } from "../managers/test-utils";
import { SmartAccountErrorCode, ValidationError } from "../errors";

const NETWORK = "Test SDF Network ; September 2015";
const CONTRACT = StrKey.encodeContract(hash(Buffer.from("wallet")));
const OTHER_CONTRACT = StrKey.encodeContract(hash(Buffer.from("other-wallet")));
const VERIFIER = StrKey.encodeContract(hash(Buffer.from("verifier")));

/** A minimal, well-formed DER ECDSA signature (r=32B, s=32B) for compaction. */
function derSignature(): Buffer {
  const r = Buffer.alloc(32, 0x11);
  const s = Buffer.alloc(32, 0x22);
  return Buffer.concat([
    Buffer.from([0x30, 0x44, 0x02, 0x20]),
    r,
    Buffer.from([0x02, 0x20]),
    s,
  ]);
}

async function spkiPublicKeyB64(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const spki = Buffer.from(
    new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey))
  );
  return base64url.encode(spki);
}

describe("createPasskey", () => {
  it("registers a passkey and extracts the public key", async () => {
    const startRegistration = vi.fn(async () => ({
      id: "cred-abc",
      response: { publicKey: await spkiPublicKeyB64(), transports: ["internal"] },
    }));
    const deps = {
      rpName: "Test App",
      webAuthn: { startRegistration, startAuthentication: vi.fn() },
    } as never;

    const result = await createPasskey(deps, "App", "alice");

    expect(startRegistration).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({
        authenticatorSelection: expect.objectContaining({
          userVerification: "required",
        }),
      }),
    });
    expect(result.credentialId).toBe("cred-abc");
    expect(result.publicKey).toHaveLength(65);
    expect(result.publicKey[0]).toBe(0x04);
  });
});

describe("authenticatePasskey", () => {
  it("returns the asserted credential id", async () => {
    const startAuthentication = vi.fn(async () => ({ id: "cred-xyz", response: {} }));
    const deps = {
      rpName: "Test App",
      webAuthn: { startRegistration: vi.fn(), startAuthentication },
    } as never;

    const result = await authenticatePasskey(deps);

    expect(result.credentialId).toBe("cred-xyz");
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({ userVerification: "required" }),
    });
  });
});

describe("signAuthEntry", () => {
  it("signs an auth entry into an AuthPayload keyed by the WebAuthn signer", async () => {
    const credentialId = "cred-abc";
    const signer: ContractSigner = {
      tag: "External",
      values: [VERIFIER, Buffer.concat([Buffer.alloc(65, 4), base64url.toBuffer(credentialId)])],
    };

    const startAuthentication = vi.fn(async ({ optionsJSON }) => {
      // The WebAuthn challenge is the base64url of the 32-byte auth digest.
      expect(base64url.toBuffer(optionsJSON.challenge)).toHaveLength(32);
      return {
        id: credentialId,
        response: {
          signature: base64url.encode(derSignature()),
          authenticatorData: base64url.encode(Buffer.alloc(37, 1)),
          clientDataJSON: base64url.encode(Buffer.from('{"type":"webauthn.get"}')),
        },
      };
    });

    const update = vi.fn();
    const calculateExpiration = vi.fn(async () => 1000);
    const deps = {
      rpName: "Test App",
      networkPassphrase: NETWORK,
      storage: { update },
      calculateExpiration,
      getCredentialId: () => credentialId,
      requireWallet: () => ({ wallet: {}, contractId: CONTRACT }),
      rpc: {} as never,
      timeoutInSeconds: 30,
      webAuthn: { startRegistration: vi.fn(), startAuthentication },
    } as never;

    const entry = makeAddressAuthEntry(CONTRACT);

    const signed = await signAuthEntry(deps, entry, {
      credentialId,
      contextRuleIds: [0],
      signer,
    });

    // The auth entry now carries an AuthPayload with our signer's signature bytes.
    const payload = readAuthPayload(getAddressCredentials(signed.credentials()).signature());
    expect(payload.context_rule_ids).toEqual([0]);
    expect(payload.signers.size).toBe(1);
    expect(getAddressCredentials(signed.credentials()).signatureExpirationLedger()).toBe(1);
    expect(calculateExpiration).not.toHaveBeenCalled();
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({ userVerification: "required" }),
    });
    expect(update).toHaveBeenCalledWith(credentialId, expect.objectContaining({ lastUsedAt: expect.any(Number) }));
  });

  it("rejects when no context rule ids are available", async () => {
    const deps = {
      rpName: "Test App",
      networkPassphrase: NETWORK,
      storage: { update: vi.fn() },
      calculateExpiration: async () => 1000,
      getCredentialId: () => "cred-abc",
      requireWallet: () => ({ wallet: {}, contractId: CONTRACT }),
      rpc: {} as never,
      timeoutInSeconds: 30,
      webAuthn: { startRegistration: vi.fn(), startAuthentication: vi.fn() },
    } as never;

    await expect(
      signAuthEntry(deps, makeAddressAuthEntry(CONTRACT), { credentialId: "cred-abc" })
    ).rejects.toThrow();
  });

  it("uses a typed error for an entry from another smart account", async () => {
    const deps = {
      requireWallet: () => ({ wallet: {}, contractId: CONTRACT }),
    } as never;

    try {
      await signAuthEntry(deps, makeAddressAuthEntry(OTHER_CONTRACT));
      throw new Error("Expected signAuthEntry to reject the foreign entry");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe(
        SmartAccountErrorCode.INVALID_INPUT
      );
    }
  });
});
