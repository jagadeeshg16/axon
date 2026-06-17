# axon

Captures conversations from Claude Code, OpenAI Codex CLI, GitHub Copilot CLI, and OpenCode into a shared log at `~/ai-chats/sessions/`.

## Log format

Each session gets its own JSONL file: `~/ai-chats/sessions/<tool>-<session_id>.jsonl`

Every line is one message:
```json
{"ts":"2026-06-12T10:30:00Z","tool":"claude","session":"ses_xxx","role":"user","content":"..."}
{"ts":"2026-06-12T10:30:05Z","tool":"claude","session":"ses_xxx","role":"assistant","content":"..."}
```

## How it works

Each tool's `Stop` / `sessionEnd` hook runs a script that reads the tool's transcript file and writes the conversation to the shared log. The session file is **overwritten** on each turn (not appended) to avoid duplicates, since Stop hooks fire per-turn.

## Setup

### Claude Code

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "/home/jagadeesh-12581/tools/axon/hooks/claude/on-stop.sh"
      }]
    }]
  }
}
```

### OpenAI Codex CLI

Replace `INSTALL_DIR` in `hooks/codex/hooks.json` with the actual path, then copy to `~/.codex/hooks.json`.

### GitHub Copilot CLI

Replace `INSTALL_DIR` in `hooks/copilot/session-end.json` with the actual path, then copy to `~/.copilot/hooks/axon.json`.

### OpenCode plugin

```bash
cd hooks/opencode/plugin
npm install
npm run build
```

Then add to your OpenCode config (`~/.config/opencode/config.json` or `opencode.json`):
```json
{
  "plugins": ["/home/jagadeesh-12581/tools/axon/hooks/opencode/plugin"]
}
```

## Environment

Override the log directory:
```bash
export AI_CHAT_LOG_DIR=~/my-chats
```

## To publish

```bash
cd /home/jagadeesh-12581/tools/axon
git init
git add .
git commit -m "initial commit"
gh repo create axon --public --source=. --push
```
