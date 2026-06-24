#!/bin/bash
# GitHub Copilot CLI sessionEnd hook.
# stdin JSON: {sessionID, messages: [{role, content, timestamp}], ...}
# Note: verify exact stdin schema with `gh copilot` docs after install.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../lib/shared.sh
source "${SCRIPT_DIR}/../../lib/shared.sh"

input=$(cat)
session_id=$(echo "$input" | jq -r '.sessionID // .session_id // "unknown"')
ts_now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Copilot passes conversation as a messages array in the hook payload
has_messages=$(echo "$input" | jq 'has("messages")')
[[ "$has_messages" != "true" ]] && exit 0

file=$(session_file "copilot" "$session_id")
mkdir -p "$(dirname "$file")"
> "$file"

echo "$input" | jq -c '.messages[]?' | while IFS= read -r msg; do
  role=$(echo "$msg"    | jq -r '.role // empty')
  content=$(echo "$msg" | jq -r '.content // empty')
  ts=$(echo "$msg"      | jq -r '.timestamp // empty')
  [[ -z "$ts" ]] && ts="$ts_now"
  [[ -n "$role" && -n "$content" ]] && \
    append_message "$file" "$ts" "copilot" "$session_id" "$role" "$content"
done
