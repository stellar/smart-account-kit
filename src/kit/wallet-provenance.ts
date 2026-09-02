/** Immutable wallet-birth and fresh WebAuthn verification. */

import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import {
  Address,
  FeeBumpTransaction,
  StrKey,
  TransactionBuilder,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import type { Horizon } from "@stellar/stellar-sdk";
import { Api, type Server } from "@stellar/stellar-sdk/rpc";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";
import base64url from "../base64url.js";
import type { PolicyConfig } from "../types.js";
import type { WalletCandidate } from "../indexer.js";
import { compactSignature } from "../utils.js";
import { compareScVal, parseSignerScVal } from "./auth-payload.js";
import { buildConstructorPolicies } from "./policies-ops.js";

const HASH_HEX = /^[0-9a-f]{64}$/;
const P256_PUBLIC_KEY_SIZE = 65;
const AUTHENTICATOR_DATA_MIN_SIZE = 37;
const USER_PRESENT_FLAG = 0x01;
const USER_VERIFIED_FLAG = 0x04;

/** A verified immutable wallet birth. */
export interface VerifiedWalletBirth extends WalletCandidate {
  constructorArgsHash: string;
  birthSigner: ContractSigner;
}

export type WalletBirthFailure =
  | "invalid_candidate"
  | "transaction_not_found"
  | "transaction_failed"
  | "transaction_hash_mismatch"
  | "ledger_mismatch"
  | "contract_not_created"
  | "ambiguous_creation"
  | "deployer_mismatch"
  | "salt_mismatch"
  | "wasm_mismatch"
  | "wasm_not_accepted"
  | "constructor_mismatch";

export type WalletBirthResult =
  | { ok: true; birth: VerifiedWalletBirth }
  | { ok: false; reason: WalletBirthFailure; detail: string };

export interface WalletBirthVerificationDeps {
  rpc: Server;
  history?: Pick<Horizon.Server, "transactions">;
  networkPassphrase: string;
  acceptedBirthWasmHashes: readonly string[];
  webauthnVerifierAddress: string;
  expectedDeployer?: string;
  expectedSalt?: Uint8Array;
  expectedConstructorArgsHash?: string;
  expectedPolicies?: readonly PolicyConfig[];
}

function normalizeHash(value: string): string | undefined {
  const normalized = value.toLowerCase();
  return HASH_HEX.test(normalized) ? normalized : undefined;
}

function fail(reason: WalletBirthFailure, detail: string): WalletBirthResult {
  return { ok: false, reason, detail };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++) {
    diff |= left[index]! ^ right[index]!;
  }
  return diff === 0;
}

/** Derive the contract address created by one CreateContractV2 operation. */
export function contractIdFromCreateV2(
  networkPassphrase: string,
  create: xdr.CreateContractArgsV2
): string | undefined {
  const preimage = create.contractIdPreimage();
  if (preimage.switch().name !== "contractIdPreimageFromAddress") {
    return undefined;
  }

  const hashPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: preimage,
    })
  );
  return StrKey.encodeContract(hash(hashPreimage.toXDR()));
}

/** Hash the complete constructor argument vector. */
export function constructorArgsHash(args: readonly xdr.ScVal[]): string {
  return hash(xdr.ScVal.scvVec([...args]).toXDR()).toString("hex");
}

function expectedPoliciesScVal(policies: readonly PolicyConfig[]): xdr.ScVal {
  const entries = [...buildConstructorPolicies([...policies])].map(
    ([address, value]) =>
      new xdr.ScMapEntry({
        key: Address.fromString(address).toScVal(),
        val: value,
      })
  );
  entries.sort((left, right) => compareScVal(left.key(), right.key()));
  return xdr.ScVal.scvMap(entries);
}

function validateConstructor(
  create: xdr.CreateContractArgsV2,
  deps: WalletBirthVerificationDeps
): { signer: ContractSigner; argsHash: string } | WalletBirthResult {
  const args = create.constructorArgs();
  const argsHash = constructorArgsHash(args);
  if (args.length !== 2 || args[0]?.switch().name !== "scvVec") {
    return fail(
      "constructor_mismatch",
      "the wallet constructor must contain one signer vector and one policy map"
    );
  }

  const signerValues = args[0].vec() ?? [];
  if (signerValues.length !== 1) {
    return fail(
      "constructor_mismatch",
      "the wallet constructor must contain exactly one initial signer"
    );
  }

  let signer: ContractSigner;
  try {
    signer = parseSignerScVal(signerValues[0]!);
  } catch {
    return fail("constructor_mismatch", "the initial signer cannot be decoded");
  }
  if (
    signer.tag !== "External" ||
    signer.values[0] !== deps.webauthnVerifierAddress ||
    signer.values[1].length <= P256_PUBLIC_KEY_SIZE ||
    signer.values[1][0] !== 0x04
  ) {
    return fail(
      "constructor_mismatch",
      "the initial signer is not one valid WebAuthn signer for the configured verifier"
    );
  }

  const expectedArgsHash = deps.expectedConstructorArgsHash
    ? normalizeHash(deps.expectedConstructorArgsHash)
    : undefined;
  if (deps.expectedConstructorArgsHash && !expectedArgsHash) {
    return fail("constructor_mismatch", "the expected constructor hash is malformed");
  }
  if (expectedArgsHash) {
    if (argsHash !== expectedArgsHash) {
      return fail(
        "constructor_mismatch",
        "the immutable constructor arguments do not match the locally approved deployment"
      );
    }
  } else {
    const actualPolicies = args[1];
    const expectedPolicies = expectedPoliciesScVal(deps.expectedPolicies ?? []);
    if (!actualPolicies || !bytesEqual(actualPolicies.toXDR(), expectedPolicies.toXDR())) {
      return fail(
        "constructor_mismatch",
        "the immutable constructor policies do not match the expected policy configuration"
      );
    }
  }

  return { signer, argsHash };
}

/** Verify an indexer or local birth claim against immutable transaction history. */
export async function verifyWalletBirth(
  deps: WalletBirthVerificationDeps,
  candidate: WalletCandidate
): Promise<WalletBirthResult> {
  const claimedWasm = normalizeHash(candidate.birthWasmHash);
  const txHash = normalizeHash(candidate.creationTransactionHash);
  const accepted = new Set(
    deps.acceptedBirthWasmHashes
      .map(normalizeHash)
      .filter((value): value is string => value !== undefined)
  );
  if (
    !claimedWasm ||
    !txHash ||
    !Number.isSafeInteger(candidate.creationLedger) ||
    candidate.creationLedger < 1
  ) {
    return fail("invalid_candidate", "wallet birth metadata is malformed");
  }

  const rpcResponse = await deps.rpc.getTransaction(txHash);
  let ledger: number;
  let envelopeXdr: xdr.TransactionEnvelope | string;
  if (rpcResponse.status === Api.GetTransactionStatus.SUCCESS) {
    ledger = rpcResponse.ledger;
    envelopeXdr = rpcResponse.envelopeXdr;
  } else if (rpcResponse.status === Api.GetTransactionStatus.FAILED) {
    return fail("transaction_failed", "the claimed creation transaction failed");
  } else if (deps.history) {
    try {
      const historical = await deps.history
        .transactions()
        .transaction(txHash)
        .call();
      if (!historical.successful) {
        return fail("transaction_failed", "the historical creation transaction failed");
      }
      if (historical.hash.toLowerCase() !== txHash) {
        return fail(
          "transaction_hash_mismatch",
          "the history response returned a different transaction hash"
        );
      }
      ledger = historical.ledger_attr;
      envelopeXdr = historical.envelope_xdr;
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "response" in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined;
      if (status !== 404) throw error;
      return fail(
        "transaction_not_found",
        "the creation transaction is unavailable from RPC and history"
      );
    }
  } else {
    return fail(
      "transaction_not_found",
      "the creation transaction is outside RPC retention and no history source is configured"
    );
  }

  if (ledger !== candidate.creationLedger) {
    return fail(
      "ledger_mismatch",
      `creation ledger ${ledger} does not equal claimed ledger ${candidate.creationLedger}`
    );
  }

  const parsed = TransactionBuilder.fromXDR(envelopeXdr, deps.networkPassphrase);
  if (parsed.hash().toString("hex") !== txHash) {
    return fail(
      "transaction_hash_mismatch",
      "the transaction envelope does not match the claimed transaction hash"
    );
  }
  const transaction =
    parsed instanceof FeeBumpTransaction ? parsed.innerTransaction : parsed;

  const matches: xdr.CreateContractArgsV2[] = [];
  for (const operation of transaction.operations) {
    if (
      operation.type !== "invokeHostFunction" ||
      operation.func.switch().name !== "hostFunctionTypeCreateContractV2"
    ) {
      continue;
    }
    const create = operation.func.createContractV2();
    if (contractIdFromCreateV2(deps.networkPassphrase, create) === candidate.contractId) {
      matches.push(create);
    }
  }
  if (matches.length === 0) {
    return fail(
      "contract_not_created",
      "the transaction did not directly create the candidate contract"
    );
  }
  if (matches.length !== 1) {
    return fail(
      "ambiguous_creation",
      "the transaction contains multiple matching CreateContractV2 operations"
    );
  }

  const create = matches[0]!;
  const preimage = create.contractIdPreimage();
  if (preimage.switch().name !== "contractIdPreimageFromAddress") {
    return fail("contract_not_created", "the wallet did not use an address preimage");
  }
  if (deps.expectedDeployer) {
    const actualDeployer = Address.fromScAddress(
      preimage.fromAddress().address()
    ).toString();
    if (actualDeployer !== deps.expectedDeployer) {
      return fail("deployer_mismatch", "the wallet used an unexpected deployer");
    }
  }
  if (
    deps.expectedSalt &&
    !bytesEqual(preimage.fromAddress().salt(), deps.expectedSalt)
  ) {
    return fail("salt_mismatch", "the wallet used an unexpected address salt");
  }

  const executable = create.executable();
  if (executable.switch().name !== "contractExecutableWasm") {
    return fail("contract_not_created", "the wallet birth did not use WASM code");
  }
  const actualWasm = Buffer.from(executable.wasmHash()).toString("hex");
  if (actualWasm !== claimedWasm) {
    return fail(
      "wasm_mismatch",
      `birth WASM ${actualWasm} does not equal claimed WASM ${claimedWasm}`
    );
  }
  if (!accepted.has(actualWasm)) {
    return fail("wasm_not_accepted", `birth WASM ${actualWasm} is not accepted`);
  }

  const constructor = validateConstructor(create, deps);
  if ("ok" in constructor) return constructor;

  return {
    ok: true,
    birth: {
      ...candidate,
      birthWasmHash: actualWasm,
      creationTransactionHash: txHash,
      constructorArgsHash: constructor.argsHash,
      birthSigner: constructor.signer,
    },
  };
}

export type FreshAssertionFailure =
  | "key_id"
  | "client_data"
  | "type"
  | "challenge"
  | "origin"
  | "authenticator_data"
  | "rp_id"
  | "user_presence"
  | "user_verification"
  | "public_key"
  | "signature";

export type FreshAssertionResult =
  | { ok: true }
  | { ok: false; reason: FreshAssertionFailure; detail: string };

export interface FreshAssertionPolicy {
  expectedChallenge: string;
  expectedCredentialId: string;
  rpId: string;
  publicKey: Uint8Array;
  allowedOrigins?: readonly string[];
  requireUserVerification?: boolean;
}

function assertionFail(
  reason: FreshAssertionFailure,
  detail: string
): FreshAssertionResult {
  return { ok: false, reason, detail };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

/** Verify a fresh WebAuthn assertion under an on-chain P-256 public key. */
export async function verifyFreshAssertion(
  response: AuthenticationResponseJSON,
  policy: FreshAssertionPolicy
): Promise<FreshAssertionResult> {
  if (response.id !== policy.expectedCredentialId) {
    return assertionFail("key_id", "the assertion credential id does not match");
  }

  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  let clientDataJSON: Buffer;
  try {
    clientDataJSON = base64url.toBuffer(response.response.clientDataJSON);
    clientData = JSON.parse(clientDataJSON.toString("utf8"));
  } catch {
    return assertionFail("client_data", "clientDataJSON is not valid JSON");
  }
  if (clientData.type !== "webauthn.get") {
    return assertionFail("type", "clientDataJSON.type is not webauthn.get");
  }
  if (clientData.challenge !== policy.expectedChallenge) {
    return assertionFail("challenge", "the assertion challenge does not match");
  }
  if (!policy.allowedOrigins?.length) {
    return assertionFail("origin", "no allowed WebAuthn origin is configured");
  }
  if (
    typeof clientData.origin !== "string" ||
    !policy.allowedOrigins.includes(clientData.origin)
  ) {
    return assertionFail("origin", "the assertion origin is not allowed");
  }

  const authenticatorData = base64url.toBuffer(
    response.response.authenticatorData
  );
  if (authenticatorData.length < AUTHENTICATOR_DATA_MIN_SIZE) {
    return assertionFail("authenticator_data", "authenticatorData is too short");
  }
  if (!bytesEqual(authenticatorData.subarray(0, 32), hash(Buffer.from(policy.rpId)))) {
    return assertionFail("rp_id", "authenticatorData has the wrong rpId hash");
  }
  const flags = authenticatorData[32]!;
  if ((flags & USER_PRESENT_FLAG) === 0) {
    return assertionFail("user_presence", "the User Present flag is not set");
  }
  if (
    policy.requireUserVerification &&
    (flags & USER_VERIFIED_FLAG) === 0
  ) {
    return assertionFail("user_verification", "the User Verified flag is not set");
  }
  if (
    policy.publicKey.length !== P256_PUBLIC_KEY_SIZE ||
    policy.publicKey[0] !== 0x04
  ) {
    return assertionFail("public_key", "the public key is not an uncompressed P-256 key");
  }

  let signature: Uint8Array;
  try {
    signature = compactSignature(
      base64url.toBuffer(response.response.signature)
    );
  } catch {
    return assertionFail("signature", "the DER signature is malformed");
  }
  if (signature.length !== 64) {
    return assertionFail("signature", "the compact signature is not 64 bytes");
  }

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return assertionFail("signature", "WebCrypto is not available");
  }
  let key: CryptoKey;
  try {
    key = await subtle.importKey(
      "raw",
      toArrayBuffer(policy.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
  } catch {
    return assertionFail("public_key", "WebCrypto rejected the public key");
  }
  const signed = Buffer.concat([
    authenticatorData,
    hash(clientDataJSON),
  ]);
  const valid = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(signature),
    toArrayBuffer(signed)
  );
  return valid
    ? { ok: true }
    : assertionFail("signature", "the P-256 signature does not verify");
}

/** Read the uncompressed P-256 public key from one External signer. */
export function publicKeyFromExternalSigner(
  signer: ContractSigner
): Uint8Array | undefined {
  if (signer.tag !== "External") return undefined;
  const keyData = signer.values[1];
  if (keyData.length <= P256_PUBLIC_KEY_SIZE || keyData[0] !== 0x04) {
    return undefined;
  }
  return new Uint8Array(keyData.subarray(0, P256_PUBLIC_KEY_SIZE));
}

/** Check that one External signer contains the exact key and credential id. */
export function signerMatchesCredential(
  signer: ContractSigner,
  verifierAddress: string,
  publicKey: Uint8Array,
  credentialId: string
): boolean {
  if (signer.tag !== "External" || signer.values[0] !== verifierAddress) {
    return false;
  }
  const expected = Buffer.concat([
    Buffer.from(publicKey),
    base64url.toBuffer(credentialId),
  ]);
  return bytesEqual(signer.values[1], expected);
}
