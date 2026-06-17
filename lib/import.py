#!/usr/bin/env python3
"""
Import/sync conversations from each AI tool into ~/ai-chats/sessions/.

Usage:
  python3 import.py claude                  # incremental sync
  python3 import.py opencode
  python3 import.py codex
  python3 import.py all
  python3 import.py claude --full           # full re-import (ignores existing)
  python3 import.py sync-state             # print sync state as JSON
"""
import json, os, sys, sqlite3
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict

LOG_DIR      = os.environ.get("AI_CHAT_LOG_DIR", os.path.expanduser("~/ai-chats"))
SESSIONS_DIR = os.path.join(LOG_DIR, "sessions")
SYNC_STATE   = os.path.join(LOG_DIR, "sync-state.json")
DIRS_FILE    = os.path.join(LOG_DIR, "session-dirs.json")

# ── state helpers ─────────────────────────────────────────────────────────────

def load_state():
    if os.path.exists(SYNC_STATE):
        try: return json.load(open(SYNC_STATE))
        except: pass
    return {}

def save_state(state):
    os.makedirs(os.path.dirname(SYNC_STATE), exist_ok=True)
    json.dump(state, open(SYNC_STATE, "w"), indent=2)

def our_file(tool, session_id):
    return os.path.join(SESSIONS_DIR, f"{tool}-{session_id}.jsonl")

def is_fresh(src_path, tool, session_id):
    """Return True if our copy is up-to-date (src not modified since we wrote it)."""
    dest = our_file(tool, session_id)
    if not os.path.exists(dest): return False
    return os.path.getmtime(src_path) <= os.path.getmtime(dest)

def load_dirs():
    if os.path.exists(DIRS_FILE):
        try: return json.load(open(DIRS_FILE))
        except: pass
    return {}

def save_dir(tool, session_id, directory):
    if not directory: return
    dirs = load_dirs()
    dirs[f"{tool}-{session_id}"] = directory
    os.makedirs(os.path.dirname(DIRS_FILE), exist_ok=True)
    json.dump(dirs, open(DIRS_FILE, "w"), indent=2)

def write_session(tool, session_id, messages):
    if not messages: return 0
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    with open(our_file(tool, session_id), "w") as f:
        for m in messages:
            f.write(json.dumps(m) + "\n")
    return len(messages)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def ts_from_ms(ms):
    if not ms: return ""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()

# ── parsers ───────────────────────────────────────────────────────────────────

def _extract_text(content) -> str:
    """Extract plain text from Claude message content (string or content-block list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            b.get("text", "") for b in content
            if b.get("type") == "text"
        )
    return ""

def _clean_omo(text: str) -> str:
    """Strip ALL oh-my-opencode / system injections — keep only real user↔AI content."""
    import re
    # XML-style blocks
    text = re.sub(r'<system-reminder>.*?</system-reminder>', '', text, flags=re.DOTALL)
    text = re.sub(r'<Work_Context>.*?</Work_Context>', '', text, flags=re.DOTALL)
    text = re.sub(r'<[A-Z][A-Z_]+>.*?</[A-Z][A-Z_]+>', '', text, flags=re.DOTALL)
    # [SYSTEM DIRECTIVE: ...] blocks — greedy until double newline or end
    text = re.sub(r'\[SYSTEM DIRECTIVE:.*?(?=\n\n|\Z)', '', text, flags=re.DOTALL)
    # HTML comments
    text = re.sub(r'<!--.*?-->', '', text, flags=re.DOTALL)
    # Oh-my-opencode bracket markers
    text = re.sub(r'\[(CONTEXT|GOAL|REQUEST|TASK|AGENT|PLAN|STEP|NOTE)\]:?\s*', '', text)
    # Sisyphus / orchestrator plan directives
    text = re.sub(r'\*\*STOP\. READ THIS.*?(?=\n\n|\Z)', '', text, flags=re.DOTALL)
    text = re.sub(r'##\s*(Notepad Location|Plan Location).*?(?=\n##|\Z)', '', text, flags=re.DOTALL)
    # Collapse excess whitespace
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

def parse_claude_project_jsonl(path, session_id):
    """
    Parse a ~/.claude/projects/<path>/<uuid>.jsonl file.

    Format (per line):
      {
        "type": "user" | "assistant" | "summary" | ...,
        "isSidechain": bool,
        "timestamp": "ISO",
        "message": {
          "role": "user" | "assistant",
          "content": "<string>" | [{"type":"text","text":"..."}, {"type":"tool_use",...}, ...]
        }
      }

    Rules:
    - Skip isSidechain=true  (subagent sidechains — separate sessions)
    - type="user":  content can be string or list; skip entries that are
                    ONLY tool_result blocks (those are tool outputs fed back,
                    not real user messages)
    - type="assistant": extract text blocks only; skip thinking + tool_use
    """
    messages = []
    try:
        with open(path) as f:
            for line in f:
                try: d = json.loads(line)
                except: continue

                if d.get("isSidechain"): continue
                t  = d.get("type", "")
                ts = d.get("timestamp", "")

                if t == "user":
                    content = d.get("message", {}).get("content", "")
                    if isinstance(content, list):
                        text_blocks = [b for b in content if b.get("type") == "text"]
                        if not text_blocks: continue
                        c = "".join(b.get("text", "") for b in text_blocks)
                    else:
                        c = content or ""
                    c = _clean_omo(c)
                    if c.strip():
                        messages.append({"ts": ts, "tool": "claude", "session": session_id, "role": "user", "content": c})

                elif t == "assistant":
                    raw = d.get("message", {}).get("content", [])
                    c = _clean_omo(_extract_text(raw))
                    if c.strip():
                        messages.append({"ts": ts, "tool": "claude", "session": session_id, "role": "assistant", "content": c})
    except Exception:
        pass
    return messages

def parse_codex_jsonl(path, session_id):
    """Convert a Codex CLI transcript JSONL into our message format."""
    messages = []
    try:
        with open(path) as f:
            for line in f:
                try: d = json.loads(line)
                except: continue
                t  = d.get("type", "")
                ts = d.get("timestamp", "")
                if t == "user":
                    c = d.get("content", "")
                    if isinstance(c, list):
                        c = "".join(p.get("text","") for p in c if p.get("type")=="text")
                    if c: messages.append({"ts": ts, "tool": "codex", "session": session_id, "role": "user", "content": c})
                elif t == "assistant":
                    raw = d.get("message", {}).get("content") or d.get("content")
                    if isinstance(raw, list):
                        c = "".join(p.get("text","") for p in raw if p.get("type")=="text")
                    else:
                        c = raw or ""
                    if c: messages.append({"ts": ts, "tool": "codex", "session": session_id, "role": "assistant", "content": c})
    except Exception:
        pass
    return messages

# ── importers ─────────────────────────────────────────────────────────────────

def import_claude(full=False):
    """
    Import from ~/.claude/projects/<encoded-path>/<uuid>.jsonl

    These are direct Claude Code CLI sessions — the only place AI text responses
    are stored. Filenames are UUIDs (not ses_* prefixes, those belong to OpenCode).
    """
    projects_root = os.path.expanduser("~/.claude/projects")
    if not os.path.exists(projects_root):
        return {"imported": 0, "skipped": 0, "error": "~/.claude/projects not found"}

    imported = skipped = 0
    for dirpath, _, filenames in os.walk(projects_root):
        for fname in filenames:
            if not fname.endswith(".jsonl"): continue
            sid  = fname[:-6]   # UUID, e.g. "6a113614-ed76-43eb-8d3f-6a3970f7c089"
            path = os.path.join(dirpath, fname)
            if not full and is_fresh(path, "claude", sid):
                skipped += 1; continue
            msgs = parse_claude_project_jsonl(path, sid)
            if write_session("claude", sid, msgs):
                # Extract cwd from first entry that has one
                cwd = next((json.loads(l).get("cwd") for l in open(path)
                            if "cwd" in l), None)
                if cwd: save_dir("claude", sid, cwd)
                imported += 1
            else: skipped += 1

    state = load_state()
    state["claude"] = {"last_sync": now_iso(), "imported": imported}
    save_state(state)
    return {"imported": imported, "skipped": skipped}


def import_opencode(full=False):
    db_path = os.path.expanduser("~/.local/share/opencode/opencode.db")
    if not os.path.exists(db_path):
        return {"imported": 0, "skipped": 0, "error": "~/.local/share/opencode/opencode.db not found"}

    imported = skipped = 0
    conn = sqlite3.connect(db_path)
    try:
        sessions = conn.execute(
            "SELECT id, time_updated FROM session ORDER BY time_created"
        ).fetchall()

        for (sid, time_updated) in sessions:
            dest = our_file("opencode", sid)
            if not full and os.path.exists(dest):
                # Skip if our file is newer than session's last_updated
                our_mtime_ms = os.path.getmtime(dest) * 1000
                if (time_updated or 0) <= our_mtime_ms:
                    skipped += 1; continue

            # Fetch messages + text parts in one query
            rows = conn.execute("""
                SELECT m.id, m.data, p.data
                FROM message m
                LEFT JOIN part p
                  ON p.message_id = m.id
                 AND json_extract(p.data,'$.type') = 'text'
                 AND (json_extract(p.data,'$.synthetic') IS NULL
                      OR json_extract(p.data,'$.synthetic') = 0)
                WHERE m.session_id = ?
                ORDER BY m.time_created, p.time_created
            """, (sid,)).fetchall()

            # Group text parts by message (preserve order)
            seen_msgs = {}
            msg_parts = defaultdict(list)
            for (mid, mdata_s, pdata_s) in rows:
                if mid not in seen_msgs:
                    try: seen_msgs[mid] = json.loads(mdata_s)
                    except: seen_msgs[mid] = {}
                if pdata_s:
                    try:
                        p = json.loads(pdata_s)
                        if p.get("text"): msg_parts[mid].append(p["text"])
                    except: pass

            messages = []
            for mid, mdata in seen_msgs.items():
                role = mdata.get("role", "assistant")
                ts   = ts_from_ms(mdata.get("time", {}).get("created"))
                text = _clean_omo("".join(msg_parts.get(mid, [])))
                if text:
                    messages.append({"ts": ts, "tool": "opencode", "session": sid, "role": role, "content": text})

            if write_session("opencode", sid, messages):
                # Get directory from the session table
                dir_row = conn.execute("SELECT directory FROM session WHERE id=?", (sid,)).fetchone()
                if dir_row: save_dir("opencode", sid, dir_row[0])
                imported += 1
            else: skipped += 1
    finally:
        conn.close()

    state = load_state()
    state["opencode"] = {"last_sync": now_iso(), "imported": imported}
    save_state(state)
    return {"imported": imported, "skipped": skipped}


def import_codex(full=False):
    src = os.path.expanduser("~/.codex/sessions")
    if not os.path.exists(src):
        return {"imported": 0, "skipped": 0, "error": "~/.codex/sessions not found"}

    imported = skipped = 0
    for root, _, files in os.walk(src):
        for fname in files:
            if not fname.endswith(".jsonl"): continue
            path = os.path.join(root, fname)
            sid  = fname[:-6].removeprefix("rollout-")
            if not full and is_fresh(path, "codex", sid):
                skipped += 1; continue
            msgs = parse_codex_jsonl(path, sid)
            if write_session("codex", sid, msgs): imported += 1
            else: skipped += 1

    state = load_state()
    state["codex"] = {"last_sync": now_iso(), "imported": imported}
    save_state(state)
    return {"imported": imported, "skipped": skipped}

# ── entrypoint ────────────────────────────────────────────────────────────────

def import_copilot(full=False):
    """
    Import from ~/.copilot/session-store.db (GitHub Copilot CLI / VS Code Copilot Chat).
    Schema: sessions(id, cwd, ...) + turns(id, session_id, user_message, assistant_response, timestamp)
    """
    db_path = os.path.expanduser("~/.copilot/session-store.db")
    if not os.path.exists(db_path):
        return {"imported": 0, "skipped": 0, "error": "~/.copilot/session-store.db not found"}

    imported = skipped = 0
    conn = sqlite3.connect(db_path)
    try:
        sessions = conn.execute("SELECT id, cwd, created_at FROM sessions ORDER BY created_at").fetchall()
        for (sid, cwd, created_at) in sessions:
            dest = our_file("copilot", sid)
            if not full and os.path.exists(dest):
                skipped += 1; continue

            turns = conn.execute(
                "SELECT user_message, assistant_response, timestamp FROM turns WHERE session_id=? ORDER BY turn_index",
                (sid,)
            ).fetchall()

            messages = []
            for (user_msg, asst_msg, ts_raw) in turns:
                try: ts = datetime.fromtimestamp(ts_raw / 1000 if ts_raw > 1e10 else ts_raw, tz=timezone.utc).isoformat()
                except: ts = now_iso()
                if user_msg:
                    messages.append({"ts": ts, "tool": "copilot", "session": sid, "role": "user", "content": user_msg})
                if asst_msg:
                    messages.append({"ts": ts, "tool": "copilot", "session": sid, "role": "assistant", "content": asst_msg})

            if write_session("copilot", sid, messages):
                if cwd: save_dir("copilot", sid, cwd)
                imported += 1
            else: skipped += 1
    finally:
        conn.close()

    state = load_state()
    state["copilot"] = {"last_sync": now_iso(), "imported": imported}
    save_state(state)
    return {"imported": imported, "skipped": skipped}


IMPORTERS = {"claude": import_claude, "opencode": import_opencode, "codex": import_codex, "copilot": import_copilot}

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "sync-state":
        print(json.dumps(load_state(), indent=2))
        sys.exit(0)

    tool = args[0]
    full = "--full" in args
    results = {}

    targets = list(IMPORTERS.keys()) if tool == "all" else [tool]
    for t in targets:
        if t in IMPORTERS:
            results[t] = IMPORTERS[t](full=full)
        else:
            results[t] = {"error": f"unknown tool: {t}"}

    print(json.dumps(results))
