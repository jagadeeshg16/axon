#!/usr/bin/env node
import http from "http"
import fs from "fs"
import path from "path"
import { execFileSync } from "child_process"
import { fileURLToPath } from "url"

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const IMPORT_PY  = path.join(__dirname, "..", "lib", "import.py")
const LOG_DIR    = process.env.AI_CHAT_LOG_DIR ?? path.join(process.env.HOME, "ai-chats")
const SESSIONS_DIR = path.join(LOG_DIR, "sessions")
const PORT_HISTORY = path.join(LOG_DIR, "port-history.jsonl")
const SYNC_STATE   = path.join(LOG_DIR, "sync-state.json")
const DIRS_FILE    = path.join(LOG_DIR, "session-dirs.json")
const PORT         = process.env.PORT ?? 4242
const MCP_SERVER   = path.join(__dirname, "..", "mcp", "server.js")
const FEED_HISTORY = path.join(LOG_DIR, "feed-history.json")
const OPENCODE_CFG = path.join(process.env.HOME, ".config", "opencode", "opencode.json")

const MIME = {
  ".html": "text/html", ".css": "text/css",
  ".js": "application/javascript", ".json": "application/json",
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readJSONL(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

function appendJSONL(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(obj) + "\n")
}

function genSessionId() {
  const ts = Date.now().toString(16)
  const rnd = Math.random().toString(36).slice(2, 12)
  return `ses_${ts}fffe${rnd}`
}

function genUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

function encodeProjectDir(dir) {
  // ~/.claude/projects/ uses path with / replaced by - (leading / becomes empty)
  return dir.replace(/\//g, "-")
}

function loadDirs() {
  if (!fs.existsSync(DIRS_FILE)) return {}
  try { return JSON.parse(fs.readFileSync(DIRS_FILE, "utf8")) } catch { return {} }
}

// ── list all sessions ─────────────────────────────────────────────────────────

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return []
  const portHistory = readJSONL(PORT_HISTORY)
  const dirs = loadDirs()

  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => {
      const [tool, ...rest] = f.replace(".jsonl", "").split("-")
      const sessionId = rest.join("-")
      const messages = readJSONL(path.join(SESSIONS_DIR, f))
      if (!messages.length) return null

      const first = messages[0]
      const last = messages[messages.length - 1]
      const ports = portHistory.filter(p => p.session_id === sessionId)

      return {
        id: sessionId,
        tool,
        file: f,
        preview: (first.content ?? "").slice(0, 120),
        message_count: messages.length,
        ts_start: first.ts,
        ts_end: last.ts,
        ports,
        directory: dirs[`${tool}-${sessionId}`] ?? null,
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.ts_start) - new Date(a.ts_start))
}

// ── inject into target tool ───────────────────────────────────────────────────

function injectClaudeCode(messages, newSessionId, directory) {
  // NOTE: claude --resume requires cloud sync — injected files can't be resumed
  // that way. Instead we write a context file the user can load in a new session.
  const targetDir  = directory ?? process.env.HOME
  const encoded    = encodeProjectDir(targetDir)
  const projectDir = path.join(process.env.HOME, ".claude", "projects", encoded)
  fs.mkdirSync(projectDir, { recursive: true })
  const filePath   = path.join(projectDir, `${newSessionId}.jsonl`)

  // Read real version from an existing session so we match exactly
  let claudeVersion = "2.1.153"
  try {
    const existing = fs.readdirSync(path.join(process.env.HOME, ".claude", "projects"), { recursive: true })
      .filter(f => f.endsWith(".jsonl") && !f.includes(newSessionId))
    for (const rel of existing.slice(0, 10)) {
      const content = fs.readFileSync(
        path.join(process.env.HOME, ".claude", "projects", rel), "utf8")
        .split("\n").find(l => l.includes('"version"'))
      if (content) {
        const m = content.match(/"version":"([^"]+)"/)
        if (m && m[1] !== "1.0.0") { claudeVersion = m[1]; break }
      }
    }
  } catch {}

  // Header entries — exactly what Claude Code writes at session start
  const snapshotId = genUUID()
  const nowIso = new Date().toISOString()
  const header = [
    { type: "agent-setting",   agentSetting:   "claude",            sessionId: newSessionId },
    { type: "mode",            mode:            "normal",            sessionId: newSessionId },
    { type: "permission-mode", permissionMode: "bypassPermissions",  sessionId: newSessionId },
    { type: "file-history-snapshot", messageId: snapshotId,
      snapshot: { messageId: snapshotId, trackedFileBackups: {}, timestamp: nowIso },
      isSnapshotUpdate: false },
  ]

  function cleanContent(c) {
    if (typeof c !== "string") return c
    return c
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/gi, "")
      .replace(/<!--[\s\S]*?-->\s*/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }

  // Merge consecutive messages of the same role — API doesn't support them
  const merged = []
  for (const m of messages) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === m.role) {
      prev.content += "\n\n" + m.content
    } else {
      merged.push({ ...m })
    }
  }

  // Each message entry with all fields Claude Code needs to reconstruct API payload
  let prevUuid = null
  const lines = merged.map(m => {
    const uuid      = genUUID()
    const promptId  = genUUID()
    const msgId     = "msg_" + genUUID().replace(/-/g, "").slice(0, 24)
    const ts        = m.ts || new Date().toISOString()
    const entry = {
      parentUuid:  prevUuid,
      isSidechain: false,
      ...(m.role === "user" ? { promptId } : { requestId: "req_" + genUUID().replace(/-/g, "").slice(0, 24) }),
      type:        m.role,
      message: m.role === "user"
        ? { role: "user", content: cleanContent(m.content) }
        : {
            id:            msgId,
            type:          "message",
            role:          "assistant",
            content:       [{ type: "text", text: m.content }],
            model:         "claude-sonnet-4-6",
            stop_reason:   "end_turn",
            stop_sequence: null,
            usage: {
              input_tokens: 0, output_tokens: m.content.split(" ").length,
              cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            },
          },
      uuid,
      timestamp:   ts,
      ...(m.role === "user" ? { permissionMode: "bypassPermissions" } : {}),
      sessionKind: "interactive",
      userType:    "external",
      entrypoint:  "cli",
      cwd:         targetDir,
      sessionId:   newSessionId,
      version:     claudeVersion,
    }
    prevUuid = uuid
    return JSON.stringify(entry)
  })

  // Tail metadata — Claude Code uses lastPrompt + leafUuid for session picker display and dedup
  const firstUserMsg = messages.find(m => m.role === "user")
  const lastPromptText = firstUserMsg ? cleanContent(firstUserMsg.content).slice(0, 200) : ""
  const leafUuid = prevUuid  // uuid of the last message entry
  const tail = [
    { type: "last-prompt", lastPrompt: lastPromptText, leafUuid, sessionId: newSessionId },
    { type: "ai-title",    aiTitle: lastPromptText.slice(0, 60),  sessionId: newSessionId },
  ]

  const all = [...header.map(h => JSON.stringify(h)), ...lines, ...tail.map(t => JSON.stringify(t))]
  fs.writeFileSync(filePath, all.join("\n") + "\n")
  return filePath
}

function injectOpenCode(messages, newSessionId, directory) {
  const dbPath = path.join(process.env.HOME, ".local", "share", "opencode", "opencode.db")
  if (!fs.existsSync(dbPath)) throw new Error("OpenCode DB not found")

  const targetDir = directory ?? process.env.HOME
  const tmpFile   = path.join(process.env.HOME, `.axon-inject-${newSessionId}.json`)
  fs.writeFileSync(tmpFile, JSON.stringify({ messages, session_id: newSessionId, directory: targetDir }))

  const script = `
import sqlite3, json, time, random, os, datetime

data       = json.load(open(${JSON.stringify(tmpFile)}))
messages   = data["messages"]
session_id = data["session_id"]
directory  = data["directory"]
os.unlink(${JSON.stringify(tmpFile)})

db = sqlite3.connect(${JSON.stringify(dbPath)})
db.execute("PRAGMA journal_mode=WAL")
now   = int(time.time() * 1000)
title = (messages[0].get("content", "") or "Imported session")[:60]

ADJS  = ["tidy","brave","neon","eager","shiny","jolly","playful","quiet","swift","bold","calm","dark","warm","cool"]
NOUNS = ["tiger","mountain","falcon","cactus","lagoon","nebula","forest","orchid","river","hawk","stone","cloud"]
slug  = f"{random.choice(ADJS)}-{random.choice(NOUNS)}"
taken = {r[0] for r in db.execute("SELECT slug FROM session").fetchall()}
while slug in taken:
    slug = f"{random.choice(ADJS)}-{random.choice(NOUNS)}"

ver = (db.execute("SELECT version FROM session WHERE version IS NOT NULL ORDER BY time_created DESC LIMIT 1").fetchone() or ("1.3.17",))[0]

db.execute("""
    INSERT OR IGNORE INTO session
      (id, project_id, directory, title, slug, version, time_created, time_updated)
    VALUES (?,?,?,?,?,?,?,?)
""", (session_id, "global", directory, title, slug, ver, now, now))

for i, msg in enumerate(messages):
    try:
        ts = int(datetime.datetime.fromisoformat(msg["ts"].replace("Z","+00:00")).timestamp() * 1000)
    except Exception:
        ts = now + i
    msg_id  = f"msg_{session_id[4:20]}_{i:04x}"
    part_id = f"part_{session_id[4:20]}_{i:04x}"
    if msg["role"] == "assistant":
        msg_data = json.dumps({
            "role": "assistant",
            "time": {"created": ts, "completed": ts + 1000},
            "tokens": {"input": 0, "output": len(msg["content"].split()), "reasoning": 0,
                       "cache": {"read": 0, "write": 0}},
            "modelID": "claude-sonnet-4-6",
            "providerID": "anthropic",
            "agent": "general",
            "mode": "general",
            "finish": "end_turn",
            "path": {"cwd": directory, "root": directory},
            "cost": 0,
        })
    else:
        msg_data = json.dumps({"role": "user", "time": {"created": ts}})
    db.execute("INSERT OR IGNORE INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
               (msg_id, session_id, ts, ts, msg_data))
    db.execute("INSERT OR IGNORE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
               (part_id, msg_id, session_id, ts, ts,
                json.dumps({"type": "text", "text": msg["content"], "time": {"start": ts, "end": ts}})))

db.commit()
db.close()
print("ok")
`
  execFileSync("python3", ["-c", script])
}


function injectCodex(messages, newSessionId) {
  const d = new Date()
  const dateDir = path.join(
    process.env.HOME, ".codex", "sessions",
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  )
  fs.mkdirSync(dateDir, { recursive: true })
  const file = path.join(dateDir, `rollout-${newSessionId}.jsonl`)
  const lines = messages.map(m => {
    if (m.role === "user") {
      return JSON.stringify({ type: "user", timestamp: m.ts, content: m.content })
    } else {
      return JSON.stringify({
        type: "assistant", timestamp: m.ts,
        message: { role: "assistant", content: [{ type: "text", text: m.content }] }
      })
    }
  })
  fs.writeFileSync(file, lines.join("\n") + "\n")
  return file
}

function buildContextFile(messages, ctxPath, fromTool) {
  // Full conversation history — no trimming. Passed via --append-system-prompt-file
  // so the AI has complete context without it appearing as chat bubbles.
  const lines = [
    `## Conversation history ported from ${fromTool}`,
    `The following is the complete prior conversation. Continue naturally from where it left off.\n`,
    "---\n",
  ]
  for (const m of messages) {
    const role = m.role === "user" ? "User" : "Assistant"
    lines.push(`**${role}:** ${m.content}\n`)
  }
  lines.push("---")
  fs.writeFileSync(ctxPath, lines.join("\n"))
  return ctxPath
}

function portSession(sessionId, fromTool, toTool, targetDir) {
  const srcFile = path.join(SESSIONS_DIR, `${fromTool}-${sessionId}.jsonl`)
  const messages = readJSONL(srcFile)
  if (!messages.length) throw new Error("Source session empty or not found")

  const dirs     = loadDirs()
  const sourceDir = targetDir || dirs[`${fromTool}-${sessionId}`] || process.env.HOME
  const newId    = toTool === "claude" ? genUUID() : genSessionId()

  // Inject into target tool's native storage
  if (toTool === "opencode") {
    injectClaudeCode(messages, newId, sourceDir)
    injectOpenCode(messages, newId, sourceDir)
  } else if (toTool === "codex") {
    injectCodex(messages, newId)
  }
  // Claude: no JSONL injection — cloud sync required; use context file + --session-id instead

  // Mirror into our sessions dir immediately (for UI without sync)
  const destFile = path.join(SESSIONS_DIR, `${toTool}-${newId}.jsonl`)
  fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  fs.writeFileSync(destFile,
    messages.map(m => JSON.stringify({ ...m, tool: toTool, session: newId })).join("\n") + "\n")

  // Claude & Copilot: write context file so AI knows the prior conversation
  let contextFile     = null
  let claudeSessionId = null

  if (toTool === "claude" && sourceDir) {
    claudeSessionId = genUUID()
    const ctxName   = `${claudeSessionId}-port-from-${fromTool}.md`
    contextFile     = buildContextFile(messages, path.join(sourceDir, ctxName), fromTool)
  }

  if (toTool === "copilot" && sourceDir) {
    const ctxName = `${newId}-port-from-${fromTool}.md`
    const ctxPath = path.join(sourceDir, ctxName)
    buildContextFile(messages, ctxPath, fromTool)
    contextFile   = ctxPath
  }

  // Persist full port record so UI can always reconstruct the command
  appendJSONL(PORT_HISTORY, {
    ts:               new Date().toISOString(),
    session_id:       sessionId,
    from_tool:        fromTool,
    to_tool:          toTool,
    new_session_id:   newId,
    claude_session_id: claudeSessionId,
    target_dir:       sourceDir,
    context_file:     contextFile,
    total_messages:   messages.length,
    sent_messages:    messages.length,
  })

  return {
    new_session_id:   newId,
    claude_session_id: claudeSessionId,
    context_file:     contextFile,
    target_dir:       sourceDir,
    total_messages:   messages.length,
    sent_messages:    messages.length,
  }
}

// ── import (calls lib/import.py) ──────────────────────────────────────────────

function runImport(tool, full = false) {
  const args = [IMPORT_PY, tool, ...(full ? ["--full"] : [])]
  const out = execFileSync("python3", args, { encoding: "utf8" })
  return JSON.parse(out.trim())
}

function getSyncState() {
  if (!fs.existsSync(SYNC_STATE)) return {}
  try { return JSON.parse(fs.readFileSync(SYNC_STATE, "utf8")) } catch { return {} }
}

// ── router ────────────────────────────────────────────────────────────────────

function respond(res, status, body) {
  const json = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" })
  res.end(json)
}

function parseBody(req) {
  return new Promise(resolve => {
    let b = ""
    req.on("data", c => b += c)
    req.on("end", () => { try { resolve(JSON.parse(b)) } catch { resolve({}) } })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  // sessions list
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    return respond(res, 200, listSessions())
  }

  // single session messages
  if (url.pathname.startsWith("/api/sessions/") && req.method === "GET") {
    const id   = url.pathname.split("/").pop()
    const tool = url.searchParams.get("tool")
    const file = path.join(SESSIONS_DIR, `${tool}-${id}.jsonl`)
    if (!fs.existsSync(file)) return respond(res, 404, { error: "Not found" })
    const msgs       = readJSONL(file)
    const allHistory = readJSONL(PORT_HISTORY)

    function enrichPort(p) {
      const ctxBase = p.context_file ? path.basename(p.context_file) : null
      return {
        ...p,
        resume_cmd:   p.to_tool === "claude" && p.claude_session_id && p.target_dir && ctxBase
          ? `cd ${p.target_dir} && claude --session-id ${p.claude_session_id} --append-system-prompt-file ${ctxBase}`
          : null,
        opencode_cmd: p.to_tool === "opencode" && p.target_dir
          ? `cd ${p.target_dir} && opencode --session ${p.new_session_id}`
          : null,
        copilot_cmd:  p.to_tool === "copilot" && p.target_dir && ctxBase
          ? `cd ${p.target_dir} && code ${ctxBase}`
          : p.to_tool === "copilot" && p.target_dir ? `cd ${p.target_dir} && code .` : null,
      }
    }

    // Ports FROM this session (we are the source)
    const portsFrom = allHistory.filter(p => p.session_id === id).map(enrichPort)

    // This session IS a ported destination — show command to open it
    // Matches on new_session_id (our tracking ID) or claude_session_id (the --session-id uuid)
    const portedHere = allHistory
      .filter(p => p.new_session_id === id || p.claude_session_id === id)
      .map(p => ({ ...enrichPort(p), _is_destination: true }))

    return respond(res, 200, { messages: msgs, ports: [...portsFrom, ...portedHere] })
  }

  // port a session to another tool
  if (url.pathname === "/api/port" && req.method === "POST") {
    const { session_id, from_tool, to_tool, target_dir } = await parseBody(req)
    try {
      respond(res, 200, portSession(session_id, from_tool, to_tool, target_dir))
    } catch (e) {
      respond(res, 500, { error: e.message })
    }
    return
  }

  // import/sync from a tool  { tool, full? }
  if (url.pathname === "/api/import" && req.method === "POST") {
    const { tool, full } = await parseBody(req)
    if (!tool) return respond(res, 400, { error: "tool required" })
    try {
      const result = runImport(tool, !!full)
      respond(res, 200, result)
    } catch (e) {
      respond(res, 500, { error: e.message })
    }
    return
  }

  // sync state (last import timestamps)
  if (url.pathname === "/api/sync-state" && req.method === "GET") {
    return respond(res, 200, getSyncState())
  }

  // ── MCP status: which tools have it installed ─────────────────────────────
  if (url.pathname === "/api/mcp/status" && req.method === "GET") {
    const status = {}
    // Claude Code
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".claude", "settings.json"), "utf8"))
      status.claude = !!(cfg?.mcpServers?.["axon"] || cfg?.mcp?.servers?.["axon"])
    } catch { status.claude = false }
    // OpenCode
    try {
      const cfg = JSON.parse(fs.readFileSync(OPENCODE_CFG, "utf8"))
      status.opencode = !!(cfg?.mcp?.["axon"])
    } catch { status.opencode = false }
    // VS Code (.vscode/mcp.json in HOME)
    try {
      const vscMcp = path.join(process.env.HOME, ".vscode", "mcp.json")
      const cfg = JSON.parse(fs.readFileSync(vscMcp, "utf8"))
      status.copilot = !!(cfg?.servers?.["axon"] || cfg?.inputs?.find?.(i => i.id?.includes("axon")))
    } catch { status.copilot = false }
    // Codex CLI
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".codex", "config.json"), "utf8"))
      status.codex = !!(cfg?.mcp?.["axon"])
    } catch { status.codex = false }
    return respond(res, 200, status)
  }

  // ── MCP install for a tool ────────────────────────────────────────────────
  if (url.pathname === "/api/mcp/install" && req.method === "POST") {
    const { tool } = await parseBody(req)
    try {
      if (tool === "claude") {
        // Patch ~/.claude/settings.json
        const cfgPath = path.join(process.env.HOME, ".claude", "settings.json")
        let cfg = {}
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) } catch {}
        cfg.mcpServers = cfg.mcpServers ?? {}
        cfg.mcpServers["axon"] = { command: "node", args: [MCP_SERVER] }
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
      } else if (tool === "opencode") {
        let cfg = {}
        try { cfg = JSON.parse(fs.readFileSync(OPENCODE_CFG, "utf8")) } catch {}
        cfg.mcp = cfg.mcp ?? {}
        cfg.mcp["axon"] = { type: "local", command: ["node", MCP_SERVER], enabled: true }
        fs.writeFileSync(OPENCODE_CFG, JSON.stringify(cfg, null, 2))
      } else if (tool === "copilot") {
        const vscDir = path.join(process.env.HOME, ".vscode")
        fs.mkdirSync(vscDir, { recursive: true })
        const vscMcp = path.join(vscDir, "mcp.json")
        let cfg = { servers: {} }
        try { cfg = JSON.parse(fs.readFileSync(vscMcp, "utf8")) } catch {}
        cfg.servers = cfg.servers ?? {}
        cfg.servers["axon"] = { command: "node", args: [MCP_SERVER] }
        fs.writeFileSync(vscMcp, JSON.stringify(cfg, null, 2))
      } else if (tool === "codex") {
        const codexDir = path.join(process.env.HOME, ".codex")
        fs.mkdirSync(codexDir, { recursive: true })
        const cfgPath = path.join(codexDir, "config.json")
        let cfg = {}
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) } catch {}
        cfg.mcp = cfg.mcp ?? {}
        cfg.mcp["axon"] = { command: "node", args: [MCP_SERVER] }
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
      } else {
        return respond(res, 400, { error: `Unknown tool: ${tool}` })
      }
      respond(res, 200, { ok: true })
    } catch (e) { respond(res, 500, { error: e.message }) }
    return
  }

  // ── AgentMemory feed ──────────────────────────────────────────────────────
  if (url.pathname === "/api/feed" && req.method === "POST") {
    const { session_id, tool, all } = await parseBody(req)
    try {
      const feedHistory = fs.existsSync(FEED_HISTORY)
        ? JSON.parse(fs.readFileSync(FEED_HISTORY, "utf8")) : {}

      const toFeed = all
        ? (fs.existsSync(SESSIONS_DIR)
          ? fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".jsonl")).map(f => {
              const [t, ...r] = f.replace(".jsonl","").split("-")
              return { tool: t, id: r.join("-") }
            })
          : [])
        : [{ tool, id: session_id }]

      const dirs = loadDirs()
      let fed = 0, skipped = 0
      const amUrl = process.env.AGENTMEMORY_URL ?? "http://localhost:3111"

      for (const { tool: t, id } of toFeed) {
        const key = `${t}-${id}`
        const msgs = readJSONL(path.join(SESSIONS_DIR, `${t}-${id}.jsonl`))
        if (!msgs.length) { skipped++; continue }

        // Skip if already fed AND no new messages since last feed
        if (feedHistory[key] && !all) {
          const lastFedAt  = new Date(feedHistory[key])
          const lastMsgAt  = new Date(msgs[msgs.length - 1]?.ts ?? 0)
          if (lastMsgAt <= lastFedAt) { skipped++; continue }
          // Has new messages since last feed — fall through to re-feed
        }

        const dir     = dirs[key] ?? null
        const first   = msgs.find(m => m.role === "user")?.content ?? ""
        const last    = [...msgs].reverse().find(m => m.role === "assistant")?.content ?? ""
        try {
          const r = await fetch(`${amUrl}/agentmemory/remember`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Conversation in ${t} (${dir ?? "unknown dir"}):\n\nQuestion: ${first.slice(0,300)}\n\nAnswer: ${last.slice(0,300)}`,
              type: "workflow",
              concepts: [t, dir, first.slice(0,50)].filter(Boolean),
              project: dir ?? t,
            }),
          })
          if (r.ok) {
            feedHistory[key] = new Date().toISOString()
            fed++
          }
        } catch { skipped++ }
      }

      fs.writeFileSync(FEED_HISTORY, JSON.stringify(feedHistory, null, 2))
      respond(res, 200, { fed, skipped })
    } catch (e) { respond(res, 500, { error: e.message }) }
    return
  }

  // ── Feed history (which sessions are in agentmemory) ──────────────────────
  if (url.pathname === "/api/feed/status" && req.method === "GET") {
    const fh = fs.existsSync(FEED_HISTORY)
      ? JSON.parse(fs.readFileSync(FEED_HISTORY, "utf8")) : {}
    return respond(res, 200, fh)
  }

  // static files
  let filePath = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname)
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, "public", "index.html")
  const ext = path.extname(filePath)
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "text/plain" })
  fs.createReadStream(filePath).pipe(res)
})

server.listen(PORT, () => {
  console.log(`axon UI → http://localhost:${PORT}`)
  console.log(`Sessions dir: ${SESSIONS_DIR}`)
})
