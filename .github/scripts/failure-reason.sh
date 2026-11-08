#!/usr/bin/env bash
# Usage: failure-reason.sh <log> [variable names whose values to redact...]
# Prints the failure lines of a test log, for the report job's Slack message.
set -euo pipefail

log_file=$1
shift

if [ -f "$log_file" ]; then
  log=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log_file")
  reason=$(grep -E -A8 'Demo failed:|\(fail\)|^error:|^e: |^FAILURE:' <<<"$log" | head -30 || true)
  [ -n "$reason" ] || reason=$(tail -15 <<<"$log")
else
  reason="Failed before any test ran (install or setup)."
fi

# Slack doesn't mask secrets the way the Actions log does.
for name in "$@"; do
  secret=${!name:-}
  if [ -n "$secret" ]; then reason=${reason//"$secret"/<redacted>}; fi
done

printf '%s\n' "${reason:0:2500}"
