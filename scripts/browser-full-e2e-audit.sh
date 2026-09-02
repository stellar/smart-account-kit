#!/usr/bin/env bash

set -euo pipefail

SESSION_NAME="${SESSION_NAME:?SESSION_NAME is required}"
DEMO_URL="${DEMO_URL:-http://localhost:5173}"
INDEXER_DEMO_URL="${INDEXER_DEMO_URL:-http://localhost:5174}"
INDEXER_API_URL="${INDEXER_API_URL:-https://testnet.mercurydata.app/rest/smart-account-indexer}"
RECIPIENT_ADDRESS="${RECIPIENT_ADDRESS:-GAAH4OT36RRCCAGKARGPN2HLHT2NOBVFHO4GUHA6CF7UKQ4MMV24WQ4N}"
CALL_CONTRACT_ADDRESS="${CALL_CONTRACT_ADDRESS:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"
RULE_NAME="${RULE_NAME:-XLM Transfer Rule}"
UPDATED_RULE_NAME="${UPDATED_RULE_NAME:-XLM Transfer Rule V2}"

log_box() {
  agent-browser --session "$SESSION_NAME" get text .log-box 2>/dev/null || true
}

log_line_count() {
  # .log-box renders newest-first (demo/src/hooks/useLog.ts prepends entries).
  # Count via a normalized snapshot so this matches wait_for_new_log()'s own
  # counting exactly, independent of any trailing newline in the element text.
  printf '%s\n' "$(log_box)" | wc -l | tr -d ' '
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

wait_for_new_log() {
  local previous_count="$1"
  local success_pattern="$2"
  local failure_pattern="$3"
  local attempts="${4:-60}"

  for _ in $(seq 1 "$attempts"); do
    local all total new_count log
    # Newest entries are prepended, so lines added since previous_count are the
    # FIRST (total - previous_count) lines, not the tail. (BSD head on macOS has
    # no negative-count form, so compute the count explicitly.)
    all="$(log_box)"
    total="$(printf '%s\n' "$all" | wc -l | tr -d ' ')"
    new_count=$(( total - previous_count ))
    if (( new_count > 0 )); then
      log="$(printf '%s\n' "$all" | head -n "$new_count")"
    else
      log=""
    fi
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
    sleep 1
  done

  body_text
  return 1
}

wait_for_contract_rule_count() {
  local contract_id="$1"
  local expected_count="$2"
  local attempts="${3:-90}"

  for _ in $(seq 1 "$attempts"); do
    local response
    response="$(curl -sS "$INDEXER_API_URL/api/contract/$contract_id" || true)"
    if [[ -n "$response" ]] && ! printf '%s\n' "$response" | rg -q '"error":"Contract not found"'; then
      local count
      count="$(printf '%s\n' "$response" | jq -r '.summary.context_rule_count')"
      if [[ "$count" == "$expected_count" ]]; then
        printf '%s\n' "$response"
        return 0
      fi
    fi
    sleep 2
  done

  curl -sS "$INDEXER_API_URL/api/contract/$contract_id" || true
  return 1
}

js_string() {
  jq -Rn --arg v "$1" '$v'
}

click_button_contains() {
  local text="$1"
  local text_json
  text_json="$(js_string "$text")"
  agent-browser --session "$SESSION_NAME" eval "(() => {
    const match = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes($text_json));
    if (!match) throw new Error('Missing button containing: ' + $text_json);
    match.click();
    return match.textContent;
  })()" >/dev/null
}

click_modal_button_exact() {
  local text="$1"
  local text_json
  text_json="$(js_string "$text")"
  agent-browser --session "$SESSION_NAME" eval "(() => {
    const modal = document.querySelector('.modal-content');
    if (!modal) throw new Error('Missing modal');
    const match = Array.from(modal.querySelectorAll('button')).find((button) => button.textContent?.trim() === $text_json);
    if (!match) throw new Error('Missing modal button: ' + $text_json);
    match.click();
    return match.textContent;
  })()" >/dev/null
}

open_rule_builder() {
  click_button_contains "Add Rule"
  wait_for_body_pattern "Create Context Rule" "Failed to create rule" 15 >/dev/null
}

open_rule_for_action() {
  local rule_name="$1"
  local button_label="$2"
  local rule_name_json
  local button_label_json
  rule_name_json="$(js_string "$rule_name")"
  button_label_json="$(js_string "$button_label")"
  agent-browser --session "$SESSION_NAME" eval "(() => {
    const details = Array.from(document.querySelectorAll('details')).find((item) => item.textContent?.includes($rule_name_json));
    if (!details) throw new Error('Missing rule: ' + $rule_name_json);
    details.open = true;
    const button = Array.from(details.querySelectorAll('button')).find((item) => item.textContent?.includes($button_label_json));
    if (!button) throw new Error('Missing rule action: ' + $button_label_json);
    button.click();
    return button.textContent;
  })()" >/dev/null
}

set_rule_context_call_contract() {
  agent-browser --session "$SESSION_NAME" eval "(() => {
    const radio = document.querySelector('input[name=\"contextType\"][value=\"call_contract\"]');
    if (!radio) throw new Error('Missing call_contract radio');
    radio.click();
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()" >/dev/null
}

remove_modal_policy() {
  # The edit modal loads the rule's existing policies asynchronously (live
  # on-chain read via the typed policy clients in ContextRuleBuilder), so the
  # "Remove policy" control (PolicyConfigList) is not in the DOM the instant the
  # modal opens. Wait for it to render, then click.
  for _ in $(seq 1 30); do
    if agent-browser --session "$SESSION_NAME" find title "Remove policy" click >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for the edit modal's 'Remove policy' control" >&2
  return 1
}

enable_modal_expiration_days() {
  local days="$1"
  # Check "Set Expiration" with a native click (fires React's onChange), scoping
  # by label text and retrying: the accessible-name find raced the modal
  # re-render that fires when the policy is removed just before this, and
  # reported the checkbox as "not found".
  local result=""
  for _ in $(seq 1 20); do
    result="$(agent-browser --session "$SESSION_NAME" eval "(() => {
      const label = Array.from(document.querySelectorAll('.modal-content label')).find((item) => item.textContent?.includes('Set Expiration'));
      const box = label ? label.querySelector('input[type=\"checkbox\"]') : null;
      if (!box) return 'EXP_MISSING';
      if (!box.checked) box.click();
      return 'EXP_OK';
    })()" 2>/dev/null || true)"
    if printf '%s' "$result" | rg -q 'EXP_OK'; then break; fi
    sleep 1
  done
  if ! printf '%s' "$result" | rg -q 'EXP_OK'; then
    echo "Timed out enabling the 'Set Expiration' checkbox" >&2
    return 1
  fi
  sleep 1
  # Scope to the number field inside the 'Expires in:' label; set via the native
  # value setter so React's controlled-input tracker registers the change.
  agent-browser --session "$SESSION_NAME" eval "(() => {
    const label = Array.from(document.querySelectorAll('label')).find((item) => item.textContent?.includes('Expires in:'));
    const input = label ? label.querySelector('input[type=\"number\"]') : null;
    if (!input) throw new Error('Missing expiration input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, \"${days}\");
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.value;
  })()" >/dev/null
}

echo "Opening root demo"
agent-browser --session "$SESSION_NAME" open "$DEMO_URL" >/dev/null

USER_NAME="audit$(date +%s)"
echo "Creating wallet for $USER_NAME"
agent-browser --session "$SESSION_NAME" find placeholder "Enter username (optional)" fill "$USER_NAME"
CREATE_SNAP="$(snapshot)"
CREATE_REF="$(extract_ref 'button "Create Wallet" \[ref=(e[0-9]+)\]' "$CREATE_SNAP")"
agent-browser --session "$SESSION_NAME" click "@$CREATE_REF"

wait_for_log "Wallet deployed successfully!" "Failed to create wallet|Deployment failed" 120 >/dev/null
DEPLOY_LOG="$(log_box)"
CONTRACT_ID="$(printf '%s\n' "$DEPLOY_LOG" | sed -n 's/.*Contract address: //p' | head -n1)"
if [[ -z "$CONTRACT_ID" ]]; then
  echo "Missing contract address in deployment log" >&2
  exit 1
fi
echo "Deployed contract: $CONTRACT_ID"

echo "Disconnecting and reconnecting with passkey"
agent-browser --session "$SESSION_NAME" find role button click --name "Disconnect" >/dev/null
wait_for_body_pattern "Connect Existing" "" 15 >/dev/null
agent-browser --session "$SESSION_NAME" find role button click --name "Connect Existing" >/dev/null
wait_for_log "Contract ID: $CONTRACT_ID" "Failed to connect" 120 >/dev/null

POST_RECONNECT_SNAP="$(snapshot)"
FUND_REF="$(extract_ref 'button "Fund Wallet \(Testnet\)" \[ref=(e[0-9]+)\]' "$POST_RECONNECT_SNAP")"
if [[ -z "$FUND_REF" ]]; then
  echo "Unable to locate Fund Wallet button after reconnect" >&2
  exit 1
fi

echo "Funding wallet"
FUND_LOG_COUNT="$(log_line_count)"
agent-browser --session "$SESSION_NAME" click "@$FUND_REF"
wait_for_new_log "$FUND_LOG_COUNT" "Funded smart wallet" "Funding failed" 120 >/dev/null

echo "Submitting baseline transfer"
BASELINE_TRANSFER_LOG_COUNT="$(log_line_count)"
TRANSFER_SNAP="$(snapshot)"
RECIPIENT_REF="$(extract_ref 'textbox "G\.\.\. or C\.\.\." \[ref=(e[0-9]+)\]' "$TRANSFER_SNAP")"
AMOUNT_REF="$(extract_ref 'textbox "10" \[ref=(e[0-9]+)\]' "$TRANSFER_SNAP")"
if [[ -z "$RECIPIENT_REF" || -z "$AMOUNT_REF" ]]; then
  echo "Unable to locate baseline transfer inputs" >&2
  printf '%s\n' "$TRANSFER_SNAP" >&2
  exit 1
fi
agent-browser --session "$SESSION_NAME" fill "@$RECIPIENT_REF" "$RECIPIENT_ADDRESS"
agent-browser --session "$SESSION_NAME" fill "@$AMOUNT_REF" "1"
TRANSFER_READY_SNAP="$(snapshot)"
TRANSFER_REF="$(extract_ref 'button "Send Transfer" \[ref=(e[0-9]+)\]' "$TRANSFER_READY_SNAP")"
if [[ -z "$TRANSFER_REF" ]]; then
  echo "Unable to locate baseline Send Transfer button" >&2
  printf '%s\n' "$TRANSFER_READY_SNAP" >&2
  exit 1
fi
agent-browser --session "$SESSION_NAME" click "@$TRANSFER_REF"
wait_for_new_log "$BASELINE_TRANSFER_LOG_COUNT" "Transfer successful" "Transfer failed" 120 >/dev/null

echo "Creating call-contract rule with threshold policy"
open_rule_builder
agent-browser --session "$SESSION_NAME" find placeholder "e.g., Primary Signers, Trading Bot, Daily Spending" fill "$RULE_NAME"
set_rule_context_call_contract
agent-browser --session "$SESSION_NAME" find placeholder "Contract address (C...)" fill "$CALL_CONTRACT_ADDRESS"
click_modal_button_exact "Add"
click_modal_button_exact "Add Policy"
wait_for_body_pattern "Required signatures:" "Failed to create rule" 15 >/dev/null
CREATE_RULE_LOG_COUNT="$(log_line_count)"
agent-browser --session "$SESSION_NAME" find role button click --name "Create Rule" >/dev/null
wait_for_new_log "$CREATE_RULE_LOG_COUNT" "Context rule \"$RULE_NAME\" created!" "Failed to create rule" 120 >/dev/null

echo "Waiting for rule creation to reach the indexer"
RULE_RESPONSE="$(wait_for_contract_rule_count "$CONTRACT_ID" 2 120)"
NEW_RULE_ID="$(printf '%s\n' "$RULE_RESPONSE" | jq -r '.summary.context_rule_ids[] | select(. != 0)' | head -n1)"
if [[ -z "$NEW_RULE_ID" ]]; then
  echo "Unable to resolve created rule ID" >&2
  printf '%s\n' "$RULE_RESPONSE" >&2
  exit 1
fi

echo "Submitting transfer through the call-contract rule"
CALL_RULE_TRANSFER_LOG_COUNT="$(log_line_count)"
POST_RULE_TRANSFER_SNAP="$(snapshot)"
RECIPIENT_REF="$(extract_ref 'textbox "G\.\.\. or C\.\.\." \[ref=(e[0-9]+)\]' "$POST_RULE_TRANSFER_SNAP")"
AMOUNT_REF="$(extract_ref 'textbox "10" \[ref=(e[0-9]+)\]' "$POST_RULE_TRANSFER_SNAP")"
if [[ -z "$RECIPIENT_REF" || -z "$AMOUNT_REF" ]]; then
  echo "Unable to locate post-rule transfer inputs" >&2
  printf '%s\n' "$POST_RULE_TRANSFER_SNAP" >&2
  exit 1
fi
agent-browser --session "$SESSION_NAME" fill "@$RECIPIENT_REF" "$RECIPIENT_ADDRESS"
agent-browser --session "$SESSION_NAME" fill "@$AMOUNT_REF" "1"
POST_RULE_READY_SNAP="$(snapshot)"
TRANSFER_REF="$(extract_ref 'button "Send Transfer" \[ref=(e[0-9]+)\]' "$POST_RULE_READY_SNAP")"
if [[ -z "$TRANSFER_REF" ]]; then
  echo "Unable to locate Send Transfer button after rule creation" >&2
  printf '%s\n' "$POST_RULE_READY_SNAP" >&2
  exit 1
fi
agent-browser --session "$SESSION_NAME" click "@$TRANSFER_REF"
wait_for_new_log "$CALL_RULE_TRANSFER_LOG_COUNT" "Transfer successful" "Transfer failed" 120 >/dev/null

echo "Editing the created rule"
open_rule_for_action "$RULE_NAME" "Edit Rule"
wait_for_body_pattern "Edit Context Rule" "Failed to update rule" 15 >/dev/null
# The edit modal pre-fills its fields a beat after the heading renders, so the
# rename can race the (already-populated) name input. Retry the fill until ready.
rename_filled=""
for _ in $(seq 1 20); do
  if agent-browser --session "$SESSION_NAME" find placeholder "e.g., Primary Signers, Trading Bot, Daily Spending" fill "$UPDATED_RULE_NAME" >/dev/null 2>&1; then
    rename_filled=1
    break
  fi
  sleep 1
done
if [[ -z "$rename_filled" ]]; then
  echo "Timed out filling the edit modal rule name" >&2
  exit 1
fi
remove_modal_policy
enable_modal_expiration_days 2
UPDATE_RULE_LOG_COUNT="$(log_line_count)"
agent-browser --session "$SESSION_NAME" find role button click --name "Update Rule" >/dev/null
wait_for_new_log "$UPDATE_RULE_LOG_COUNT" "Context rule \"$UPDATED_RULE_NAME\" updated!" "Failed to update rule" 120 >/dev/null

echo "Removing the edited rule"
agent-browser --session "$SESSION_NAME" eval 'window.confirm = () => true' >/dev/null
REMOVE_RULE_LOG_COUNT="$(log_line_count)"
open_rule_for_action "$UPDATED_RULE_NAME" "Remove Rule"
wait_for_new_log "$REMOVE_RULE_LOG_COUNT" "Context rule ${NEW_RULE_ID} removed successfully!" "Failed to remove rule" 120 >/dev/null
FINAL_RULE_RESPONSE="$(wait_for_contract_rule_count "$CONTRACT_ID" 1 120)"
FINAL_RULE_COUNT="$(printf '%s\n' "$FINAL_RULE_RESPONSE" | jq -r '.summary.context_rule_count')"
if [[ "$FINAL_RULE_COUNT" != "1" ]]; then
  echo "Expected final rule count of 1, got $FINAL_RULE_COUNT" >&2
  printf '%s\n' "$FINAL_RULE_RESPONSE" >&2
  exit 1
fi

ROOT_FINAL_LOG="$(log_box)"

echo "Opening indexer demo"
agent-browser --session "$SESSION_NAME" open "$INDEXER_DEMO_URL" >/dev/null
INDEXER_SNAP="$(snapshot)"
LOGIN_REF="$(extract_ref 'button "Find with Passkey" \[ref=(e[0-9]+)\]' "$INDEXER_SNAP")"
if [[ -z "$LOGIN_REF" ]]; then
  echo "Unable to locate Find with Passkey button" >&2
  printf '%s\n' "$INDEXER_SNAP" >&2
  exit 1
fi
agent-browser --session "$SESSION_NAME" click "@$LOGIN_REF"
# Wait for this wallet candidate. The demo never selects a candidate automatically.
wait_for_body_pattern "${CONTRACT_ID:0:8}...${CONTRACT_ID: -8}" "Authentication failed|Lookup failed|Indexer lookup failed|No contracts found for" 120 >/dev/null
agent-browser --session "$SESSION_NAME" eval \
  "document.querySelector('[data-contract-id=\"$CONTRACT_ID\"]')?.click()" >/dev/null
wait_for_body_pattern "Viewing details for ${CONTRACT_ID:0:8}" "Failed to load contract details" 120 >/dev/null

FINAL_BODY="$(body_text)"

echo "=== ROOT DEMO LOG ==="
printf '%s\n' "$ROOT_FINAL_LOG"

echo "=== INDEXER DEMO BODY ==="
printf '%s\n' "$FINAL_BODY"

echo "Full browser audit passed for contract $CONTRACT_ID"
