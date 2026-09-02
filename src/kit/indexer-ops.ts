import base64url from "../base64url.js";
import type {
  IndexerClient,
  IndexedContractSummary,
  ContractDetailsResponse,
  WalletCandidateLookup,
} from "../indexer.js";

export async function discoverContractsByCredential(
  indexer: IndexerClient | null,
  credentialId: string
): Promise<IndexedContractSummary[] | null> {
  if (!indexer) return null;

  const hexCredentialId = normalizeCredentialIdToHex(credentialId);
  const result = await indexer.lookupByCredentialId(hexCredentialId);
  return result.contracts;
}

export async function discoverContractsByAddress(
  indexer: IndexerClient | null,
  address: string
): Promise<IndexedContractSummary[] | null> {
  if (!indexer) return null;
  const result = await indexer.lookupByAddress(address);
  return result.contracts;
}

export async function lookupWalletCandidates(
  indexer: IndexerClient | null,
  credentialId: string
): Promise<WalletCandidateLookup | null> {
  if (!indexer) return null;
  return indexer.lookupWalletCandidates(
    normalizeCredentialIdToHex(credentialId)
  );
}

export async function getContractDetailsFromIndexer(
  indexer: IndexerClient | null,
  contractId: string
): Promise<ContractDetailsResponse | null> {
  if (!indexer) return null;
  return indexer.getContractDetails(contractId);
}

function normalizeCredentialIdToHex(credentialId: string): string {
  if (/^[0-9a-fA-F]+$/.test(credentialId)) {
    return credentialId.toLowerCase();
  }

  try {
    const bytes = base64url.toBuffer(credentialId);
    return bytes.toString("hex");
  } catch {
    return credentialId.toLowerCase();
  }
}
