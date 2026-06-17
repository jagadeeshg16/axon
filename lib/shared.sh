#!/bin/bash
AI_CHAT_LOG_DIR="${AI_CHAT_LOG_DIR:-$HOME/ai-chats}"

session_file() {
  echo "${AI_CHAT_LOG_DIR}/sessions/${1}-${2}.jsonl"
}

append_message() {
  local file="$1" ts="$2" tool="$3" session="$4" role="$5" content="$6"
  mkdir -p "$(dirname "$file")"
  jq -cn \
    --arg ts "$ts" --arg tool "$tool" \
    --arg session "$session" --arg role "$role" --arg content "$content" \
    '{ts:$ts, tool:$tool, session:$session, role:$role, content:$content}' >> "$file"
}
