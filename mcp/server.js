#!/usr/bin/env node
/**
 * axon MCP Server
 * Exposes ~/ai-chats/sessions/ as queryable MCP tools + resources.
 *
 * Tools:     list_sessions, get_session, search_sessions, get_insights
 * Resources: session://{tool}/{id}, sessions://recent, sessions://by-project/{path}
 * Prompts:   load_context, recall_project_context, avoid_past_mistakes, find_prior_solution
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

const LOG_DIR          = process.env.AI_CHAT_LOG_DIR ?? path.join(process.env.HOME, "ai-chats")
const SESSIONS_DIR     = path.join(LOG_DIR, "sessions")
const DIRS_FILE        = path.join(LOG_DIR, "session-dirs.json")
const MCP_HITS_FILE    = path.join(LOG_DIR, "mcp-hits.jsonl")
const INSIGHTS_HISTORY = path.join(LOG_DIR, "insights-history.jsonl")
const INSIGHTS_HISTORY_VERSION = 2

const TOOL_KEYS = new Set(["claude", "opencode", "codex", "copilot"])

const TOOLS = {
  claude:   { label: "Claude Code" },
  opencode: { label: "OpenCode" },
  codex:    { label: "Codex CLI" },
  copilot:  { label: "VS Code Copilot" },
}

// Hard cap: never return more than this many chars from get_session
const GET_SESSION_CHAR_CAP     = 80_000
const GET_SESSION_DEFAULT_HEAD = 30
const GET_SESSION_DEFAULT_TAIL = 30

// ── security ──────────────────────────────────────────────────────────────────

function isSafeSessionId(id) {
  return typeof id === "string" && id.length > 0
    && !id.includes("/") && !id.includes("\\") && !id.includes("\0")
}

function assertTool(tool) {
  if (!TOOL_KEYS.has(tool)) throw new Error(`Unknown tool: ${tool}. Must be one of: ${[...TOOL_KEYS].join(", ")}`)
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
    ts_start: session.ts_start ?? null,
    ts_end: session.ts_end ?? null,
    ts_last: session.ts_end ?? null,  // back-compat: ui/server.js summarizeMcpHits reads ts_last
    source_mtime: session.source_mtime ?? null,
    content_hash: session.content_hash ?? null,
    preview: session.preview ?? null,
    relevance_score: session.relevance_score ?? undefined,
  }
}

function resultAuditList(items, limit = 10) {
  return (items || []).slice(0, limit).map(sessionAuditMeta)
}

// ── tokenizer ─────────────────────────────────────────────────────────────────

function tokenize(text) {
  return (text ?? "").toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2)
}

// ── BM25-style scoring ────────────────────────────────────────────────────────
// IDF approximated by log(1 + term.length) — longer terms are rarer.
// k1=1.5, b=0.75.

function bm25Score(msgTexts, queryTerms, avgDocLen = 5000) {
  const k1 = 1.5, b = 0.75
  const docLen = msgTexts.reduce((s, t) => s + t.length, 0)
  let totalScore = 0
  const termCounts = {}

  for (const term of queryTerms) {
    let count = 0
    for (const txt of msgTexts) {
      let i = 0
      while ((i = txt.indexOf(term, i)) !== -1) { count++; i++ }
    }
    if (count === 0) continue
    const idf = Math.log(1 + term.length)
    const tf  = (count * (k1 + 1)) / (count + k1 * (1 - b + b * (docLen / Math.max(1, avgDocLen))))
    totalScore += idf * tf
    termCounts[term] = count
  }
  return { score: totalScore, termCounts }
}

function bestPassage(msgs, queryTerms, windowSize = 3) {
  if (!msgs.length) return ""
  let bestScore = 0
  let bestIdx   = 0
  for (let i = 0; i < msgs.length; i++) {
    const window = msgs.slice(i, i + windowSize).map(m => (m.content ?? "").toLowerCase())
    let score = 0
    for (const term of queryTerms) {
      for (const w of window) if (w.includes(term)) score++
    }
    if (score > bestScore) { bestScore = score; bestIdx = i }
  }
  if (bestScore === 0) return (msgs[0]?.content ?? "").slice(0, 150)
  const content = msgs[bestIdx]?.content ?? ""
  const idx = content.toLowerCase().indexOf(queryTerms[0] ?? "")
  if (idx === -1) return content.slice(0, 160)
  const start = Math.max(0, idx - 40)
  return "…" + content.slice(start, start + 180) + "…"
}

// ── core data functions ───────────────────────────────────────────────────────

function listSessions(toolFilter, searchQuery, limit = 50, directoryFilter = null) {
  if (!fs.existsSync(SESSIONS_DIR)) return []
  const dirs = loadDirs()

  return fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".jsonl"))
    .map(f => {
      const [tool, ...rest] = f.replace(".jsonl", "").split("-")
      const id = rest.join("-")
      if (toolFilter && tool !== toolFilter) return null
      const fpath = path.join(SESSIONS_DIR, f)
      const msgs  = readJSONL(fpath)
      if (!msgs.length) return null
      const stat  = fs.statSync(fpath)
      const first = msgs[0]
      const last  = msgs[msgs.length - 1]
      const dir   = dirs[`${tool}-${id}`] ?? null
      if (directoryFilter && (!dir || !dir.startsWith(directoryFilter))) return null
      const preview = (msgs.find(m => m.role === "user")?.content ?? first.content ?? "").slice(0, 150)
      if (searchQuery) {
        const q = searchQuery.toLowerCase()
        const haystack = (preview + " " + id + " " + (dir ?? "")).toLowerCase()
        if (!haystack.includes(q)) return null
      }
      return {
        id, tool,
        preview,
        directory: dir,
        message_count: msgs.length,
        ts_start: first.ts ?? null,
        ts_end:   last?.ts ?? first.ts ?? null,
        source_mtime: new Date(stat.mtimeMs).toISOString(),
        tool_label: TOOLS[tool]?.label ?? tool,
      }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.ts_end ?? b.ts_start) - new Date(a.ts_end ?? a.ts_start))
    .slice(0, limit)
}

function getSession(id, tool, mode = "full", offset = 0, limit = null) {
  assertTool(tool)
  if (!isSafeSessionId(id)) throw new Error(`Invalid session id: ${id}`)

  const file = path.join(SESSIONS_DIR, `${tool}-${id}.jsonl`)
  if (!fs.existsSync(file)) return null
  const raw  = fs.readFileSync(file, "utf8")
  const msgs = parseJSONLText(raw)
  const stat = fs.statSync(file)
  const dirs = loadDirs()
  const dir  = dirs[`${tool}-${id}`] ?? null
  const firstUser = msgs.find(m => m.role === "user")?.content ?? msgs[0]?.content ?? ""

  let slicedMsgs
  if (mode === "head") {
    const n = limit ?? GET_SESSION_DEFAULT_HEAD
    slicedMsgs = msgs.slice(0, n)
  } else if (mode === "tail") {
    const n = limit ?? GET_SESSION_DEFAULT_TAIL
    slicedMsgs = msgs.slice(Math.max(0, msgs.length - n))
  } else {
    const start = Math.max(0, offset ?? 0)
    const end   = limit != null ? start + limit : msgs.length
    slicedMsgs  = msgs.slice(start, end)
  }

  let text = slicedMsgs.map(m => {
    const role = m.role === "user" ? "User" : `${TOOLS[tool]?.label ?? tool} (AI)`
    return `**${role}:** ${m.content}`
  }).join("\n\n")

  let truncated = false
  if (text.length > GET_SESSION_CHAR_CAP) {
    text = text.slice(0, GET_SESSION_CHAR_CAP)
    truncated = true
  }

  const shown_start = mode === "tail"
    ? msgs.length - slicedMsgs.length
    : (offset ?? 0)

  return {
    id, tool,
    tool_label: TOOLS[tool]?.label ?? tool,
    directory: dir,
    message_count: msgs.length,
    shown_count: slicedMsgs.length,
    shown_range: [shown_start, shown_start + slicedMsgs.length - 1],
    truncated,
    ts_start: msgs[0]?.ts ?? null,
    ts_end:   msgs[msgs.length - 1]?.ts ?? msgs[0]?.ts ?? null,
    source_mtime: new Date(stat.mtimeMs).toISOString(),
    content_hash: shortHash(raw),
    preview: firstUser.slice(0, 150),
    conversation: text,
    messages: slicedMsgs,
  }
}

function searchSessions(query, toolFilter, limit = 20) {
  if (!fs.existsSync(SESSIONS_DIR)) return []
  const queryTerms = tokenize(query)
  if (!queryTerms.length) return []
  const dirs = loadDirs()
  const results = []

  const sessionFiles = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".jsonl"))

  // Compute average document size for BM25 normalization
  let totalSize = 0
  for (const f of sessionFiles) {
    try { totalSize += fs.statSync(path.join(SESSIONS_DIR, f)).size } catch {}
  }
  const avgDocLen = sessionFiles.length ? totalSize / sessionFiles.length : 5000

  for (const f of sessionFiles) {
    const [tool, ...rest] = f.replace(".jsonl", "").split("-")
    const id = rest.join("-")
    if (toolFilter && tool !== toolFilter) continue

    const fpath = path.join(SESSIONS_DIR, f)
    const msgs  = readJSONL(fpath)
    if (!msgs.length) continue
    const stat = fs.statSync(fpath)

    const msgTexts = msgs.map(m => (m.content ?? "").toLowerCase())
    const { score, termCounts } = bm25Score(msgTexts, queryTerms, avgDocLen)
    if (score === 0) continue

    results.push({
      id, tool,
      tool_label: TOOLS[tool]?.label ?? tool,
      directory: dirs[`${tool}-${id}`] ?? null,
      preview: bestPassage(msgs, queryTerms),
      message_count: msgs.length,
      ts_start: msgs[0]?.ts ?? null,
      ts_end:   msgs[msgs.length - 1]?.ts ?? msgs[0]?.ts ?? null,
      source_mtime: new Date(stat.mtimeMs).toISOString(),
      relevance_score: Math.round(score * 100) / 100,
      matched_terms: Object.keys(termCounts),
    })
  }

  return results
    .sort((a, b) => b.relevance_score - a.relevance_score
      || new Date(b.ts_end ?? b.ts_start) - new Date(a.ts_end ?? a.ts_start))
    .slice(0, limit)
}

function readInsights(limit = 30) {
  if (!fs.existsSync(INSIGHTS_HISTORY)) return []
  return fs.readFileSync(INSIGHTS_HISTORY, "utf8").trim().split("\n")
    .flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
    .filter(r => r.version === INSIGHTS_HISTORY_VERSION)
    .sort((a, b) => (a.date > b.date ? 1 : -1))
    .slice(-limit)
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "axon", version: "1.1.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
)

// ── Tools ─────────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_sessions",
      description: "List AI conversation sessions stored in axon. Filter by tool, search term, or working directory.",
      inputSchema: {
        type: "object",
        properties: {
          tool:      { type: "string", description: "Filter by tool: claude, opencode, codex, copilot", enum: ["claude","opencode","codex","copilot"] },
          search:    { type: "string", description: "Filter sessions whose preview or directory contains this text" },
          directory: { type: "string", description: "Filter to sessions from a specific project directory (prefix match)" },
          limit:     { type: "number", description: "Max sessions to return (default 20, max 200)", default: 20 },
        },
      },
    },
    {
      name: "get_session",
      description: "Retrieve a conversation from axon. Supports mode=head/tail/full and offset+limit for pagination to avoid returning huge sessions in one shot.",
      inputSchema: {
        type: "object",
        required: ["id", "tool"],
        properties: {
          id:     { type: "string", description: "Session ID returned by list_sessions or search_sessions" },
          tool:   { type: "string", description: "Tool name: claude, opencode, codex, copilot", enum: ["claude","opencode","codex","copilot"] },
          mode:   { type: "string", description: "head = first N messages, tail = last N, full = all (default)", enum: ["full","head","tail"], default: "full" },
          offset: { type: "number", description: "Skip first N messages (full mode only)", default: 0 },
          limit:  { type: "number", description: "Max messages. In head/tail defaults to 30." },
        },
      },
    },
    {
      name: "search_sessions",
      description: "Full-text search across all conversations using BM25 scoring. Returns sessions ranked by relevance with passage-level snippets.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Search terms to find in conversation content" },
          tool:  { type: "string", description: "Optionally restrict to one tool", enum: ["claude","opencode","codex","copilot"] },
          limit: { type: "number", description: "Max results (default 10, max 50)", default: 10 },
        },
      },
    },
    {
      name: "get_insights",
      description: "Retrieve daily session insights — productivity scores, patterns, and summaries synthesized from past conversations.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max records to return, most recent first (default 14)", default: 14 },
          date:  { type: "string", description: "Return only the record for a specific date (YYYY-MM-DD)" },
        },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === "list_sessions") {
    const lim = Math.min(args.limit ?? 20, 200)
    const sessions = listSessions(args.tool, args.search, lim, args.directory ?? null)
    recordMcpHit({ kind: "tool", name, tool: args.tool ?? null, limit: lim, has_search: !!args.search, has_dir: !!args.directory, search_hash: args.search ? shortHash(args.search) : null, result: "ok", count: sessions.length, results: resultAuditList(sessions) })
    if (!sessions.length) {
      return { content: [{ type: "text", text: "No sessions found." }] }
    }
    const lines = sessions.map(s =>
      `• [${s.tool_label}] ${s.id}\n  Preview: ${s.preview}\n  Dir: ${s.directory ?? "unknown"} | ${s.message_count} msgs | ${(s.ts_start ?? "").slice(0, 10)}`
    )
    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
      _meta: { count: sessions.length, sessions: sessions.map(s => ({ id: s.id, tool: s.tool, directory: s.directory, message_count: s.message_count, ts_start: s.ts_start, ts_end: s.ts_end })) },
    }
  }

  if (name === "get_session") {
    let session
    try {
      session = getSession(args.id, args.tool, args.mode ?? "full", args.offset ?? 0, args.limit ?? null)
    } catch (e) {
      return { content: [{ type: "text", text: e.message }], isError: true }
    }
    recordMcpHit({ kind: "tool", name, tool: args.tool ?? null, session_id: args.id ?? null, mode: args.mode ?? "full", result: session ? "hit" : "miss", session: sessionAuditMeta(session) })
    if (!session) {
      return { content: [{ type: "text", text: `Session ${args.id} (${args.tool}) not found.` }], isError: true }
    }
    const paginationNote = session.message_count > session.shown_count
      ? `\n\n[Showing messages ${session.shown_range[0]}–${session.shown_range[1]} of ${session.message_count} total. Use offset/limit or mode=head/tail to paginate.]`
      : ""
    const truncNote = session.truncated
      ? `\n\n[Response truncated at ${GET_SESSION_CHAR_CAP.toLocaleString()} chars. Use offset+limit to read other parts.]`
      : ""
    const header = `# Conversation: ${session.id}\nTool: ${session.tool_label} | Dir: ${session.directory ?? "unknown"} | ${session.message_count} messages | ${(session.ts_start ?? "").slice(0, 10)}\n\n---\n\n`
    return {
      content: [{ type: "text", text: header + session.conversation + paginationNote + truncNote }],
      _meta: sessionAuditMeta(session),
    }
  }

  if (name === "search_sessions") {
    const lim = Math.min(args.limit ?? 10, 50)
    const results = searchSessions(args.query, args.tool, lim)
    recordMcpHit({ kind: "tool", name, tool: args.tool ?? null, limit: lim, has_query: !!args.query, query_len: String(args.query ?? "").length, query_hash: args.query ? shortHash(args.query) : null, result: "ok", count: results.length, results: resultAuditList(results) })
    if (!results.length) {
      return { content: [{ type: "text", text: `No sessions found matching "${args.query}".` }] }
    }
    const lines = results.map(s =>
      `• [${s.tool_label}] ${s.id} (score: ${s.relevance_score}, terms: ${s.matched_terms.join(", ")})\n  ${s.preview}\n  Dir: ${s.directory ?? "unknown"} | ${s.message_count} msgs | Use get_session("${s.id}", "${s.tool}") for full conversation`
    )
    return {
      content: [{ type: "text", text: lines.join("\n\n") }],
      _meta: { count: results.length, sessions: results.map(s => ({ id: s.id, tool: s.tool, directory: s.directory, relevance_score: s.relevance_score, matched_terms: s.matched_terms })) },
    }
  }

  if (name === "get_insights") {
    const lim = Math.min(args.limit ?? 14, 90)
    let records = readInsights(lim)
    if (args.date) records = records.filter(r => r.date === args.date)
    recordMcpHit({ kind: "tool", name, result: "ok", count: records.length })
    if (!records.length) {
      return { content: [{ type: "text", text: "No insights records found. Run axon insights to generate them." }] }
    }
    const lines = records.map(r =>
      `## ${r.date}\nScore: ${r.score}/10 | Waste: ${r.wastePct}% | Sessions: ${r.sessions} | Model: ${r.modelName ?? r.model ?? "unknown"}\n\n${r.summary}\n\nPatterns:\n${(r.patterns ?? []).map(p => `• ${p}`).join("\n") || "  (none)"}`
    )
    return {
      content: [{ type: "text", text: lines.join("\n\n---\n\n") }],
      _meta: { count: records.length, records: records.map(r => ({ date: r.date, score: r.score, wastePct: r.wastePct, sessions: r.sessions, pattern_count: (r.patterns ?? []).length })) },
    }
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
})

// ── Resources ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const sessions = listSessions(null, null, 30)
  recordMcpHit({ kind: "resource", name: "list_resources", result: "ok", count: sessions.length + 1, results: resultAuditList(sessions) })

  // Enumerate unique project directories for by-project resources
  const dirs = loadDirs()
  const projectSet = [...new Set(Object.values(dirs).filter(Boolean))].slice(0, 20)
  const projectResources = projectSet.map(p => ({
    uri: `sessions://by-project/${encodeURIComponent(p)}`,
    name: `[Project] ${path.basename(p)}`,
    description: `Sessions from ${p}`,
    mimeType: "text/plain",
  }))

  return {
    resources: [
      {
        uri: "sessions://recent",
        name: "Recent Sessions",
        description: "The 30 most recent AI conversations across all tools",
        mimeType: "text/plain",
      },
      ...projectResources,
      ...sessions.map(s => ({
        uri: `session://${s.tool}/${s.id}`,
        name: `[${s.tool_label}] ${s.preview.slice(0, 60)}`,
        description: `${s.message_count} messages | ${s.directory ?? ""} | ${(s.ts_start ?? "").slice(0, 10)}`,
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
      `[${s.tool_label}] ${s.id} — ${s.preview.slice(0, 100)} (${(s.ts_start ?? "").slice(0, 10)})`
    ).join("\n")
    return { contents: [{ uri, mimeType: "text/plain", text }] }
  }

  const byProject = uri.match(/^sessions:\/\/by-project\/(.+)$/)
  if (byProject) {
    const dirFilter = decodeURIComponent(byProject[1])
    const sessions  = listSessions(null, null, 50, dirFilter)
    recordMcpHit({ kind: "resource", name: "read_resource", uri: "sessions://by-project", dir: dirFilter, result: "hit", count: sessions.length })
    if (!sessions.length) {
      return { contents: [{ uri, mimeType: "text/plain", text: `No sessions found for directory: ${dirFilter}` }] }
    }
    const text = sessions.map(s =>
      `[${s.tool_label}] ${s.id} — ${s.preview.slice(0, 100)} (${(s.ts_start ?? "").slice(0, 10)}, ${s.message_count} msgs)`
    ).join("\n")
    return { contents: [{ uri, mimeType: "text/plain", text: `Sessions in ${dirFilter}:\n\n${text}` }] }
  }

  const sessionMatch = uri.match(/^session:\/\/([^/]+)\/(.+)$/)
  if (sessionMatch) {
    const [, tool, id] = sessionMatch
    let session
    try {
      session = getSession(id, tool, "head", 0, 60)
    } catch (e) {
      throw new Error(e.message)
    }
    recordMcpHit({ kind: "resource", name: "read_resource", uri: "session", tool, session_id: id, result: session ? "hit" : "miss", session: sessionAuditMeta(session) })
    if (!session) throw new Error(`Session ${id} not found`)
    const header = `# ${session.tool_label} — ${session.id}\nDir: ${session.directory ?? "unknown"} | ${session.message_count} messages\n\n---\n\n`
    const note = session.message_count > session.shown_count
      ? `\n\n[First ${session.shown_count} of ${session.message_count} messages. Use get_session tool with mode/offset/limit for full access.]`
      : ""
    return { contents: [{ uri, mimeType: "text/plain", text: header + session.conversation + note }] }
  }

  throw new Error(`Unknown resource: ${uri}`)
})

// ── Prompts ───────────────────────────────────────────────────────────────────

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  recordMcpHit({ kind: "prompt", name: "list_prompts", result: "ok", count: 4 })
  return {
    prompts: [
      {
        name: "load_context",
        description: "Load a prior conversation as context to continue working on it",
        arguments: [
          { name: "id",   description: "Session ID from axon", required: true },
          { name: "tool", description: "Tool name: claude / opencode / codex / copilot", required: true },
        ],
      },
      {
        name: "recall_project_context",
        description: "Load recent sessions from a specific project directory to recall past work",
        arguments: [
          { name: "directory", description: "Absolute path to the project directory", required: true },
          { name: "limit",     description: "Number of sessions to load (default 5)", required: false },
        ],
      },
      {
        name: "avoid_past_mistakes",
        description: "Search for sessions where things went wrong to avoid repeating the same mistakes",
        arguments: [
          { name: "topic", description: "What kind of mistakes to look for (e.g. git, deployment, database)", required: true },
        ],
      },
      {
        name: "find_prior_solution",
        description: "Search past conversations for a solution you recall having solved before",
        arguments: [
          { name: "query", description: "What you're looking for (e.g. docker networking fix, auth token refresh)", required: true },
        ],
      },
    ],
  }
})

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const pname = req.params.name
  const pargs = req.params.arguments ?? {}

  if (pname === "load_context") {
    const { id, tool } = pargs
    let session
    try { session = getSession(id, tool, "full") } catch (e) { throw new Error(e.message) }
    recordMcpHit({ kind: "prompt", name: "get_prompt", prompt: "load_context", tool: tool ?? null, session_id: id ?? null, result: session ? "hit" : "miss", session: sessionAuditMeta(session) })
    if (!session) throw new Error(`Session ${id} (${tool}) not found`)
    return {
      description: `Load conversation context from ${session.tool_label}`,
      messages: [{
        role: "user",
        content: { type: "text", text: `I want to continue a conversation I had previously.\n\nHere is the full history from ${session.tool_label}:\n\n${session.conversation}\n\n---\nPlease read this and confirm you have the context before I continue.` },
      }],
    }
  }

  if (pname === "recall_project_context") {
    const { directory, limit } = pargs
    if (!directory) throw new Error("directory is required")
    const lim = Math.min(parseInt(limit ?? "5", 10) || 5, 20)
    const sessions = listSessions(null, null, lim, directory)
    recordMcpHit({ kind: "prompt", name: "get_prompt", prompt: "recall_project_context", dir: directory, result: "ok", count: sessions.length })
    if (!sessions.length) {
      return {
        description: `No sessions found for ${directory}`,
        messages: [{ role: "user", content: { type: "text", text: `No past conversations found for directory: ${directory}` } }],
      }
    }
    const summaries = sessions.map((s, i) =>
      `### Session ${i + 1}: ${s.id} (${s.tool_label}, ${(s.ts_start ?? "").slice(0, 10)})\n${s.preview}`
    ).join("\n\n")
    return {
      description: `Recent sessions from ${path.basename(directory)}`,
      messages: [{
        role: "user",
        content: { type: "text", text: `Here are the ${sessions.length} most recent conversations from ${directory}:\n\n${summaries}\n\n---\nI am about to work in this directory. Please note any relevant context from these past sessions.` },
      }],
    }
  }

  if (pname === "avoid_past_mistakes") {
    const { topic } = pargs
    if (!topic) throw new Error("topic is required")
    const results = searchSessions(topic + " error bug failed mistake wrong", null, 8)
    recordMcpHit({ kind: "prompt", name: "get_prompt", prompt: "avoid_past_mistakes", topic, result: "ok", count: results.length })
    if (!results.length) {
      return {
        description: `No relevant past mistakes found for: ${topic}`,
        messages: [{ role: "user", content: { type: "text", text: `No past sessions found about mistakes with: ${topic}` } }],
      }
    }
    const summaries = results.map(s =>
      `• [${s.tool_label}] ${s.id} (${(s.ts_start ?? "").slice(0, 10)})\n  ${s.preview}\n  Dir: ${s.directory ?? "unknown"}`
    ).join("\n\n")
    return {
      description: `Past sessions with errors related to: ${topic}`,
      messages: [{
        role: "user",
        content: { type: "text", text: `Before I start, here are past sessions where things went wrong related to "${topic}":\n\n${summaries}\n\n---\nPlease note these past issues and help me avoid repeating the same mistakes.` },
      }],
    }
  }

  if (pname === "find_prior_solution") {
    const { query } = pargs
    if (!query) throw new Error("query is required")
    const results = searchSessions(query, null, 5)
    recordMcpHit({ kind: "prompt", name: "get_prompt", prompt: "find_prior_solution", query, result: "ok", count: results.length })
    if (!results.length) {
      return {
        description: `No prior solutions found for: ${query}`,
        messages: [{ role: "user", content: { type: "text", text: `No past sessions found matching: ${query}` } }],
      }
    }
    const best = results[0]
    let session
    try { session = getSession(best.id, best.tool, "full") } catch {}
    const text = session?.conversation
      ?? `${best.preview}\n\n(Use get_session("${best.id}", "${best.tool}") for full content)`
    return {
      description: `Prior solution for: ${query}`,
      messages: [{
        role: "user",
        content: { type: "text", text: `I believe I solved this before. Here is the most relevant past conversation (${best.tool_label}, ${(best.ts_start ?? "").slice(0, 10)}, dir: ${best.directory ?? "unknown"}):\n\n${text}\n\n---\nBased on this prior conversation, help me apply the same or an improved solution.` },
      }],
    }
  }

  throw new Error(`Unknown prompt: ${pname}`)
})

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
