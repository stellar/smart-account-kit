import {Address, xdr} from '@stellar/stellar-sdk';

    /**
 * Contract executable used for creating a new contract and used in
 * `CreateContractHostFnContext`.
 */
 export type ContractExecutable =
  /**
   * Executable specified by the contract instance as a specific Wasm contract code entry identified by its Wasm sha256 hash.
   */
  { tag: "Wasm"; values: readonly [Uint8Array] } |
  /**
   * Executable reference via a persistent storage entry owned by this contract or another contract.
   */
  { tag: "ExternalRef"; values: readonly [ContractExecutableRef] };

/**
 * Executable referenced via a persistent storage entry owned by a contract,
 * either this contract or another contract.
 *
 * The persistent storage entry owned by the `owner` has the `tag` as its key.
 */
export interface ContractExecutableRef {
  owner: string;
  tag: string;
}

/**
 * Context of a single authorized call performed by an address.
 *
 * Custom account contracts that implement `__check_auth` special function
 * receive a list of `Context` values corresponding to all the calls that
 * need to be authorized.
 */
 export type Context =
  /**
   * Contract invocation.
   */
  { tag: "Contract"; values: readonly [ContractContext] } |
  /**
   * Contract that has a constructor with no arguments is created.
   */
  { tag: "CreateContractHostFn"; values: readonly [CreateContractHostFnContext] } |
  /**
   * Contract that has a constructor with 1 or more arguments is created.
   */
  { tag: "CreateContractWithCtorHostFn"; values: readonly [CreateContractWithConstructorHostFnContext] };

/**
 * Authorization context of a single contract call.
 *
 * This struct corresponds to a `require_auth_for_args` call for an address
 * from `contract` function with `fn_name` name and `args` arguments.
 */
export interface ContractContext {
  args: Array<any>;
  contract: string;
  fn_name: string;
}

/**
 * Authorization context for `create_contract` host function that creates a
 * new contract on behalf of authorizer address.
 */
export interface CreateContractHostFnContext {
  executable: ContractExecutable;
  salt: Uint8Array;
}

/**
 * Authorization context for `create_contract` host function that creates a
 * new contract on behalf of authorizer address.
 * This is the same as `CreateContractHostFnContext`, but also has
 * contract constructor arguments.
 */
export interface CreateContractWithConstructorHostFnContext {
  constructor_args: Array<any>;
  executable: ContractExecutable;
  salt: Uint8Array;
}

/**
 * Event emitted when a policy is added to a context rule.
 */
export interface PolicyAddedEvent {
  name: "PolicyAdded";
  data: {
    context_rule_id: number;
    policy_id?: number;
  };
}

/**
 * Event emitted when a signer is added to a context rule.
 */
export interface SignerAddedEvent {
  name: "SignerAdded";
  data: {
    context_rule_id: number;
    signer_id?: number;
  };
}

/**
 * Event emitted when a policy is removed from a context rule.
 */
export interface PolicyRemovedEvent {
  name: "PolicyRemoved";
  data: {
    context_rule_id: number;
    policy_id?: number;
  };
}

/**
 * Event emitted when a signer is removed from a context rule.
 */
export interface SignerRemovedEvent {
  name: "SignerRemoved";
  data: {
    context_rule_id: number;
    signer_id?: number;
  };
}

/**
 * Event emitted when a context rule is added.
 */
export interface ContextRuleAddedEvent {
  name: "ContextRuleAdded";
  data: {
    context_rule_id: number;
    name?: string;
    context_type?: ContextRuleType;
    valid_until?: number | null;
    signer_ids?: Array<number>;
    policy_ids?: Array<number>;
  };
}

/**
 * Event emitted when a policy is registered in the global registry.
 */
export interface PolicyRegisteredEvent {
  name: "PolicyRegistered";
  data: {
    policy_id: number;
    policy?: string;
  };
}

/**
 * Event emitted when a signer is registered in the global registry.
 */
export interface SignerRegisteredEvent {
  name: "SignerRegistered";
  data: {
    signer_id: number;
    signer?: Signer;
  };
}

/**
 * Error codes for smart account operations.
 */
export const SmartAccountError = {
  /**
   * The specified context rule does not exist.
   */
  3000 : { message: "ContextRuleNotFound" },
  /**
   * The provided context cannot be validated against any rule.
   */
  3002 : { message: "UnvalidatedContext" },
  /**
   * External signature verification failed.
   */
  3003 : { message: "ExternalVerificationFailed" },
  /**
   * Context rule must have at least one signer or policy.
   */
  3004 : { message: "NoSignersAndPolicies" },
  /**
   * The valid_until timestamp is in the past.
   */
  3005 : { message: "PastValidUntil" },
  /**
   * The specified signer was not found.
   */
  3006 : { message: "SignerNotFound" },
  /**
   * The signer already exists in the context rule.
   */
  3007 : { message: "DuplicateSigner" },
  /**
   * The specified policy was not found.
   */
  3008 : { message: "PolicyNotFound" },
  /**
   * The policy already exists in the context rule.
   */
  3009 : { message: "DuplicatePolicy" },
  /**
   * Too many signers in the context rule.
   */
  3010 : { message: "TooManySigners" },
  /**
   * Too many policies in the context rule.
   */
  3011 : { message: "TooManyPolicies" },
  /**
   * An internal ID counter (context rule, signer, or policy) has reached
   * its maximum value (`u32::MAX`) and cannot be incremented further.
   */
  3012 : { message: "MathOverflow" },
  /**
   * External signer key data exceeds the maximum allowed size.
   */
  3013 : { message: "KeyDataTooLarge" },
  /**
   * context_rule_ids length does not match auth_contexts length.
   */
  3014 : { message: "ContextRuleIdsLengthMismatch" },
  /**
   * Context rule name exceeds the maximum allowed length.
   */
  3015 : { message: "NameTooLong" },
  /**
   * A signer in `AuthPayload` is not part of any selected context rule.
   */
  3016 : { message: "UnauthorizedSigner" },
  /**
   * A delegated signer's address is the contract of a context being
   * authorized.
   */
  3017 : { message: "DelegatedSignerIsContextContract" },
  /**
   * A delegated signer's address is the smart account itself.
   */
  3018 : { message: "SelfDelegatedSigner" }
} as const;
export type SmartAccountError = (typeof SmartAccountError)[keyof typeof SmartAccountError];

/**
 * Event emitted when a context rule is removed.
 */
export interface ContextRuleRemovedEvent {
  name: "ContextRuleRemoved";
  data: {
    context_rule_id: number;
  };
}

/**
 * Event emitted when a policy is deregistered from the global registry.
 */
export interface PolicyDeregisteredEvent {
  name: "PolicyDeregistered";
  data: {
    policy_id: number;
  };
}

/**
 * Event emitted when a signer is deregistered from the global registry.
 */
export interface SignerDeregisteredEvent {
  name: "SignerDeregistered";
  data: {
    signer_id: number;
  };
}

/**
 * Event emitted when a context rule name or valid_until are updated.
 */
export interface ContextRuleMetaUpdatedEvent {
  name: "ContextRuleMetaUpdated";
  data: {
    context_rule_id: number;
    name?: string;
    valid_until?: number | null;
  };
}

/**
 * Represents different types of signers in the smart account system.
 */
 export type Signer =
  /**
   * A delegated signer, any contract or account address, authenticated
   * through `require_auth_for_args((preimage,))`. Transaction simulation
   * does not return this nested authorization entry, because the call
   * happens inside `__check_auth`. Clients add it manually: an entry for
   * the delegated address whose root invocation is `__check_auth` on the
   * smart account with the [`AuthDigestPreimage`] as its single argument.
   * See `src/smart_account/test/auth_entries.rs` for a reference
   * construction.
   *
   * The address must not be an account that delegates its authentication
   * back to this smart account, unless it is an account that authenticates
   * through [`do_check_auth`]; this signer can otherwise be authorized
   * without any signature. See [`validate_no_delegated_context_contract`].
   */
  { tag: "Delegated"; values: readonly [string] } |
  /**
   * An external signer with custom verification logic.
   * Contains the verifier contract address and the public key data.
   */
  { tag: "External"; values: readonly [string, Uint8Array] };

/**
 * The authorization payload passed to `__check_auth`, bundling cryptographic
 * proofs with context rule selection.
 *
 * This struct carries two distinct pieces of information that are both
 * required for authorization but cannot be derived from each other:
 *
 * - `signers` maps each [`Signer`] to its raw signature bytes, providing
 * cryptographic proof that the signer actually signed the transaction
 * payload. A context rule stores which signer *identities* are authorized
 * (via `signer_ids`), but the rule does not contain the signatures
 * themselves — those must be supplied here.
 *
 * - `context_rule_ids` tells the system which rule to validate for each auth
 * context. Because multiple rules can exist for the same context type, the
 * caller must explicitly select one per context rather than relying on
 * auto-discovery. Each entry is aligned by index with the `auth_contexts`
 * passed to `__check_auth`.
 *
 * The length of `context_rule_ids` must equal the number of auth contexts;
 * a mismatch is rejected with
 * [`SmartAccountError::ContextRuleIdsLen
 */
export interface AuthPayload {
  /**
   * Per-context rule IDs, aligned by index with `auth_contexts`.
   */
  context_rule_ids: Array<number>;
  /**
   * Signature data mapped to each signer.
   */
  signers: Map<Signer, Uint8Array>;
}

/**
 * A complete context rule defining authorization requirements.
 */
export interface ContextRule {
  /**
   * The type of context this rule applies to.
   */
  context_type: ContextRuleType;
  /**
   * Unique identifier for the context rule.
   */
  id: number;
  /**
   * Human-readable name for the context rule.
   */
  name: string;
  /**
   * List of policy contracts that must be satisfied.
   */
  policies: Array<string>;
  /**
   * Global registry IDs for each policy, positionally aligned with
   * `policies`.
   */
  policy_ids: Array<number>;
  /**
   * Global registry IDs for each signer, positionally aligned with
   * `signers`.
   */
  signer_ids: Array<number>;
  /**
   * List of signers authorized by this rule.
   */
  signers: Array<Signer>;
  /**
   * Optional expiration ledger sequence for the rule.
   */
  valid_until: number | null;
}

/**
 * Types of contexts that can be authorized by smart account rules.
 */
 export type ContextRuleType =
  /**
   * Default rules that can authorize any context.
   */
  { tag: "Default"; values: void } |
  /**
   * Rules specific to calling a particular contract.
   */
  { tag: "CallContract"; values: readonly [string] } |
  /**
   * Rules specific to creating a contract with a particular WASM hash.
   */
  { tag: "CreateContract"; values: readonly [Uint8Array] } |
  /**
   * Rules specific to creating a contract from the executable reference that
   * `owner` stores under `tag`.
   */
  { tag: "CreateContractExternalRef"; values: readonly [string, string] };

/**
 * The structured message that every signer commits to in `__check_auth`.
 *
 * [`Signer::External`] signers sign [`AuthDigestPreimage::digest`], the
 * SHA-256 hash of this struct's XDR encoding. [`Signer::Delegated`] signers
 * authorize the struct itself through `require_auth_for_args`.
 */
export interface AuthDigestPreimage {
  /**
   * The smart account performing the authorization check.
   */
  account: string;
  /**
   * Per-context rule IDs, aligned by index with `auth_contexts`.
   */
  context_rule_ids: Array<number>;
  /**
   * The 32-byte payload provided by the host to `__check_auth`.
   */
  signature_payload: Uint8Array;
}
    export type ContractEvent = PolicyAddedEvent | SignerAddedEvent | PolicyRemovedEvent | SignerRemovedEvent | ContextRuleAddedEvent | PolicyRegisteredEvent | SignerRegisteredEvent | ContextRuleRemovedEvent | PolicyDeregisteredEvent | SignerDeregisteredEvent | ContextRuleMetaUpdatedEvent;
