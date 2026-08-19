/**
 * Smart-account signer abstraction and the Ed25519 signer.
 *
 * All smart-account signers authenticate the SAME Protocol 27 auth digest:
 *
 *   signature_payload = sha256(P27 auth preimage)          // see auth-payload.ts
 *   auth_digest       = sha256(signature_payload ++ scvVec(context_rule_ids).toXDR())
 *
 * The auth digest binds the context rule ids, so rule selection cannot change
 * after signing.
 *
 * A signature-bearing signer (WebAuthn passkey, Ed25519) contributes bytes into
 * the AuthPayload `signers` map keyed by its on-chain {@link ContractSigner}:
 * - WebAuthn: XDR-encoded WebAuthnSigData (built in auth-payload.ts).
 * - Ed25519:  the raw 64-byte signature over the auth digest; the on-chain
 *   verifier reads it as `BytesN<64>` and checks it against the 32-byte key.
 *
 * Delegated (G-address) signers do NOT contribute AuthPayload bytes; their auth
 * is a nested `require_auth_for_args((auth_digest,))` handled in the multi-signer
 * path. They are therefore modelled separately from {@link AuthDigestSigner}.
 *
 * @packageDocumentation
 */

import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import { buildAuthDigest, buildSignaturePayload } from "./kit/auth-payload.js";
import { SmartAccountErrorCode, ValidationError } from "./errors.js";
import { ED25519_PUBLIC_KEY_SIZE, ED25519_SIGNATURE_SIZE } from "./constants.js";

/**
 * Compute the Protocol 27 signature payload and auth digest for an auth entry.
 *
 * Single source of truth for the auth-digest formula shared by every signer
 * type. Note: like {@link buildSignaturePayload}, this normalizes and writes the
 * entry's `signatureExpirationLedger` to `expiration` as a side effect.
 *
 * @param networkPassphrase - Network passphrase
 * @param entry - The Soroban auth entry being signed
 * @param expiration - Signature expiration ledger
 * @param contextRuleIds - Context rule ids bound into the digest
 */
export function computeEntryAuthDigest(
  networkPassphrase: string,
  entry: xdr.SorobanAuthorizationEntry,
  expiration: number,
  contextRuleIds: number[]
): { signaturePayload: Buffer; authDigest: Buffer } {
  const signaturePayload = buildSignaturePayload(networkPassphrase, entry, expiration);
  const authDigest = buildAuthDigest(signaturePayload, contextRuleIds);
  return { signaturePayload, authDigest };
}

/**
 * A signer that authenticates by placing signature bytes into the AuthPayload
 * `signers` map (WebAuthn passkeys and Ed25519 keys).
 */
export interface AuthDigestSigner {
  /** The on-chain contract signer identity this signer authenticates as. */
  readonly signer: ContractSigner;
  /**
   * Produce the AuthPayload signature bytes for a 32-byte auth digest.
   */
  signAuthDigest(authDigest: Buffer): Promise<Buffer> | Buffer;
}

/**
 * An Ed25519 external signer.
 *
 * Signs the raw 32-byte auth digest with a local Stellar keypair, producing the
 * 64-byte signature the deployed ed25519 verifier checks. The on-chain identity
 * is `External(ed25519VerifierAddress, <32-byte public key>)`.
 */
export class Ed25519Signer implements AuthDigestSigner {
  readonly signer: ContractSigner;
  private readonly keypair: Keypair;
  private readonly verifierAddress: string;

  constructor(keypair: Keypair, ed25519VerifierAddress: string) {
    const publicKey = Buffer.from(keypair.rawPublicKey());
    if (publicKey.length !== ED25519_PUBLIC_KEY_SIZE) {
      throw new ValidationError(
        `Ed25519 public key must be ${ED25519_PUBLIC_KEY_SIZE} bytes`,
        SmartAccountErrorCode.INVALID_INPUT,
        { actualLength: publicKey.length }
      );
    }
    this.keypair = keypair;
    this.verifierAddress = ed25519VerifierAddress;
    this.signer = {
      tag: "External",
      values: [ed25519VerifierAddress, publicKey],
    };
  }

  /**
   * Build an Ed25519Signer from a Stellar secret key (S...).
   *
   * @throws {ValidationError} If the secret key is invalid
   */
  static fromSecret(secretKey: string, ed25519VerifierAddress: string): Ed25519Signer {
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecret(secretKey);
    } catch {
      throw new ValidationError(
        "Invalid Ed25519 secret key. Must be a valid Stellar secret key (S...)"
      );
    }
    return new Ed25519Signer(keypair, ed25519VerifierAddress);
  }

  /** The 32-byte Ed25519 public key (= the External signer's key data). */
  get publicKey(): Buffer {
    return Buffer.from(this.keypair.rawPublicKey());
  }

  /** The G-address form of this signer's public key. */
  get address(): string {
    return this.keypair.publicKey();
  }

  /** The verifier contract this signer authenticates through. */
  get verifier(): string {
    return this.verifierAddress;
  }

  /**
   * Sign the raw 32-byte auth digest, returning the 64-byte Ed25519 signature
   * that the on-chain verifier reads as `BytesN<64>`.
   */
  signAuthDigest(authDigest: Buffer): Buffer {
    const signature = this.keypair.sign(authDigest);
    if (signature.length !== ED25519_SIGNATURE_SIZE) {
      // The on-chain verifier reads sig_data as BytesN<64>; a wrong length would
      // fail cryptically on-chain, so reject it here.
      throw new ValidationError(
        `Ed25519 signature must be ${ED25519_SIGNATURE_SIZE} bytes`,
        SmartAccountErrorCode.INVALID_INPUT,
        { actualLength: signature.length }
      );
    }
    return signature;
  }
}
