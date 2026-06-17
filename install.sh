#!/usr/bin/env bash
# axon installer
# Usage: ./install.sh [--claude] [--opencode] [--codex] [--copilot] [--all]

set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_HOOK="${INSTALL_DIR}/hooks/claude/on-stop.sh"
CODEX_HOOK="${INSTALL_DIR}/hooks/codex/on-stop.sh"
COPILOT_HOOK="${INSTALL_DIR}/hooks/copilot/on-session-end.sh"
OPENCODE_PLUGIN="${INSTALL_DIR}/hooks/opencode/plugin"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
skip() { echo -e "  ${YELLOW}–${NC} $*"; }
fail() { echo -e "  ${RED}✗${NC} $*"; }
hdr()  { echo -e "\n${DIM}[$*]${NC}"; }

# ── helpers ───────────────────────────────────────────────────────────────────

patch_json() {
  # patch_json <file> <python-expr-returning-dict>
  # Creates file if missing, deep-merges the patch
  local file="$1" patch="$2"
  python3 - "$file" "$patch" <<'PY'
import sys, json, os

file = sys.argv[1]
patch_code = sys.argv[2]

existing = {}
if os.path.exists(file):
    try:
        with open(file) as f:
            existing = json.load(f)
    except Exception:
        pass

def deep_merge(base, override):
    for k, v in override.items():
        if k in base and isinstance(base[k], dict) and isinstance(v, dict):
            deep_merge(base[k], v)
        elif k in base and isinstance(base[k], list) and isinstance(v, list):
            # Append only items not already present (by JSON equality)
            for item in v:
                if item not in base[k]:
                    base[k].append(item)
        else:
            base[k] = v
    return base

patch = eval(patch_code)
result = deep_merge(existing, patch)

os.makedirs(os.path.dirname(os.path.abspath(file)), exist_ok=True)
with open(file, 'w') as f:
    json.dump(result, f, indent=2)
print("ok")
PY
}

json_has() {
  # json_has <file> <python-bool-expr>
  python3 -c "
import json, sys, os
if not os.path.exists('$1'):
    sys.exit(1)
d = json.load(open('$1'))
sys.exit(0 if ($2) else 1)
" 2>/dev/null
}

# ── Claude Code ───────────────────────────────────────────────────────────────

install_claude() {
  hdr "Claude Code"
  local settings="$HOME/.claude/settings.json"

  if json_has "$settings" \
    "any(h.get('command','').endswith('axon/hooks/claude/on-stop.sh') for g in d.get('hooks',{}).get('Stop',[]) for h in g.get('hooks',[]))"; then
    skip "hook already installed"; return
  fi

  local patch
  patch=$(cat <<PYEXPR
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_HOOK}"
          }
        ]
      }
    ]
  }
}
PYEXPR
)
  patch_json "$settings" "$patch" > /dev/null
  ok "Stop hook added → ${settings}"
}

# ── OpenCode ──────────────────────────────────────────────────────────────────

install_opencode() {
  hdr "OpenCode"
  local cfg="$HOME/.config/opencode/opencode.json"

  # Build the plugin first
  if [ ! -f "${OPENCODE_PLUGIN}/dist/index.js" ]; then
    echo -e "  ${DIM}building TypeScript plugin...${NC}"
    if command -v npm &>/dev/null; then
      (cd "${OPENCODE_PLUGIN}" && npm install --silent && npm run build --silent) \
        && ok "plugin built" \
        || { fail "build failed — run: cd ${OPENCODE_PLUGIN} && npm install && npm run build"; return; }
    else
      skip "npm not found — build manually: cd ${OPENCODE_PLUGIN} && npm install && npm run build"
      return
    fi
  else
    ok "plugin already built"
  fi

  if json_has "$cfg" \
    "'${OPENCODE_PLUGIN}' in d.get('plugin', []) or ['${OPENCODE_PLUGIN}'] in d.get('plugin', [])"; then
    skip "plugin already registered"; return
  fi

  python3 - "$cfg" "$OPENCODE_PLUGIN" <<'PY'
import json, sys, os
cfg, plugin_path = sys.argv[1], sys.argv[2]
d = json.load(open(cfg)) if os.path.exists(cfg) else {}
d.setdefault('plugin', [])
if plugin_path not in d['plugin']:
    d['plugin'].append(plugin_path)
with open(cfg, 'w') as f:
    json.dump(d, f, indent=2)
print("ok")
PY
  ok "plugin registered → ${cfg}"
}

# ── Codex CLI ─────────────────────────────────────────────────────────────────

install_codex() {
  hdr "OpenAI Codex CLI"
  local hooks_file="$HOME/.codex/hooks.json"

  if [ ! -d "$HOME/.codex" ]; then
    skip "~/.codex not found — install Codex CLI first"
    return
  fi

  if json_has "$hooks_file" \
    "any(h.get('command','').endswith('axon/hooks/codex/on-stop.sh') for h in d.get('Stop',[]))"; then
    skip "hook already installed"; return
  fi

  python3 - "$hooks_file" "$CODEX_HOOK" <<'PY'
import json, sys, os
hfile, cmd = sys.argv[1], sys.argv[2]
d = json.load(open(hfile)) if os.path.exists(hfile) else {}
d.setdefault('Stop', [])
entry = {"type": "command", "command": cmd}
if entry not in d['Stop']:
    d['Stop'].append(entry)
os.makedirs(os.path.dirname(os.path.abspath(hfile)), exist_ok=True)
with open(hfile, 'w') as f:
    json.dump(d, f, indent=2)
print("ok")
PY
  ok "Stop hook added → ${hooks_file}"
}

# ── GitHub Copilot CLI ────────────────────────────────────────────────────────

install_copilot() {
  hdr "GitHub Copilot CLI"

  if ! command -v gh &>/dev/null; then
    skip "gh CLI not found — install GitHub CLI first"
    return
  fi

  local hooks_dir="$HOME/.copilot/hooks"
  local hook_file="${hooks_dir}/axon.json"
  mkdir -p "$hooks_dir"

  if [ -f "$hook_file" ] && python3 -c "
import json; d=json.load(open('${hook_file}'))
assert d.get('run','').endswith('axon/hooks/copilot/on-session-end.sh')
" 2>/dev/null; then
    skip "hook already installed"; return
  fi

  python3 -c "
import json
with open('${hook_file}','w') as f:
    json.dump({'event':'sessionEnd','run':'${COPILOT_HOOK}'}, f, indent=2)
"
  ok "sessionEnd hook added → ${hook_file}"
}

# ── flush (one-time backfill of existing sessions) ────────────────────────────

flush_import() {
  local tool="${1:-all}"
  local full="${2}"          # "" = incremental, "--full" = full re-import
  hdr "Flush: ${tool}"
  echo -e "  ${DIM}reading existing sessions from ${tool}...${NC}"
  local args=("${INSTALL_DIR}/lib/import.py" "$tool")
  [ -n "$full" ] && args+=("$full")
  result=$(python3 "${args[@]}" 2>&1) || {
    fail "import failed: $result"; return
  }
  # Print per-tool results
  echo "$result" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for tool,r in d.items():
    if 'error' in r:
        print(f'  \033[1;33m–\033[0m {tool}: {r[\"error\"]}')
    else:
        print(f'  \033[0;32m✓\033[0m {tool}: {r[\"imported\"]} imported, {r[\"skipped\"]} skipped')
" 2>/dev/null || echo "  result: $result"
}

# ── UI ────────────────────────────────────────────────────────────────────────

install_ui() {
  hdr "Web UI"
  echo -e "  ${DIM}Start with: cd ${INSTALL_DIR}/ui && node server.js${NC}"
  ok "ready at http://localhost:4242"
}

# ── systemd service ───────────────────────────────────────────────────────────

install_service() {
  hdr "Systemd Service (autostart)"

  local service_src="${INSTALL_DIR}/axon.service"
  local service_dst="$HOME/.config/systemd/user/axon.service"

  if [ ! -f "$service_src" ]; then
    fail "service file not found: ${service_src}"; return
  fi

  # Substitute INSTALL_DIR placeholder with actual path
  mkdir -p "$(dirname "$service_dst")"
  sed "s|INSTALL_DIR|${INSTALL_DIR}|g" "$service_src" > "$service_dst"

  systemctl --user daemon-reload
  systemctl --user enable axon.service 2>/dev/null
  systemctl --user restart axon.service

  ok "service installed → ${service_dst}"
  ok "autostart enabled — runs at login"
  echo -e "  ${DIM}systemctl --user status axon${NC}"
}

# ── parse args ────────────────────────────────────────────────────────────────

echo -e "\n${DIM}axon installer${NC}"
echo -e "${DIM}install dir: ${INSTALL_DIR}${NC}"

if [ $# -eq 0 ]; then
  echo ""
  echo "Usage: ./install.sh [options]"
  echo ""
  echo "  --claude      Wire Claude Code Stop hook"
  echo "  --opencode    Build & register OpenCode plugin"
  echo "  --codex       Wire Codex CLI Stop hook"
  echo "  --copilot     Wire GitHub Copilot CLI sessionEnd hook"
  echo "  --all         Install everything (hooks + flush + service)"
  echo "  --flush       One-time full import of all existing sessions"
  echo "  --flush=tool  Import only: claude, opencode, or codex"
  echo "  --sync        Incremental sync (only new/changed sessions)"
  echo "  --service     Install & enable systemd autostart service"
  echo "  --ui          Show UI start instructions"
  echo ""
  exit 0
fi

DO_CLAUDE=0; DO_OC=0; DO_CODEX=0; DO_COPILOT=0; DO_UI=0; DO_SERVICE=0
DO_FLUSH=""; FLUSH_MODE="--full"

for arg in "$@"; do
  case "$arg" in
    --claude)      DO_CLAUDE=1 ;;
    --opencode)    DO_OC=1 ;;
    --codex)       DO_CODEX=1 ;;
    --copilot)     DO_COPILOT=1 ;;
    --ui)          DO_UI=1 ;;
    --service)     DO_SERVICE=1 ;;
    --flush)       DO_FLUSH="all";  FLUSH_MODE="--full" ;;
    --flush=*)     DO_FLUSH="${arg#--flush=}"; FLUSH_MODE="--full" ;;
    --sync)        DO_FLUSH="all";  FLUSH_MODE="" ;;
    --sync=*)      DO_FLUSH="${arg#--sync=}";  FLUSH_MODE="" ;;
    --all)         DO_CLAUDE=1; DO_OC=1; DO_CODEX=1; DO_COPILOT=1; DO_UI=1; DO_SERVICE=1; DO_FLUSH="all"; FLUSH_MODE="--full" ;;
    *) echo "unknown option: $arg"; exit 1 ;;
  esac
done

[ $DO_CLAUDE  -eq 1 ] && install_claude
[ $DO_OC      -eq 1 ] && install_opencode
[ $DO_CODEX   -eq 1 ] && install_codex
[ $DO_COPILOT -eq 1 ] && install_copilot
[ $DO_SERVICE -eq 1 ] && install_service
[ $DO_UI      -eq 1 ] && install_ui
[ -n "$DO_FLUSH" ]    && flush_import "$DO_FLUSH" "$FLUSH_MODE"

echo -e "\n${GREEN}done.${NC} Captured sessions → ~/ai-chats/sessions/\n"
