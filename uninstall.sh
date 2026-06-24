#!/usr/bin/env bash
# axon uninstaller

set -euo pipefail
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'
ok()   { echo -e "  ${GREEN}✓${NC} $*"; }
skip() { echo -e "  ${YELLOW}–${NC} $*"; }
hdr()  { echo -e "\n${DIM}[$*]${NC}"; }

hdr "Claude Code"
python3 - "$HOME/.claude/settings.json" <<'PY'
import json, sys, os
f = sys.argv[1]
if not os.path.exists(f): sys.exit(0)
d = json.load(open(f))
stops = d.get('hooks', {}).get('Stop', [])
changed = False
filtered = []
for group in stops:
    hooks = group.get('hooks', [])
    kept = [h for h in hooks if 'axon' not in h.get('command','')]
    if len(kept) != len(hooks):
        changed = True
    if kept:
        ng = dict(group)
        ng['hooks'] = kept
        filtered.append(ng)
if not changed:
    print("  – not installed")
    sys.exit(0)
d['hooks']['Stop'] = filtered
with open(f, 'w') as fh: json.dump(d, fh, indent=2)
print("  ✓ Stop hook removed")
PY

hdr "OpenCode"
python3 - "$HOME/.config/opencode/opencode.json" "$INSTALL_DIR/hooks/opencode/plugin" <<'PY'
import json, sys, os
cfg, path = sys.argv[1], sys.argv[2]
if not os.path.exists(cfg): sys.exit(0)
d = json.load(open(cfg))
before = list(d.get('plugin', []))
d['plugin'] = [p for p in before if p != path]
if d['plugin'] == before:
    print("  – not installed")
    sys.exit(0)
with open(cfg, 'w') as f: json.dump(d, f, indent=2)
print("  ✓ plugin removed")
PY

hdr "Codex CLI"
if [ -f "$HOME/.codex/hooks.json" ]; then
  python3 - "$HOME/.codex/hooks.json" <<'PY'
import json, sys, os
f = sys.argv[1]
if not os.path.exists(f): sys.exit(0)
d = json.load(open(f))
before = list(d.get('Stop', []))
d['Stop'] = [h for h in before if 'axon' not in h.get('command','')]
if d['Stop'] == before:
    print("  – not installed")
    sys.exit(0)
with open(f, 'w') as fh: json.dump(d, fh, indent=2)
print("  ✓ Stop hook removed")
PY
else
  skip "~/.codex not found"
fi

hdr "GitHub Copilot CLI"
COPILOT_HOOK="$HOME/.copilot/hooks/axon.json"
if [ -f "$COPILOT_HOOK" ]; then
  rm "$COPILOT_HOOK"
  ok "hook file removed"
else
  skip "not installed"
fi

hdr "Systemd Service"
if systemctl --user is-enabled axon.service &>/dev/null; then
  systemctl --user stop axon.service 2>/dev/null || true
  systemctl --user disable axon.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/axon.service"
  systemctl --user daemon-reload
  ok "service removed"
else
  skip "service not installed"
fi

echo -e "\n${GREEN}done.${NC}\n"
