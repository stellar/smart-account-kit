/**
 * Utility functions for the Smart Account Kit SDK.
 *
 * Contains cryptographic helpers, validation functions, and common operations.
 *
 * @packageDocumentation
 */

import { StrKey, hash, xdr, Address, Keypair } from "@stellar/stellar-sdk";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import base64url from "./base64url.js";

import {
  SECP256R1_PUBLIC_KEY_SIZE,
  UNCOMPRESSED_PUBKEY_PREFIX,
  STROOPS_PER_XLM,
  DEFAULT_DEPLOYER_SEED,
} from "./constants.js";
import {
  ValidationError,
  SmartAccountErrorCode,
} from "./errors.js";

/**
 * Public key of the shared, deterministic default deployer (derived once from
 * {@link DEFAULT_DEPLOYER_SEED}).
 */
export const DEFAULT_DEPLOYER_PUBLIC_KEY = Keypair.fromRawEd25519Seed(
  hash(Buffer.from(DEFAULT_DEPLOYER_SEED))
).publicKey();

/**
 * True when `publicKey` is the shared default deployer.
 *
 * This sign-only identity must not provide the transaction source or fee.
 * This predicate supports the guards in each deployment and submission path.
 */
export function isDefaultDeployer(publicKey: string): boolean {
  return publicKey === DEFAULT_DEPLOYER_PUBLIC_KEY;
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate that a string is a valid Stellar address (G... or C...).
 *
 * Uses stellar-sdk's StrKey methods for proper checksum validation.
 *
 * @param address - The address to validate
 * @param fieldName - Name of the field for error messages
 * @throws {ValidationError} If the address is invalid
 */
export function validateAddress(address: string, fieldName: string = "address"): void {
  if (!address || typeof address !== "string") {
    throw new ValidationError(
      `${fieldName} is required`,
      SmartAccountErrorCode.INVALID_ADDRESS,
      { field: fieldName }
    );
  }

  const isValidAccount = StrKey.isValidEd25519PublicKey(address);
  const isValidContract = StrKey.isValidContract(address);

  if (!isValidAccount && !isValidContract) {
    throw new ValidationError(
      `Invalid ${fieldName}: must be a valid Stellar account (G...) or contract (C...) address`,
      SmartAccountErrorCode.INVALID_ADDRESS,
      { field: fieldName, value: address.slice(0, 10) + "..." }
    );
  }
}

/**
 * Validate that an amount is a positive number.
 *
 * @param amount - The amount to validate
 * @param fieldName - Name of the field for error messages
 * @throws {ValidationError} If the amount is invalid
 */
export function validateAmount(amount: number, fieldName: string = "amount"): void {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new ValidationError(
      `${fieldName} must be a number`,
      SmartAccountErrorCode.INVALID_AMOUNT,
      { field: fieldName }
    );
  }

  if (amount <= 0) {
    throw new ValidationError(
      `${fieldName} must be positive`,
      SmartAccountErrorCode.INVALID_AMOUNT,
      { field: fieldName, value: amount }
    );
  }
}

// ============================================================================
// Conversion Helpers
// ============================================================================

/**
 * Convert XLM amount to stroops.
 *
 * @param xlm - Amount in XLM
 * @returns Amount in stroops as BigInt
 */
export function xlmToStroops(xlm: number): bigint {
  return BigInt(Math.round(xlm * STROOPS_PER_XLM));
}

/**
 * Convert stroops to XLM amount.
 *
 * @param stroops - Amount in stroops
 * @returns Amount in XLM
 */
export function stroopsToXlm(stroops: bigint | number): number {
  return Number(stroops) / STROOPS_PER_XLM;
}

// ============================================================================
// Key Data Helpers
// ============================================================================

/**
 * Build key_data by concatenating public key and credential ID.
 *
 * The key_data format is: pubkey (65 bytes) + credentialId (variable bytes)
 *
 * @param publicKey - The 65-byte uncompressed secp256r1 public key
 * @param credentialId - The credential ID (as base64url string or Buffer)
 * @returns Concatenated key_data as Buffer
 */
export function buildKeyData(
  publicKey: Uint8Array,
  credentialId: string | Buffer
): Buffer {
  const credentialIdBuffer =
    typeof credentialId === "string"
      ? base64url.toBuffer(credentialId)
      : credentialId;

  return Buffer.concat([Buffer.from(publicKey), credentialIdBuffer]);
}

// ============================================================================
// Cryptographic Helpers
// ============================================================================

/**
 * Derive a contract address from a credential ID.
 *
 * Uses the Stellar contract ID preimage to deterministically derive
 * the contract address from the deployer and credential ID.
 *
 * @param credentialId - The credential ID buffer
 * @param deployerPublicKey - The deployer's public key string
 * @param networkPassphrase - The network passphrase
 * @returns The derived contract address (C...)
 */
export function deriveContractAddress(
  credentialId: Buffer,
  deployerPublicKey: string,
  networkPassphrase: string
): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployerPublicKey).toScAddress(),
          salt: hash(credentialId),
        })
      ),
    })
  );

  return StrKey.encodeContract(hash(preimage.toXDR()));
}

/**
 * Extract the public key from a WebAuthn attestation response.
 *
 * Requires the browser-provided `response.publicKey` value. It accepts a raw
 * P-256 point or an SPKI key and validates the resulting curve point.
 *
 * @param response - The WebAuthn registration response
 * @returns The 65-byte uncompressed secp256r1 public key
 * @throws {Error} If public key cannot be extracted
 */
export async function extractPublicKeyFromAttestation(
  response: RegistrationResponseJSON["response"]
): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;

  const validateRawKey = async (candidate: Buffer): Promise<Uint8Array> => {
    if (
      candidate.length !== SECP256R1_PUBLIC_KEY_SIZE ||
      candidate[0] !== UNCOMPRESSED_PUBKEY_PREFIX
    ) {
      throw new Error("WebAuthn public key is not an uncompressed P-256 key");
    }
    if (!subtle) {
      throw new Error("WebCrypto is required to validate a WebAuthn public key");
    }
    try {
      await subtle.importKey(
        "raw",
        new Uint8Array(candidate),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
    } catch {
      throw new Error("WebAuthn public key is not a valid P-256 curve point");
    }
    return new Uint8Array(candidate);
  };

  if (!response.publicKey) {
    throw new Error("WebAuthn registration did not provide a public key");
  }

  const encodedPublicKey = base64url.toBuffer(response.publicKey);
  if (
    encodedPublicKey.length === SECP256R1_PUBLIC_KEY_SIZE &&
    encodedPublicKey[0] === UNCOMPRESSED_PUBKEY_PREFIX
  ) {
    return validateRawKey(encodedPublicKey);
  }

  if (!subtle) {
    throw new Error("WebCrypto is required to decode a WebAuthn public key");
  }

  try {
    const imported = await subtle.importKey(
      "spki",
      new Uint8Array(encodedPublicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      []
    );
    const rawKey = await subtle.exportKey("raw", imported);
    return validateRawKey(Buffer.from(new Uint8Array(rawKey)));
  } catch {
    throw new Error("Could not extract a valid P-256 public key from WebAuthn registration");
  }
}

/**
 * Convert a DER-encoded ECDSA signature to compact format with low-S.
 *
 * Stellar requires signatures in compact (r || s) format with low-S values.
 * This function:
 * 1. Decodes the DER structure
 * 2. Ensures S is in low-S form (S <= n/2)
 * 3. Returns 64-byte compact signature
 *
 * @param derSignature - The DER-encoded signature
 * @returns 64-byte compact signature (r || s)
 */
export function compactSignature(derSignature: Buffer): Uint8Array {
  const malformed = (reason: string): ValidationError =>
    new ValidationError(`Malformed DER ECDSA signature: ${reason}`);
  if (derSignature.length < 8) throw malformed("too short");
  if (derSignature[0] !== 0x30) throw malformed("missing SEQUENCE tag");
  const totalLength = derSignature[1]!;
  if (totalLength >= 0x80) throw malformed("long-form length is unsupported");
  if (totalLength !== derSignature.length - 2) {
    throw malformed("SEQUENCE length does not span the buffer");
  }

  if (derSignature[2] !== 0x02) throw malformed("missing INTEGER tag for r");
  const rLength = derSignature[3]!;
  if (rLength < 1 || rLength > 33) throw malformed("r length is out of range");
  if (4 + rLength + 2 > derSignature.length) {
    throw malformed("r overruns the buffer");
  }
  const r = derSignature.subarray(4, 4 + rLength);

  const sTagOffset = 4 + rLength;
  if (derSignature[sTagOffset] !== 0x02) {
    throw malformed("missing INTEGER tag for s");
  }
  const sLength = derSignature[sTagOffset + 1]!;
  if (sLength < 1 || sLength > 33) throw malformed("s length is out of range");
  if (sTagOffset + 2 + sLength !== derSignature.length) {
    throw malformed("s does not end at the buffer end");
  }
  const s = derSignature.subarray(sTagOffset + 2);

  // Convert to BigInt for low-S calculation
  const rBigInt = BigInt("0x" + r.toString("hex"));
  let sBigInt = BigInt("0x" + s.toString("hex"));

  // Ensure low-S form (required by Stellar)
  // n is the order of the secp256r1 curve
  const n = BigInt(
    "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551"
  );
  if (rBigInt < 1n || rBigInt >= n) {
    throw malformed("r is out of curve order range");
  }
  if (sBigInt < 1n || sBigInt >= n) {
    throw malformed("s is out of curve order range");
  }
  const halfN = n / 2n;

  if (sBigInt > halfN) {
    sBigInt = n - sBigInt;
  }

  // Convert back to 32-byte buffers (padded)
  const rPadded = Buffer.from(rBigInt.toString(16).padStart(64, "0"), "hex");
  const sLowS = Buffer.from(sBigInt.toString(16).padStart(64, "0"), "hex");

  return new Uint8Array(Buffer.concat([rPadded, sLowS]));
}

// ============================================================================
// WebAuthn Helpers
// ============================================================================

/**
 * Generate a random challenge for WebAuthn operations.
 *
 * @returns A base64url-encoded random challenge
 */
export function generateChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url.encode(Buffer.from(bytes));
}
