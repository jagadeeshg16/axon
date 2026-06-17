#!/bin/bash
# Claude Code Stop hook — fires after every assistant turn.
# Reads the project JSONL (which has full AI responses) not the simplified transcript.
# Overwrites the session file each time — Stop fires per turn, not per session.
#
# stdin JSON: { session_id, transcript_path, hook_event_name, ... }

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../lib/shared.sh
source "${SCRIPT_DIR}/../../lib/shared.sh"

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // empty')
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')

[[ -z "$session_id" ]] && exit 0

# ── locate the right file ─────────────────────────────────────────────────────
# transcript_path from the hook points to either:
#   ~/.claude/projects/<path>/<uuid>.jsonl  ← direct CLI session (full AI responses)
#   ~/.claude/transcripts/<ses_*>.jsonl     ← OpenCode session (no AI text, handled by OC plugin)
#
# Detect which by checking if the transcript contains "parentUuid" (project format).

src="$transcript_path"
[[ -z "$src" || ! -f "$src" ]] && exit 0

first_line=$(head -1 "$src" 2>/dev/null || echo "{}")
is_project_format=$(echo "$first_line" | jq -r 'if has("parentUuid") then "yes" else "no" end' 2>/dev/null || echo "no")

if [[ "$is_project_format" == "no" ]]; then
  # This is a simplified transcript (OpenCode session) — the OpenCode plugin
  # already captures it with full AI responses. Nothing to do here.
  exit 0
fi

# ── parse project-format JSONL ────────────────────────────────────────────────

file=$(session_file "claude" "$session_id")
> "$file"
mkdir -p "$(dirname "$file")"

python3 - "$src" "$session_id" <<'PY'
import sys, json

src, session_id = sys.argv[1], sys.argv[2]
LOG_DIR = __import__('os').environ.get("AI_CHAT_LOG_DIR",
          __import__('os.path', fromlist=['expanduser']).expanduser("~/ai-chats"))

out_path = f"{LOG_DIR}/sessions/claude-{session_id}.jsonl"
messages = []

with open(src) as f:
    for line in f:
        try: d = json.loads(line)
        except: continue

        if d.get("isSidechain"): continue
        t   = d.get("type", "")
        ts  = d.get("timestamp", "")
        content = d.get("message", {}).get("content", "")

        if t == "user":
            if isinstance(content, list):
                text_blocks = [b for b in content if b.get("type") == "text"]
                if not text_blocks: continue
                c = "".join(b.get("text","") for b in text_blocks)
            else:
                c = content or ""
            if c.strip():
                messages.append({"ts": ts, "tool": "claude", "session": session_id,
                                 "role": "user", "content": c})

        elif t == "assistant":
            if isinstance(content, list):
                c = "".join(b.get("text","") for b in content if b.get("type") == "text")
            else:
                c = content or ""
            if c.strip():
                messages.append({"ts": ts, "tool": "claude", "session": session_id,
                                 "role": "assistant", "content": c})

__import__('os').makedirs(__import__('os.path', fromlist=['dirname']).dirname(out_path), exist_ok=True)
with open(out_path, "w") as f:
    for m in messages:
        f.write(json.dumps(m) + "\n")
PY
