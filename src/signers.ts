/**
 * Smart-account signer abstraction and the Ed25519 signer.
 *
 * All smart-account signers on an auth entry authenticate the SAME auth digest.
 * Its formula depends on the wallet's {@link AuthDigestScheme}:
 *
 *   signature_payload = sha256(HashIdPreimage)                // see auth-payload.ts
 *   legacy-concat:  auth_digest = sha256(signature_payload ++ scvVec(context_rule_ids).toXDR())
 *   preimage-v1:    auth_digest = sha256(AuthDigestPreimage {
 *                     account, signature_payload, context_rule_ids }.toXDR())
 *
 * The auth digest binds the context rule ids, so rule selection cannot change
 * after signing. `preimage-v1` also binds the smart account address.
 *
 * A signature-bearing signer (WebAuthn passkey, Ed25519) contributes bytes into
 * the AuthPayload `signers` map keyed by its on-chain {@link ContractSigner}:
 * - WebAuthn: XDR-encoded WebAuthnSigData (built in auth-payload.ts).
 * - Ed25519:  the raw 64-byte signature over the auth digest; the on-chain
 *   verifier reads it as `BytesN<64>` and checks it against the 32-byte key.
 *
 * Delegated (G-address) signers do NOT contribute AuthPayload bytes; their auth
 * is a nested `require_auth_for_args` handled in the multi-signer path, over
 * `(auth_digest,)` for `legacy-concat` and `(preimage,)` for `preimage-v1`.
 * They are therefore modelled separately from {@link AuthDigestSigner}.
 *
 * @packageDocumentation
 */

import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import {
  assertWalletMutationIntent,
  buildAuthDigestPreimage,
  buildLegacyAuthDigest,
  buildPreimageAuthDigest,
  buildSignaturePayload,
  getAddressCredentials,
  getAuthEntryAddress,
  normalizeSignatureExpirationLedger,
  readAuthPayload,
  upsertAuthPayloadSigner,
  writeAuthPayload,
} from "./kit/auth-payload.js";
import {
  AUTH_DIGEST_SCHEMES,
  isAuthDigestScheme,
  type AuthDigestScheme,
} from "./kit/auth-digest-scheme.js";
import { SmartAccountErrorCode, ValidationError } from "./errors.js";
import { ED25519_PUBLIC_KEY_SIZE, ED25519_SIGNATURE_SIZE } from "./constants.js";

/** The digest material every signer on one auth entry commits to. */
export interface EntryAuthDigest {
  /** The host `signature_payload` passed to `__check_auth`. */
  signaturePayload: Buffer;
  /** The 32-byte digest that External signers sign. */
  authDigest: Buffer;
  /** The `__check_auth` arguments that Delegated signers authorize. */
  delegatedAuthArgs: xdr.ScVal[];
}

/**
 * Compute the signature payload and auth digest for a smart-account auth entry.
 *
 * Single source of truth for the auth-digest formula shared by every signer
 * type. Note: like {@link buildSignaturePayload}, this normalizes and writes the
 * entry's `signatureExpirationLedger` to `expiration` as a side effect.
 *
 * @param networkPassphrase - Network passphrase
 * @param entry - The Soroban auth entry being signed
 * @param expiration - Signature expiration ledger
 * @param contextRuleIds - Context rule ids bound into the digest
 * @param scheme - The digest scheme of the code the smart account runs
 * @throws {ValidationError} If `scheme` is not a known scheme
 */
export function computeEntryAuthDigest(
  networkPassphrase: string,
  entry: xdr.SorobanAuthorizationEntry,
  expiration: number,
  contextRuleIds: number[],
  scheme: AuthDigestScheme
): EntryAuthDigest {
  const signaturePayload = buildSignaturePayload(networkPassphrase, entry, expiration);

  switch (scheme) {
    case "legacy-concat": {
      const authDigest = buildLegacyAuthDigest(signaturePayload, contextRuleIds);
      return {
        signaturePayload,
        authDigest,
        delegatedAuthArgs: [xdr.ScVal.scvBytes(authDigest)],
      };
    }
    case "preimage-v1": {
      const preimage = buildAuthDigestPreimage(
        getAuthEntryAddress(entry),
        signaturePayload,
        contextRuleIds
      );
      return {
        signaturePayload,
        authDigest: buildPreimageAuthDigest(preimage),
        delegatedAuthArgs: [preimage],
      };
    }
    default: {
      const unknown: never = scheme;
      throw new ValidationError(
        `Unknown authorization digest scheme: ${String(unknown)}. Expected one of ${AUTH_DIGEST_SCHEMES.join(", ")}.`,
        SmartAccountErrorCode.INVALID_INPUT,
        { scheme: unknown }
      );
    }
  }
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

/** Options for {@link signAuthEntryWithSigners}. */
export interface SignAuthEntryWithSignersOptions {
  /** Network passphrase the entry will be submitted on. */
  networkPassphrase: string;
  /**
   * Digest scheme of the code the smart account runs. This helper reads no
   * chain state, so the caller supplies it: look up the wallet's WASM hash in
   * {@link KNOWN_AUTH_DIGEST_SCHEMES}. A wrong scheme gives a signature that
   * fails `__check_auth`.
   */
  authDigestScheme: AuthDigestScheme;
  /**
   * Context rule ids bound into the auth digest. Required unless the entry's
   * AuthPayload already carries them (for example, a partially signed entry).
   */
  contextRuleIds?: number[];
  /**
   * Signature expiration ledger. Required unless the entry already has a
   * non-zero `signatureExpirationLedger`. On a partially signed entry it must
   * match the existing expiration, because the existing signatures cover it.
   */
  expiration?: number;
}

/**
 * Sign a smart-account authorization entry with local auth-digest signers and
 * return the signed entry WITHOUT submitting it.
 *
 * This is the sign-only path for headless or non-browser callers, such as an
 * agent that holds an Ed25519 key and hands the signed entry to a third party
 * (an x402 facilitator, a relayer, a coordinator) that builds and submits the
 * transaction. It needs no connected wallet, no RPC, and no WebAuthn.
 *
 * Security properties:
 * - Refuses smart-account mutations (`execute`, `upgrade`, signer, rule, and
 *   policy changes). Use `kit.multiSigners.adminOperation()` for those.
 * - Binds `contextRuleIds` into the auth digest, so the rule selection cannot
 *   change after signing. A mismatch with ids already in the payload throws.
 * - Never widens a partially signed payload: existing signatures are kept and
 *   the same signer is replaced, not duplicated. A changed expiration or rule
 *   selection would invalidate them, so either one throws.
 *
 * @param entry - The `SorobanAuthorizationEntry` from simulation
 * @param signers - Local signers (e.g. {@link Ed25519Signer}) that sign the digest
 * @param options - Network passphrase, digest scheme, context rule ids, and
 *   expiration
 * @returns A signed copy of the entry; the input is not modified
 * @throws {ValidationError} On empty signers, an unknown digest scheme,
 *   unsupported credentials, a wallet mutation, a missing or changed
 *   expiration, or missing/mismatched rule ids
 *
 * @example
 * ```ts
 * const signer = Ed25519Signer.fromSecret(process.env.AGENT_SECRET!, verifier);
 * const signed = await signAuthEntryWithSigners(entry, [signer], {
 *   networkPassphrase: Networks.TESTNET,
 *   authDigestScheme: KNOWN_AUTH_DIGEST_SCHEMES[walletWasmHash],
 *   contextRuleIds: [usdcRuleId],
 *   expiration: latestLedger + 100,
 * });
 * facilitator.settle(signed.toXDR("base64"));
 * ```
 */
export async function signAuthEntryWithSigners(
  entry: xdr.SorobanAuthorizationEntry,
  signers: readonly AuthDigestSigner[],
  options: SignAuthEntryWithSignersOptions
): Promise<xdr.SorobanAuthorizationEntry> {
  if (signers.length === 0) {
    throw new ValidationError(
      "At least one signer is required",
      SmartAccountErrorCode.INVALID_INPUT
    );
  }
  if (!isAuthDigestScheme(options.authDigestScheme)) {
    throw new ValidationError(
      `authDigestScheme must be one of ${AUTH_DIGEST_SCHEMES.join(", ")} (got "${String(options.authDigestScheme)}")`,
      SmartAccountErrorCode.INVALID_INPUT,
      { authDigestScheme: options.authDigestScheme }
    );
  }

  const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentialType = signed.credentials().switch().name as string;
  if (credentialType === "sorobanCredentialsAddressWithDelegates") {
    throw new ValidationError(
      "ADDRESS_WITH_DELEGATES auth entries are not supported by sign-only signing yet",
      SmartAccountErrorCode.INVALID_INPUT
    );
  }
  if (
    credentialType !== "sorobanCredentialsAddress" &&
    credentialType !== "sorobanCredentialsAddressV2"
  ) {
    throw new ValidationError(
      "Only address-credential auth entries can be signed by a smart account",
      SmartAccountErrorCode.INVALID_INPUT,
      { credentialType }
    );
  }

  const contractId = getAuthEntryAddress(signed);
  // No host function: this is a generic path and must refuse admin mutations.
  assertWalletMutationIntent(signed, contractId);

  const credentials = getAddressCredentials(signed.credentials());
  const existingExpiration = credentials.signatureExpirationLedger();
  const requestedExpiration = options.expiration ?? existingExpiration;
  if (!requestedExpiration) {
    throw new ValidationError(
      "A signature expiration ledger is required to sign this auth entry",
      SmartAccountErrorCode.INVALID_INPUT
    );
  }
  const expiration = normalizeSignatureExpirationLedger(requestedExpiration);

  const authPayload = readAuthPayload(credentials.signature());
  if (authPayload.signers.size > 0 && expiration !== existingExpiration) {
    throw new ValidationError(
      "Existing signatures cover a different expiration ledger",
      SmartAccountErrorCode.INVALID_INPUT,
      { existing: existingExpiration, requested: expiration }
    );
  }
  const contextRuleIds = options.contextRuleIds ?? authPayload.context_rule_ids;
  if (contextRuleIds.length === 0) {
    throw new ValidationError(
      "contextRuleIds are required to sign smart account auth entries when the payload does not already include them",
      SmartAccountErrorCode.INVALID_INPUT
    );
  }
  if (
    authPayload.context_rule_ids.length > 0 &&
    authPayload.context_rule_ids.join(",") !== contextRuleIds.join(",")
  ) {
    throw new ValidationError(
      "Existing auth payload uses different context rule IDs",
      SmartAccountErrorCode.INVALID_INPUT,
      { existing: authPayload.context_rule_ids, requested: contextRuleIds }
    );
  }

  const { authDigest } = computeEntryAuthDigest(
    options.networkPassphrase,
    signed,
    expiration,
    contextRuleIds,
    options.authDigestScheme
  );

  for (const signer of signers) {
    const signatureBytes = await signer.signAuthDigest(authDigest);
    upsertAuthPayloadSigner(authPayload, signer.signer, Buffer.from(signatureBytes));
  }

  authPayload.context_rule_ids = [...contextRuleIds];
  credentials.signature(writeAuthPayload(authPayload));
  return signed;
}
