#!/usr/bin/env bash
# Prints the Slack message for a failed run as the GitHub output `payload`: one section per failed job,
# with the reason each job saved as $REASONS_DIR/<job>.txt.
set -euo pipefail

blocks=$(jq -n --arg repo "$REPOSITORY" --arg trigger "$TRIGGER" --arg commit "$COMMIT" --arg run "$RUN_URL" '[
  {type: "section", text: {type: "mrkdwn", text: ":red_circle: *E2E Tests failed*"}},
  {type: "section", fields: [
    {type: "mrkdwn", text: "*Repo:*\n\($repo)"},
    {type: "mrkdwn", text: "*Trigger:*\n\($trigger)"},
    {type: "mrkdwn", text: "*Commit:*\n`\($commit)`"},
    {type: "mrkdwn", text: "*Run:*\n<\($run)|View logs>"}
  ]}
]')

add_failed_job() {
  local label=$1 result=$2 job=$3
  [ "$result" = failure ] || return 0
  local reason
  reason=$(cat "$REASONS_DIR/$job.txt" 2>/dev/null || true)
  [ -n "$reason" ] || reason="Not captured, see the logs."
  local text
  text=$(printf '*%s failed:*\n```\n%s\n```' "$label" "$reason")
  blocks=$(jq --arg text "$text" '. + [{type: "section", text: {type: "mrkdwn", text: $text}}]' <<<"$blocks")
}

add_failed_job "Checks (typecheck and unit tests)" "$CHECKS_RESULT" checks
add_failed_job "Circle payout E2E" "$CIRCLE_RESULT" circle
add_failed_job "Managed wallet E2E (Kotlin signer, inbound and outbound)" "$MANAGED_WALLET_RESULT" managed-wallet

echo "payload=$(jq -c '{blocks: .}' <<<"$blocks")"
