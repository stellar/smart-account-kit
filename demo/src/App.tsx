import { useState, useCallback } from "react";
import type { Buffer } from "buffer";
import type { ContextRule } from "smart-account-kit-bindings";
import { CONFIG, KNOWN_POLICIES, RECOGNIZED_POLICIES } from "./config";
import { useLog } from "./hooks/useLog";
import { useKit } from "./hooks/useKit";
import { useExternalWallets } from "./hooks/useExternalWallets";
import { useWalletSession } from "./hooks/useWalletSession";
import {
  ConfigPanel,
  ExternalWalletsPanel,
  PendingCredentialsPanel,
  WalletPanel,
  TransferPanel,
  ActivityLog,
  ContractPickerModal,
  AdvancedPanel,
  ContextRulesPanel,
  ContextRuleBuilder,
  SignerPicker,
} from "./components";

function App() {
  const { logs, log } = useLog();
  const {
    kit,
    configValid,
    accountWasmHash,
    setAccountWasmHash,
    webauthnVerifier,
    setWebauthnVerifier,
    pendingCredentials,
    refreshPending,
  } = useKit(log);

  const wallets = useExternalWallets(kit, log);
  const session = useWalletSession({ kit, log, webauthnVerifier, refreshPending });

  // Rule builder modal state
  const [ruleBuilderOpen, setRuleBuilderOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ContextRule | null>(null);
  const [contextRulesKey, setContextRulesKey] = useState(0);

  const handleAddRule = useCallback(() => {
    log("Opening context rule builder...");
    setEditingRule(null);
    setRuleBuilderOpen(true);
  }, [log]);

  const handleEditRule = useCallback(
    (rule: ContextRule) => {
      log(`Editing context rule ${rule.id}...`);
      setEditingRule(rule);
      setRuleBuilderOpen(true);
    },
    [log]
  );

  const handleRuleBuilderClose = useCallback(async () => {
    setRuleBuilderOpen(false);
    setEditingRule(null);
    await refreshPending();
  }, [refreshPending]);

  const handleRuleBuilderSuccess = useCallback(async () => {
    setContextRulesKey((prev) => prev + 1);
    session.refreshSigners();
    await refreshPending();
  }, [session, refreshPending]);

  return (
    <div className="container">
      <header>
        <h1>Smart Account Kit Demo</h1>
        <h2>Test WebAuthn passkey wallets on Stellar</h2>
      </header>

      <ConfigPanel
        accountWasmHash={accountWasmHash}
        setAccountWasmHash={setAccountWasmHash}
        webauthnVerifier={webauthnVerifier}
        setWebauthnVerifier={setWebauthnVerifier}
        configValid={configValid}
        hasRelayer={Boolean(kit?.relayer)}
        knownPolicies={KNOWN_POLICIES}
      />

      <ExternalWalletsPanel
        connectedWallets={wallets.connectedWallets}
        connectWallet={wallets.connectWallet}
        disconnectWallet={wallets.disconnectWallet}
        disconnectWalletByAddress={wallets.disconnectWalletByAddress}
        log={log}
      />

      {pendingCredentials.length > 0 && !session.isConnected && (
        <PendingCredentialsPanel
          pendingCredentials={pendingCredentials}
          loading={session.loading}
          onDeploy={session.deployPending}
          onDelete={session.deletePending}
        />
      )}

      <WalletPanel
        isConnected={session.isConnected}
        contractId={session.contractId}
        balance={session.balance}
        credentialId={session.credentialId}
        activeSigner={session.activeSigner}
        loading={session.loading}
        configValid={configValid}
        onCreate={session.createWallet}
        onConnect={session.connectExisting}
        onDisconnect={session.disconnect}
        onFund={session.fundWallet}
      />

      {session.isConnected && kit && (
        <ContextRulesPanel
          key={contextRulesKey}
          kit={kit}
          isConnected={session.isConnected}
          onLog={log}
          onAddRule={handleAddRule}
          onEditRule={handleEditRule}
          knownPolicies={RECOGNIZED_POLICIES}
          activeCredentialId={session.credentialId}
          connectedWallets={wallets.connectedWallets}
          connectWallet={wallets.connectWallet}
        />
      )}

      {session.isConnected && <TransferPanel loading={session.loading} onTransfer={session.requestTransfer} />}

      {session.isConnected && kit && (
        <AdvancedPanel
          kit={kit}
          allSigners={session.allSigners}
          activeCredentialId={session.credentialId}
          onLog={log}
        />
      )}

      <ActivityLog logs={logs} />

      {kit && (
        <ContextRuleBuilder
          kit={kit}
          isOpen={ruleBuilderOpen}
          onClose={handleRuleBuilderClose}
          onLog={log}
          onSuccess={handleRuleBuilderSuccess}
          editingRule={editingRule}
          availablePolicies={KNOWN_POLICIES}
          recognizedPolicies={RECOGNIZED_POLICIES}
          webauthnVerifierAddress={webauthnVerifier}
          ed25519VerifierAddress={CONFIG.ed25519VerifierAddress}
          activeCredentialId={session.credentialId}
          existingSigners={session.allSigners}
          pendingCredentials={pendingCredentials}
          connectedWallets={wallets.connectedWallets}
          connectWallet={wallets.connectWallet}
          disconnectWalletByAddress={wallets.disconnectWalletByAddress}
          addFromSecret={wallets.addFromSecret}
          addEd25519FromSecret={wallets.addEd25519FromSecret}
        />
      )}

      <SignerPicker
        isOpen={session.signerPickerOpen}
        onClose={session.cancelTransferSigners}
        availableSigners={session.allSigners}
        activeCredentialId={session.credentialId}
        onConfirm={session.confirmTransferSigners}
        title="Select Signers for Transfer"
        description={
          session.pendingTransfer
            ? `Choose which signers to use for transferring ${session.pendingTransfer.amount} XLM to ${session.pendingTransfer.recipient.slice(0, 10)}...`
            : "Choose which signers to use for this transaction."
        }
        connectedWallets={wallets.connectedWallets}
        connectWallet={wallets.connectWallet}
        disconnectWalletByAddress={wallets.disconnectWalletByAddress}
        addFromSecret={wallets.addFromSecret}
        addEd25519FromSecret={wallets.addEd25519FromSecret}
        canSignEd25519={
          kit
            ? (signer) =>
                signer.tag === "External" &&
                kit.externalSigners.canSignEd25519(signer.values[1] as Buffer)
            : undefined
        }
      />

      {session.showContractPicker && (
        <ContractPickerModal
          contracts={session.discoveredContracts}
          onSelect={session.selectContract}
          onCancel={session.cancelContractPicker}
        />
      )}
    </div>
  );
}

export default App;
