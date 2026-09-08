import { describe, expect, it } from "vitest";
import base64url from "base64url";
import { deriveContractAddress, extractPublicKeyFromAttestation } from "./utils";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const DEPLOYER = "GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N";

// Golden vectors for deterministic contract-address derivation. Generated from
// stellar-sdk's HashIdPreimage.envelopeTypeContractId and pinned here so any
// change to the derivation (salt = sha256(credentialId), network id, deployer)
// breaks the test instead of silently shifting deployed addresses.
const DERIVE_VECTORS = [
  { name: "zeros-16", credHex: "00".repeat(16), passphrase: TESTNET, deployer: DEPLOYER, expected: "CDTEIP7UZJSIGDFEAXOJ2567456XRMJP5DQ6GY6M4XRC6D6WOLDLZQBU" },
  { name: "zeros-32", credHex: "00".repeat(32), passphrase: TESTNET, deployer: DEPLOYER, expected: "CCOKEMTJ3SW4D36UKXVPASP34H67UFRUVOPHWH2I6L3YH45EOCGIKNG6" },
  { name: "ff-16", credHex: "ff".repeat(16), passphrase: TESTNET, deployer: DEPLOYER, expected: "CCDHFYA5CHV47HQUXXGKYJZ7D2AOZZGGQB3CU45K2EJQ7AVSVTRID3YM" },
  { name: "random-16", credHex: "0123456789abcdef0123456789abcdef", passphrase: TESTNET, deployer: DEPLOYER, expected: "CARY667YH5HC3PBTEV3HPPLPYRFK7XGBHIS2KLP4AM3NKWS4MCE3WGIH" },
  { name: "random-32", credHex: "deadbeefcafef00dfeedfacebaadf00d0123456789abcdef0123456789abcdef", passphrase: TESTNET, deployer: DEPLOYER, expected: "CC2VOBZ3UVBEJ6ZAKJXCDHMKV7TFJ3MIVL5XIJVEG6PHTBC4CQMX7NQX" },
  { name: "mainnet-same-cred", credHex: "0123456789abcdef0123456789abcdef", passphrase: MAINNET, deployer: DEPLOYER, expected: "CBRJOLL5OGC3HG3DDZTAA2544AUB36AMPUUSXZCTGM7SN4UX5XSUQUBM" },
] as const;

describe("utils.deriveContractAddress", () => {
  it.each(DERIVE_VECTORS)(
    "derives $name to the pinned contract address",
    ({ credHex, passphrase, deployer, expected }) => {
      const credentialId = Buffer.from(credHex, "hex");
      expect(deriveContractAddress(credentialId, deployer, passphrase)).toBe(
        expected
      );
    }
  );

  it("derives a different address on mainnet than testnet for the same credential", () => {
    const credentialId = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const testnet = deriveContractAddress(credentialId, DEPLOYER, TESTNET);
    const mainnet = deriveContractAddress(credentialId, DEPLOYER, MAINNET);
    expect(testnet).not.toBe(mainnet);
  });
});

describe("utils.extractPublicKeyFromAttestation", () => {
  it("rejects a registration response without a browser-provided public key", async () => {
    await expect(
      extractPublicKeyFromAttestation({
        clientDataJSON: "",
        attestationObject: base64url.encode(Buffer.alloc(200, 7)),
      })
    ).rejects.toThrow("did not provide a public key");
  });

  it("normalizes SPKI public keys from WebAuthn registration responses", async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );

    const spki = Buffer.from(
      new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey))
    );
    const raw = Buffer.from(
      new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
    );

    const extracted = await extractPublicKeyFromAttestation({
      clientDataJSON: "",
      attestationObject: "",
      publicKey: base64url.encode(spki),
    });

    expect(Buffer.from(extracted)).toEqual(raw);
    expect(extracted).toHaveLength(65);
    expect(extracted[0]).toBe(0x04);
  });

  it("rejects a malformed public key instead of slicing its last bytes", async () => {
    await expect(
      extractPublicKeyFromAttestation({
        clientDataJSON: "",
        attestationObject: "",
        publicKey: base64url.encode(Buffer.alloc(80, 7)),
      })
    ).rejects.toThrow("Could not extract a valid P-256 public key");
  });

  it("rejects an uncompressed point that is not on P-256", async () => {
    const invalidPoint = Buffer.alloc(65);
    invalidPoint[0] = 0x04;

    await expect(
      extractPublicKeyFromAttestation({
        clientDataJSON: "",
        attestationObject: "",
        publicKey: base64url.encode(invalidPoint),
      })
    ).rejects.toThrow("valid P-256 curve point");
  });
});
