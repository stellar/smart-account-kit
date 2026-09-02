/**
 * Smart Account Indexer Demo
 *
 * This demo shows how to:
 * 1. Request a passkey response
 * 2. Read the credential ID from the authentication response
 * 3. Query the indexer for unverified wallet candidates
 * 4. Display candidate activity without selecting one
 * 5. Let the user choose one candidate to inspect
 */

import { rpc, xdr, Address } from "@stellar/stellar-sdk";
import {
  MemoryStorage,
  SmartAccountKit,
  SimpleThresholdPolicyClient,
  SpendingLimitPolicyClient,
  WeightedThresholdPolicyClient,
  type PolicyClientDeps,
} from "smart-account-kit";
import {
  DEFAULT_ACCOUNT_WASM_HASH,
  DEFAULT_INDEXER_URL,
  DEFAULT_NETWORK_PASSPHRASE,
  DEFAULT_RPC_URL,
  DEFAULT_WEBAUTHN_VERIFIER_ADDRESS,
  DEFAULT_THRESHOLD_POLICY_ADDRESS,
  DEFAULT_SPENDING_LIMIT_POLICY_ADDRESS,
  DEFAULT_WEIGHTED_THRESHOLD_POLICY_ADDRESS,
  LEDGERS_PER_DAY,
  STROOPS_PER_XLM,
  truncateAddress,
} from "./constants";
import { escapeHtml } from "./html";

// Types
interface SmartAccountInfo {
  contractId: string;
  contextRuleCount: number;
  externalSignerCount: number;
  delegatedSignerCount: number;
  nativeSignerCount: number;
  firstSeenLedger: number;
  lastSeenLedger: number;
  contextRuleIds: number[];
  // Enriched data
  contractExists?: boolean;
}

interface SignerInfo {
  signer_type: string;
  signer_address: string | null;
  credential_id: string | null;
}

interface PolicyInfo {
  policy_address: string;
  install_params: any;
}

interface ContextRuleInfo {
  context_rule_id: number;
  signers: SignerInfo[];
  policies: PolicyInfo[];
}

interface ContractDetails {
  contractId: string;
  summary: SmartAccountInfo;
  contextRules: ContextRuleInfo[];
}

// State
let selectedContract: string | null = null;
let discoveredContracts: SmartAccountInfo[] = [];
let currentCredentialId: string | null = null;
let currentSignerAddress: string | null = null;
let authKit: SmartAccountKit | null = null;
let authKitConfigKey: string | null = null;

// DOM Elements
const authBtn = document.getElementById("auth-btn") as HTMLButtonElement;
const contractLookupBtn = document.getElementById("contract-lookup-btn") as HTMLButtonElement;
const lookupBtn = document.getElementById("lookup-btn") as HTMLButtonElement;
const addressLookupBtn = document.getElementById("address-lookup-btn") as HTMLButtonElement;
const backBtn = document.getElementById("back-btn") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const contractsList = document.getElementById("contracts-list") as HTMLDivElement;
const contractDetailsSection = document.getElementById("contract-details-section") as HTMLDivElement;
const contractDetailsEl = document.getElementById("contract-details") as HTMLDivElement;
const contractIdInput = document.getElementById("contract-id") as HTMLInputElement;
const publicKeyInput = document.getElementById("public-key") as HTMLInputElement;
const stellarAddressInput = document.getElementById("stellar-address") as HTMLInputElement;
const indexerUrlInput = document.getElementById("indexer-url") as HTMLInputElement;
const rpcUrlInput = document.getElementById("rpc-url") as HTMLInputElement;

// Set default values from environment variables (with fallbacks)
indexerUrlInput.value = import.meta.env.VITE_INDEXER_URL || DEFAULT_INDEXER_URL;
rpcUrlInput.value = import.meta.env.VITE_RPC_URL || DEFAULT_RPC_URL;

// ============================================================================
// Utility Functions
// ============================================================================

function showStatus(message: string, type: "success" | "error" | "info") {
  statusEl.textContent = message;
  statusEl.className = type;
  statusEl.style.display = "block";
}

function hideStatus() {
  statusEl.style.display = "none";
}

function getAuthKit(): SmartAccountKit {
  const indexerAuthToken = import.meta.env.VITE_INDEXER_AUTH_TOKEN || undefined;
  const configKey = [
    rpcUrlInput.value,
    indexerUrlInput.value,
    indexerAuthToken,
    window.location.hostname,
  ].join("|");

  if (authKit && authKitConfigKey === configKey) {
    return authKit;
  }

  authKit = new SmartAccountKit({
    rpcUrl: rpcUrlInput.value,
    networkPassphrase:
      import.meta.env.VITE_NETWORK_PASSPHRASE || DEFAULT_NETWORK_PASSPHRASE,
    accountWasmHash:
      import.meta.env.VITE_ACCOUNT_WASM_HASH || DEFAULT_ACCOUNT_WASM_HASH,
    webauthnVerifierAddress:
      import.meta.env.VITE_WEBAUTHN_VERIFIER_ADDRESS ||
      DEFAULT_WEBAUTHN_VERIFIER_ADDRESS,
    storage: new MemoryStorage(),
    rpId: window.location.hostname,
    rpName: "Smart Account Indexer Demo",
    indexerUrl: indexerUrlInput.value,
    indexerAuthToken,
  });
  authKitConfigKey = configKey;
  return authKit;
}

// ============================================================================
// Policy Params (via typed policy clients)
// ============================================================================

type KnownPolicyType = "threshold" | "spending_limit" | "weighted_threshold";

/**
 * Map of known policy contract addresses -> type. Built from env (with testnet
 * defaults matching the root demo). Policies not in this map fall back to the
 * indexer's install_params (see formatPolicyParams).
 */
const POLICY_TYPES: Record<string, KnownPolicyType> = {};
function registerPolicyType(address: string | undefined, type: KnownPolicyType): void {
  if (address) POLICY_TYPES[address] = type;
}
registerPolicyType(
  import.meta.env.VITE_THRESHOLD_POLICY_ADDRESS || DEFAULT_THRESHOLD_POLICY_ADDRESS,
  "threshold"
);
registerPolicyType(
  import.meta.env.VITE_SPENDING_LIMIT_POLICY_ADDRESS || DEFAULT_SPENDING_LIMIT_POLICY_ADDRESS,
  "spending_limit"
);
registerPolicyType(
  import.meta.env.VITE_WEIGHTED_THRESHOLD_POLICY_ADDRESS || DEFAULT_WEIGHTED_THRESHOLD_POLICY_ADDRESS,
  "weighted_threshold"
);

/**
 * Build policy-client deps for read-only getters. Getters only need
 * rpc/network/timeout + the smart-account address; encodeContextRule and
 * execute (used by setters and weighted getSignerWeights) are not wired here
 * because this demo is a read-only viewer without a connected wallet client.
 */
function policyClientDeps(contractId: string): PolicyClientDeps {
  return {
    rpc: new rpc.Server(rpcUrlInput.value),
    networkPassphrase:
      import.meta.env.VITE_NETWORK_PASSPHRASE || DEFAULT_NETWORK_PASSPHRASE,
    timeoutInSeconds: 30,
    getSmartAccount: () => contractId,
    encodeContextRule: () => {
      throw new Error("encodeContextRule is not available in the read-only indexer demo");
    },
    execute: () => {
      throw new Error("execute is not available in the read-only indexer demo");
    },
  };
}

/**
 * Read live policy params via the SDK's typed policy clients
 * (get_threshold / get_spending_limit_data) for every recognized policy across
 * all context rules. Returns a Map keyed by "contextRuleId:policyAddress" with a
 * formatted display string.
 */
async function readTypedPolicyParams(
  contractId: string,
  contextRules: ContextRuleInfo[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const deps = policyClientDeps(contractId);

  const reads: Promise<void>[] = [];
  for (const rule of contextRules) {
    for (const policy of rule.policies ?? []) {
      const type = POLICY_TYPES[policy.policy_address];
      if (!type) continue;
      const mapKey = `${rule.context_rule_id}:${policy.policy_address}`;
      reads.push(
        (async () => {
          try {
            if (type === "threshold") {
              const threshold = await new SimpleThresholdPolicyClient(
                policy.policy_address,
                deps
              ).getThreshold(rule.context_rule_id);
              out.set(mapKey, `threshold: ${threshold}`);
            } else if (type === "spending_limit") {
              const data = await new SpendingLimitPolicyClient(
                policy.policy_address,
                deps
              ).getSpendingLimitData(rule.context_rule_id);
              const limitXlm = Number(data.spending_limit) / STROOPS_PER_XLM;
              const days = Math.round(Number(data.period_ledgers) / LEDGERS_PER_DAY);
              out.set(mapKey, `limit: ${limitXlm} XLM, period: ${days} day${days !== 1 ? "s" : ""}`);
            } else if (type === "weighted_threshold") {
              const threshold = await new WeightedThresholdPolicyClient(
                policy.policy_address,
                deps
              ).getThreshold(rule.context_rule_id);
              out.set(mapKey, `threshold: ${threshold}`);
            }
          } catch (error) {
            console.warn(
              `Typed policy read failed for ${type} ${policy.policy_address}:`,
              error
            );
          }
        })()
      );
    }
  }

  await Promise.all(reads);
  return out;
}

// ============================================================================
// Indexer Client
// ============================================================================

function getIndexerHeaders(): HeadersInit | undefined {
  const token = import.meta.env.VITE_INDEXER_AUTH_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

async function lookupContractsByCredentialId(
  credentialId: string
): Promise<SmartAccountInfo[]> {
  const indexerUrl = indexerUrlInput.value;
  const normalizedKey = credentialId.toLowerCase().replace(/^0x/, "");

  const response = await fetch(`${indexerUrl}/api/lookup/${normalizedKey}`, {
    headers: getIndexerHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Indexer lookup failed: ${response.statusText}`);
  }

  const data = await response.json();

  return data.contracts.map((c: any) => ({
    contractId: c.contract_id,
    contextRuleCount: parseInt(c.context_rule_count),
    externalSignerCount: parseInt(c.external_signer_count),
    delegatedSignerCount: parseInt(c.delegated_signer_count),
    nativeSignerCount: parseInt(c.native_signer_count || "0"),
    firstSeenLedger: parseInt(c.first_seen_ledger),
    lastSeenLedger: parseInt(c.last_seen_ledger),
    contextRuleIds: c.context_rule_ids,
  }));
}

async function lookupContractsByCredentialIdWithRetry(
  credentialId: string,
  options?: {
    attempts?: number;
    delayMs?: number;
  }
): Promise<SmartAccountInfo[]> {
  const attempts = options?.attempts ?? 20;
  const delayMs = options?.delayMs ?? 2000;

  let lastContracts: SmartAccountInfo[] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastContracts = await lookupContractsByCredentialId(credentialId);
    if (lastContracts.length > 0) {
      return lastContracts;
    }

    if (attempt < attempts) {
      showStatus(
        `Passkey response received. Waiting for indexer sync (${attempt}/${attempts - 1})...`,
        "info"
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return lastContracts;
}

async function lookupContractsByAddress(
  signerAddress: string
): Promise<SmartAccountInfo[]> {
  const indexerUrl = indexerUrlInput.value;

  const response = await fetch(`${indexerUrl}/api/lookup/address/${signerAddress}`, {
    headers: getIndexerHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Indexer lookup failed: ${response.statusText}`);
  }

  const data = await response.json();

  return data.contracts.map((c: any) => ({
    contractId: c.contract_id,
    contextRuleCount: parseInt(c.context_rule_count),
    externalSignerCount: parseInt(c.external_signer_count),
    delegatedSignerCount: parseInt(c.delegated_signer_count),
    nativeSignerCount: parseInt(c.native_signer_count || "0"),
    firstSeenLedger: parseInt(c.first_seen_ledger),
    lastSeenLedger: parseInt(c.last_seen_ledger),
    contextRuleIds: c.context_rule_ids,
  }));
}

async function getContractDetails(contractId: string): Promise<ContractDetails> {
  const indexerUrl = indexerUrlInput.value;

  const response = await fetch(`${indexerUrl}/api/contract/${contractId}`, {
    headers: getIndexerHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch contract details: ${response.statusText}`);
  }

  return await response.json();
}

async function lookupContractById(contractId: string): Promise<SmartAccountInfo> {
  const details = await getContractDetails(contractId);
  const summary = details.summary as any;
  return {
    contractId: summary.contract_id,
    contextRuleCount: parseInt(summary.context_rule_count),
    externalSignerCount: parseInt(summary.external_signer_count),
    delegatedSignerCount: parseInt(summary.delegated_signer_count),
    nativeSignerCount: parseInt(summary.native_signer_count || "0"),
    firstSeenLedger: parseInt(summary.first_seen_ledger),
    lastSeenLedger: parseInt(summary.last_seen_ledger),
    contextRuleIds: summary.context_rule_ids,
  };
}

async function enrichWithContractCheck(account: SmartAccountInfo): Promise<SmartAccountInfo> {
  const rpcUrl = rpcUrlInput.value;

  try {
    const server = new rpc.Server(rpcUrl);

    // Build the contract instance ledger key using XDR
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(account.contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );

    const response = await server.getLedgerEntries(ledgerKey);
    return {
      ...account,
      contractExists: (response.entries?.length ?? 0) > 0,
    };
  } catch (error) {
    console.warn("Failed to check contract:", error);
    return account;
  }
}

// ============================================================================
// UI Rendering
// ============================================================================

function renderContracts(contracts: SmartAccountInfo[]) {
  if (contracts.length === 0) {
    contractsList.innerHTML = `
      <div class="empty-state">
        No contracts found for this credential.
      </div>
    `;
    return;
  }

  contractsList.innerHTML = contracts
    .map(
      (contract, index) => {
        const isSelected = selectedContract === contract.contractId;
        return `
      <div class="contract-card ${isSelected ? "selected" : ""}"
           data-contract-id="${escapeHtml(contract.contractId)}"
           data-index="${index}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <div>
            <div class="contract-id">${escapeHtml(truncateAddress(contract.contractId))}</div>
            <div class="activity">Unverified indexer candidate</div>
            <div style="margin-top: 0.5rem; display: flex; gap: 1rem; flex-wrap: wrap;">
              <span class="activity">${contract.contextRuleCount} context rule${contract.contextRuleCount !== 1 ? 's' : ''}</span>
              <span class="activity">${contract.externalSignerCount + contract.delegatedSignerCount} signer${(contract.externalSignerCount + contract.delegatedSignerCount) !== 1 ? 's' : ''}</span>
            </div>
            <div class="activity" style="margin-top: 0.25rem;">
              Last activity: ledger ${contract.lastSeenLedger.toLocaleString()}
            </div>
          </div>
              ${isSelected && contract.contractExists !== undefined ?
            `<span class="${contract.contractExists ? 'balance' : 'activity'}" style="white-space: nowrap;">${contract.contractExists ? '✓ Instance visible' : '✗ Instance unavailable'}</span>`
            : ''}
        </div>
      </div>
    `;
      }
    )
    .join("");

  // Load details only after the user selects a candidate.
  document.querySelectorAll(".contract-card").forEach((card) => {
    card.addEventListener("click", async () => {
      const contractId = card.getAttribute("data-contract-id");
      if (contractId) {
        selectedContract = contractId;
        renderContracts(discoveredContracts);
        await viewContractDetails(contractId);
      }
    });
  });
}

async function renderContractDetails(details: ContractDetails) {
  const { contractId, contextRules } = details;

  // Hide contracts list section, show details section
  contractDetailsSection.style.display = "block";

  // Read live policy params via the SDK's typed policy clients
  const typedPolicyParams = await readTypedPolicyParams(contractId, contextRules);

  let html = `
    <div class="contract-full-id">${escapeHtml(contractId)}</div>
  `;

  // Render each context rule
  for (const rule of contextRules) {
    html += `
      <div class="context-rule">
        <h4>Context Rule #${escapeHtml(rule.context_rule_id)}</h4>
    `;

    // Group signers by type
    const externalSigners = rule.signers.filter((s: SignerInfo) => s.signer_type === 'External');
    const delegatedSigners = rule.signers.filter((s: SignerInfo) => s.signer_type === 'Delegated');
    const nativeSigners = rule.signers.filter((s: SignerInfo) => s.signer_type === 'Native');

    // Render External signers (passkeys) - group by verifier
    if (externalSigners.length > 0) {
      // Group by verifier address
      const byVerifier: Record<string, SignerInfo[]> = {};
      for (const signer of externalSigners) {
        const verifier = signer.signer_address || 'unknown';
        if (!byVerifier[verifier]) byVerifier[verifier] = [];
        byVerifier[verifier].push(signer);
      }

      for (const [verifier, signers] of Object.entries(byVerifier)) {
        html += `
          <div class="signer-group">
            <div class="signer-group-header">
              <span class="signer-type External">External</span>
              <span class="verifier-label">Verifier:</span>
              <span class="address-full">${escapeHtml(verifier)}</span>
            </div>
            <div class="signer-group-items">
        `;
        for (const signer of signers) {
          const matchesLookup = currentCredentialId && signer.credential_id?.toLowerCase() === currentCredentialId.toLowerCase();
          html += `
            <div class="credential-item ${matchesLookup ? 'highlight' : ''}">
              ${matchesLookup ? '<span class="match-badge">LOOKUP MATCH</span>' : ''}
              <span class="address-full">${escapeHtml(signer.credential_id)}</span>
            </div>
          `;
        }
        html += `
            </div>
          </div>
        `;
      }
    }

    // Render Delegated signers
    if (delegatedSigners.length > 0) {
      html += `
        <div class="signer-group">
          <div class="signer-group-header">
            <span class="signer-type Delegated">Delegated</span>
          </div>
          <div class="signer-group-items">
      `;
      for (const signer of delegatedSigners) {
        const matchesLookup = currentSignerAddress && signer.signer_address === currentSignerAddress;
        html += `
          <div class="credential-item ${matchesLookup ? 'highlight' : ''}">
            ${matchesLookup ? '<span class="match-badge">LOOKUP MATCH</span>' : ''}
            <span class="address-full">${escapeHtml(signer.signer_address)}</span>
          </div>
        `;
      }
      html += `
          </div>
        </div>
      `;
    }

    // Render Native signers
    if (nativeSigners.length > 0) {
      html += `
        <div class="signer-group">
          <div class="signer-group-header">
            <span class="signer-type Native">Native</span>
          </div>
          <div class="signer-group-items">
      `;
      for (const signer of nativeSigners) {
        const matchesLookup = currentSignerAddress && signer.signer_address === currentSignerAddress;
        html += `
          <div class="credential-item ${matchesLookup ? 'highlight' : ''}">
            ${matchesLookup ? '<span class="match-badge">LOOKUP MATCH</span>' : ''}
            <span class="address-full">${escapeHtml(signer.signer_address)}</span>
          </div>
        `;
      }
      html += `
          </div>
        </div>
      `;
    }

    // Render Policies
    if (rule.policies && rule.policies.length > 0) {
      html += `
        <div class="signer-group">
          <div class="signer-group-header">
            <span class="signer-type Policy">Policies</span>
          </div>
          <div class="signer-group-items">
      `;
      for (const policy of rule.policies) {
        // Prefer live params from the typed policy clients; fall back to the
        // indexer's install_params for unrecognized policy types.
        const mapKey = `${rule.context_rule_id}:${policy.policy_address}`;
        const params =
          typedPolicyParams.get(mapKey) ?? formatPolicyParams(policy.install_params);
        html += `
          <div class="credential-item">
            <span class="address-full">${escapeHtml(policy.policy_address)}</span>
            ${params ? `<span class="policy-params">${escapeHtml(params)}</span>` : ''}
          </div>
        `;
      }
      html += `
          </div>
        </div>
      `;
    }

    html += `</div>`;
  }

  contractDetailsEl.innerHTML = html;
}

function formatPolicyParams(params: any): string {
  if (!params || !params.map) return '';
  const parts: string[] = [];
  for (const item of params.map) {
    const key = item.key?.symbol;
    const val = item.val?.u32 ?? item.val?.i128;
    if (key && val !== undefined) {
      parts.push(`${key}: ${val}`);
    }
  }
  return parts.join(', ');
}

function hideContractDetails() {
  contractDetailsSection.style.display = "none";
}

// ============================================================================
// Event Handlers
// ============================================================================

authBtn.addEventListener("click", async () => {
  try {
    hideStatus();
    showStatus("Authenticating with passkey...", "info");
    const { credentialId: credentialIdBase64Url } =
      await getAuthKit().authenticatePasskey();

    showStatus("Passkey response received. Looking up candidates...", "info");

    // Reset selection for new lookup
    selectedContract = null;

    // Match the SDK flow: convert the returned credential ID into hex
    // for the indexer lookup API and UI display.
    const rawIdBytes = base64UrlToBytes(credentialIdBase64Url);
    const credentialIdHex = bytesToHex(rawIdBytes);

    // Store for highlighting in contract details
    currentCredentialId = credentialIdHex;
    currentSignerAddress = null;

    // Put it in the input for visibility
    publicKeyInput.value = credentialIdHex;

    // Automatically look up contracts
    discoveredContracts = await lookupContractsByCredentialIdWithRetry(credentialIdHex);

    if (discoveredContracts.length === 0) {
      showStatus(`No contracts found for credential ID: ${credentialIdHex.slice(0, 16)}...`, "info");
      renderContracts([]);
      return;
    }

    showStatus(`Found ${discoveredContracts.length} unverified candidate(s)`, "success");

    // Check if contracts still exist on-chain
    discoveredContracts = await Promise.all(
      discoveredContracts.map(enrichWithContractCheck)
    );

    // Wait for an explicit user selection before loading details.
    renderContracts(discoveredContracts);
  } catch (error) {
    console.error("Authentication error:", error);
    showStatus(`Authentication failed: ${(error as Error).message}`, "error");
  }
});

// Helper: Convert base64url to bytes
function base64UrlToBytes(base64url: string): Uint8Array {
  // Add padding if needed
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + padding;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Helper: Convert bytes to hex
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

lookupBtn.addEventListener("click", async () => {
  const credentialId = publicKeyInput.value.trim();

  if (!credentialId) {
    showStatus("Please enter a credential ID", "error");
    return;
  }

  try {
    hideStatus();
    showStatus("Looking up contracts...", "info");

    // Reset selection for new lookup
    selectedContract = null;

    // Store for highlighting in contract details
    currentCredentialId = credentialId.toLowerCase();
    currentSignerAddress = null;

    discoveredContracts = await lookupContractsByCredentialId(credentialId);

    if (discoveredContracts.length === 0) {
      showStatus("No contracts found for this public key", "info");
      renderContracts([]);
      return;
    }

    showStatus(`Found ${discoveredContracts.length} contract(s)`, "success");

    // Check if contracts still exist on-chain
    discoveredContracts = await Promise.all(
      discoveredContracts.map(enrichWithContractCheck)
    );

    // Wait for an explicit user selection before loading details.
    renderContracts(discoveredContracts);
  } catch (error) {
    console.error("Lookup error:", error);
    showStatus(`Lookup failed: ${(error as Error).message}`, "error");
  }
});

contractLookupBtn.addEventListener("click", async () => {
  const contractId = contractIdInput.value.trim();

  if (!contractId) {
    showStatus("Please enter a contract ID", "error");
    return;
  }

  try {
    hideStatus();
    showStatus(`Looking up contract ${truncateAddress(contractId)}...`, "info");

    selectedContract = contractId;
    currentCredentialId = null;
    currentSignerAddress = null;

    const contract = await lookupContractById(contractId);
    const enrichedContract = await enrichWithContractCheck(contract);
    discoveredContracts = [enrichedContract];

    renderContracts(discoveredContracts);
    await viewContractDetails(contractId);
  } catch (error) {
    console.error("Contract lookup error:", error);
    showStatus(`Lookup failed: ${(error as Error).message}`, "error");
    renderContracts([]);
    hideContractDetails();
  }
});

// Load indexed details. This action does not connect to a wallet.
async function viewContractDetails(contractId: string) {
  showStatus(`Loading contract details for ${truncateAddress(contractId)}...`, "info");

  try {
    const details = await getContractDetails(contractId);
    await renderContractDetails(details);
    showStatus(`Viewing details for ${truncateAddress(contractId)}`, "success");
  } catch (error) {
    console.error("Failed to get contract details:", error);
    showStatus(`Failed to load contract details: ${(error as Error).message}`, "error");
  }
}

addressLookupBtn.addEventListener("click", async () => {
  const address = stellarAddressInput.value.trim();

  if (!address) {
    showStatus("Please enter a Stellar address", "error");
    return;
  }

  try {
    hideStatus();
    showStatus("Looking up contracts by address...", "info");

    // Reset selection for new lookup
    selectedContract = null;

    // Track the address for highlighting, clear credential
    currentCredentialId = null;
    currentSignerAddress = address;

    discoveredContracts = await lookupContractsByAddress(address);

    if (discoveredContracts.length === 0) {
      showStatus("No contracts found for this address", "info");
      renderContracts([]);
      return;
    }

    showStatus(`Found ${discoveredContracts.length} contract(s)`, "success");

    // Check if contracts still exist on-chain
    discoveredContracts = await Promise.all(
      discoveredContracts.map(enrichWithContractCheck)
    );

    // Wait for an explicit user selection before loading details.
    renderContracts(discoveredContracts);
  } catch (error) {
    console.error("Address lookup error:", error);
    showStatus(`Lookup failed: ${(error as Error).message}`, "error");
  }
});

backBtn.addEventListener("click", () => {
  hideContractDetails();
  showStatus("", "info");
  hideStatus();
});
