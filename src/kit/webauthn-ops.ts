import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { rpc, xdr } from "@stellar/stellar-sdk";
import base64url from "../base64url.js";
import type { StorageAdapter } from "../types.js";
import type {
  Client as SmartAccountClient,
  Signer as ContractSigner,
} from "smart-account-kit-bindings";
import type { WebAuthnSigData } from "../contract-types.js";
import { WEBAUTHN_TIMEOUT_MS } from "../constants.js";
import {
  compactSignature,
  extractPublicKeyFromAttestation,
  generateChallenge,
} from "../utils.js";
import {
  assertWalletMutationIntent,
  buildWebAuthnSignatureBytes,
  getAddressCredentials,
  getAuthEntryAddress,
  normalizeSignatureExpirationLedger,
  readAuthPayload,
  upsertAuthPayloadSigner,
  writeAuthPayload,
} from "./auth-payload.js";
import { computeEntryAuthDigest } from "../signers.js";
import {
  findWebAuthnSignerInRules,
} from "./context-rules.js";
import { SmartAccountErrorCode, ValidationError } from "../errors.js";

type WebAuthnDeps = {
  rpId?: string;
  rpName: string;
  webAuthn: {
    startRegistration: (args: { optionsJSON: PublicKeyCredentialCreationOptionsJSON }) => Promise<RegistrationResponseJSON>;
    startAuthentication: (args: { optionsJSON: PublicKeyCredentialRequestOptionsJSON }) => Promise<AuthenticationResponseJSON>;
  };
};

type RequireWallet = () => { wallet: SmartAccountClient; contractId: string };

type SignAuthEntryDeps = WebAuthnDeps & {
  networkPassphrase: string;
  storage: StorageAdapter;
  calculateExpiration: () => Promise<number>;
  getCredentialId: () => string | undefined;
  requireWallet: RequireWallet;
  rpc: rpc.Server;
  timeoutInSeconds: number;
};

export async function createPasskey(
  deps: WebAuthnDeps,
  appName: string,
  userName: string,
  authenticatorSelection?: {
    authenticatorAttachment?: "platform" | "cross-platform";
    residentKey?: "discouraged" | "preferred" | "required";
  }
): Promise<{
  rawResponse: RegistrationResponseJSON;
  credentialId: string;
  publicKey: Uint8Array;
}> {
  const now = new Date();
  const displayName = `${userName} — ${now.toLocaleString()}`;

  const options: PublicKeyCredentialCreationOptionsJSON = {
    challenge: generateChallenge(),
    rp: {
      id: deps.rpId,
      name: appName || deps.rpName,
    },
    user: {
      id: base64url(`${userName}:${now.getTime()}:${Math.random()}`),
      name: displayName,
      displayName,
    },
    authenticatorSelection: {
      residentKey: authenticatorSelection?.residentKey ?? "preferred",
      userVerification: "required",
      authenticatorAttachment: authenticatorSelection?.authenticatorAttachment,
    },
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    timeout: WEBAUTHN_TIMEOUT_MS,
  };

  const rawResponse = await deps.webAuthn.startRegistration({ optionsJSON: options });
  const publicKey = await extractPublicKeyFromAttestation(rawResponse.response);

  return {
    rawResponse,
    credentialId: rawResponse.id,
    publicKey,
  };
}

export async function authenticatePasskey(
  deps: WebAuthnDeps
): Promise<{ credentialId: string; rawResponse: AuthenticationResponseJSON }> {
  const authOptions: PublicKeyCredentialRequestOptionsJSON = {
    challenge: generateChallenge(),
    rpId: deps.rpId,
    userVerification: "required",
    timeout: WEBAUTHN_TIMEOUT_MS,
  };

  const rawResponse = await deps.webAuthn.startAuthentication({ optionsJSON: authOptions });

  return {
    credentialId: rawResponse.id,
    rawResponse,
  };
}

export async function signAuthEntry(
  deps: SignAuthEntryDeps,
  entry: xdr.SorobanAuthorizationEntry,
  options?: {
    credentialId?: string;
    expiration?: number;
    contextRuleIds?: number[];
    signer?: ContractSigner;
    /** Internal declaration from a dedicated admin transaction path. */
    walletMutationHostFunction?: xdr.HostFunction;
  }
): Promise<xdr.SorobanAuthorizationEntry> {
  const normalizedEntry = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentialType = normalizedEntry.credentials().switch().name as string;
  if (credentialType === "sorobanCredentialsAddressWithDelegates") {
    throw new Error(
      "ADDRESS_WITH_DELEGATES auth entries are not supported by WebAuthn signing yet"
    );
  }

  const credentials = getAddressCredentials(normalizedEntry.credentials());
  const { wallet, contractId } = deps.requireWallet();
  if (getAuthEntryAddress(normalizedEntry) !== contractId) {
    throw new ValidationError(
      "The authorization entry is not for the connected smart account",
      SmartAccountErrorCode.INVALID_INPUT,
      { contractId }
    );
  }
  assertWalletMutationIntent(
    normalizedEntry,
    contractId,
    options?.walletMutationHostFunction
  );
  let requestedExpiration = options?.expiration;
  if (requestedExpiration == null) {
    requestedExpiration = credentials.signatureExpirationLedger();
    if (!requestedExpiration) {
      requestedExpiration = await deps.calculateExpiration();
    }
  }
  const expiration = normalizeSignatureExpirationLedger(requestedExpiration);
  credentials.signatureExpirationLedger(expiration);
  const authPayload = readAuthPayload(credentials.signature());

  const credentialId = options?.credentialId ?? deps.getCredentialId();
  if (!credentialId) {
    throw new Error("A credential ID is required to sign smart account auth entries");
  }

  const contextRuleIds = options?.contextRuleIds ?? authPayload.context_rule_ids;
  if (contextRuleIds.length === 0) {
    throw new Error(
      "contextRuleIds are required to sign smart account auth entries when the payload does not already include them"
    );
  }

  const credentialIdBuffer = base64url.toBuffer(credentialId);
  const signer = options?.signer ?? await findWebAuthnSignerInRules(
    wallet,
    contextRuleIds,
    credentialIdBuffer,
    {
      rpc: deps.rpc,
      contractId,
      networkPassphrase: deps.networkPassphrase,
      timeoutInSeconds: deps.timeoutInSeconds,
    }
  );
  const { authDigest } = computeEntryAuthDigest(
    deps.networkPassphrase,
    normalizedEntry,
    credentials.signatureExpirationLedger(),
    contextRuleIds
  );

  const authResponse = await deps.webAuthn.startAuthentication({
    optionsJSON: {
      challenge: base64url(authDigest),
      rpId: deps.rpId,
      userVerification: "required",
      timeout: WEBAUTHN_TIMEOUT_MS,
      allowCredentials: [{ id: credentialId, type: "public-key" }],
    },
  });

  const rawSignature = base64url.toBuffer(authResponse.response.signature);
  const compactedSignature = compactSignature(rawSignature);

  const webAuthnSigData: WebAuthnSigData = {
    authenticator_data: base64url.toBuffer(authResponse.response.authenticatorData),
    client_data: base64url.toBuffer(authResponse.response.clientDataJSON),
    signature: Buffer.from(compactedSignature),
  };

  if (
    authPayload.context_rule_ids.length > 0 &&
    authPayload.context_rule_ids.join(",") !== contextRuleIds.join(",")
  ) {
    throw new Error("Existing auth payload uses different context rule IDs");
  }

  authPayload.context_rule_ids = contextRuleIds;
  upsertAuthPayloadSigner(authPayload, signer, buildWebAuthnSignatureBytes(webAuthnSigData));
  credentials.signature(writeAuthPayload(authPayload));

  await deps.storage.update(credentialId, { lastUsedAt: Date.now() });
  return normalizedEntry;
}
