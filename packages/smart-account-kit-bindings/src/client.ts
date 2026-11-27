import {Signer, AuthDigestPreimage, AuthPayload, Context, SmartAccountError, ContextRuleType, ContextRule, ContractEvent} from './types.js';
import {Result, Spec, AssembledTransaction, Client as ContractClient, ClientOptions as ContractClientOptions, MethodOptions, ExternalExecutableRef} from '@stellar/stellar-sdk/contract';
import {Address, xdr} from '@stellar/stellar-sdk';

export interface Client {
  /**
   * Executes a function call on a target contract from within the smart
   * account context.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `target` - The address of the contract to call.
   * * `target_fn` - The function name to invoke on the target contract.
   * * `target_args` - Arguments to pass to the target function.
   *
   * # Notes
   *
   * Defaults to requiring authorization from the smart account itself
   * (`e.current_contract_address().require_auth()`) and then calling
   * `e.invoke_contract()`.
   */
  execute(args: { target: string | Address; target_fn: string; target_args: Array<any> }, options?: MethodOptions): Promise<AssembledTransaction<void>>;
  upgrade(args: { new_wasm_hash: Uint8Array; operator: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<void>>;
  /**
   * Adds a new policy to an existing context rule, installs it, and returns
   * the assigned policy ID. The policy's `install` method will be called
   * during this operation.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_rule_id` - The ID of the context rule to modify.
   * * `policy` - The address of the policy contract to add.
   * * `install_param` - The installation parameter for the policy.
   *
   * # Errors
   *
   * * [`SmartAccountError::ContextRuleNotFound`] - When no context rule
   * exists with the given ID.
   * * [`SmartAccountError::DuplicatePolicy`] - When the policy already
   * exists in the rule.
   * * [`SmartAccountError::TooManyPolicies`] - When adding would exceed
   * MAX_POLICIES (5).
   *
   * # Events
   *
   * * topics - `["policy_added", context_rule_id: u32]`
   * * data - `[policy_id: u32]`
   *
   * # Notes
   *
   * Defaults to requiring authorization from the smart account itself
   * (`e.current_contract_address().require_auth()`) and then delegating to
   * [`storage::add_policy`].
   */
  add_policy(args: { context_rule_id: number; policy: string | Address; install_param: any }, options?: MethodOptions): Promise<AssembledTransaction<number>>;
  /**
   * Adds a new signer to an existing context rule, returning the assigned
   * signer ID.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_rule_id` - The ID of the context rule to modify.
   * * `signer` - The signer to add to the context rule.
   *
   * # Errors
   *
   * * [`SmartAccountError::ContextRuleNotFound`] - When no context rule
   * exists with the given ID.
   * * [`SmartAccountError::DuplicateSigner`] - When the signer already
   * exists in the rule.
   * * [`SmartAccountError::TooManySigners`] - When adding would exceed
   * MAX_SIGNERS (15).
   *
   * # Events
   *
   * * topics - `["signer_added", context_rule_id: u32]`
   * * data - `[signer_id: u32]`
   *
   * # Notes
   *
   * Defaults to requiring authorization from the smart account itself
   * (`e.current_contract_address().require_auth()`) and then delegating to
   * [`storage::add_signer`].
   */
  add_signer(args: { context_rule_id: number; signer: Signer }, options?: MethodOptions): Promise<AssembledTransaction<number>>;
  /**
   * Computes the digest that [`Signer::External`] signers sign for
   * `preimage`, that is `sha256(preimage.to_xdr())`. A pure helper for
   * off-chain clients: simulating it verifies a locally computed digest
   * before any signature is collected, and it exposes
   * [`AuthDigestPreimage`] in the contract spec so generated bindings can
   * encode the value that [`Signer::Delegated`] signers authorize.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `preimage` - The structured message that signers commit to.
   */
  auth_digest(args: { preimage: AuthDigestPreimage }, options?: MethodOptions): Promise<AssembledTransaction<Uint8Array>>;
  /**
   * Verify authorization for the smart account.
   *
   * This function is called by the Soroban host when authorization is
   * required. It validates signatures against the configured context
   * rules and policies.
   *
   * # Arguments
   *
   * * `signature_payload` - Hash of the data that was signed
   * * `signatures` - Map of signers to their signature data
   * * `auth_contexts` - Contexts being authorized (contract calls,
   * deployments, etc.)
   *
   * # Returns
   *
   * * `Ok(())` if authorization succeeds
   * * `Err(SmartAccountError)` if authorization fails
   */
  __check_auth(args: { signature_payload: Uint8Array; signatures: AuthPayload; auth_contexts: Array<Context> }, options?: MethodOptions): Promise<AssembledTransaction<Result<null, SmartAccountError>>>;
  /**
   * Retrieves the global registry ID for a policy.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `policy` - The policy address to look up.
   *
   * # Errors
   *
   * * [`SmartAccountError::PolicyNotFound`] - When the policy is not
   * registered in the global registry.
   */
  get_policy_id(args: { policy: string | Address }, options?: MethodOptions): Promise<AssembledTransaction<number>>;
  /**
   * Retrieves the global registry ID for a signer.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `signer` - The signer to look up.
   *
   * # Errors
   *
   * * [`SmartAccountError::SignerNotFound`] - When the signer is not
   * registered in the global registry.
   */
  get_signer_id(args: { signer: Signer }, options?: MethodOptions): Promise<AssembledTransaction<number>>;
  /**
   * Removes a policy from an existing context rule and uninstalls it. The
   * policy's `uninstall` method will be called during this operation.
   * Removing the last policy is allowed only if the rule has at least
   * one signer.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_rule_id` - The ID of the context rule to modify.
   * * `policy_id` - The ID of the policy to remove from the context rule.
   *
   * # Errors
   *
   * * [`SmartAccountError::ContextRuleNotFound`] - When no context rule
   * exists with the given ID.
   * * [`SmartAccountError::PolicyNotFound`] - When the policy doesn't exist
   * in the rule.
   *
   * # Events
   *
   * * topics - `["policy_removed", context_rule_id: u32]`
   * * data - `[policy_id: u32]`
   *
   * # Notes
   *
   * Defaults to requiring authorization from the smart account itself
   * (`e.current_contract_address().require_auth()`) and then delegating to
   * [`storage::remove_policy`].
   */
  remove_policy(args: { context_rule_id: number; policy_id: number }, options?: MethodOptions): Promise<AssembledTransaction<void>>;
  /**
   * Removes a signer from an existing context rule. Removing the last signer
   * is allowed only if the rule has at least one policy.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_rule_id` - The ID of the context rule to modify.
   * * `signer_id` - The ID of the signer to remove from the context rule.
   *
   * # Errors
   *
   * * [`SmartAccountError::ContextRuleNotFound`] - When no context rule
   * exists with the given ID.
   * * [`SmartAccountError::SignerNotFound`] - When the signer doesn't exist
   * in the rule.
   *
   * # Events
   *
   * * topics - `["signer_removed", context_rule_id: u32]`
   * * data - `[signer_id: u32]`
   *
   * # Notes
   *
   * Defaults to requiring authorization from the smart account itself
   * (`e.current_contract_address().require_auth()`) and then delegating to
   * [`storage::remove_signer`].
   */
  remove_signer(args: { context_rule_id: number; signer_id: number }, options?: MethodOptions): Promise<AssembledTransaction<void>>;
  /**
   * Creates a new context rule with the specified configuration, returning
   * the newly created `ContextRule` with a unique ID assigned. Installs
   * all specified policies during creation.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_type` - The type of context this rule applies to.
   * * `name` - Human-readable name for the context rule.
   * * `valid_until` - Optional expiration ledger sequence.
   * * `signers` - List of signers authorized by this rule.
   * * `policies` - Map of policy addresses to their installation parameters.
   *
   * # Errors
   *
   * * [`SmartAccountError::NoSignersAndPolicies`] - When both signers and
   * policies are empty.
   * * [`SmartAccountError::TooManySigners`] - When signers exceed
   * MAX_SIGNERS (15).
   * * [`SmartAccountError::TooManyPolicies`] - When policies exceed
   * MAX_POLICIES (5).
   * * [`SmartAccountError::DuplicateSigner`] - When the same signer appears
   * multiple times.
   * * [`SmartAccountError::PastValidUntil`] - When valid_until is in the
   * past.
   * * [`SmartAccountError::MathOverflow`] - When the context rule, si
   */
  add_context_rule(args: { context_type: ContextRuleType; name: string; valid_until: number | null; signers: Array<Signer>; policies: Map<string | Address, any> }, options?: MethodOptions): Promise<AssembledTransaction<ContextRule>>;
  batch_add_signer(args: { context_rule_id: number; signers: Array<Signer> }, options?: MethodOptions): Promise<AssembledTransaction<void>>;
  /**
   * Retrieves a context rule by its unique ID, returning the
   * `ContextRule` containing all metadata, signers, and policies.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_rule_id` - The unique identifier of the context rule to
   * retrieve.
   *
   * # Errors
   *
   * * [`SmartAccountError::ContextRuleNotFound`] - When no context rule
   * exists with the given ID.
   */
  get_context_rule(args: { context_rule_id: number }, options?: MethodOptions): Promise<AssembledTransaction<ContextRule>>;
  /**
   * Removes a context rule and cleans up all associated data. This function
   * uninstalls all policies associated with the rule and removes all stored
   * data including signers, policies, and metadata.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_rule_id` - The ID of the context rule to remove.
   *
   * # Errors
   *
   * * [`SmartAccountError::ContextRuleNotFound`] - When no context rule
   * exists with the given ID.
   *
   * # Events
   *
   * * topics - `["context_rule_removed", context_rule_id: u32]`
   * * data - `[]`
   *
   * # Notes
   *
   * Defaults to requiring authorization from the smart account itself
   * (`e.current_contract_address().require_auth()`) and then delegating to
   * [`storage::remove_context_rule`].
   *
   * The library does not stop the account from removing the last context
   * rule that can authorize calls to the account itself (a `Default` rule,
   * or a `CallContract` rule for the account's own address). Every
   * management function, including [`SmartAccount::add_context_rule`],
   * needs such a rule, so once none is valid the account is locked
   * permanentl
   */
  remove_context_rule(args: { context_rule_id: number }, options?: MethodOptions): Promise<AssembledTransaction<void>>;
  /**
   * Retrieves the number of all context rules, including expired rules.
   * Defaults to 0.
   *
   * A count of 0 means the account cannot authorize anything, including
   * adding a rule back. A non-zero count does not rule this out either,
   * since the remaining rules may all be expired or scoped to other
   * contracts (refer to [`SmartAccount::remove_context_rule`]).
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   */
  get_context_rules_count(options?: MethodOptions): Promise<AssembledTransaction<number>>;
  /**
   * Updates the name of an existing context rule, returning the updated
   * `ContextRule` with the new name.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_rule_id` - The ID of the context rule to update.
   * * `name` - The new human-readable name for the context rule.
   *
   * # Errors
   *
   * * [`SmartAccountError::ContextRuleNotFound`] - When no context rule
   * exists with the given ID.
   *
   * # Events
   *
   * * topics - `["context_rule_meta_updated", context_rule_id: u32]`
   * * data - `[name: String, valid_until: Option<u32>]` (`valid_until` is
   * left out of the data when it is `None`)
   *
   * # Notes
   *
   * Defaults to requiring authorization from the smart account itself
   * (`e.current_contract_address().require_auth()`) and then delegating to
   * [`storage::update_context_rule_name`].
   */
  update_context_rule_name(args: { context_rule_id: number; name: string }, options?: MethodOptions): Promise<AssembledTransaction<ContextRule>>;
  /**
   * Updates the expiration time of an existing context rule, returning the
   * updated `ContextRule` with the new expiration time.
   *
   * # Arguments
   *
   * * `e` - Access to the Soroban environment.
   * * `context_rule_id` - The ID of the context rule to update.
   * * `valid_until` - New optional expiration ledger sequence. Use `None`
   * for no expiration.
   *
   * # Errors
   *
   * * [`SmartAccountError::ContextRuleNotFound`] - When no context rule
   * exists with the given ID.
   * * [`SmartAccountError::PastValidUntil`] - When valid_until is in the
   * past.
   *
   * # Events
   *
   * * topics - `["context_rule_meta_updated", context_rule_id: u32]`
   * * data - `[name: String, valid_until: Option<u32>]` (`valid_until` is
   * left out of the data when it is `None`)
   *
   * # Notes
   *
   * Defaults to requiring authorization from the smart account itself
   * (`e.current_contract_address().require_auth()`) and then delegating to
   * [`storage::update_context_rule_valid_until`].
   *
   * The library does not stop the account from giving an expiry to the last
   * context rule that can authorize calls to the account itself (a
   *
   */
  update_context_rule_valid_until(args: { context_rule_id: number; valid_until: number | null }, options?: MethodOptions): Promise<AssembledTransaction<ContextRule>>;
}

export class Client extends ContractClient {
  constructor(public readonly options: ContractClientOptions) {
    super(
      new Spec(["AAAAAAAAAeNFeGVjdXRlcyBhIGZ1bmN0aW9uIGNhbGwgb24gYSB0YXJnZXQgY29udHJhY3QgZnJvbSB3aXRoaW4gdGhlIHNtYXJ0CmFjY291bnQgY29udGV4dC4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgdGFyZ2V0YCAtIFRoZSBhZGRyZXNzIG9mIHRoZSBjb250cmFjdCB0byBjYWxsLgoqIGB0YXJnZXRfZm5gIC0gVGhlIGZ1bmN0aW9uIG5hbWUgdG8gaW52b2tlIG9uIHRoZSB0YXJnZXQgY29udHJhY3QuCiogYHRhcmdldF9hcmdzYCAtIEFyZ3VtZW50cyB0byBwYXNzIHRvIHRoZSB0YXJnZXQgZnVuY3Rpb24uCgojIE5vdGVzCgpEZWZhdWx0cyB0byByZXF1aXJpbmcgYXV0aG9yaXphdGlvbiBmcm9tIHRoZSBzbWFydCBhY2NvdW50IGl0c2VsZgooYGUuY3VycmVudF9jb250cmFjdF9hZGRyZXNzKCkucmVxdWlyZV9hdXRoKClgKSBhbmQgdGhlbiBjYWxsaW5nCmBlLmludm9rZV9jb250cmFjdCgpYC4AAAAAB2V4ZWN1dGUAAAAAAwAAAAAAAAAGdGFyZ2V0AAAAAAATAAAAAAAAAAl0YXJnZXRfZm4AAAAAAAARAAAAAAAAAAt0YXJnZXRfYXJncwAAAAPqAAAAAAAAAAA=", "AAAAAAAAAAAAAAAHdXBncmFkZQAAAAACAAAAAAAAAA1uZXdfd2FzbV9oYXNoAAAAAAAD7gAAACAAAAAAAAAACG9wZXJhdG9yAAAAEwAAAAA=", "AAAAAAAAA6xBZGRzIGEgbmV3IHBvbGljeSB0byBhbiBleGlzdGluZyBjb250ZXh0IHJ1bGUsIGluc3RhbGxzIGl0LCBhbmQgcmV0dXJucwp0aGUgYXNzaWduZWQgcG9saWN5IElELiBUaGUgcG9saWN5J3MgYGluc3RhbGxgIG1ldGhvZCB3aWxsIGJlIGNhbGxlZApkdXJpbmcgdGhpcyBvcGVyYXRpb24uCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYGNvbnRleHRfcnVsZV9pZGAgLSBUaGUgSUQgb2YgdGhlIGNvbnRleHQgcnVsZSB0byBtb2RpZnkuCiogYHBvbGljeWAgLSBUaGUgYWRkcmVzcyBvZiB0aGUgcG9saWN5IGNvbnRyYWN0IHRvIGFkZC4KKiBgaW5zdGFsbF9wYXJhbWAgLSBUaGUgaW5zdGFsbGF0aW9uIHBhcmFtZXRlciBmb3IgdGhlIHBvbGljeS4KCiMgRXJyb3JzCgoqIFtgU21hcnRBY2NvdW50RXJyb3I6OkNvbnRleHRSdWxlTm90Rm91bmRgXSAtIFdoZW4gbm8gY29udGV4dCBydWxlCmV4aXN0cyB3aXRoIHRoZSBnaXZlbiBJRC4KKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpEdXBsaWNhdGVQb2xpY3lgXSAtIFdoZW4gdGhlIHBvbGljeSBhbHJlYWR5CmV4aXN0cyBpbiB0aGUgcnVsZS4KKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpUb29NYW55UG9saWNpZXNgXSAtIFdoZW4gYWRkaW5nIHdvdWxkIGV4Y2VlZApNQVhfUE9MSUNJRVMgKDUpLgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsicG9saWN5X2FkZGVkIiwgY29udGV4dF9ydWxlX2lkOiB1MzJdYAoqIGRhdGEgLSBgW3BvbGljeV9pZDogdTMyXWAKCiMgTm90ZXMKCkRlZmF1bHRzIHRvIHJlcXVpcmluZyBhdXRob3JpemF0aW9uIGZyb20gdGhlIHNtYXJ0IGFjY291bnQgaXRzZWxmCihgZS5jdXJyZW50X2NvbnRyYWN0X2FkZHJlc3MoKS5yZXF1aXJlX2F1dGgoKWApIGFuZCB0aGVuIGRlbGVnYXRpbmcgdG8KW2BzdG9yYWdlOjphZGRfcG9saWN5YF0uAAAACmFkZF9wb2xpY3kAAAAAAAMAAAAAAAAAD2NvbnRleHRfcnVsZV9pZAAAAAAEAAAAAAAAAAZwb2xpY3kAAAAAABMAAAAAAAAADWluc3RhbGxfcGFyYW0AAAAAAAAAAAAAAQAAAAQ=", "AAAAAAAAAxVBZGRzIGEgbmV3IHNpZ25lciB0byBhbiBleGlzdGluZyBjb250ZXh0IHJ1bGUsIHJldHVybmluZyB0aGUgYXNzaWduZWQKc2lnbmVyIElELgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgoqIGBjb250ZXh0X3J1bGVfaWRgIC0gVGhlIElEIG9mIHRoZSBjb250ZXh0IHJ1bGUgdG8gbW9kaWZ5LgoqIGBzaWduZXJgIC0gVGhlIHNpZ25lciB0byBhZGQgdG8gdGhlIGNvbnRleHQgcnVsZS4KCiMgRXJyb3JzCgoqIFtgU21hcnRBY2NvdW50RXJyb3I6OkNvbnRleHRSdWxlTm90Rm91bmRgXSAtIFdoZW4gbm8gY29udGV4dCBydWxlCmV4aXN0cyB3aXRoIHRoZSBnaXZlbiBJRC4KKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpEdXBsaWNhdGVTaWduZXJgXSAtIFdoZW4gdGhlIHNpZ25lciBhbHJlYWR5CmV4aXN0cyBpbiB0aGUgcnVsZS4KKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpUb29NYW55U2lnbmVyc2BdIC0gV2hlbiBhZGRpbmcgd291bGQgZXhjZWVkCk1BWF9TSUdORVJTICgxNSkuCgojIEV2ZW50cwoKKiB0b3BpY3MgLSBgWyJzaWduZXJfYWRkZWQiLCBjb250ZXh0X3J1bGVfaWQ6IHUzMl1gCiogZGF0YSAtIGBbc2lnbmVyX2lkOiB1MzJdYAoKIyBOb3RlcwoKRGVmYXVsdHMgdG8gcmVxdWlyaW5nIGF1dGhvcml6YXRpb24gZnJvbSB0aGUgc21hcnQgYWNjb3VudCBpdHNlbGYKKGBlLmN1cnJlbnRfY29udHJhY3RfYWRkcmVzcygpLnJlcXVpcmVfYXV0aCgpYCkgYW5kIHRoZW4gZGVsZWdhdGluZyB0bwpbYHN0b3JhZ2U6OmFkZF9zaWduZXJgXS4AAAAAAAAKYWRkX3NpZ25lcgAAAAAAAgAAAAAAAAAPY29udGV4dF9ydWxlX2lkAAAAAAQAAAAAAAAABnNpZ25lcgAAAAAH0AAAAAZTaWduZXIAAAAAAAEAAAAE", "AAAAAAAAAfNDb21wdXRlcyB0aGUgZGlnZXN0IHRoYXQgW2BTaWduZXI6OkV4dGVybmFsYF0gc2lnbmVycyBzaWduIGZvcgpgcHJlaW1hZ2VgLCB0aGF0IGlzIGBzaGEyNTYocHJlaW1hZ2UudG9feGRyKCkpYC4gQSBwdXJlIGhlbHBlciBmb3IKb2ZmLWNoYWluIGNsaWVudHM6IHNpbXVsYXRpbmcgaXQgdmVyaWZpZXMgYSBsb2NhbGx5IGNvbXB1dGVkIGRpZ2VzdApiZWZvcmUgYW55IHNpZ25hdHVyZSBpcyBjb2xsZWN0ZWQsIGFuZCBpdCBleHBvc2VzCltgQXV0aERpZ2VzdFByZWltYWdlYF0gaW4gdGhlIGNvbnRyYWN0IHNwZWMgc28gZ2VuZXJhdGVkIGJpbmRpbmdzIGNhbgplbmNvZGUgdGhlIHZhbHVlIHRoYXQgW2BTaWduZXI6OkRlbGVnYXRlZGBdIHNpZ25lcnMgYXV0aG9yaXplLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgoqIGBwcmVpbWFnZWAgLSBUaGUgc3RydWN0dXJlZCBtZXNzYWdlIHRoYXQgc2lnbmVycyBjb21taXQgdG8uAAAAAAthdXRoX2RpZ2VzdAAAAAABAAAAAAAAAAhwcmVpbWFnZQAAB9AAAAASQXV0aERpZ2VzdFByZWltYWdlAAAAAAABAAAD7gAAACA=", "AAAAAAAAAfdWZXJpZnkgYXV0aG9yaXphdGlvbiBmb3IgdGhlIHNtYXJ0IGFjY291bnQuCgpUaGlzIGZ1bmN0aW9uIGlzIGNhbGxlZCBieSB0aGUgU29yb2JhbiBob3N0IHdoZW4gYXV0aG9yaXphdGlvbiBpcwpyZXF1aXJlZC4gSXQgdmFsaWRhdGVzIHNpZ25hdHVyZXMgYWdhaW5zdCB0aGUgY29uZmlndXJlZCBjb250ZXh0CnJ1bGVzIGFuZCBwb2xpY2llcy4KCiMgQXJndW1lbnRzCgoqIGBzaWduYXR1cmVfcGF5bG9hZGAgLSBIYXNoIG9mIHRoZSBkYXRhIHRoYXQgd2FzIHNpZ25lZAoqIGBzaWduYXR1cmVzYCAtIE1hcCBvZiBzaWduZXJzIHRvIHRoZWlyIHNpZ25hdHVyZSBkYXRhCiogYGF1dGhfY29udGV4dHNgIC0gQ29udGV4dHMgYmVpbmcgYXV0aG9yaXplZCAoY29udHJhY3QgY2FsbHMsCmRlcGxveW1lbnRzLCBldGMuKQoKIyBSZXR1cm5zCgoqIGBPaygoKSlgIGlmIGF1dGhvcml6YXRpb24gc3VjY2VlZHMKKiBgRXJyKFNtYXJ0QWNjb3VudEVycm9yKWAgaWYgYXV0aG9yaXphdGlvbiBmYWlscwAAAAAMX19jaGVja19hdXRoAAAAAwAAAAAAAAARc2lnbmF0dXJlX3BheWxvYWQAAAAAAAPuAAAAIAAAAAAAAAAKc2lnbmF0dXJlcwAAAAAH0AAAAAtBdXRoUGF5bG9hZAAAAAAAAAAADWF1dGhfY29udGV4dHMAAAAAAAPqAAAH0AAAAAdDb250ZXh0AAAAAAEAAAPpAAAAAgAAB9AAAAARU21hcnRBY2NvdW50RXJyb3IAAAA=", "AAAAAAAAAP1DcmVhdGVzIGEgZGVmYXVsdCBjb250ZXh0IHJ1bGUgd2l0aCB0aGUgcHJvdmlkZWQgc2lnbmVycyBhbmQgcG9saWNpZXMuCgojIEFyZ3VtZW50cwoKKiBgc2lnbmVyc2AgLSBWZWN0b3Igb2Ygc2lnbmVycyAoRGVsZWdhdGVkIG9yIEV4dGVybmFsKSB0aGF0IGNhbgphdXRob3JpemUgdHJhbnNhY3Rpb25zCiogYHBvbGljaWVzYCAtIE1hcCBvZiBwb2xpY3kgY29udHJhY3QgYWRkcmVzc2VzIHRvIHRoZWlyIGluc3RhbGxhdGlvbgpwYXJhbWV0ZXJzAAAAAAAADV9fY29uc3RydWN0b3IAAAAAAAACAAAAAAAAAAdzaWduZXJzAAAAA+oAAAfQAAAABlNpZ25lcgAAAAAAAAAAAAhwb2xpY2llcwAAA+wAAAATAAAAAAAAAAA=", "AAAAAAAAAQJSZXRyaWV2ZXMgdGhlIGdsb2JhbCByZWdpc3RyeSBJRCBmb3IgYSBwb2xpY3kuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYHBvbGljeWAgLSBUaGUgcG9saWN5IGFkZHJlc3MgdG8gbG9vayB1cC4KCiMgRXJyb3JzCgoqIFtgU21hcnRBY2NvdW50RXJyb3I6OlBvbGljeU5vdEZvdW5kYF0gLSBXaGVuIHRoZSBwb2xpY3kgaXMgbm90CnJlZ2lzdGVyZWQgaW4gdGhlIGdsb2JhbCByZWdpc3RyeS4AAAAAAA1nZXRfcG9saWN5X2lkAAAAAAAAAQAAAAAAAAAGcG9saWN5AAAAAAATAAAAAQAAAAQ=", "AAAAAAAAAPpSZXRyaWV2ZXMgdGhlIGdsb2JhbCByZWdpc3RyeSBJRCBmb3IgYSBzaWduZXIuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYHNpZ25lcmAgLSBUaGUgc2lnbmVyIHRvIGxvb2sgdXAuCgojIEVycm9ycwoKKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpTaWduZXJOb3RGb3VuZGBdIC0gV2hlbiB0aGUgc2lnbmVyIGlzIG5vdApyZWdpc3RlcmVkIGluIHRoZSBnbG9iYWwgcmVnaXN0cnkuAAAAAAANZ2V0X3NpZ25lcl9pZAAAAAAAAAEAAAAAAAAABnNpZ25lcgAAAAAH0AAAAAZTaWduZXIAAAAAAAEAAAAE", "AAAAAAAAA1pSZW1vdmVzIGEgcG9saWN5IGZyb20gYW4gZXhpc3RpbmcgY29udGV4dCBydWxlIGFuZCB1bmluc3RhbGxzIGl0LiBUaGUKcG9saWN5J3MgYHVuaW5zdGFsbGAgbWV0aG9kIHdpbGwgYmUgY2FsbGVkIGR1cmluZyB0aGlzIG9wZXJhdGlvbi4KUmVtb3ZpbmcgdGhlIGxhc3QgcG9saWN5IGlzIGFsbG93ZWQgb25seSBpZiB0aGUgcnVsZSBoYXMgYXQgbGVhc3QKb25lIHNpZ25lci4KCiMgQXJndW1lbnRzCgoqIGBlYCAtIEFjY2VzcyB0byB0aGUgU29yb2JhbiBlbnZpcm9ubWVudC4KKiBgY29udGV4dF9ydWxlX2lkYCAtIFRoZSBJRCBvZiB0aGUgY29udGV4dCBydWxlIHRvIG1vZGlmeS4KKiBgcG9saWN5X2lkYCAtIFRoZSBJRCBvZiB0aGUgcG9saWN5IHRvIHJlbW92ZSBmcm9tIHRoZSBjb250ZXh0IHJ1bGUuCgojIEVycm9ycwoKKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpDb250ZXh0UnVsZU5vdEZvdW5kYF0gLSBXaGVuIG5vIGNvbnRleHQgcnVsZQpleGlzdHMgd2l0aCB0aGUgZ2l2ZW4gSUQuCiogW2BTbWFydEFjY291bnRFcnJvcjo6UG9saWN5Tm90Rm91bmRgXSAtIFdoZW4gdGhlIHBvbGljeSBkb2Vzbid0IGV4aXN0CmluIHRoZSBydWxlLgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsicG9saWN5X3JlbW92ZWQiLCBjb250ZXh0X3J1bGVfaWQ6IHUzMl1gCiogZGF0YSAtIGBbcG9saWN5X2lkOiB1MzJdYAoKIyBOb3RlcwoKRGVmYXVsdHMgdG8gcmVxdWlyaW5nIGF1dGhvcml6YXRpb24gZnJvbSB0aGUgc21hcnQgYWNjb3VudCBpdHNlbGYKKGBlLmN1cnJlbnRfY29udHJhY3RfYWRkcmVzcygpLnJlcXVpcmVfYXV0aCgpYCkgYW5kIHRoZW4gZGVsZWdhdGluZyB0bwpbYHN0b3JhZ2U6OnJlbW92ZV9wb2xpY3lgXS4AAAAAAA1yZW1vdmVfcG9saWN5AAAAAAAAAgAAAAAAAAAPY29udGV4dF9ydWxlX2lkAAAAAAQAAAAAAAAACXBvbGljeV9pZAAAAAAAAAQAAAAA", "AAAAAAAAAwJSZW1vdmVzIGEgc2lnbmVyIGZyb20gYW4gZXhpc3RpbmcgY29udGV4dCBydWxlLiBSZW1vdmluZyB0aGUgbGFzdCBzaWduZXIKaXMgYWxsb3dlZCBvbmx5IGlmIHRoZSBydWxlIGhhcyBhdCBsZWFzdCBvbmUgcG9saWN5LgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgoqIGBjb250ZXh0X3J1bGVfaWRgIC0gVGhlIElEIG9mIHRoZSBjb250ZXh0IHJ1bGUgdG8gbW9kaWZ5LgoqIGBzaWduZXJfaWRgIC0gVGhlIElEIG9mIHRoZSBzaWduZXIgdG8gcmVtb3ZlIGZyb20gdGhlIGNvbnRleHQgcnVsZS4KCiMgRXJyb3JzCgoqIFtgU21hcnRBY2NvdW50RXJyb3I6OkNvbnRleHRSdWxlTm90Rm91bmRgXSAtIFdoZW4gbm8gY29udGV4dCBydWxlCmV4aXN0cyB3aXRoIHRoZSBnaXZlbiBJRC4KKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpTaWduZXJOb3RGb3VuZGBdIC0gV2hlbiB0aGUgc2lnbmVyIGRvZXNuJ3QgZXhpc3QKaW4gdGhlIHJ1bGUuCgojIEV2ZW50cwoKKiB0b3BpY3MgLSBgWyJzaWduZXJfcmVtb3ZlZCIsIGNvbnRleHRfcnVsZV9pZDogdTMyXWAKKiBkYXRhIC0gYFtzaWduZXJfaWQ6IHUzMl1gCgojIE5vdGVzCgpEZWZhdWx0cyB0byByZXF1aXJpbmcgYXV0aG9yaXphdGlvbiBmcm9tIHRoZSBzbWFydCBhY2NvdW50IGl0c2VsZgooYGUuY3VycmVudF9jb250cmFjdF9hZGRyZXNzKCkucmVxdWlyZV9hdXRoKClgKSBhbmQgdGhlbiBkZWxlZ2F0aW5nIHRvCltgc3RvcmFnZTo6cmVtb3ZlX3NpZ25lcmBdLgAAAAAADXJlbW92ZV9zaWduZXIAAAAAAAACAAAAAAAAAA9jb250ZXh0X3J1bGVfaWQAAAAABAAAAAAAAAAJc2lnbmVyX2lkAAAAAAAABAAAAAA=", "AAAAAAAABABDcmVhdGVzIGEgbmV3IGNvbnRleHQgcnVsZSB3aXRoIHRoZSBzcGVjaWZpZWQgY29uZmlndXJhdGlvbiwgcmV0dXJuaW5nCnRoZSBuZXdseSBjcmVhdGVkIGBDb250ZXh0UnVsZWAgd2l0aCBhIHVuaXF1ZSBJRCBhc3NpZ25lZC4gSW5zdGFsbHMKYWxsIHNwZWNpZmllZCBwb2xpY2llcyBkdXJpbmcgY3JlYXRpb24uCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYGNvbnRleHRfdHlwZWAgLSBUaGUgdHlwZSBvZiBjb250ZXh0IHRoaXMgcnVsZSBhcHBsaWVzIHRvLgoqIGBuYW1lYCAtIEh1bWFuLXJlYWRhYmxlIG5hbWUgZm9yIHRoZSBjb250ZXh0IHJ1bGUuCiogYHZhbGlkX3VudGlsYCAtIE9wdGlvbmFsIGV4cGlyYXRpb24gbGVkZ2VyIHNlcXVlbmNlLgoqIGBzaWduZXJzYCAtIExpc3Qgb2Ygc2lnbmVycyBhdXRob3JpemVkIGJ5IHRoaXMgcnVsZS4KKiBgcG9saWNpZXNgIC0gTWFwIG9mIHBvbGljeSBhZGRyZXNzZXMgdG8gdGhlaXIgaW5zdGFsbGF0aW9uIHBhcmFtZXRlcnMuCgojIEVycm9ycwoKKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpOb1NpZ25lcnNBbmRQb2xpY2llc2BdIC0gV2hlbiBib3RoIHNpZ25lcnMgYW5kCnBvbGljaWVzIGFyZSBlbXB0eS4KKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpUb29NYW55U2lnbmVyc2BdIC0gV2hlbiBzaWduZXJzIGV4Y2VlZApNQVhfU0lHTkVSUyAoMTUpLgoqIFtgU21hcnRBY2NvdW50RXJyb3I6OlRvb01hbnlQb2xpY2llc2BdIC0gV2hlbiBwb2xpY2llcyBleGNlZWQKTUFYX1BPTElDSUVTICg1KS4KKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpEdXBsaWNhdGVTaWduZXJgXSAtIFdoZW4gdGhlIHNhbWUgc2lnbmVyIGFwcGVhcnMKbXVsdGlwbGUgdGltZXMuCiogW2BTbWFydEFjY291bnRFcnJvcjo6UGFzdFZhbGlkVW50aWxgXSAtIFdoZW4gdmFsaWRfdW50aWwgaXMgaW4gdGhlCnBhc3QuCiogW2BTbWFydEFjY291bnRFcnJvcjo6TWF0aE92ZXJmbG93YF0gLSBXaGVuIHRoZSBjb250ZXh0IHJ1bGUsIHNpAAAAEGFkZF9jb250ZXh0X3J1bGUAAAAFAAAAAAAAAAxjb250ZXh0X3R5cGUAAAfQAAAAD0NvbnRleHRSdWxlVHlwZQAAAAAAAAAABG5hbWUAAAAQAAAAAAAAAAt2YWxpZF91bnRpbAAAAAPoAAAABAAAAAAAAAAHc2lnbmVycwAAAAPqAAAH0AAAAAZTaWduZXIAAAAAAAAAAAAIcG9saWNpZXMAAAPsAAAAEwAAAAAAAAABAAAH0AAAAAtDb250ZXh0UnVsZQA=", "AAAAAAAAAAAAAAAQYmF0Y2hfYWRkX3NpZ25lcgAAAAIAAAAAAAAAD2NvbnRleHRfcnVsZV9pZAAAAAAEAAAAAAAAAAdzaWduZXJzAAAAA+oAAAfQAAAABlNpZ25lcgAAAAAAAA==", "AAAAAAAAAWVSZXRyaWV2ZXMgYSBjb250ZXh0IHJ1bGUgYnkgaXRzIHVuaXF1ZSBJRCwgcmV0dXJuaW5nIHRoZQpgQ29udGV4dFJ1bGVgIGNvbnRhaW5pbmcgYWxsIG1ldGFkYXRhLCBzaWduZXJzLCBhbmQgcG9saWNpZXMuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYGNvbnRleHRfcnVsZV9pZGAgLSBUaGUgdW5pcXVlIGlkZW50aWZpZXIgb2YgdGhlIGNvbnRleHQgcnVsZSB0bwpyZXRyaWV2ZS4KCiMgRXJyb3JzCgoqIFtgU21hcnRBY2NvdW50RXJyb3I6OkNvbnRleHRSdWxlTm90Rm91bmRgXSAtIFdoZW4gbm8gY29udGV4dCBydWxlCmV4aXN0cyB3aXRoIHRoZSBnaXZlbiBJRC4AAAAAAAAQZ2V0X2NvbnRleHRfcnVsZQAAAAEAAAAAAAAAD2NvbnRleHRfcnVsZV9pZAAAAAAEAAAAAQAAB9AAAAALQ29udGV4dFJ1bGUA", "AAAAAAAABABSZW1vdmVzIGEgY29udGV4dCBydWxlIGFuZCBjbGVhbnMgdXAgYWxsIGFzc29jaWF0ZWQgZGF0YS4gVGhpcyBmdW5jdGlvbgp1bmluc3RhbGxzIGFsbCBwb2xpY2llcyBhc3NvY2lhdGVkIHdpdGggdGhlIHJ1bGUgYW5kIHJlbW92ZXMgYWxsIHN0b3JlZApkYXRhIGluY2x1ZGluZyBzaWduZXJzLCBwb2xpY2llcywgYW5kIG1ldGFkYXRhLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgoqIGBjb250ZXh0X3J1bGVfaWRgIC0gVGhlIElEIG9mIHRoZSBjb250ZXh0IHJ1bGUgdG8gcmVtb3ZlLgoKIyBFcnJvcnMKCiogW2BTbWFydEFjY291bnRFcnJvcjo6Q29udGV4dFJ1bGVOb3RGb3VuZGBdIC0gV2hlbiBubyBjb250ZXh0IHJ1bGUKZXhpc3RzIHdpdGggdGhlIGdpdmVuIElELgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsiY29udGV4dF9ydWxlX3JlbW92ZWQiLCBjb250ZXh0X3J1bGVfaWQ6IHUzMl1gCiogZGF0YSAtIGBbXWAKCiMgTm90ZXMKCkRlZmF1bHRzIHRvIHJlcXVpcmluZyBhdXRob3JpemF0aW9uIGZyb20gdGhlIHNtYXJ0IGFjY291bnQgaXRzZWxmCihgZS5jdXJyZW50X2NvbnRyYWN0X2FkZHJlc3MoKS5yZXF1aXJlX2F1dGgoKWApIGFuZCB0aGVuIGRlbGVnYXRpbmcgdG8KW2BzdG9yYWdlOjpyZW1vdmVfY29udGV4dF9ydWxlYF0uCgpUaGUgbGlicmFyeSBkb2VzIG5vdCBzdG9wIHRoZSBhY2NvdW50IGZyb20gcmVtb3ZpbmcgdGhlIGxhc3QgY29udGV4dApydWxlIHRoYXQgY2FuIGF1dGhvcml6ZSBjYWxscyB0byB0aGUgYWNjb3VudCBpdHNlbGYgKGEgYERlZmF1bHRgIHJ1bGUsCm9yIGEgYENhbGxDb250cmFjdGAgcnVsZSBmb3IgdGhlIGFjY291bnQncyBvd24gYWRkcmVzcykuIEV2ZXJ5Cm1hbmFnZW1lbnQgZnVuY3Rpb24sIGluY2x1ZGluZyBbYFNtYXJ0QWNjb3VudDo6YWRkX2NvbnRleHRfcnVsZWBdLApuZWVkcyBzdWNoIGEgcnVsZSwgc28gb25jZSBub25lIGlzIHZhbGlkIHRoZSBhY2NvdW50IGlzIGxvY2tlZApwZXJtYW5lbnRsAAAAE3JlbW92ZV9jb250ZXh0X3J1bGUAAAAAAQAAAAAAAAAPY29udGV4dF9ydWxlX2lkAAAAAAQAAAAA", "AAAAAAAAAZBSZXRyaWV2ZXMgdGhlIG51bWJlciBvZiBhbGwgY29udGV4dCBydWxlcywgaW5jbHVkaW5nIGV4cGlyZWQgcnVsZXMuCkRlZmF1bHRzIHRvIDAuCgpBIGNvdW50IG9mIDAgbWVhbnMgdGhlIGFjY291bnQgY2Fubm90IGF1dGhvcml6ZSBhbnl0aGluZywgaW5jbHVkaW5nCmFkZGluZyBhIHJ1bGUgYmFjay4gQSBub24temVybyBjb3VudCBkb2VzIG5vdCBydWxlIHRoaXMgb3V0IGVpdGhlciwKc2luY2UgdGhlIHJlbWFpbmluZyBydWxlcyBtYXkgYWxsIGJlIGV4cGlyZWQgb3Igc2NvcGVkIHRvIG90aGVyCmNvbnRyYWN0cyAocmVmZXIgdG8gW2BTbWFydEFjY291bnQ6OnJlbW92ZV9jb250ZXh0X3J1bGVgXSkuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuAAAAF2dldF9jb250ZXh0X3J1bGVzX2NvdW50AAAAAAAAAAABAAAABA==", "AAAAAAAAAvNVcGRhdGVzIHRoZSBuYW1lIG9mIGFuIGV4aXN0aW5nIGNvbnRleHQgcnVsZSwgcmV0dXJuaW5nIHRoZSB1cGRhdGVkCmBDb250ZXh0UnVsZWAgd2l0aCB0aGUgbmV3IG5hbWUuCgojIEFyZ3VtZW50cwoKKiBgZWAgLSBBY2Nlc3MgdG8gdGhlIFNvcm9iYW4gZW52aXJvbm1lbnQuCiogYGNvbnRleHRfcnVsZV9pZGAgLSBUaGUgSUQgb2YgdGhlIGNvbnRleHQgcnVsZSB0byB1cGRhdGUuCiogYG5hbWVgIC0gVGhlIG5ldyBodW1hbi1yZWFkYWJsZSBuYW1lIGZvciB0aGUgY29udGV4dCBydWxlLgoKIyBFcnJvcnMKCiogW2BTbWFydEFjY291bnRFcnJvcjo6Q29udGV4dFJ1bGVOb3RGb3VuZGBdIC0gV2hlbiBubyBjb250ZXh0IHJ1bGUKZXhpc3RzIHdpdGggdGhlIGdpdmVuIElELgoKIyBFdmVudHMKCiogdG9waWNzIC0gYFsiY29udGV4dF9ydWxlX21ldGFfdXBkYXRlZCIsIGNvbnRleHRfcnVsZV9pZDogdTMyXWAKKiBkYXRhIC0gYFtuYW1lOiBTdHJpbmcsIHZhbGlkX3VudGlsOiBPcHRpb248dTMyPl1gIChgdmFsaWRfdW50aWxgIGlzCmxlZnQgb3V0IG9mIHRoZSBkYXRhIHdoZW4gaXQgaXMgYE5vbmVgKQoKIyBOb3RlcwoKRGVmYXVsdHMgdG8gcmVxdWlyaW5nIGF1dGhvcml6YXRpb24gZnJvbSB0aGUgc21hcnQgYWNjb3VudCBpdHNlbGYKKGBlLmN1cnJlbnRfY29udHJhY3RfYWRkcmVzcygpLnJlcXVpcmVfYXV0aCgpYCkgYW5kIHRoZW4gZGVsZWdhdGluZyB0bwpbYHN0b3JhZ2U6OnVwZGF0ZV9jb250ZXh0X3J1bGVfbmFtZWBdLgAAAAAYdXBkYXRlX2NvbnRleHRfcnVsZV9uYW1lAAAAAgAAAAAAAAAPY29udGV4dF9ydWxlX2lkAAAAAAQAAAAAAAAABG5hbWUAAAAQAAAAAQAAB9AAAAALQ29udGV4dFJ1bGUA", "AAAAAAAABABVcGRhdGVzIHRoZSBleHBpcmF0aW9uIHRpbWUgb2YgYW4gZXhpc3RpbmcgY29udGV4dCBydWxlLCByZXR1cm5pbmcgdGhlCnVwZGF0ZWQgYENvbnRleHRSdWxlYCB3aXRoIHRoZSBuZXcgZXhwaXJhdGlvbiB0aW1lLgoKIyBBcmd1bWVudHMKCiogYGVgIC0gQWNjZXNzIHRvIHRoZSBTb3JvYmFuIGVudmlyb25tZW50LgoqIGBjb250ZXh0X3J1bGVfaWRgIC0gVGhlIElEIG9mIHRoZSBjb250ZXh0IHJ1bGUgdG8gdXBkYXRlLgoqIGB2YWxpZF91bnRpbGAgLSBOZXcgb3B0aW9uYWwgZXhwaXJhdGlvbiBsZWRnZXIgc2VxdWVuY2UuIFVzZSBgTm9uZWAKZm9yIG5vIGV4cGlyYXRpb24uCgojIEVycm9ycwoKKiBbYFNtYXJ0QWNjb3VudEVycm9yOjpDb250ZXh0UnVsZU5vdEZvdW5kYF0gLSBXaGVuIG5vIGNvbnRleHQgcnVsZQpleGlzdHMgd2l0aCB0aGUgZ2l2ZW4gSUQuCiogW2BTbWFydEFjY291bnRFcnJvcjo6UGFzdFZhbGlkVW50aWxgXSAtIFdoZW4gdmFsaWRfdW50aWwgaXMgaW4gdGhlCnBhc3QuCgojIEV2ZW50cwoKKiB0b3BpY3MgLSBgWyJjb250ZXh0X3J1bGVfbWV0YV91cGRhdGVkIiwgY29udGV4dF9ydWxlX2lkOiB1MzJdYAoqIGRhdGEgLSBgW25hbWU6IFN0cmluZywgdmFsaWRfdW50aWw6IE9wdGlvbjx1MzI+XWAgKGB2YWxpZF91bnRpbGAgaXMKbGVmdCBvdXQgb2YgdGhlIGRhdGEgd2hlbiBpdCBpcyBgTm9uZWApCgojIE5vdGVzCgpEZWZhdWx0cyB0byByZXF1aXJpbmcgYXV0aG9yaXphdGlvbiBmcm9tIHRoZSBzbWFydCBhY2NvdW50IGl0c2VsZgooYGUuY3VycmVudF9jb250cmFjdF9hZGRyZXNzKCkucmVxdWlyZV9hdXRoKClgKSBhbmQgdGhlbiBkZWxlZ2F0aW5nIHRvCltgc3RvcmFnZTo6dXBkYXRlX2NvbnRleHRfcnVsZV92YWxpZF91bnRpbGBdLgoKVGhlIGxpYnJhcnkgZG9lcyBub3Qgc3RvcCB0aGUgYWNjb3VudCBmcm9tIGdpdmluZyBhbiBleHBpcnkgdG8gdGhlIGxhc3QKY29udGV4dCBydWxlIHRoYXQgY2FuIGF1dGhvcml6ZSBjYWxscyB0byB0aGUgYWNjb3VudCBpdHNlbGYgKGEKAAAAH3VwZGF0ZV9jb250ZXh0X3J1bGVfdmFsaWRfdW50aWwAAAAAAgAAAAAAAAAPY29udGV4dF9ydWxlX2lkAAAAAAQAAAAAAAAAC3ZhbGlkX3VudGlsAAAAA+gAAAAEAAAAAQAAB9AAAAALQ29udGV4dFJ1bGUA", "AAAAAgAAAF9Db250cmFjdCBleGVjdXRhYmxlIHVzZWQgZm9yIGNyZWF0aW5nIGEgbmV3IGNvbnRyYWN0IGFuZCB1c2VkIGluCmBDcmVhdGVDb250cmFjdEhvc3RGbkNvbnRleHRgLgAAAAAAAAAAEkNvbnRyYWN0RXhlY3V0YWJsZQAAAAAAAgAAAAEAAAB4RXhlY3V0YWJsZSBzcGVjaWZpZWQgYnkgdGhlIGNvbnRyYWN0IGluc3RhbmNlIGFzIGEgc3BlY2lmaWMgV2FzbSBjb250cmFjdCBjb2RlIGVudHJ5IGlkZW50aWZpZWQgYnkgaXRzIFdhc20gc2hhMjU2IGhhc2guAAAABFdhc20AAAABAAAD7gAAACAAAAABAAAAX0V4ZWN1dGFibGUgcmVmZXJlbmNlIHZpYSBhIHBlcnNpc3RlbnQgc3RvcmFnZSBlbnRyeSBvd25lZCBieSB0aGlzIGNvbnRyYWN0IG9yIGFub3RoZXIgY29udHJhY3QuAAAAAAtFeHRlcm5hbFJlZgAAAAABAAAH0AAAABVDb250cmFjdEV4ZWN1dGFibGVSZWYAAAA=", "AAAAAQAAAMBFeGVjdXRhYmxlIHJlZmVyZW5jZWQgdmlhIGEgcGVyc2lzdGVudCBzdG9yYWdlIGVudHJ5IG93bmVkIGJ5IGEgY29udHJhY3QsCmVpdGhlciB0aGlzIGNvbnRyYWN0IG9yIGFub3RoZXIgY29udHJhY3QuCgpUaGUgcGVyc2lzdGVudCBzdG9yYWdlIGVudHJ5IG93bmVkIGJ5IHRoZSBgb3duZXJgIGhhcyB0aGUgYHRhZ2AgYXMgaXRzIGtleS4AAAAAAAAAFUNvbnRyYWN0RXhlY3V0YWJsZVJlZgAAAAAAAAIAAAAAAAAABW93bmVyAAAAAAAAEwAAAAAAAAADdGFnAAAAABA=", "AAAAAgAAAONDb250ZXh0IG9mIGEgc2luZ2xlIGF1dGhvcml6ZWQgY2FsbCBwZXJmb3JtZWQgYnkgYW4gYWRkcmVzcy4KCkN1c3RvbSBhY2NvdW50IGNvbnRyYWN0cyB0aGF0IGltcGxlbWVudCBgX19jaGVja19hdXRoYCBzcGVjaWFsIGZ1bmN0aW9uCnJlY2VpdmUgYSBsaXN0IG9mIGBDb250ZXh0YCB2YWx1ZXMgY29ycmVzcG9uZGluZyB0byBhbGwgdGhlIGNhbGxzIHRoYXQKbmVlZCB0byBiZSBhdXRob3JpemVkLgAAAAAAAAAAB0NvbnRleHQAAAAAAwAAAAEAAAAUQ29udHJhY3QgaW52b2NhdGlvbi4AAAAIQ29udHJhY3QAAAABAAAH0AAAAA9Db250cmFjdENvbnRleHQAAAAAAQAAAD1Db250cmFjdCB0aGF0IGhhcyBhIGNvbnN0cnVjdG9yIHdpdGggbm8gYXJndW1lbnRzIGlzIGNyZWF0ZWQuAAAAAAAAFENyZWF0ZUNvbnRyYWN0SG9zdEZuAAAAAQAAB9AAAAAbQ3JlYXRlQ29udHJhY3RIb3N0Rm5Db250ZXh0AAAAAAEAAABEQ29udHJhY3QgdGhhdCBoYXMgYSBjb25zdHJ1Y3RvciB3aXRoIDEgb3IgbW9yZSBhcmd1bWVudHMgaXMgY3JlYXRlZC4AAAAcQ3JlYXRlQ29udHJhY3RXaXRoQ3Rvckhvc3RGbgAAAAEAAAfQAAAAKkNyZWF0ZUNvbnRyYWN0V2l0aENvbnN0cnVjdG9ySG9zdEZuQ29udGV4dAAA", "AAAAAQAAAL1BdXRob3JpemF0aW9uIGNvbnRleHQgb2YgYSBzaW5nbGUgY29udHJhY3QgY2FsbC4KClRoaXMgc3RydWN0IGNvcnJlc3BvbmRzIHRvIGEgYHJlcXVpcmVfYXV0aF9mb3JfYXJnc2AgY2FsbCBmb3IgYW4gYWRkcmVzcwpmcm9tIGBjb250cmFjdGAgZnVuY3Rpb24gd2l0aCBgZm5fbmFtZWAgbmFtZSBhbmQgYGFyZ3NgIGFyZ3VtZW50cy4AAAAAAAAAAAAAD0NvbnRyYWN0Q29udGV4dAAAAAADAAAAAAAAAARhcmdzAAAD6gAAAAAAAAAAAAAACGNvbnRyYWN0AAAAEwAAAAAAAAAHZm5fbmFtZQAAAAAR", "AAAAAQAAAHZBdXRob3JpemF0aW9uIGNvbnRleHQgZm9yIGBjcmVhdGVfY29udHJhY3RgIGhvc3QgZnVuY3Rpb24gdGhhdCBjcmVhdGVzIGEKbmV3IGNvbnRyYWN0IG9uIGJlaGFsZiBvZiBhdXRob3JpemVyIGFkZHJlc3MuAAAAAAAAAAAAG0NyZWF0ZUNvbnRyYWN0SG9zdEZuQ29udGV4dAAAAAACAAAAAAAAAApleGVjdXRhYmxlAAAAAAfQAAAAEkNvbnRyYWN0RXhlY3V0YWJsZQAAAAAAAAAAAARzYWx0AAAD7gAAACA=", "AAAAAQAAANZBdXRob3JpemF0aW9uIGNvbnRleHQgZm9yIGBjcmVhdGVfY29udHJhY3RgIGhvc3QgZnVuY3Rpb24gdGhhdCBjcmVhdGVzIGEKbmV3IGNvbnRyYWN0IG9uIGJlaGFsZiBvZiBhdXRob3JpemVyIGFkZHJlc3MuClRoaXMgaXMgdGhlIHNhbWUgYXMgYENyZWF0ZUNvbnRyYWN0SG9zdEZuQ29udGV4dGAsIGJ1dCBhbHNvIGhhcwpjb250cmFjdCBjb25zdHJ1Y3RvciBhcmd1bWVudHMuAAAAAAAAAAAAKkNyZWF0ZUNvbnRyYWN0V2l0aENvbnN0cnVjdG9ySG9zdEZuQ29udGV4dAAAAAAAAwAAAAAAAAAQY29uc3RydWN0b3JfYXJncwAAA+oAAAAAAAAAAAAAAApleGVjdXRhYmxlAAAAAAfQAAAAEkNvbnRyYWN0RXhlY3V0YWJsZQAAAAAAAAAAAARzYWx0AAAD7gAAACA=", "AAAABQAAADdFdmVudCBlbWl0dGVkIHdoZW4gYSBwb2xpY3kgaXMgYWRkZWQgdG8gYSBjb250ZXh0IHJ1bGUuAAAAAAAAAAALUG9saWN5QWRkZWQAAAAAAQAAAAxwb2xpY3lfYWRkZWQAAAACAAAAAAAAAA9jb250ZXh0X3J1bGVfaWQAAAAABAAAAAEAAAAAAAAACXBvbGljeV9pZAAAAAAAAAQAAAAAAAAAAg==", "AAAABQAAADdFdmVudCBlbWl0dGVkIHdoZW4gYSBzaWduZXIgaXMgYWRkZWQgdG8gYSBjb250ZXh0IHJ1bGUuAAAAAAAAAAALU2lnbmVyQWRkZWQAAAAAAQAAAAxzaWduZXJfYWRkZWQAAAACAAAAAAAAAA9jb250ZXh0X3J1bGVfaWQAAAAABAAAAAEAAAAAAAAACXNpZ25lcl9pZAAAAAAAAAQAAAAAAAAAAg==", "AAAABQAAADtFdmVudCBlbWl0dGVkIHdoZW4gYSBwb2xpY3kgaXMgcmVtb3ZlZCBmcm9tIGEgY29udGV4dCBydWxlLgAAAAAAAAAADVBvbGljeVJlbW92ZWQAAAAAAAABAAAADnBvbGljeV9yZW1vdmVkAAAAAAACAAAAAAAAAA9jb250ZXh0X3J1bGVfaWQAAAAABAAAAAEAAAAAAAAACXBvbGljeV9pZAAAAAAAAAQAAAAAAAAAAg==", "AAAABQAAADtFdmVudCBlbWl0dGVkIHdoZW4gYSBzaWduZXIgaXMgcmVtb3ZlZCBmcm9tIGEgY29udGV4dCBydWxlLgAAAAAAAAAADVNpZ25lclJlbW92ZWQAAAAAAAABAAAADnNpZ25lcl9yZW1vdmVkAAAAAAACAAAAAAAAAA9jb250ZXh0X3J1bGVfaWQAAAAABAAAAAEAAAAAAAAACXNpZ25lcl9pZAAAAAAAAAQAAAAAAAAAAg==", "AAAABQAAACtFdmVudCBlbWl0dGVkIHdoZW4gYSBjb250ZXh0IHJ1bGUgaXMgYWRkZWQuAAAAAAAAAAAQQ29udGV4dFJ1bGVBZGRlZAAAAAEAAAASY29udGV4dF9ydWxlX2FkZGVkAAAAAAAGAAAAAAAAAA9jb250ZXh0X3J1bGVfaWQAAAAABAAAAAEAAAAAAAAABG5hbWUAAAAQAAAAAAAAAAAAAAAMY29udGV4dF90eXBlAAAH0AAAAA9Db250ZXh0UnVsZVR5cGUAAAAAAAAAAAAAAAALdmFsaWRfdW50aWwAAAAD6AAAAAQAAAAAAAAAAAAAAApzaWduZXJfaWRzAAAAAAPqAAAABAAAAAAAAAAAAAAACnBvbGljeV9pZHMAAAAAA+oAAAAEAAAAAAAAAAI=", "AAAABQAAAEFFdmVudCBlbWl0dGVkIHdoZW4gYSBwb2xpY3kgaXMgcmVnaXN0ZXJlZCBpbiB0aGUgZ2xvYmFsIHJlZ2lzdHJ5LgAAAAAAAAAAAAAQUG9saWN5UmVnaXN0ZXJlZAAAAAEAAAARcG9saWN5X3JlZ2lzdGVyZWQAAAAAAAACAAAAAAAAAAlwb2xpY3lfaWQAAAAAAAAEAAAAAQAAAAAAAAAGcG9saWN5AAAAAAATAAAAAAAAAAI=", "AAAABQAAAEFFdmVudCBlbWl0dGVkIHdoZW4gYSBzaWduZXIgaXMgcmVnaXN0ZXJlZCBpbiB0aGUgZ2xvYmFsIHJlZ2lzdHJ5LgAAAAAAAAAAAAAQU2lnbmVyUmVnaXN0ZXJlZAAAAAEAAAARc2lnbmVyX3JlZ2lzdGVyZWQAAAAAAAACAAAAAAAAAAlzaWduZXJfaWQAAAAAAAAEAAAAAQAAAAAAAAAGc2lnbmVyAAAAAAfQAAAABlNpZ25lcgAAAAAAAAAAAAI=", "AAAABAAAAClFcnJvciBjb2RlcyBmb3Igc21hcnQgYWNjb3VudCBvcGVyYXRpb25zLgAAAAAAAAAAAAARU21hcnRBY2NvdW50RXJyb3IAAAAAAAASAAAAKlRoZSBzcGVjaWZpZWQgY29udGV4dCBydWxlIGRvZXMgbm90IGV4aXN0LgAAAAAAE0NvbnRleHRSdWxlTm90Rm91bmQAAAALuAAAADpUaGUgcHJvdmlkZWQgY29udGV4dCBjYW5ub3QgYmUgdmFsaWRhdGVkIGFnYWluc3QgYW55IHJ1bGUuAAAAAAASVW52YWxpZGF0ZWRDb250ZXh0AAAAAAu6AAAAJ0V4dGVybmFsIHNpZ25hdHVyZSB2ZXJpZmljYXRpb24gZmFpbGVkLgAAAAAaRXh0ZXJuYWxWZXJpZmljYXRpb25GYWlsZWQAAAAAC7sAAAA1Q29udGV4dCBydWxlIG11c3QgaGF2ZSBhdCBsZWFzdCBvbmUgc2lnbmVyIG9yIHBvbGljeS4AAAAAAAAUTm9TaWduZXJzQW5kUG9saWNpZXMAAAu8AAAAKVRoZSB2YWxpZF91bnRpbCB0aW1lc3RhbXAgaXMgaW4gdGhlIHBhc3QuAAAAAAAADlBhc3RWYWxpZFVudGlsAAAAAAu9AAAAI1RoZSBzcGVjaWZpZWQgc2lnbmVyIHdhcyBub3QgZm91bmQuAAAAAA5TaWduZXJOb3RGb3VuZAAAAAALvgAAAC5UaGUgc2lnbmVyIGFscmVhZHkgZXhpc3RzIGluIHRoZSBjb250ZXh0IHJ1bGUuAAAAAAAPRHVwbGljYXRlU2lnbmVyAAAAC78AAAAjVGhlIHNwZWNpZmllZCBwb2xpY3kgd2FzIG5vdCBmb3VuZC4AAAAADlBvbGljeU5vdEZvdW5kAAAAAAvAAAAALlRoZSBwb2xpY3kgYWxyZWFkeSBleGlzdHMgaW4gdGhlIGNvbnRleHQgcnVsZS4AAAAAAA9EdXBsaWNhdGVQb2xpY3kAAAALwQAAACVUb28gbWFueSBzaWduZXJzIGluIHRoZSBjb250ZXh0IHJ1bGUuAAAAAAAADlRvb01hbnlTaWduZXJzAAAAAAvCAAAAJlRvbyBtYW55IHBvbGljaWVzIGluIHRoZSBjb250ZXh0IHJ1bGUuAAAAAAAPVG9vTWFueVBvbGljaWVzAAAAC8MAAACGQW4gaW50ZXJuYWwgSUQgY291bnRlciAoY29udGV4dCBydWxlLCBzaWduZXIsIG9yIHBvbGljeSkgaGFzIHJlYWNoZWQKaXRzIG1heGltdW0gdmFsdWUgKGB1MzI6Ok1BWGApIGFuZCBjYW5ub3QgYmUgaW5jcmVtZW50ZWQgZnVydGhlci4AAAAAAAxNYXRoT3ZlcmZsb3cAAAvEAAAAOkV4dGVybmFsIHNpZ25lciBrZXkgZGF0YSBleGNlZWRzIHRoZSBtYXhpbXVtIGFsbG93ZWQgc2l6ZS4AAAAAAA9LZXlEYXRhVG9vTGFyZ2UAAAALxQAAADxjb250ZXh0X3J1bGVfaWRzIGxlbmd0aCBkb2VzIG5vdCBtYXRjaCBhdXRoX2NvbnRleHRzIGxlbmd0aC4AAAAcQ29udGV4dFJ1bGVJZHNMZW5ndGhNaXNtYXRjaAAAC8YAAAA1Q29udGV4dCBydWxlIG5hbWUgZXhjZWVkcyB0aGUgbWF4aW11bSBhbGxvd2VkIGxlbmd0aC4AAAAAAAALTmFtZVRvb0xvbmcAAAALxwAAAENBIHNpZ25lciBpbiBgQXV0aFBheWxvYWRgIGlzIG5vdCBwYXJ0IG9mIGFueSBzZWxlY3RlZCBjb250ZXh0IHJ1bGUuAAAAABJVbmF1dGhvcml6ZWRTaWduZXIAAAAAC8gAAABLQSBkZWxlZ2F0ZWQgc2lnbmVyJ3MgYWRkcmVzcyBpcyB0aGUgY29udHJhY3Qgb2YgYSBjb250ZXh0IGJlaW5nCmF1dGhvcml6ZWQuAAAAACBEZWxlZ2F0ZWRTaWduZXJJc0NvbnRleHRDb250cmFjdAAAC8kAAAA5QSBkZWxlZ2F0ZWQgc2lnbmVyJ3MgYWRkcmVzcyBpcyB0aGUgc21hcnQgYWNjb3VudCBpdHNlbGYuAAAAAAAAE1NlbGZEZWxlZ2F0ZWRTaWduZXIAAAALyg==", "AAAABQAAAC1FdmVudCBlbWl0dGVkIHdoZW4gYSBjb250ZXh0IHJ1bGUgaXMgcmVtb3ZlZC4AAAAAAAAAAAAAEkNvbnRleHRSdWxlUmVtb3ZlZAAAAAAAAQAAABRjb250ZXh0X3J1bGVfcmVtb3ZlZAAAAAEAAAAAAAAAD2NvbnRleHRfcnVsZV9pZAAAAAAEAAAAAQAAAAI=", "AAAABQAAAEVFdmVudCBlbWl0dGVkIHdoZW4gYSBwb2xpY3kgaXMgZGVyZWdpc3RlcmVkIGZyb20gdGhlIGdsb2JhbCByZWdpc3RyeS4AAAAAAAAAAAAAElBvbGljeURlcmVnaXN0ZXJlZAAAAAAAAQAAABNwb2xpY3lfZGVyZWdpc3RlcmVkAAAAAAEAAAAAAAAACXBvbGljeV9pZAAAAAAAAAQAAAABAAAAAg==", "AAAABQAAAEVFdmVudCBlbWl0dGVkIHdoZW4gYSBzaWduZXIgaXMgZGVyZWdpc3RlcmVkIGZyb20gdGhlIGdsb2JhbCByZWdpc3RyeS4AAAAAAAAAAAAAElNpZ25lckRlcmVnaXN0ZXJlZAAAAAAAAQAAABNzaWduZXJfZGVyZWdpc3RlcmVkAAAAAAEAAAAAAAAACXNpZ25lcl9pZAAAAAAAAAQAAAABAAAAAg==", "AAAABQAAAEJFdmVudCBlbWl0dGVkIHdoZW4gYSBjb250ZXh0IHJ1bGUgbmFtZSBvciB2YWxpZF91bnRpbCBhcmUgdXBkYXRlZC4AAAAAAAAAAAAWQ29udGV4dFJ1bGVNZXRhVXBkYXRlZAAAAAAAAQAAABljb250ZXh0X3J1bGVfbWV0YV91cGRhdGVkAAAAAAAAAwAAAAAAAAAPY29udGV4dF9ydWxlX2lkAAAAAAQAAAABAAAAAAAAAARuYW1lAAAAEAAAAAAAAAAAAAAAC3ZhbGlkX3VudGlsAAAAA+gAAAAEAAAAAAAAAAI=", "AAAAAgAAAEJSZXByZXNlbnRzIGRpZmZlcmVudCB0eXBlcyBvZiBzaWduZXJzIGluIHRoZSBzbWFydCBhY2NvdW50IHN5c3RlbS4AAAAAAAAAAAAGU2lnbmVyAAAAAAACAAAAAQAAAvtBIGRlbGVnYXRlZCBzaWduZXIsIGFueSBjb250cmFjdCBvciBhY2NvdW50IGFkZHJlc3MsIGF1dGhlbnRpY2F0ZWQKdGhyb3VnaCBgcmVxdWlyZV9hdXRoX2Zvcl9hcmdzKChwcmVpbWFnZSwpKWAuIFRyYW5zYWN0aW9uIHNpbXVsYXRpb24KZG9lcyBub3QgcmV0dXJuIHRoaXMgbmVzdGVkIGF1dGhvcml6YXRpb24gZW50cnksIGJlY2F1c2UgdGhlIGNhbGwKaGFwcGVucyBpbnNpZGUgYF9fY2hlY2tfYXV0aGAuIENsaWVudHMgYWRkIGl0IG1hbnVhbGx5OiBhbiBlbnRyeSBmb3IKdGhlIGRlbGVnYXRlZCBhZGRyZXNzIHdob3NlIHJvb3QgaW52b2NhdGlvbiBpcyBgX19jaGVja19hdXRoYCBvbiB0aGUKc21hcnQgYWNjb3VudCB3aXRoIHRoZSBbYEF1dGhEaWdlc3RQcmVpbWFnZWBdIGFzIGl0cyBzaW5nbGUgYXJndW1lbnQuClNlZSBgc3JjL3NtYXJ0X2FjY291bnQvdGVzdC9hdXRoX2VudHJpZXMucnNgIGZvciBhIHJlZmVyZW5jZQpjb25zdHJ1Y3Rpb24uCgpUaGUgYWRkcmVzcyBtdXN0IG5vdCBiZSBhbiBhY2NvdW50IHRoYXQgZGVsZWdhdGVzIGl0cyBhdXRoZW50aWNhdGlvbgpiYWNrIHRvIHRoaXMgc21hcnQgYWNjb3VudCwgdW5sZXNzIGl0IGlzIGFuIGFjY291bnQgdGhhdCBhdXRoZW50aWNhdGVzCnRocm91Z2ggW2Bkb19jaGVja19hdXRoYF07IHRoaXMgc2lnbmVyIGNhbiBvdGhlcndpc2UgYmUgYXV0aG9yaXplZAp3aXRob3V0IGFueSBzaWduYXR1cmUuIFNlZSBbYHZhbGlkYXRlX25vX2RlbGVnYXRlZF9jb250ZXh0X2NvbnRyYWN0YF0uAAAAAAlEZWxlZ2F0ZWQAAAAAAAABAAAAEwAAAAEAAAByQW4gZXh0ZXJuYWwgc2lnbmVyIHdpdGggY3VzdG9tIHZlcmlmaWNhdGlvbiBsb2dpYy4KQ29udGFpbnMgdGhlIHZlcmlmaWVyIGNvbnRyYWN0IGFkZHJlc3MgYW5kIHRoZSBwdWJsaWMga2V5IGRhdGEuAAAAAAAIRXh0ZXJuYWwAAAACAAAAEwAAAA4=", "AAAAAQAABABUaGUgYXV0aG9yaXphdGlvbiBwYXlsb2FkIHBhc3NlZCB0byBgX19jaGVja19hdXRoYCwgYnVuZGxpbmcgY3J5cHRvZ3JhcGhpYwpwcm9vZnMgd2l0aCBjb250ZXh0IHJ1bGUgc2VsZWN0aW9uLgoKVGhpcyBzdHJ1Y3QgY2FycmllcyB0d28gZGlzdGluY3QgcGllY2VzIG9mIGluZm9ybWF0aW9uIHRoYXQgYXJlIGJvdGgKcmVxdWlyZWQgZm9yIGF1dGhvcml6YXRpb24gYnV0IGNhbm5vdCBiZSBkZXJpdmVkIGZyb20gZWFjaCBvdGhlcjoKCi0gYHNpZ25lcnNgIG1hcHMgZWFjaCBbYFNpZ25lcmBdIHRvIGl0cyByYXcgc2lnbmF0dXJlIGJ5dGVzLCBwcm92aWRpbmcKY3J5cHRvZ3JhcGhpYyBwcm9vZiB0aGF0IHRoZSBzaWduZXIgYWN0dWFsbHkgc2lnbmVkIHRoZSB0cmFuc2FjdGlvbgpwYXlsb2FkLiBBIGNvbnRleHQgcnVsZSBzdG9yZXMgd2hpY2ggc2lnbmVyICppZGVudGl0aWVzKiBhcmUgYXV0aG9yaXplZAoodmlhIGBzaWduZXJfaWRzYCksIGJ1dCB0aGUgcnVsZSBkb2VzIG5vdCBjb250YWluIHRoZSBzaWduYXR1cmVzCnRoZW1zZWx2ZXMg4oCUIHRob3NlIG11c3QgYmUgc3VwcGxpZWQgaGVyZS4KCi0gYGNvbnRleHRfcnVsZV9pZHNgIHRlbGxzIHRoZSBzeXN0ZW0gd2hpY2ggcnVsZSB0byB2YWxpZGF0ZSBmb3IgZWFjaCBhdXRoCmNvbnRleHQuIEJlY2F1c2UgbXVsdGlwbGUgcnVsZXMgY2FuIGV4aXN0IGZvciB0aGUgc2FtZSBjb250ZXh0IHR5cGUsIHRoZQpjYWxsZXIgbXVzdCBleHBsaWNpdGx5IHNlbGVjdCBvbmUgcGVyIGNvbnRleHQgcmF0aGVyIHRoYW4gcmVseWluZyBvbgphdXRvLWRpc2NvdmVyeS4gRWFjaCBlbnRyeSBpcyBhbGlnbmVkIGJ5IGluZGV4IHdpdGggdGhlIGBhdXRoX2NvbnRleHRzYApwYXNzZWQgdG8gYF9fY2hlY2tfYXV0aGAuCgpUaGUgbGVuZ3RoIG9mIGBjb250ZXh0X3J1bGVfaWRzYCBtdXN0IGVxdWFsIHRoZSBudW1iZXIgb2YgYXV0aCBjb250ZXh0czsKYSBtaXNtYXRjaCBpcyByZWplY3RlZCB3aXRoCltgU21hcnRBY2NvdW50RXJyb3I6OkNvbnRleHRSdWxlSWRzTGVuAAAAAAAAAAtBdXRoUGF5bG9hZAAAAAACAAAAPFBlci1jb250ZXh0IHJ1bGUgSURzLCBhbGlnbmVkIGJ5IGluZGV4IHdpdGggYGF1dGhfY29udGV4dHNgLgAAABBjb250ZXh0X3J1bGVfaWRzAAAD6gAAAAQAAAAlU2lnbmF0dXJlIGRhdGEgbWFwcGVkIHRvIGVhY2ggc2lnbmVyLgAAAAAAAAdzaWduZXJzAAAAA+wAAAfQAAAABlNpZ25lcgAAAAAADg==", "AAAAAQAAADxBIGNvbXBsZXRlIGNvbnRleHQgcnVsZSBkZWZpbmluZyBhdXRob3JpemF0aW9uIHJlcXVpcmVtZW50cy4AAAAAAAAAC0NvbnRleHRSdWxlAAAAAAgAAAApVGhlIHR5cGUgb2YgY29udGV4dCB0aGlzIHJ1bGUgYXBwbGllcyB0by4AAAAAAAAMY29udGV4dF90eXBlAAAH0AAAAA9Db250ZXh0UnVsZVR5cGUAAAAAJ1VuaXF1ZSBpZGVudGlmaWVyIGZvciB0aGUgY29udGV4dCBydWxlLgAAAAACaWQAAAAAAAQAAAApSHVtYW4tcmVhZGFibGUgbmFtZSBmb3IgdGhlIGNvbnRleHQgcnVsZS4AAAAAAAAEbmFtZQAAABAAAAAwTGlzdCBvZiBwb2xpY3kgY29udHJhY3RzIHRoYXQgbXVzdCBiZSBzYXRpc2ZpZWQuAAAACHBvbGljaWVzAAAD6gAAABMAAABKR2xvYmFsIHJlZ2lzdHJ5IElEcyBmb3IgZWFjaCBwb2xpY3ksIHBvc2l0aW9uYWxseSBhbGlnbmVkIHdpdGgKYHBvbGljaWVzYC4AAAAAAApwb2xpY3lfaWRzAAAAAAPqAAAABAAAAElHbG9iYWwgcmVnaXN0cnkgSURzIGZvciBlYWNoIHNpZ25lciwgcG9zaXRpb25hbGx5IGFsaWduZWQgd2l0aApgc2lnbmVyc2AuAAAAAAAACnNpZ25lcl9pZHMAAAAAA+oAAAAEAAAAKExpc3Qgb2Ygc2lnbmVycyBhdXRob3JpemVkIGJ5IHRoaXMgcnVsZS4AAAAHc2lnbmVycwAAAAPqAAAH0AAAAAZTaWduZXIAAAAAADFPcHRpb25hbCBleHBpcmF0aW9uIGxlZGdlciBzZXF1ZW5jZSBmb3IgdGhlIHJ1bGUuAAAAAAAAC3ZhbGlkX3VudGlsAAAAA+gAAAAE", "AAAAAgAAAEBUeXBlcyBvZiBjb250ZXh0cyB0aGF0IGNhbiBiZSBhdXRob3JpemVkIGJ5IHNtYXJ0IGFjY291bnQgcnVsZXMuAAAAAAAAAA9Db250ZXh0UnVsZVR5cGUAAAAABAAAAAAAAAAtRGVmYXVsdCBydWxlcyB0aGF0IGNhbiBhdXRob3JpemUgYW55IGNvbnRleHQuAAAAAAAAB0RlZmF1bHQAAAAAAQAAADBSdWxlcyBzcGVjaWZpYyB0byBjYWxsaW5nIGEgcGFydGljdWxhciBjb250cmFjdC4AAAAMQ2FsbENvbnRyYWN0AAAAAQAAABMAAAABAAAAQlJ1bGVzIHNwZWNpZmljIHRvIGNyZWF0aW5nIGEgY29udHJhY3Qgd2l0aCBhIHBhcnRpY3VsYXIgV0FTTSBoYXNoLgAAAAAADkNyZWF0ZUNvbnRyYWN0AAAAAAABAAAD7gAAACAAAAABAAAAZFJ1bGVzIHNwZWNpZmljIHRvIGNyZWF0aW5nIGEgY29udHJhY3QgZnJvbSB0aGUgZXhlY3V0YWJsZSByZWZlcmVuY2UgdGhhdApgb3duZXJgIHN0b3JlcyB1bmRlciBgdGFnYC4AAAAZQ3JlYXRlQ29udHJhY3RFeHRlcm5hbFJlZgAAAAAAAAIAAAATAAAAEA==", "AAAAAQAAARRUaGUgc3RydWN0dXJlZCBtZXNzYWdlIHRoYXQgZXZlcnkgc2lnbmVyIGNvbW1pdHMgdG8gaW4gYF9fY2hlY2tfYXV0aGAuCgpbYFNpZ25lcjo6RXh0ZXJuYWxgXSBzaWduZXJzIHNpZ24gW2BBdXRoRGlnZXN0UHJlaW1hZ2U6OmRpZ2VzdGBdLCB0aGUKU0hBLTI1NiBoYXNoIG9mIHRoaXMgc3RydWN0J3MgWERSIGVuY29kaW5nLiBbYFNpZ25lcjo6RGVsZWdhdGVkYF0gc2lnbmVycwphdXRob3JpemUgdGhlIHN0cnVjdCBpdHNlbGYgdGhyb3VnaCBgcmVxdWlyZV9hdXRoX2Zvcl9hcmdzYC4AAAAAAAAAEkF1dGhEaWdlc3RQcmVpbWFnZQAAAAAAAwAAADVUaGUgc21hcnQgYWNjb3VudCBwZXJmb3JtaW5nIHRoZSBhdXRob3JpemF0aW9uIGNoZWNrLgAAAAAAAAdhY2NvdW50AAAAABMAAAA8UGVyLWNvbnRleHQgcnVsZSBJRHMsIGFsaWduZWQgYnkgaW5kZXggd2l0aCBgYXV0aF9jb250ZXh0c2AuAAAAEGNvbnRleHRfcnVsZV9pZHMAAAPqAAAABAAAADtUaGUgMzItYnl0ZSBwYXlsb2FkIHByb3ZpZGVkIGJ5IHRoZSBob3N0IHRvIGBfX2NoZWNrX2F1dGhgLgAAAAARc2lnbmF0dXJlX3BheWxvYWQAAAAAAAPuAAAAIA=="]),
      options
    );
  }

   static deploy<T = Client>(args: { signers: Array<Signer>; policies: Map<string | Address, any> }, options: MethodOptions & Omit<ContractClientOptions, 'contractId'> & { salt?: Uint8Array; address?: string; } & ({ wasmHash: Uint8Array | string; format?: "hex" | "base64"; externalRef?: never; } | { externalRef: ExternalExecutableRef; wasmHash?: never; format?: never; })): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(args, options);
  }
  public readonly fromJson = {
    execute : this.txFromJson<void>,  upgrade : this.txFromJson<void>,  add_policy : this.txFromJson<number>,  add_signer : this.txFromJson<number>,  auth_digest : this.txFromJson<Uint8Array>,  __check_auth : this.txFromJson<Result<null, SmartAccountError>>,  get_policy_id : this.txFromJson<number>,  get_signer_id : this.txFromJson<number>,  remove_policy : this.txFromJson<void>,  remove_signer : this.txFromJson<void>,  add_context_rule : this.txFromJson<ContextRule>,  batch_add_signer : this.txFromJson<void>,  get_context_rule : this.txFromJson<ContextRule>,  remove_context_rule : this.txFromJson<void>,  get_context_rules_count : this.txFromJson<number>,  update_context_rule_name : this.txFromJson<ContextRule>,  update_context_rule_valid_until : this.txFromJson<ContextRule>
  };

  /** @deprecated Use fromJson instead. */
  public readonly fromJSON = this.fromJson;

  /**
   * Parse a raw contract event (topics + data) into a typed {@link ContractEvent}.
   */
  parseEvent(topics: xdr.ScVal[] | string[], data: xdr.ScVal | string): ContractEvent | undefined {
    return this.spec.parseEvent(topics, data) as ContractEvent | undefined;
  }
  /**
   * Build a topics filter row for the "PolicyAdded" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  policyAddedEventFilter(topicValues?: { context_rule_id?: number }): string[] {
    return this.spec.eventTopicFilter("PolicyAdded", topicValues);
  }
  /**
   * Build a topics filter row for the "SignerAdded" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  signerAddedEventFilter(topicValues?: { context_rule_id?: number }): string[] {
    return this.spec.eventTopicFilter("SignerAdded", topicValues);
  }
  /**
   * Build a topics filter row for the "PolicyRemoved" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  policyRemovedEventFilter(topicValues?: { context_rule_id?: number }): string[] {
    return this.spec.eventTopicFilter("PolicyRemoved", topicValues);
  }
  /**
   * Build a topics filter row for the "SignerRemoved" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  signerRemovedEventFilter(topicValues?: { context_rule_id?: number }): string[] {
    return this.spec.eventTopicFilter("SignerRemoved", topicValues);
  }
  /**
   * Build a topics filter row for the "ContextRuleAdded" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  contextRuleAddedEventFilter(topicValues?: { context_rule_id?: number }): string[] {
    return this.spec.eventTopicFilter("ContextRuleAdded", topicValues);
  }
  /**
   * Build a topics filter row for the "PolicyRegistered" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  policyRegisteredEventFilter(topicValues?: { policy_id?: number }): string[] {
    return this.spec.eventTopicFilter("PolicyRegistered", topicValues);
  }
  /**
   * Build a topics filter row for the "SignerRegistered" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  signerRegisteredEventFilter(topicValues?: { signer_id?: number }): string[] {
    return this.spec.eventTopicFilter("SignerRegistered", topicValues);
  }
  /**
   * Build a topics filter row for the "ContextRuleRemoved" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  contextRuleRemovedEventFilter(topicValues?: { context_rule_id?: number }): string[] {
    return this.spec.eventTopicFilter("ContextRuleRemoved", topicValues);
  }
  /**
   * Build a topics filter row for the "PolicyDeregistered" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  policyDeregisteredEventFilter(topicValues?: { policy_id?: number }): string[] {
    return this.spec.eventTopicFilter("PolicyDeregistered", topicValues);
  }
  /**
   * Build a topics filter row for the "SignerDeregistered" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  signerDeregisteredEventFilter(topicValues?: { signer_id?: number }): string[] {
    return this.spec.eventTopicFilter("SignerDeregistered", topicValues);
  }
  /**
   * Build a topics filter row for the "ContextRuleMetaUpdated" event, for use in `Api.EventFilter.topics` when calling `server.getEvents`. Omitted fields match any value.
   */
  contextRuleMetaUpdatedEventFilter(topicValues?: { context_rule_id?: number }): string[] {
    return this.spec.eventTopicFilter("ContextRuleMetaUpdated", topicValues);
  }
}
