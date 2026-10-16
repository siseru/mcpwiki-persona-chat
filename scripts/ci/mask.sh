#!/usr/bin/env bash
# Registers environment-specific values with the GitHub Actions log masker (run first in every job that
# handles them). "::add-mask::" lines are consumed by the runner and never displayed; afterwards every
# occurrence of the value in logs is shown as ***. Sources: AWS_ACCOUNT_ID, ALARM_EMAIL, REDACT_EXTRA
# (comma-separated values or URLs; for URLs the host is masked, e.g. the wiki and WebSocket endpoints).
# See scripts/ci/redact.mjs for redacting piped output.
set -euo pipefail
count=0
mask() {
  local v="$1"
  if [ "${#v}" -ge 4 ]; then echo "::add-mask::$v"; count=$((count + 1)); fi
}
mask "${AWS_ACCOUNT_ID:-}"
mask "${ALARM_EMAIL:-}"
# ... and with punctuation dropped (the form CDK's EmailSubscription used in logical ids).
mask "$(printf '%s' "${ALARM_EMAIL:-}" | tr -cd 'A-Za-z0-9')"
IFS=',' read -ra extras <<< "${REDACT_EXTRA:-}"
for v in "${extras[@]}"; do
  v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
  if [[ "$v" == *://* ]]; then v="${v#*://}"; v="${v%%/*}"; fi
  mask "$v"
done
echo "mask: registered $count value(s)"
