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

### Quick install

```bash
./install.sh --all
```

Use individual flags like `--claude`, `--opencode`, `--codex`, `--copilot`, `--service`, or `--ui` when you only want part of the setup.

### Claude Code

Add to `~/.claude/settings.json`:
```json
{
  "hooks": {
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "/path/to/axon/hooks/claude/on-stop.sh"
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
  "plugin": ["/path/to/axon/hooks/opencode/plugin"]
}
```

## Environment

Override the log directory:
```bash
export AI_CHAT_LOG_DIR=~/my-chats
```

Session Insights can use any connected provider. GitHub Copilot works through the existing Copilot sign-in flow; OpenAI and Claude API use environment keys:
```bash
# OpenAI API provider
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-5.5              # optional
export OPENAI_ORGANIZATION=org_...       # optional
export OPENAI_PROJECT=proj_...           # optional

# Claude API provider
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_MODEL=claude-sonnet-4-6 # optional
# CLAUDE_API_KEY is also accepted as an alias for ANTHROPIC_API_KEY.

# Run Insights automatically every 6 hours.
export AXON_INSIGHTS_CRON=1
```

`ANTHROPIC_VERSION` defaults to `2023-06-01` and can be overridden if Anthropic requires a newer API version for your account.

## To publish

```bash
cd /path/to/axon
git init
git add .
git commit -m "initial commit"
gh repo create axon --public --source=. --push
```
