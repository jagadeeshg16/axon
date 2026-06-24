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
import json, os, sys, sqlite3, re
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

def normalized_count(tool):
    return len(list(Path(SESSIONS_DIR).glob(f"{tool}-*.jsonl"))) if os.path.exists(SESSIONS_DIR) else 0

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

def session_has_role(tool, session_id, role):
    try:
        with open(our_file(tool, session_id)) as f:
            for line in f:
                try:
                    if json.loads(line).get("role") == role:
                        return True
                except:
                    continue
    except FileNotFoundError:
        pass
    return False

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def ts_from_ms(ms):
    if not ms: return ""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()

def ts_from_any(value):
    if value is None or value == "": return ""
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000 if value > 1e10 else value, tz=timezone.utc).isoformat()
    if isinstance(value, str):
        raw = value.strip()
        if not raw: return ""
        try:
            n = float(raw)
            return datetime.fromtimestamp(n / 1000 if n > 1e10 else n, tz=timezone.utc).isoformat()
        except:
            pass
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat()
        except:
            return ""
    return ""

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

def parse_claude_history_jsonl(path):
    """Parse ~/.claude/history.jsonl prompt metadata as a user-message fallback."""
    sessions = defaultdict(list)
    dirs = {}
    try:
        with open(path) as f:
            for line in f:
                try: d = json.loads(line)
                except: continue
                sid = str(d.get("sessionId") or "").strip()
                text = _clean_omo(d.get("display") or "")
                ts = ts_from_ms(d.get("timestamp"))
                if not sid or not text or not ts:
                    continue
                sessions[sid].append({"ts": ts, "tool": "claude", "session": sid, "role": "user", "content": text})
                if d.get("project") and sid not in dirs:
                    dirs[sid] = d.get("project")
    except Exception:
        pass

    for sid in sessions:
        sessions[sid].sort(key=lambda m: m.get("ts") or "")
    return sessions, dirs

def _codex_content_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for p in content:
            if not isinstance(p, dict):
                continue
            if p.get("type") in ("input_text", "output_text", "text"):
                chunks.append(p.get("text", ""))
        return "".join(chunks)
    return ""


def parse_codex_jsonl(path, session_id):
    """Convert current and legacy Codex CLI rollout JSONL into our message format."""
    messages = []
    try:
        with open(path) as f:
            for line in f:
                try: d = json.loads(line)
                except: continue
                t  = d.get("type", "")
                ts = d.get("timestamp", "")

                # Current Codex rollout format: top-level event with response_item payload.
                if t == "response_item":
                    payload = d.get("payload", {})
                    if payload.get("type") == "message" and payload.get("role") in ("user", "assistant"):
                        role = payload.get("role")
                        c = _clean_omo(_codex_content_text(payload.get("content")))
                        if role == "user" and c.lstrip().startswith(("<environment_context>", "<permissions instructions>")):
                            continue
                        if c.strip():
                            messages.append({"ts": ts, "tool": "codex", "session": session_id, "role": role, "content": c})
                    continue

                # Legacy Codex transcript format.
                if t == "user":
                    c = _clean_omo(_codex_content_text(d.get("content", "")))
                    if c.strip(): messages.append({"ts": ts, "tool": "codex", "session": session_id, "role": "user", "content": c})
                elif t == "assistant":
                    raw = d.get("message", {}).get("content") or d.get("content")
                    c = _clean_omo(_codex_content_text(raw))
                    if c.strip(): messages.append({"ts": ts, "tool": "codex", "session": session_id, "role": "assistant", "content": c})
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

    imported = skipped = history_imported = 0
    project_sids = set()
    for dirpath, _, filenames in os.walk(projects_root):
        for fname in filenames:
            if not fname.endswith(".jsonl"): continue
            sid  = fname[:-6]   # UUID, e.g. "6a113614-ed76-43eb-8d3f-6a3970f7c089"
            path = os.path.join(dirpath, fname)
            project_sids.add(sid)
            if not full and is_fresh(path, "claude", sid) and session_has_role("claude", sid, "assistant"):
                skipped += 1; continue
            msgs = parse_claude_project_jsonl(path, sid)
            if write_session("claude", sid, msgs):
                # Extract cwd from first entry that has one
                cwd = next((json.loads(l).get("cwd") for l in open(path)
                            if "cwd" in l), None)
                if cwd: save_dir("claude", sid, cwd)
                imported += 1
            else: skipped += 1

    # Older Claude Code history may only exist in ~/.claude/history.jsonl.
    # It contains prompt metadata, not assistant responses, so use it only as a
    # fallback for sessions without a full project transcript.
    history_path = os.path.expanduser("~/.claude/history.jsonl")
    if os.path.exists(history_path):
        history_sessions, history_dirs = parse_claude_history_jsonl(history_path)
        for sid, msgs in history_sessions.items():
            if sid in project_sids:
                skipped += 1; continue
            if not full and is_fresh(history_path, "claude", sid):
                skipped += 1; continue
            if write_session("claude", sid, msgs):
                save_dir("claude", sid, history_dirs.get(sid))
                imported += 1
                history_imported += 1
            else:
                skipped += 1

    available = normalized_count("claude")
    state = load_state()
    state["claude"] = {"last_sync": now_iso(), "imported": imported, "available": available}
    save_state(state)
    return {"imported": imported, "skipped": skipped, "available": available, "history_fallback": history_imported}


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

    available = normalized_count("opencode")
    state = load_state()
    state["opencode"] = {"last_sync": now_iso(), "imported": imported, "available": available}
    save_state(state)
    return {"imported": imported, "skipped": skipped, "available": available}


def _codex_thread_meta():
    db_path = os.path.expanduser("~/.codex/state_5.sqlite")
    meta = {}
    if not os.path.exists(db_path):
        return meta
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            for sid, cwd, thread_source, source in conn.execute("SELECT id, cwd, thread_source, source FROM threads"):
                meta[sid] = {"cwd": cwd, "thread_source": thread_source, "source": source}
        finally:
            conn.close()
    except Exception:
        pass
    return meta


def _codex_session_id_from_filename(fname):
    base = fname[:-6]
    m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", base)
    if m:
        return m.group(1)
    return base.removeprefix("rollout-")


def import_codex(full=False):
    src = os.path.expanduser("~/.codex/sessions")
    if not os.path.exists(src):
        return {"imported": 0, "skipped": 0, "error": "~/.codex/sessions not found"}

    imported = skipped = 0
    meta = _codex_thread_meta()
    for root, _, files in os.walk(src):
        for fname in files:
            if not fname.endswith(".jsonl"): continue
            path = os.path.join(root, fname)
            sid  = _codex_session_id_from_filename(fname)
            info = meta.get(sid, {})
            if info.get("thread_source") == "subagent":
                skipped += 1; continue
            if not full and is_fresh(path, "codex", sid):
                skipped += 1; continue
            msgs = parse_codex_jsonl(path, sid)
            if write_session("codex", sid, msgs):
                save_dir("codex", sid, info.get("cwd"))
                imported += 1
            else: skipped += 1

    available = normalized_count("codex")
    state = load_state()
    state["codex"] = {"last_sync": now_iso(), "imported": imported, "available": available}
    save_state(state)
    return {"imported": imported, "skipped": skipped, "available": available}

# ── entrypoint ────────────────────────────────────────────────────────────────

def _copilot_workspace_cwd(workspace_path):
    try:
        for line in open(workspace_path):
            if line.startswith("cwd:"):
                cwd = line.split(":", 1)[1].strip()
                return cwd or None
    except:
        pass
    return None


def _vscode_workspace_cwd(workspace_path):
    try:
        data = json.load(open(workspace_path))
        folder = data.get("folder") or data.get("workspace")
        if isinstance(folder, str) and folder.startswith("file://"):
            from urllib.parse import unquote, urlparse
            return unquote(urlparse(folder).path)
        return folder
    except:
        return None


def _copilot_content(data):
    content = data.get("content") or data.get("transformedContent") or data.get("message") or data.get("text")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(item.get("text") or item.get("content") or "")
        return "".join(parts)
    if isinstance(content, dict):
        return content.get("text") or content.get("content") or ""
    return ""


def _copilot_messages_from_events(paths, fallback_sid):
    sid = fallback_sid
    messages = []
    for event_path in paths:
        try:
            lines = open(event_path)
        except:
            continue
        with lines:
            for line in lines:
                try:
                    event = json.loads(line)
                except:
                    continue
                typ = event.get("type")
                data = event.get("data") or {}
                if typ == "partition.created":
                    sid = data.get("conversationId") or sid
                elif typ == "session.start":
                    sid = data.get("sessionId") or sid

                role = None
                if typ == "user.message":
                    role = "user"
                elif typ == "assistant.message":
                    role = "assistant"
                else:
                    continue

                content = _copilot_content(data).strip()
                if not content:
                    continue
                ts = ts_from_any(event.get("timestamp")) or ts_from_any(data.get("createdAt")) or ts_from_any(data.get("startTime")) or now_iso()
                messages.append({"ts": ts, "tool": "copilot", "session": sid, "role": role, "content": content})
    return sid, messages


def _write_copilot_source(sid, messages, cwd, src_path, full):
    if not sid or not messages:
        return "skipped"
    if not full and is_fresh(str(src_path), "copilot", sid):
        return "skipped"
    if write_session("copilot", sid, messages):
        if cwd:
            save_dir("copilot", sid, cwd)
        return "imported"
    return "skipped"


def import_copilot(full=False):
    """
    Import Copilot histories from all known local stores:
    - ~/.copilot/session-store.db                 Copilot CLI / VS Code DB store
    - ~/.copilot/session-state/*/events.jsonl     VS Code Copilot agent event logs
    - ~/.copilot/jb/*/partition-*.jsonl           JetBrains Copilot chat partitions
    """
    imported = skipped = 0
    sources = {
        "session_store_db": {"imported": 0, "skipped": 0, "found": 0},
        "session_state": {"imported": 0, "skipped": 0, "found": 0},
        "jetbrains": {"imported": 0, "skipped": 0, "found": 0},
        "vscode_transcripts": {"imported": 0, "skipped": 0, "found": 0},
    }
    seen = set()

    def count(source, status):
        nonlocal imported, skipped
        sources[source][status] += 1
        if status == "imported":
            imported += 1
        else:
            skipped += 1

    db_path = Path(os.path.expanduser("~/.copilot/session-store.db"))
    if db_path.exists():
        conn = sqlite3.connect(db_path)
        try:
            sessions = conn.execute("SELECT id, cwd, created_at FROM sessions ORDER BY created_at").fetchall()
            sources["session_store_db"]["found"] = len(sessions)
            for (sid, cwd, created_at) in sessions:
                turns = conn.execute(
                    "SELECT user_message, assistant_response, timestamp FROM turns WHERE session_id=? ORDER BY turn_index",
                    (sid,)
                ).fetchall()

                messages = []
                for (user_msg, asst_msg, ts_raw) in turns:
                    ts = ts_from_any(ts_raw) or ts_from_any(created_at) or now_iso()
                    if user_msg:
                        messages.append({"ts": ts, "tool": "copilot", "session": sid, "role": "user", "content": user_msg})
                    if asst_msg:
                        messages.append({"ts": ts, "tool": "copilot", "session": sid, "role": "assistant", "content": asst_msg})

                status = _write_copilot_source(sid, messages, cwd, db_path, full)
                count("session_store_db", status)
                if messages:
                    seen.add(sid)
        finally:
            conn.close()

    state_root = Path(os.path.expanduser("~/.copilot/session-state"))
    if state_root.exists():
        state_dirs = [d for d in sorted(state_root.iterdir()) if d.is_dir()]
        sources["session_state"]["found"] = len(state_dirs)
        for session_dir in state_dirs:
            sid = session_dir.name
            if sid in seen:
                count("session_state", "skipped")
                continue
            events = session_dir / "events.jsonl"
            cwd = _copilot_workspace_cwd(session_dir / "workspace.yaml")
            sid, messages = _copilot_messages_from_events([events], sid)
            status = _write_copilot_source(sid, messages, cwd, events, full)
            count("session_state", status)
            if messages:
                seen.add(sid)

    jb_root = Path(os.path.expanduser("~/.copilot/jb"))
    if jb_root.exists():
        conv_dirs = [d for d in sorted(jb_root.iterdir()) if d.is_dir()]
        sources["jetbrains"]["found"] = len(conv_dirs)
        for conv_dir in conv_dirs:
            sid = conv_dir.name
            if sid in seen:
                count("jetbrains", "skipped")
                continue
            partitions = sorted(conv_dir.glob("partition-*.jsonl"))
            if not partitions:
                count("jetbrains", "skipped")
                continue
            sid, messages = _copilot_messages_from_events(partitions, sid)
            newest = max(partitions, key=lambda p: p.stat().st_mtime)
            status = _write_copilot_source(sid, messages, None, newest, full)
            count("jetbrains", status)
            if messages:
                seen.add(sid)

    vscode_root = Path(os.path.expanduser("~/.config/Code/User/workspaceStorage"))
    transcript_paths = sorted(vscode_root.glob("*/GitHub.copilot-chat/transcripts/*.jsonl")) if vscode_root.exists() else []
    sources["vscode_transcripts"]["found"] = len(transcript_paths)
    for transcript in transcript_paths:
        sid = transcript.stem
        if sid in seen:
            count("vscode_transcripts", "skipped")
            continue
        workspace_dir = transcript.parents[2]
        cwd = _vscode_workspace_cwd(workspace_dir / "workspace.json")
        sid, messages = _copilot_messages_from_events([transcript], sid)
        status = _write_copilot_source(sid, messages, cwd, transcript, full)
        count("vscode_transcripts", status)
        if messages:
            seen.add(sid)

    available = normalized_count("copilot")
    source_found = sum(s.get("found", 0) for s in sources.values())
    state = load_state()
    state["copilot"] = {
        "last_sync": now_iso(),
        "imported": imported,
        "available": available,
        "source_found": source_found,
        "sources": sources,
    }
    save_state(state)
    return {"imported": imported, "skipped": skipped, "available": available, "source_found": source_found, "sources": sources}


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
