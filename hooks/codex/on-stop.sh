#!/bin/bash
# OpenAI Codex CLI Stop hook — fires after every assistant turn.
# Overwrites the session file each time so there are no duplicates.
# stdin JSON: {session_id, transcript_path, cwd, hook_event_name, model, turn_id, ...}

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../lib/shared.sh
source "${SCRIPT_DIR}/../../lib/shared.sh"

input=$(cat)
session_id=$(echo "$input"      | jq -r '.session_id // empty')
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')

[[ -z "$session_id" || -z "$transcript_path" || ! -f "$transcript_path" ]] && exit 0

file=$(session_file "codex" "$session_id")
mkdir -p "$(dirname "$file")"
> "$file"

while IFS= read -r line; do
  # Codex transcript uses same schema as Claude Code
  type=$(echo "$line" | jq -r '.type // empty')
  ts=$(echo "$line"   | jq -r '.timestamp // empty')

  case "$type" in
    user)
      content=$(echo "$line" | jq -r '
        .content
        | if type == "array" then [.[] | select(.type=="text") | .text] | join("")
          else . end
        // ""
      ')
      [[ -n "$content" ]] && append_message "$file" "$ts" "codex" "$session_id" "user" "$content"
      ;;
    assistant)
      content=$(echo "$line" | jq -r '
        (.message.content // .content)
        | if type == "array" then [.[] | select(.type=="text") | .text] | join("")
          else . end
        // ""
      ')
      [[ -n "$content" ]] && append_message "$file" "$ts" "codex" "$session_id" "assistant" "$content"
      ;;
  esac
done < "$transcript_path"
