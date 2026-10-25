import type { Signer } from "smart-account-kit-bindings";
import type { PolicyType } from "../../config";

/** How a signer is being added in the rule builder. */
export type SignerAddMode =
  | "existing"
  | "new_passkey"
  | "connected_wallet"
  | "g_address"
  | "ed25519";

/** Which context type the rule targets. */
export type ContextTypeOption =
  | "default"
  | "call_contract"
  | "create_contract"
  | "create_contract_external_ref";

/** A signer staged in the rule-builder form. */
export interface SignerEntry {
  /** Unique ID for React keys */
  id: string;
  type: "delegated" | "passkey" | "ed25519";
  /** G-address for delegated signers */
  address?: string;
  /** Credential ID for passkeys */
  credentialId?: string;
  /** Public key: 65-byte secp256r1 (passkey) or 32-byte (ed25519) */
  publicKey?: Uint8Array;
  /** Verifier contract address for ed25519 signers */
  verifierAddress?: string;
  label: string;
  /** Original contract signer object (for signers already on-chain) */
  signer?: Signer;
  /** Whether this is the currently active signer */
  isActive?: boolean;
}

/** A policy contract, either a known type or a custom one. */
export interface PolicyInfo {
  type: PolicyType;
  name: string;
  address: string;
}

/** A policy staged in the rule-builder form with its editable params. */
export interface SelectedPolicy {
  policy: PolicyInfo;
  // Threshold policy params
  threshold?: number;
  // Spending limit params
  spendingLimit?: string;
  spendingPeriodDays?: number;
  // Weighted threshold params
  weightedThreshold?: number;
  /** Maps signer entry ID to weight */
  signerWeights?: Map<string, number>;
  // Custom policy params (JSON string)
  customParams?: string;
  /** Whether the user modified this policy's params (only update modified ones) */
  modified?: boolean;
}

/** A candidate signer (on-chain or pending) selectable in the "existing" mode. */
export interface SignerEntryInfo {
  /** Unique ID: credentialId for passkeys, address for delegated */
  id: string;
  signer?: Signer;
  label: string;
  type: "passkey" | "delegated";
  credentialId: string | null;
  /** G-address for delegated signers */
  address?: string;
  publicKey?: Uint8Array;
  isActive: boolean;
  isPending: boolean;
}
