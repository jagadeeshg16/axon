#!/usr/bin/env node
/**
 * axon MCP Server
 * Exposes ~/ai-chats/sessions/ as queryable MCP tools + resources.
 *
 * Tools:  list_sessions, get_session, search_sessions
 * Resources: session://{tool}/{id}, sessions://recent
 */

import { Server }       from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import fs   from "fs"
import path from "path"
import { createHash } from "crypto"

const LOG_DIR      = process.env.AI_CHAT_LOG_DIR ?? path.join(process.env.HOME, "ai-chats")
const SESSIONS_DIR = path.join(LOG_DIR, "sessions")
const DIRS_FILE    = path.join(LOG_DIR, "session-dirs.json")
const MCP_HITS_FILE = path.join(LOG_DIR, "mcp-hits.jsonl")

const TOOLS = {
  claude:   { label: "Claude Code" },
  opencode: { label: "OpenCode" },
  codex:    { label: "Codex CLI" },
  copilot:  { label: "VS Code Copilot" },
}

// ── helpers ───────────────────────────────────────────────────────────────────

function readJSONL(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

function loadDirs() {
  if (!fs.existsSync(DIRS_FILE)) return {}
  try { return JSON.parse(fs.readFileSync(DIRS_FILE, "utf8")) } catch { return {} }
}

function recordMcpHit(event) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    const record = { ts: new Date().toISOString(), ...event }
    fs.appendFileSync(MCP_HITS_FILE, JSON.stringify(record) + "\n")
  } catch {}
}

function shortHash(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16)
}

function parseJSONLText(text) {
  return text.split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter(Boolean)
}

function sessionAuditMeta(session) {
  if (!session) return null
  return {
    tool: session.tool,
    session_id: session.id,
    directory: session.directory ?? null,
    message_count: session.message_count ?? null,
    ts_start: session.ts ?? null,
    ts_last: session.last_ts ?? null,
    source_mtime: session.source_mtime ?? null,
    content_hash: session.content_hash ?? null,
    preview: session.preview ?? null,
    relevance_score: session.relevance_score ?? undefined,
  }
}

function resultAuditList(items, limit = 10) {
  return (items || []).slice(0, limit).map(sessionAuditMeta)
}

function listSessions(toolFilter, searchQuery, limit = 50) {
  if (!fs.existsSync(SESSIONS_DIR)) return []
  const dirs = loadDirs()

  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => {
      const [tool, ...rest] = f.replace(".jsonl", "").split("-")
      const id = rest.join("-")
      if (toolFilter && tool !== toolFilter) return null
      const fpath = path.join(SESSIONS_DIR, f)
      const msgs = readJSONL(fpath)
      if (!msgs.length) return null
      const stat = fs.statSync(fpath)
      const first = msgs[0]
      const last = msgs[msgs.length - 1]
      const preview = (msgs.find(m => m.role === "user")?.content ?? first.content ?? "").slice(0, 150)
      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        const haystack = (preview + " " + id + " " + (dirs[`${tool}-${id}`] ?? "")).toLowerCase()
        if (!haystack.includes(q)) return null
      }
      return {
        id, tool,
        preview,
        directory: dirs[`${tool}-${id}`] ?? null,
        message_count: msgs.length,
        ts: first.ts,
        last_ts: last?.ts ?? first.ts,
        source_mtime: new Date(stat.mtimeMs).toISOString(),
        tool_label: TOOLS[tool]?.label ?? tool,
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.last_ts ?? b.ts) - new Date(a.last_ts ?? a.ts))
    .slice(0, limit)
}

function getSession(id, tool) {
  const file = path.join(SESSIONS_DIR, `${tool}-${id}.jsonl`)
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, "utf8")
  const msgs = parseJSONLText(raw)
  const stat = fs.statSync(file)
  const dirs = loadDirs()
  const dir  = dirs[`${tool}-${id}`] ?? null
  const firstUser = msgs.find(m => m.role === "user")?.content ?? msgs[0]?.content ?? ""

  const text = msgs.map(m => {
    const role = m.role === "user" ? "User" : `${TOOLS[tool]?.label ?? tool} (AI)`
    return `**${role}:** ${m.content}`
  }).join("\\n\\n")

  return {
    id, tool,
    tool_label: TOOLS[tool]?.label ?? tool,
    directory: dir,
    message_count: msgs.length,
    ts: msgs[0]?.ts,
    last_ts: msgs[msgs.length - 1]?.ts ?? msgs[0]?.ts,
    source_mtime: new Date(stat.mtimeMs).toISOString(),
    content_hash: shortHash(raw),
    preview: firstUser.slice(0, 150),
    conversation: text,
    messages: msgs,
  }
}

function searchSessions(query, toolFilter, limit = 20) {
  if (!fs.existsSync(SESSIONS_DIR)) return []
  const q = query.toLowerCase()
  const dirs = loadDirs()
  const results = []

  for (const f of fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".jsonl"))) {
    const [tool, ...rest] = f.replace(".jsonl", "").split("-")
    const id = rest.join("-")
    if (toolFilter && tool !== toolFilter) continue

    const fpath = path.join(SESSIONS_DIR, f)
    const msgs = readJSONL(fpath)
    if (!msgs.length) continue
    const stat = fs.statSync(fpath)

    // Score: count query occurrences across all messages
    let score = 0
    let matchSnippet = ""
    for (const m of msgs) {
      const c = (m.content ?? "").toLowerCase()
      const idx = c.indexOf(q)
      if (idx >= 0) {
        score++
        if (!matchSnippet) {
          const start = Math.max(0, idx - 40)
          matchSnippet = "..." + m.content.slice(start, start + 120) + "..."
        }
      }
    }
    if (score === 0) continue

    results.push({
      id, tool,
      tool_label: TOOLS[tool]?.label ?? tool,
      directory: dirs[`${tool}-${id}`] ?? null,
      preview: matchSnippet || msgs[0]?.content?.slice(0, 120),
      message_count: msgs.length,
      ts: msgs[0]?.ts,
      last_ts: msgs[msgs.length - 1]?.ts ?? msgs[0]?.ts,
      source_mtime: new Date(stat.mtimeMs).toISOString(),
      relevance_score: score,
    })
  }

  return results
    .sort((a, b) => b.relevance_score - a.relevance_score || new Date(b.last_ts ?? b.ts) - new Date(a.last_ts ?? a.ts))
    .slice(0, limit)
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "axon", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
)

// ── Tools ─────────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_sessions",
      description: "List AI conversation sessions stored in axon. Filter by tool (claude/opencode/codex/copilot) and search term.",
      inputSchema: {
        type: "object",
        properties: {
          tool:   { type: "string", description: "Filter by tool: claude, opencode, codex, copilot", enum: ["claude","opencode","codex","copilot"] },
          search: { type: "string", description: "Filter sessions whose preview or directory contains this text" },
          limit:  { type: "number", description: "Max sessions to return (default 20)", default: 20 },
        },
      },
    },
    {
      name: "get_session",
      description: "Retrieve the full conversation from a specific session. Use list_sessions or search_sessions to find the id and tool first.",
      inputSchema: {
        type: "object",
        required: ["id", "tool"],
        properties: {
          id:   { type: "string", description: "Session ID (e.g. ses_xxx or uuid)" },
          tool: { type: "string", description: "Tool the session came from: claude, opencode, codex, copilot" },
        },
      },
    },
    {
      name: "search_sessions",
      description: "Full-text search across all conversation sessions. Returns sessions ranked by relevance with match snippets.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search term to find in conversation content" },
          tool:  { type: "string", description: "Optionally restrict to one tool", enum: ["claude","opencode","codex","copilot"] },
          limit: { type: "number", description: "Max results (default 10)", default: 10 },
        },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === "list_sessions") {
    const sessions = listSessions(args.tool, args.search, args.limit ?? 20)
    recordMcpHit({ kind: "tool", name, tool: args.tool ?? null, limit: args.limit ?? 20, has_search: !!args.search, search_hash: args.search ? shortHash(args.search) : null, result: "ok", count: sessions.length, results: resultAuditList(sessions) })
    if (!sessions.length) {
      return { content: [{ type: "text", text: "No sessions found." }] }
    }
    const lines = sessions.map(s =>
      `• [${s.tool_label}] ${s.id}\n  Preview: ${s.preview}\n  Dir: ${s.directory ?? "unknown"} | ${s.message_count} msgs | ${s.ts?.slice(0,10)}`
    )
    return { content: [{ type: "text", text: lines.join("\n\n") }] }
  }

  if (name === "get_session") {
    const session = getSession(args.id, args.tool)
    recordMcpHit({ kind: "tool", name, tool: args.tool ?? null, session_id: args.id ?? null, result: session ? "hit" : "miss", session: sessionAuditMeta(session) })
    if (!session) {
      return { content: [{ type: "text", text: `Session ${args.id} (${args.tool}) not found.` }], isError: true }
    }
    const header = `# Conversation: ${session.id}\nTool: ${session.tool_label} | Dir: ${session.directory ?? "unknown"} | ${session.message_count} messages | ${session.ts?.slice(0,10)}\n\n---\n\n`
    return { content: [{ type: "text", text: header + session.conversation }] }
  }

  if (name === "search_sessions") {
    const results = searchSessions(args.query, args.tool, args.limit ?? 10)
    recordMcpHit({ kind: "tool", name, tool: args.tool ?? null, limit: args.limit ?? 10, has_query: !!args.query, query_len: String(args.query ?? "").length, query_hash: args.query ? shortHash(args.query) : null, result: "ok", count: results.length, results: resultAuditList(results) })
    if (!results.length) {
      return { content: [{ type: "text", text: `No sessions found matching "${args.query}".` }] }
    }
    const lines = results.map(s =>
      `• [${s.tool_label}] ${s.id} (score: ${s.relevance_score})\n  ${s.preview}\n  Dir: ${s.directory ?? "unknown"} | Use get_session("${s.id}", "${s.tool}") for full conversation`
    )
    return { content: [{ type: "text", text: lines.join("\n\n") }] }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
})

// ── Resources ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const sessions = listSessions(null, null, 30)
  recordMcpHit({ kind: "resource", name: "list_resources", result: "ok", count: sessions.length + 1, results: resultAuditList(sessions) })
  return {
    resources: [
      {
        uri: "sessions://recent",
        name: "Recent Sessions",
        description: "The 30 most recent AI conversations across all tools",
        mimeType: "text/plain",
      },
      ...sessions.map(s => ({
        uri: `session://${s.tool}/${s.id}`,
        name: `[${s.tool_label}] ${s.preview.slice(0, 60)}`,
        description: `${s.message_count} messages | ${s.directory ?? ""} | ${s.ts?.slice(0,10)}`,
        mimeType: "text/plain",
      })),
    ],
  }
})

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = req.params.uri

  if (uri === "sessions://recent") {
    const sessions = listSessions(null, null, 30)
    recordMcpHit({ kind: "resource", name: "read_resource", uri: "sessions://recent", result: "hit", count: sessions.length, results: resultAuditList(sessions) })
    const text = sessions.map(s =>
      `[${s.tool_label}] ${s.id} — ${s.preview.slice(0, 100)} (${s.ts?.slice(0,10)})`
    ).join("\n")
    return { contents: [{ uri, mimeType: "text/plain", text }] }
  }

  const match = uri.match(/^session:\/\/([^/]+)\/(.+)$/)
  if (match) {
    const [, tool, id] = match
    const session = getSession(id, tool)
    recordMcpHit({ kind: "resource", name: "read_resource", uri: "session", tool, session_id: id, result: session ? "hit" : "miss", session: sessionAuditMeta(session) })
    if (!session) throw new Error(`Session ${id} not found`)
    const header = `# ${session.tool_label} — ${session.id}\nDir: ${session.directory ?? "unknown"} | ${session.message_count} messages\n\n---\n\n`
    return { contents: [{ uri, mimeType: "text/plain", text: header + session.conversation }] }
  }

  throw new Error(`Unknown resource: ${uri}`)
})

// ── Prompts ───────────────────────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  recordMcpHit({ kind: "prompt", name: "list_prompts", result: "ok", count: 1 })
  return {
  prompts: [{
    name: "load_context",
    description: "Load a prior conversation as context to continue working on it",
    arguments: [
      { name: "id",   description: "Session ID from axon", required: true },
      { name: "tool", description: "Tool name: claude / opencode / codex / copilot", required: true },
    ],
  }],
  }
})

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { id, tool } = req.params.arguments ?? {}
  const session = getSession(id, tool)
  recordMcpHit({ kind: "prompt", name: "get_prompt", prompt: "load_context", tool: tool ?? null, session_id: id ?? null, result: session ? "hit" : "miss", session: sessionAuditMeta(session) })
  if (!session) throw new Error(`Session ${id} (${tool}) not found`)

  return {
    description: `Load conversation context from ${session.tool_label}`,
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `I want to continue a conversation I had previously.\n\nHere is the full history from ${session.tool_label}:\n\n${session.conversation}\n\n---\nPlease read this and confirm you have the context before I continue.`,
      },
    }],
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
