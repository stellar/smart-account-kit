import { describe, expect, it, vi } from "vitest";
import base64url from "base64url";
import { StrKey, hash, xdr } from "@stellar/stellar-sdk";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import {
  authenticatePasskey,
  createPasskey,
  signAuthEntry,
} from "./webauthn-ops";
import { readAuthPayload, writeAuthPayload, getAddressCredentials } from "./auth-payload";
import { AUTH_DIGEST_SCHEMES } from "./auth-digest-scheme";
import { makeAddressAuthEntry } from "../managers/test-utils";
import { buildTokenTransferHostFunction } from "./tx-ops";
import { computeEntryAuthDigest } from "../signers";
import {
  AuthDigestSchemeError,
  SmartAccountErrorCode,
  ValidationError,
} from "../errors";

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
  const credentialId = "cred-abc";
  const signer: ContractSigner = {
    tag: "External",
    values: [VERIFIER, Buffer.concat([Buffer.alloc(65, 4), base64url.toBuffer(credentialId)])],
  };

  function makeSigningDeps(overrides: {
    startAuthentication?: ReturnType<typeof vi.fn>;
    resolveAuthDigestScheme?: ReturnType<typeof vi.fn>;
  } = {}) {
    const startAuthentication = overrides.startAuthentication ?? vi.fn(async () => ({
      id: credentialId,
      response: {
        signature: base64url.encode(derSignature()),
        authenticatorData: base64url.encode(Buffer.alloc(37, 1)),
        clientDataJSON: base64url.encode(Buffer.from('{"type":"webauthn.get"}')),
      },
    }));
    const update = vi.fn();
    const calculateExpiration = vi.fn(async () => 1000);
    const resolveAuthDigestScheme =
      overrides.resolveAuthDigestScheme ?? vi.fn(async () => "preimage-v1");
    const deps = {
      rpName: "Test App",
      networkPassphrase: NETWORK,
      storage: { update },
      calculateExpiration,
      getCredentialId: () => credentialId,
      requireWallet: () => ({ wallet: {}, contractId: CONTRACT }),
      rpc: {} as never,
      timeoutInSeconds: 30,
      resolveAuthDigestScheme,
      webAuthn: { startRegistration: vi.fn(), startAuthentication },
    } as never;
    return { deps, startAuthentication, update, calculateExpiration, resolveAuthDigestScheme };
  }

  it("signs an auth entry into an AuthPayload keyed by the WebAuthn signer", async () => {
    const { deps, startAuthentication, update, calculateExpiration } = makeSigningDeps();
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

  for (const scheme of AUTH_DIGEST_SCHEMES) {
    it(`uses the wallet's resolved ${scheme} digest as the WebAuthn challenge`, async () => {
      const resolveAuthDigestScheme = vi.fn(async () => scheme);
      const { deps, startAuthentication } = makeSigningDeps({ resolveAuthDigestScheme });

      await signAuthEntry(deps, makeAddressAuthEntry(CONTRACT), {
        credentialId,
        contextRuleIds: [0, 2],
        signer,
      });

      const { authDigest } = computeEntryAuthDigest(
        NETWORK,
        makeAddressAuthEntry(CONTRACT),
        1,
        [0, 2],
        scheme
      );
      expect(resolveAuthDigestScheme).toHaveBeenCalledWith(CONTRACT);
      expect(startAuthentication).toHaveBeenCalledWith({
        optionsJSON: expect.objectContaining({ challenge: base64url.encode(authDigest) }),
      });
    });
  }

  it("uses a scheme the caller already resolved without reading the wallet again", async () => {
    const resolveAuthDigestScheme = vi.fn(async () => "preimage-v1");
    const { deps, startAuthentication } = makeSigningDeps({ resolveAuthDigestScheme });

    await signAuthEntry(deps, makeAddressAuthEntry(CONTRACT), {
      credentialId,
      contextRuleIds: [0],
      signer,
      authDigestScheme: "legacy-concat",
    });

    const { authDigest } = computeEntryAuthDigest(
      NETWORK,
      makeAddressAuthEntry(CONTRACT),
      1,
      [0],
      "legacy-concat"
    );
    expect(resolveAuthDigestScheme).not.toHaveBeenCalled();
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({ challenge: base64url.encode(authDigest) }),
    });
  });

  it("refuses to prompt the passkey when the wallet's digest scheme is unknown", async () => {
    const resolveAuthDigestScheme = vi.fn(async () => {
      throw new AuthDigestSchemeError(CONTRACT, "ab".repeat(32));
    });
    const { deps, startAuthentication } = makeSigningDeps({ resolveAuthDigestScheme });

    await expect(
      signAuthEntry(deps, makeAddressAuthEntry(CONTRACT), {
        credentialId,
        contextRuleIds: [0],
        signer,
      })
    ).rejects.toBeInstanceOf(AuthDigestSchemeError);
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it.each([undefined, [2]])("rejects supplied Default rule IDs before the passkey prompt (pin: %j)", async (contextRuleIds) => {
    const { deps, startAuthentication } = makeSigningDeps();
    const entry = makeAddressAuthEntry(CONTRACT);
    entry.rootInvocation().function(
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        buildTokenTransferHostFunction(OTHER_CONTRACT, CONTRACT, VERIFIER, 100_000_000n).invokeContract()
      )
    );
    getAddressCredentials(entry.credentials()).signature(writeAuthPayload({
      context_rule_ids: [0],
      signers: new Map(),
    }));

    await expect(signAuthEntry(deps, entry, {
      credentialId,
      signer,
      contextRuleIds,
    })).rejects.toThrow(contextRuleIds ? /different context rule IDs/ : /contextRuleIds are required/);
    expect(startAuthentication).not.toHaveBeenCalled();
  });

  it("rejects when no context rule ids are available", async () => {
    const { deps } = makeSigningDeps();

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
