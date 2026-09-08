import { useCallback } from "react";
import type {
  SmartAccountKit,
  SelectedSigner,
  AssembledTransaction,
} from "smart-account-kit";
import type { Signer } from "smart-account-kit-bindings";
import type { LogFn } from "../types";
import { toSimpleResult, type SimpleTxResult } from "../utils/tx";

export interface MultiSignerSubmitOptions {
  /** Signers chosen in a SignerPicker; when present, always uses the multi path. */
  selectedSigners?: SelectedSigner[];
  /** Rule signers used to decide whether multi-sig is needed + to auto-build. */
  ruleSigners?: Signer[];
  /** Active credential id used when auto-building selected signers. */
  activeCredentialId?: string | null;
}

/**
 * Shared "sign + submit, routing through the multi-signer flow when needed"
 * helper used by both the rule builder and the rules panel. Normalizes the
 * SDK's {@link import("smart-account-kit").TransactionResult} into the demo's
 * simple `{ success, error }` shape.
 */
export function useMultiSignerSubmit(kit: SmartAccountKit, onLog: LogFn) {
  return useCallback(
    async (
      tx: AssembledTransaction<unknown>,
      options: MultiSignerSubmitOptions = {}
    ): Promise<SimpleTxResult> => {
      const { selectedSigners, ruleSigners, activeCredentialId } = options;

      // Single-passkey path: no explicit picker selection and the rule doesn't
      // require multiple / non-passkey signers.
      if (!selectedSigners) {
        if (!ruleSigners || !kit.multiSigners.needsMultiSigner(ruleSigners)) {
          return toSimpleResult(await kit.signAndSubmitAdmin(tx));
        }
      }

      const signers =
        selectedSigners ??
        kit.multiSigners.buildSelectedSigners(
          ruleSigners ?? [],
          activeCredentialId
        );
      return toSimpleResult(
        await kit.multiSigners.adminOperation(tx, signers, { onLog })
      );
    },
    [kit, onLog]
  );
}
