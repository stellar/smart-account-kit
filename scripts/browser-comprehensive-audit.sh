#!/usr/bin/env bash

set -euo pipefail

SESSION_NAME="${SESSION_NAME:?SESSION_NAME is required}"
DEMO_URL="${DEMO_URL:-http://localhost:5173}"
INDEXER_DEMO_URL="${INDEXER_DEMO_URL:-http://localhost:5174}"
INDEXER_API_URL="${INDEXER_API_URL:-https://testnet.mercurydata.app/rest/smart-account-indexer}"
RECIPIENT_ADDRESS="${RECIPIENT_ADDRESS:-CBSHV66WG7UV6FQVUTB67P3DZUEJ2KJ5X6JKQH5MFRAAFNFJUAJVXJYV}"
SKIP_INDEXER="${SKIP_INDEXER:-false}"

log_box() {
  agent-browser --session "$SESSION_NAME" get text .log-box 2>/dev/null || true
}

body_text() {
  agent-browser --session "$SESSION_NAME" get text body 2>/dev/null || true
}

snapshot() {
  agent-browser --session "$SESSION_NAME" snapshot -i
}

extract_ref() {
  local pattern="$1"
  local snap="$2"
  printf '%s\n' "$snap" | rg "$pattern" -or '$1' | head -n1
}

wait_for_snapshot_pattern() {
  local pattern="$1"
  local attempts="${2:-30}"

  for _ in $(seq 1 "$attempts"); do
    local snap
    snap="$(snapshot)"
    if printf '%s\n' "$snap" | rg -q "$pattern"; then
      printf '%s\n' "$snap"
      return 0
    fi
    sleep 1
  done

  snapshot
  return 1
}

wait_for_log() {
  local success_pattern="$1"
  local failure_pattern="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    local log
    log="$(log_box)"
    if [[ -n "$failure_pattern" ]] && printf '%s\n' "$log" | rg -q "$failure_pattern"; then
      printf '%s\n' "$log"
      return 2
    fi
    if printf '%s\n' "$log" | rg -q "$success_pattern"; then
      printf '%s\n' "$log"
      return 0
    fi
    sleep 2
  done

  log_box
  return 1
}

wait_for_body_pattern() {
  local success_pattern="$1"
  local failure_pattern="$2"
  local attempts="${3:-60}"

  for _ in $(seq 1 "$attempts"); do
    local body
    body="$(body_text)"
    if [[ -n "$failure_pattern" ]] && printf '%s\n' "$body" | rg -q "$failure_pattern"; then
      printf '%s\n' "$body"
      return 2
    fi
    if printf '%s\n' "$body" | rg -q "$success_pattern"; then
      printf '%s\n' "$body"
      return 0
    fi
    sleep 2
  done

  body_text
  return 1
}

wait_for_indexed_contract() {
  local contract_id="$1"
  local attempts="${2:-60}"

  for _ in $(seq 1 "$attempts"); do
    local response http_code body
    # Capture the HTTP status so a non-2xx (e.g. an indexer 500) is treated as
    # "not yet indexed" and retried, rather than mistaken for a real payload:
    # a 500 body is non-empty and isn't "Contract not found", so the old check
    # would have accepted it as indexed.
    response="$(curl -sS -w $'\n%{http_code}' "$INDEXER_API_URL/api/contract/$contract_id" || true)"
    http_code="${response##*$'\n'}"
    body="${response%$'\n'*}"
    if [[ "$http_code" =~ ^2[0-9][0-9]$ ]] && [[ -n "$body" ]] \
        && ! printf '%s\n' "$body" | rg -q '"error":"Contract not found"'; then
      printf '%s\n' "$body"
      return 0
    fi
    sleep 2
  done

  curl -sS "$INDEXER_API_URL/api/contract/$contract_id" || true
  return 1
}

echo "Opening root demo"
agent-browser --session "$SESSION_NAME" open "$DEMO_URL" >/dev/null

USER_NAME="audit$(date +%s)"
echo "Creating wallet for $USER_NAME"
agent-browser --session "$SESSION_NAME" find placeholder "Enter username (optional)" fill "$USER_NAME"
CREATE_SNAP="$(snapshot)"
CREATE_REF="$(extract_ref 'button "Create Wallet" \[ref=(e[0-9]+)\]' "$CREATE_SNAP")"
agent-browser --session "$SESSION_NAME" click "@$CREATE_REF"

wait_for_log "Wallet deployed successfully!" "Failed to create wallet|Deployment failed" 120
DEPLOY_LOG="$(log_box)"
CONTRACT_ID="$(printf '%s\n' "$DEPLOY_LOG" | sed -n 's/.*Contract address: //p' | head -n1)"
if [[ -z "$CONTRACT_ID" ]]; then
  echo "Missing contract address in deployment log" >&2
  exit 1
fi
echo "Deployed contract: $CONTRACT_ID"

POST_DEPLOY_SNAP="$(snapshot)"
FUND_REF="$(extract_ref 'button "Fund Wallet \(Testnet\)" \[ref=(e[0-9]+)\]' "$POST_DEPLOY_SNAP")"
if [[ -z "$FUND_REF" ]]; then
  echo "Unable to locate Fund Wallet button" >&2
  exit 1
fi

echo "Funding wallet"
agent-browser --session "$SESSION_NAME" click "@$FUND_REF"
wait_for_log "Funded smart wallet" "Funding failed" 120

TRANSFER_SNAP="$(snapshot)"
RECIPIENT_REF="$(extract_ref 'textbox "G\.\.\. or C\.\.\." \[ref=(e[0-9]+)\]' "$TRANSFER_SNAP")"
AMOUNT_REF="$(extract_ref 'textbox "10" \[ref=(e[0-9]+)\]' "$TRANSFER_SNAP")"
TRANSFER_REF="$(extract_ref 'button "Send Transfer".*ref=(e[0-9]+)\]' "$TRANSFER_SNAP")"
if [[ -z "$RECIPIENT_REF" || -z "$AMOUNT_REF" || -z "$TRANSFER_REF" ]]; then
  echo "Unable to locate transfer controls" >&2
  printf '%s\n' "$TRANSFER_SNAP" >&2
  exit 1
fi

echo "Submitting transfer"
agent-browser --session "$SESSION_NAME" fill "@$RECIPIENT_REF" "$RECIPIENT_ADDRESS"
agent-browser --session "$SESSION_NAME" fill "@$AMOUNT_REF" "1"
TRANSFER_READY_SNAP="$(wait_for_snapshot_pattern 'button "Send Transfer" \[ref=e[0-9]+\]' 15)"
TRANSFER_REF="$(extract_ref 'button "Send Transfer" \[ref=(e[0-9]+)\]' "$TRANSFER_READY_SNAP")"
agent-browser --session "$SESSION_NAME" click "@$TRANSFER_REF"

TRANSFER_STATUS=0
wait_for_log "Transfer successful" "Transfer failed" 120 || TRANSFER_STATUS=$?
TRANSFER_LOG="$(log_box)"
printf '%s\n' "$TRANSFER_LOG"

if [[ "$SKIP_INDEXER" == "true" ]]; then
  if [[ "$TRANSFER_STATUS" -ne 0 ]]; then
    exit 10
  fi
  exit 0
fi

echo "Waiting for indexer to catch up"
wait_for_indexed_contract "$CONTRACT_ID" 90 >/dev/null

CONTRACT_PAYLOAD="$(curl -sS "$INDEXER_API_URL/api/contract/$CONTRACT_ID")"
CREDENTIAL_ID_HEX="$(printf '%s\n' "$CONTRACT_PAYLOAD" | jq -r '.contextRules[0].signers[0].credential_id')"
if [[ -z "$CREDENTIAL_ID_HEX" || "$CREDENTIAL_ID_HEX" == "null" ]]; then
  echo "Unable to resolve credential ID for indexed contract" >&2
  printf '%s\n' "$CONTRACT_PAYLOAD" >&2
  exit 1
fi

echo "Opening indexer demo"
agent-browser --session "$SESSION_NAME" open "$INDEXER_DEMO_URL" >/dev/null
INDEXER_SNAP="$(snapshot)"
LOGIN_REF="$(extract_ref 'button "Find with Passkey" \[ref=(e[0-9]+)\]' "$INDEXER_SNAP")"
if [[ -z "$LOGIN_REF" ]]; then
  echo "Unable to locate Find with Passkey button" >&2
  printf '%s\n' "$INDEXER_SNAP" >&2
  exit 1
fi

echo "Logging into indexer demo"
agent-browser --session "$SESSION_NAME" click "@$LOGIN_REF"
PASSKEY_RESULT=0
PASSKEY_BODY=""
PASSKEY_BODY="$(wait_for_body_pattern "Viewing details for|Last activity: ledger" "Authentication failed|Lookup failed|Indexer lookup failed|No contracts found for credential ID" 120)" || PASSKEY_RESULT=$?

echo "Looking up exact fresh credential"
CREDENTIAL_INPUT_REF="$(extract_ref 'textbox "Credential ID \(Hex\):" \[ref=(e[0-9]+)\]' "$(snapshot)")"
LOOKUP_REF="$(extract_ref 'button "Lookup by Credential ID" \[ref=(e[0-9]+)\]' "$(snapshot)")"
if [[ -z "$CREDENTIAL_INPUT_REF" || -z "$LOOKUP_REF" ]]; then
  echo "Unable to locate credential lookup controls" >&2
  snapshot >&2
  exit 1
fi
agent-browser --session "$SESSION_NAME" fill "@$CREDENTIAL_INPUT_REF" "$CREDENTIAL_ID_HEX"
agent-browser --session "$SESSION_NAME" click "@$LOOKUP_REF"
CONTRACT_CARD=".contract-card[data-contract-id='$CONTRACT_ID']"
agent-browser --session "$SESSION_NAME" wait "$CONTRACT_CARD"
agent-browser --session "$SESSION_NAME" click "$CONTRACT_CARD"

INDEXER_RESULT=0
INDEXER_BODY="$(wait_for_body_pattern "$CONTRACT_ID" "Lookup failed|Indexer lookup failed|No contracts found" 120)" || INDEXER_RESULT=$?

echo "=== ROOT DEMO LOG ==="
printf '%s\n' "$TRANSFER_LOG"

echo "=== INDEXER PASSKEY BODY ==="
printf '%s\n' "$PASSKEY_BODY"
echo "=== INDEXER DEMO BODY ==="
printf '%s\n' "$INDEXER_BODY"

if [[ "$TRANSFER_STATUS" -ne 0 ]]; then
  exit 10
fi

if [[ "$PASSKEY_RESULT" -ne 0 ]]; then
  exit 11
fi

if [[ "$INDEXER_RESULT" -ne 0 ]]; then
  exit 12
fi

exit 0
