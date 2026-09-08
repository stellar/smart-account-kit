import type { Signer } from "smart-account-kit-bindings";
import { truncateAddress, formatSignerForDisplay } from "../utils/sdk";

interface ActiveSignerDisplayProps {
  credentialId: string | null;
  activeSigner: Signer | null;
}

export function ActiveSignerDisplay({
  credentialId,
  activeSigner,
}: ActiveSignerDisplayProps) {
  if (!credentialId) {
    return null;
  }

  const signerInfo = activeSigner ? formatSignerForDisplay(activeSigner) : null;

  // Truncate credential ID for display (longer format)
  const displayCredentialId = credentialId.length > 32
    ? `${credentialId.slice(0, 32)}...`
    : credentialId;

  return (
    <div className="active-signer-display">
      <div className="active-signer-header">
        <span className="active-signer-label">Active Signer</span>
        <span className="active-signer-badge">
          {signerInfo?.type || "Passkey"}
        </span>
      </div>
      <div className="active-signer-details">
        <div className="detail-row">
          <span className="detail-label">Credential ID</span>
          <span className="detail-value monospace">{displayCredentialId}</span>
        </div>
        {activeSigner && signerInfo && (
          <div className="detail-row">
            <span className="detail-label">Verifier</span>
            <span className="detail-value monospace">
              {activeSigner.tag === "External"
                ? truncateAddress(activeSigner.values[0] as string, 8)
                : "Native"}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
