#!/usr/bin/env node
import http from "http"
import fs from "fs"
import path from "path"
import { execFileSync, spawn } from "child_process"
import { fileURLToPath } from "url"
import { DatabaseSync } from "node:sqlite"

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const HOME       = process.env.HOME
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
const USAGE_CACHE        = path.join(LOG_DIR, "usage-cache.json")
const USAGE_TTL          = 5 * 60 * 1000   // 5 minutes
const INSIGHTS_HISTORY   = path.join(LOG_DIR, "insights-history.jsonl")
const INSIGHTS_CHECKPOINT = path.join(LOG_DIR, "insights-checkpoint.json")
const INSIGHTS_CACHE          = path.join(LOG_DIR, "insights-cache.json")
const INSIGHTS_RECURRING_CACHE = path.join(LOG_DIR, "insights-recurring-cache.json")
const INSIGHTS_TTL       = 10 * 60 * 1000  // 10 minutes
const INSIGHTS_INTERVAL  = 6 * 60 * 60 * 1000  // 6 hours

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

// ── Direct tool stats readers (no ccusage dependency) ────────────────────────

// Model pricing USD per 1M tokens
const MODEL_PRICING = {
  "claude-opus-4-8":          { i: 15,    o: 75,   cr: 1.5,   cw: 3.75 },
  "claude-opus-4-7":          { i: 15,    o: 75,   cr: 1.5,   cw: 3.75 },
  "claude-opus-4-6":          { i: 15,    o: 75,   cr: 1.5,   cw: 3.75 },
  "claude-opus-4-5":          { i: 15,    o: 75,   cr: 1.5,   cw: 3.75 },
  "claude-sonnet-4-6":        { i: 3,     o: 15,   cr: 0.3,   cw: 0.75 },
  "claude-sonnet-4-5":        { i: 3,     o: 15,   cr: 0.3,   cw: 0.75 },
  "claude-haiku-4-5":         { i: 0.8,   o: 4,    cr: 0.08,  cw: 0.2  },
  "claude-3-5-sonnet":        { i: 3,     o: 15,   cr: 0.3,   cw: 0.75 },
  "claude-3-5-haiku":         { i: 0.8,   o: 4,    cr: 0.08,  cw: 0.2  },
  "gpt-5-4-mini":             { i: 0.15,  o: 0.6,  cr: 0.075, cw: 0    },
  "gpt-5-4":                  { i: 10,    o: 40,   cr: 5,     cw: 0    },
  "gpt-5-3-codex":            { i: 1.5,   o: 6,    cr: 0.75,  cw: 0    },
  "gpt-5-2":                  { i: 5,     o: 20,   cr: 2.5,   cw: 0    },
  "gpt-5-1-mini":             { i: 0.4,   o: 1.6,  cr: 0.1,   cw: 0    },
  "gpt-5":                    { i: 2,     o: 8,    cr: 1,     cw: 0    },
  "grok-code-fast-1":         { i: 3,     o: 15,   cr: 0.3,   cw: 0    },
  "gemini-3-flash-preview":   { i: 0.075, o: 0.3,  cr: 0,     cw: 0    },
  "gemini-2-5-pro":           { i: 1.25,  o: 10,   cr: 0,     cw: 0    },
}

function normalizeModel(model) {
  return (model || "").toLowerCase()
    .replace(/-20\d{6}$/, "")            // strip date suffixes like -20250611
    .replace(/(\d+)\.(\d+)/g, "$1-$2")   // normalize 4.6 → 4-6 (OpenCode uses dots)
}

function calcCost(model, inp, out, cr, cw) {
  const M = 1_000_000
  const nm = normalizeModel(model)
  let p = MODEL_PRICING[nm]
  // Fuzzy: key must match at a word boundary (hyphen or end) to avoid gpt-5 matching gpt-5-4
  if (!p) p = Object.entries(MODEL_PRICING).find(([k]) => nm === k || nm.startsWith(k + "-") || nm.startsWith(k + " "))?.[1]
  if (!p) return 0
  return ((inp||0)*p.i + (out||0)*p.o + (cr||0)*p.cr + (cw||0)*p.cw) / M
}

function readClaudeStats() {
  const projDir = path.join(HOME, ".claude", "projects")
  if (!fs.existsSync(projDir)) return []
  const sessMap = {}
  for (const enc of fs.readdirSync(projDir)) {
    const pDir = path.join(projDir, enc)
    if (!fs.statSync(pDir).isDirectory()) continue
    for (const fname of fs.readdirSync(pDir)) {
      if (!fname.endsWith(".jsonl")) continue
      for (const line of readJSONL(path.join(pDir, fname))) {
        if (line.type !== "assistant") continue
        const msg = line.message
        if (!msg?.usage) continue
        const sid = line.sessionId || line.session_id
        if (!sid) continue
        if (!sessMap[sid]) sessMap[sid] = {
          sessionId: sid, tool: "claude",
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
          totalTokens: 0, totalCost: 0, modelBreakdowns: {},
          firstActivity: null, lastActivity: null,
        }
        const s = sessMap[sid]
        const u = msg.usage
        const inp = u.input_tokens || 0
        const out = u.output_tokens || 0
        const cr  = u.cache_read_input_tokens || 0
        const cw  = u.cache_creation_input_tokens || 0
        s.inputTokens      += inp
        s.outputTokens     += out
        s.cacheReadTokens  += cr
        s.cacheCreateTokens += cw
        s.totalTokens      += inp + out + cr + cw
        const rawModel = msg.model || ""
        const model = rawModel.match(/^<.*>$/) ? "" : normalizeModel(rawModel)
        if (model) {
          const cost = calcCost(model, inp, out, cr, cw)
          s.totalCost += cost
          if (!s.modelBreakdowns[model]) s.modelBreakdowns[model] = { cost: 0, tokens: 0 }
          s.modelBreakdowns[model].cost   += cost
          s.modelBreakdowns[model].tokens += inp + out + cr + cw
        }
        const ts = line.timestamp
        if (ts) {
          if (!s.firstActivity || ts < s.firstActivity) s.firstActivity = ts
          if (!s.lastActivity  || ts > s.lastActivity)  s.lastActivity  = ts
        }
      }
    }
  }
  return Object.values(sessMap)
}

async function readOpenCodeStatsAsync() {
  const dbPath = path.join(HOME, ".local/share/opencode/opencode.db")
  if (!fs.existsSync(dbPath)) return []
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  const sessions = db.prepare("SELECT id, directory, time_created, time_updated FROM session").all()
  const sessMap = {}
  for (const sess of sessions) {
    const msgs = db.prepare("SELECT data FROM message WHERE session_id = ?").all(sess.id)
    const s = {
      sessionId: sess.id, tool: "opencode",
      dir: sess.directory || null,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      totalTokens: 0, totalCost: 0, modelBreakdowns: {},
      firstActivity: sess.time_created ? new Date(sess.time_created).toISOString() : null,
      lastActivity:  sess.time_updated ? new Date(sess.time_updated).toISOString() : null,
    }
    for (const row of msgs) {
      try {
        const d = JSON.parse(row.data)
        if (d.role !== "assistant") continue
        const t = d.tokens
        if (!t) continue
        const inp = t.input  || 0
        const out = t.output || 0
        const cr  = t.cache?.read  || 0
        const cw  = t.cache?.write || 0
        s.inputTokens      += inp
        s.outputTokens     += out
        s.cacheReadTokens  += cr
        s.cacheCreateTokens += cw
        s.totalTokens      += inp + out + cr + cw
        const lineCost = d.cost || 0
        const msgCost = lineCost > 0 ? lineCost : calcCost(d.modelID || "", inp, out, cr, cw)
        s.totalCost += msgCost
        const mn = normalizeModel(d.modelID || "")
        if (mn) {
          if (!s.modelBreakdowns[mn]) s.modelBreakdowns[mn] = { cost: 0, tokens: 0 }
          s.modelBreakdowns[mn].cost   += msgCost
          s.modelBreakdowns[mn].tokens += inp + out + cr + cw
        }
      } catch {}
    }
    sessMap[sess.id] = s
  }
  db.close()
  return Object.values(sessMap)
}

function readCopilotStats() {
  const stateDir = path.join(HOME, ".copilot/session-state")
  if (!fs.existsSync(stateDir)) return []
  const sessions = []
  for (const sid of fs.readdirSync(stateDir)) {
    const evFile = path.join(stateDir, sid, "events.jsonl")
    if (!fs.existsSync(evFile)) continue
    const s = {
      sessionId: sid, tool: "copilot",
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
      totalTokens: 0, totalCost: 0, modelBreakdowns: {},
      firstActivity: null, lastActivity: null, dir: null,
    }
    let primaryModel = ""
    for (const ev of readJSONL(evFile)) {
      const ts = ev.timestamp
      if (ts) {
        if (!s.firstActivity || ts < s.firstActivity) s.firstActivity = ts
        if (!s.lastActivity  || ts > s.lastActivity)  s.lastActivity  = ts
      }
      if (ev.type === "session.shutdown") {
        const td = ev.data?.tokenDetails || {}
        const inp = td.input?.tokenCount || 0
        const out = td.output?.tokenCount || 0
        const cr  = td.cache_read?.tokenCount || 0
        const cw  = td.cache_write?.tokenCount || 0
        s.inputTokens      += inp
        s.outputTokens     += out
        s.cacheReadTokens  += cr
        s.cacheCreateTokens += cw
        s.totalTokens      += inp + out + cr + cw
      }
      if (ev.type === "assistant.message" && ev.data?.model && !primaryModel) {
        primaryModel = normalizeModel(ev.data.model)
      }
    }
    if (primaryModel) {
      s.totalCost = calcCost(primaryModel, s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheCreateTokens)
      s.modelBreakdowns[primaryModel] = { cost: s.totalCost, tokens: s.totalTokens }
    }
    sessions.push(s)
  }
  return sessions
}

// ── GitHub Copilot auth + Session Insights ────────────────────────────────────

const COPILOT_CHAT_URL   = "https://api.githubcopilot.com/chat/completions"
const COPILOT_TOKEN_URL  = "https://api.github.com/copilot_internal/v2/token"
const COPILOT_MODELS_URL = "https://api.business.githubcopilot.com/models"
const COPILOT_HEADERS    = {
  "Editor-Version": "OpenCode/1.0",
  "Editor-Plugin-Version": "OpenCode/1.0",
  "Copilot-Integration-Id": "vscode-chat",
}

let _copilotToken = { bearer: null, expiresAt: 0, modelsUrl: null }
let _modelCache   = { models: [], fetchedAt: 0 }
let _deviceAuth   = { device_code: null, interval: 5, expiresAt: 0, done: false, token: null }

function getOAuthToken() {
  const cfgDir = path.join(HOME, ".config", "github-copilot")
  try {
    const hosts = JSON.parse(fs.readFileSync(path.join(cfgDir, "hosts.json"), "utf8"))
    if (hosts["github.com"]?.oauth_token) return hosts["github.com"].oauth_token
  } catch {}
  try {
    const apps = JSON.parse(fs.readFileSync(path.join(cfgDir, "apps.json"), "utf8"))
    const key = Object.keys(apps).find(k => k.startsWith("github.com"))
    if (key && apps[key]?.oauth_token) return apps[key].oauth_token
  } catch {}
  return process.env.GITHUB_TOKEN || null
}

async function exchangeCopilotToken() {
  const oauth = getOAuthToken()
  if (!oauth) throw new Error("No GitHub Copilot token found — sign in to GitHub Copilot first")
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: { Authorization: `Token ${oauth}`, "User-Agent": "axon/1.0" },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`Copilot token exchange failed: ${res.status}`)
  const data = await res.json()
  _copilotToken.bearer    = data.token
  _copilotToken.expiresAt = data.expires_at
  _copilotToken.modelsUrl = data.endpoints?.api ? `${data.endpoints.api}/models` : COPILOT_MODELS_URL
  return _copilotToken.bearer
}

async function getCopilotBearer() {
  const now = Math.floor(Date.now() / 1000)
  if (!_copilotToken.bearer || now >= _copilotToken.expiresAt - 300) await exchangeCopilotToken()
  return _copilotToken.bearer
}

async function copilotFetch(url, opts = {}, attempt = 0) {
  const token = await getCopilotBearer()
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...COPILOT_HEADERS, ...(opts.headers || {}) }
  // Use caller-supplied signal if provided (e.g. long analysis), else default 30s
  const signal = opts.signal || AbortSignal.timeout(30000)
  const { signal: _drop, ...restOpts } = opts
  try {
    const res = await fetch(url, { ...restOpts, headers, signal })
    if (res.status === 401 && attempt === 0) {
      _copilotToken.bearer = null
      return copilotFetch(url, opts, 1)
    }
    return res
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") throw err  // don't retry on timeout
    if (attempt < 2) { await new Promise(r => setTimeout(r, (attempt + 1) * 2000)); return copilotFetch(url, opts, attempt + 1) }
    throw err
  }
}

async function getCopilotModels() {
  if (_modelCache.models.length && Date.now() - _modelCache.fetchedAt < 60 * 60 * 1000) return _modelCache.models
  const url = _copilotToken.modelsUrl || COPILOT_MODELS_URL
  const res = await copilotFetch(url, { method: "GET" })
  if (!res.ok) throw new Error(`Models fetch failed: ${res.status}`)
  const data = await res.json()
  const all  = data.data || data
  _modelCache.models = all.filter(m =>
    m.capabilities?.type === "chat" &&
    m.capabilities?.supports?.streaming &&
    m.model_picker_enabled &&
    (!m.supported_endpoints || m.supported_endpoints.includes("/chat/completions"))
  ).map(m => {
    const lim = m.capabilities?.limits || {}
    return {
      id: m.id,
      name: m.name || m.id,
      vendor: m.vendor || "?",
      category: m.model_picker_category || "versatile",
      maxInputTokens:   lim.max_prompt_tokens || lim.max_context_window_tokens || 32000,
      maxOutputTokens:  lim.max_output_tokens || 4096,
      contextWindow:    lim.max_context_window_tokens || 128000,
    }
  }).sort((a, b) => {
    const o = { powerful: 0, versatile: 1, lightweight: 2 }
    return (o[a.category] ?? 3) - (o[b.category] ?? 3)
  })
  _modelCache.fetchedAt = Date.now()
  return _modelCache.models
}

// ── Insights: bundle + analysis ───────────────────────────────────────────────

function readInsightsHistory() {
  if (!fs.existsSync(INSIGHTS_HISTORY)) return []
  return fs.readFileSync(INSIGHTS_HISTORY, "utf8").trim().split("\n")
    .flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
    .sort((a, b) => (a.date > b.date ? 1 : -1))
}

function readCheckpoint() {
  try { return JSON.parse(fs.readFileSync(INSIGHTS_CHECKPOINT, "utf8")) }
  catch { return { lastAnalyzedAt: null, analyzedIds: [], analyzedDates: [] } }
}
function writeCheckpoint(updates) {
  const existing = readCheckpoint()
  const merged = {
    ...existing,
    ...updates,
    // Always accumulate — never lose tracked IDs/dates across runs
    analyzedIds:    [...new Set([...(existing.analyzedIds   || []), ...(updates.analyzedIds   || [])])],
    analyzedDates:  [...new Set([...(existing.analyzedDates || []), ...(updates.analyzedDates || [])])],
  }
  try { fs.writeFileSync(INSIGHTS_CHECKPOINT, JSON.stringify(merged)) } catch {}
}

function appendInsightsRecord(record) {
  try { fs.appendFileSync(INSIGHTS_HISTORY, JSON.stringify(record) + "\n") } catch {}
}

// Build a bundle of sessions newer than `sinceTs`, capped by token budget
// Build a bundle of sessions within [sinceTs, untilTs], skipping excludeIds, capped by token budget
function buildAnalysisBundle(sinceTs, tokenBudget, { excludeIds = new Set(), untilTs = Infinity, maxSessions = 8 } = {}) {
  const USER_CAP    = 600
  const ASST_CAP    = 250
  const CHARS_PER_TOK = 4
  const MAX_MSGS_PER_SESSION = 40
  const budgetChars = tokenBudget * CHARS_PER_TOK

  // ── Collect candidate files from all sources ──────────────────────────────
  const candidates = []   // { fpath, mtime, tool, sessionId, format: "axon"|"claude_raw" }

  // Source 1: axon sessions dir (claude, opencode, copilot, codex — all already normalised)
  if (fs.existsSync(SESSIONS_DIR)) {
    for (const f of fs.readdirSync(SESSIONS_DIR).filter(x => x.endsWith(".jsonl"))) {
      try {
        const stat = fs.statSync(path.join(SESSIONS_DIR, f))
        if (stat.mtimeMs < (sinceTs || 0) || stat.mtimeMs > untilTs) continue
        const tool = f.split("-")[0]
        const sessionId = f.slice(tool.length + 1, -6)
        if (excludeIds.has(sessionId)) continue
        candidates.push({ fpath: path.join(SESSIONS_DIR, f), mtime: stat.mtimeMs, tool, sessionId, format: "axon" })
      } catch {}
    }
  }

  // Source 2: Claude Code raw JSONL (~/.claude/projects/**/*.jsonl)
  const CLAUDE_PROJ = path.join(HOME, ".claude", "projects")
  if (fs.existsSync(CLAUDE_PROJ)) {
    for (const proj of fs.readdirSync(CLAUDE_PROJ)) {
      const projDir = path.join(CLAUDE_PROJ, proj)
      try {
        if (!fs.statSync(projDir).isDirectory()) continue
        for (const f of fs.readdirSync(projDir).filter(x => x.endsWith(".jsonl"))) {
          const fpath = path.join(projDir, f)
          try {
            const stat = fs.statSync(fpath)
            if (stat.mtimeMs < (sinceTs || 0) || stat.mtimeMs > untilTs) continue
            const sessionId = f.slice(0, -6)
            if (excludeIds.has(sessionId)) continue
            candidates.push({ fpath, mtime: stat.mtimeMs, tool: "claude", sessionId, format: "claude_raw" })
          } catch {}
        }
      } catch {}
    }
  }

  // Dedup by sessionId (axon copy wins over raw if both present), sort newest first
  const seen = new Set()
  const allFiles = candidates
    .sort((a, b) => (a.format === "axon" ? 0 : 1) - (b.format === "axon" ? 0 : 1))  // axon first
    .filter(c => { if (seen.has(c.sessionId)) return false; seen.add(c.sessionId); return true })
    .sort((a, b) => b.mtime - a.mtime)

  if (!allFiles.length) return []

  // ── Parse messages from each session ─────────────────────────────────────
  function parseAxonMsgs(fpath) {
    return readJSONL(fpath).filter(m => m.role === "user" || m.role === "assistant")
      .map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : JSON.stringify(m.content), ts: m.ts }))
  }

  function parseClaudeRawMsgs(fpath) {
    const lines = fs.readFileSync(fpath, "utf8").trim().split("\n").filter(Boolean)
    const msgs = []
    for (const line of lines) {
      try {
        const d = JSON.parse(line)
        if (d.type === "user") {
          const c = d.message?.content
          const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join(" ") : ""
          if (text.trim()) msgs.push({ role: "user", content: text, ts: d.timestamp })
        } else if (d.type === "assistant") {
          const c = d.message?.content
          const text = Array.isArray(c) ? c.filter(x => x.type === "text").map(x => x.text).join(" ") : typeof c === "string" ? c : ""
          if (text.trim()) msgs.push({ role: "assistant", content: text, ts: d.timestamp })
        }
      } catch {}
    }
    return msgs
  }

  // ── Build bundle greedy ───────────────────────────────────────────────────
  let usedChars = 0
  const sessions = []

  for (const { fpath, tool, sessionId, format } of allFiles) {
    try {
      const msgs = format === "axon" ? parseAxonMsgs(fpath) : parseClaudeRawMsgs(fpath)
      if (!msgs.length) continue

      const rawChars = msgs.reduce((a, m) => a + m.content.length, 0)
      const isShort  = rawChars < 2000

      // For long sessions keep first half + last half to show arc
      const trimmed = msgs.length > MAX_MSGS_PER_SESSION
        ? [...msgs.slice(0, MAX_MSGS_PER_SESSION / 2), ...msgs.slice(-MAX_MSGS_PER_SESSION / 2)]
        : msgs

      const formatted = []
      let sessChars = 0
      for (const m of trimmed) {
        const trunc = isShort ? m.content : (m.role === "user" ? m.content.slice(0, USER_CAP) : m.content.slice(0, ASST_CAP))
        formatted.push({ role: m.role, content: trunc, ts: m.ts })
        sessChars += trunc.length
      }

      if (usedChars + sessChars > budgetChars && sessions.length >= 1) break
      sessions.push({ sessionId, tool, messages: formatted, rawChars })
      usedChars += sessChars
      if (sessions.length >= maxSessions) break
    } catch {}
  }

  return sessions
}

async function runInsightsAnalysis({ forceWindow = null, model: modelId = null, overrideDate = null, sinceTs: forceSinceTs = null, untilTs: forceUntilTs = null, maxSessions = 8 } = {}) {
  // Load checkpoint to know where we left off
  const cp = readCheckpoint()
  const excludeIds = new Set(cp.analyzedIds || [])

  let sinceTs, untilTs
  if (forceSinceTs !== null) {
    sinceTs = forceSinceTs
    untilTs = forceUntilTs || Infinity
  } else {
    sinceTs = forceWindow
      ? Date.now() - forceWindow * 60 * 60 * 1000
      : (cp.lastAnalyzedAt ? new Date(cp.lastAnalyzedAt).getTime() : Date.now() - 6 * 60 * 60 * 1000)
    untilTs = Infinity
  }

  // Get model info for token cap
  let models = []
  try { models = await getCopilotModels() } catch {}
  const chosenModel = models.find(m => m.id === modelId) || models.find(m => m.category === "versatile") || models[0]
  // Keep bundle small (8% of context) so Copilot responds in reasonable time
  const tokenBudget = chosenModel ? Math.floor(chosenModel.maxInputTokens * 0.08) : 6000
  const mId = chosenModel?.id || "gpt-4o-mini"

  // Build bundle — newest-first within the window, skip already-analyzed
  let bundle = buildAnalysisBundle(sinceTs, tokenBudget, { excludeIds, untilTs, maxSessions })

  // If bundle is small and no explicit window, try extending backward in 3h steps
  if (bundle.length < 2 && forceSinceTs === null) {
    for (let ext = 1; ext <= 4 && bundle.length < 2; ext++) {
      const extSince = sinceTs - ext * 3 * 60 * 60 * 1000
      bundle = buildAnalysisBundle(extSince, tokenBudget, { excludeIds, untilTs, maxSessions })
    }
  }

  if (!bundle.length) return null

  const sessionSummary = bundle.map((s, i) => {
    const msgs = s.messages.map(m => `    [${m.role}]: ${m.content}`).join("\n")
    return `Session ${i + 1} (${s.tool}, ${s.messages.length} messages):\n${msgs}`
  }).join("\n\n---\n\n")

  const systemPrompt = `You are a prompt efficiency coach. Analyze these AI coding sessions and return ONLY valid JSON — no markdown, no explanation outside the JSON.

Scoring: 9-10=crystal clear goals, full context; 7-8=clear but missing some context; 5-6=vague, needed 2-4 corrections; 3-4=very vague, half session was clarification; 1-2=no context given.

For "improved" examples: show exactly how the OPENING user message should have been rewritten — with file paths, error messages, expected behavior, constraints. Keep "improved" under 200 chars.`

  const userMsg = `Sessions to analyze:\n\n${sessionSummary}\n\nReturn this JSON structure:
{
  "overallScore": <0-10>,
  "summary": "<one sentence overall assessment>",
  "wastePct": <0-100>,
  "patterns": ["<habit1>", "<habit2>", "<habit3>"],
  "sessions": [
    {
      "sessionId": "<id>",
      "tool": "<tool>",
      "score": <0-10>,
      "issue": "<brief issue in 10 words>",
      "original": "<first user message verbatim, max 100 chars>",
      "improved": "<better version of opening message, max 200 chars>",
      "whyBetter": "<one sentence explanation>"
    }
  ]
}`

  const res = await copilotFetch(COPILOT_CHAT_URL, {
    method: "POST",
    body: JSON.stringify({
      model: mId,
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMsg }],
      temperature: 0.3,
      max_tokens: 8192,
    }),
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) throw new Error(`Copilot analysis failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  const choice = data.choices?.[0]
  const finishReason = choice?.finish_reason || "unknown"
  const raw  = choice?.message?.content || ""

  if (!raw) {
    const errDetail = JSON.stringify({ finish_reason: finishReason, usage: data.usage, error: data.error }).slice(0, 300)
    throw new Error(`Copilot returned empty content (finish_reason=${finishReason}): ${errDetail}`)
  }

  let parsed
  try {
    // Strip markdown code fences if the model wrapped the JSON
    let jsonStr = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim()
    jsonStr = jsonStr.match(/\{[\s\S]*\}/)?.[0] || jsonStr
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error(`Failed to parse AI response as JSON: ${raw.slice(0, 300)}`)
  }

  const now = new Date().toISOString()
  const recordDate = overrideDate || now.slice(0, 10)
  const record = {
    ts:   overrideDate ? (overrideDate + "T12:00:00.000Z") : now,
    date: recordDate,
    model: mId,
    score:      Math.min(10, Math.max(0, parsed.overallScore ?? 0)),
    wastePct:   Math.min(100, Math.max(0, parsed.wastePct ?? 0)),
    sessions:   bundle.length,
    summary:    parsed.summary   || "",
    patterns:   parsed.patterns  || [],
    sessionDetails: parsed.sessions || [],
  }

  // Save to history; update lastAnalyzedAt only for live (non-backfill) runs
  appendInsightsRecord(record)
  const cpUpdate = { analyzedIds: bundle.map(s => s.sessionId) }
  if (!overrideDate) cpUpdate.lastAnalyzedAt = now   // only advance the cursor for live runs
  if (overrideDate) cpUpdate.analyzedDates = [overrideDate]
  writeCheckpoint(cpUpdate)

  return record
}

// ── All-time recurring themes: synthesized by Copilot, cached by record count ─
async function getRecurringThemes() {
  const records = readInsightsHistory()
  if (!records.length) return []

  // Deduplicate patterns per day (multiple records on same day merge)
  const byDate = {}
  for (const r of records) {
    const d = r.date || (r.ts || "").slice(0, 10)
    if (!byDate[d]) byDate[d] = new Set()
    for (const p of r.patterns || []) byDate[d].add(p)
  }
  const dayCount = Object.keys(byDate).length
  const allPatterns = [...new Set(Object.values(byDate).flatMap(s => [...s]))]

  // Check cache (keyed by number of unique patterns — stable proxy for history growth)
  try {
    const c = JSON.parse(fs.readFileSync(INSIGHTS_RECURRING_CACHE, "utf8"))
    if (c.patternCount === allPatterns.length) return c.themes
  } catch {}

  // Build prompt
  const patternList = allPatterns.map((p, i) => `${i + 1}. ${p}`).join("\n")
  const prompt = `Below are ${allPatterns.length} prompt quality patterns identified across ${dayCount} days of AI coding sessions.\n\nIdentify the 5 most persistent recurring habits — themes that clearly appear many times with different phrasings. Return ONLY valid JSON: {"themes": ["<habit as short noun phrase, 4-8 words>", ...]}\n\nPatterns:\n${patternList}`

  try {
    const res = await copilotFetch(COPILOT_CHAT_URL, {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], temperature: 0.2, max_tokens: 512 }),
      signal: AbortSignal.timeout(30000),
    })
    if (!res.ok) throw new Error(`${res.status}`)
    const data = await res.json()
    const raw = data.choices?.[0]?.message?.content || ""
    let jsonStr = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim()
    jsonStr = jsonStr.match(/\{[\s\S]*\}/)?.[0] || jsonStr
    const parsed = JSON.parse(jsonStr)
    const themes = parsed.themes || []
    fs.writeFileSync(INSIGHTS_RECURRING_CACHE, JSON.stringify({ patternCount: allPatterns.length, themes }))
    return themes
  } catch (e) {
    console.error("[recurring] synthesis error:", e.message)
    return []
  }
}

// ── Backfill: analyze ALL historical sessions, one day at a time ─────────────
let _backfill = { running: false, total: 0, done: 0, skipped: 0, error: null, startedAt: null }

async function runBackfillAll({ model: modelId = null } = {}) {
  if (_backfill.running) return { error: "Backfill already running" }
  _backfill = { running: true, total: 0, done: 0, skipped: 0, error: null, startedAt: new Date().toISOString() }

  try {
    const cp = readCheckpoint()
    const alreadyDone = new Set(cp.analyzedDates || [])

    // Collect all session mtimes to find day range
    const allMtimes = []
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const f of fs.readdirSync(SESSIONS_DIR).filter(x => x.endsWith(".jsonl"))) {
        try { allMtimes.push(fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs) } catch {}
      }
    }
    const CLAUDE_PROJ = path.join(HOME, ".claude", "projects")
    if (fs.existsSync(CLAUDE_PROJ)) {
      for (const proj of fs.readdirSync(CLAUDE_PROJ)) {
        const d = path.join(CLAUDE_PROJ, proj)
        try {
          if (!fs.statSync(d).isDirectory()) continue
          for (const f of fs.readdirSync(d).filter(x => x.endsWith(".jsonl"))) {
            try { allMtimes.push(fs.statSync(path.join(d, f)).mtimeMs) } catch {}
          }
        } catch {}
      }
    }

    if (!allMtimes.length) { _backfill.running = false; return { done: 0 } }

    // Build list of unique days (oldest first)
    const days = [...new Set(allMtimes.map(ms => new Date(ms).toISOString().slice(0, 10)))].sort()
    _backfill.total = days.length

    // Get model info once
    let models = []
    try { models = await getCopilotModels() } catch {}
    const chosenModel = models.find(m => m.id === modelId) || models.find(m => m.category === "versatile") || models[0]
    const tokenBudget = chosenModel ? Math.floor(chosenModel.maxInputTokens * 0.08) : 6000
    const mId = modelId || chosenModel?.id || "gpt-4o-mini"

    for (const day of days) {
      if (alreadyDone.has(day)) {
        _backfill.skipped++; _backfill.done++
        console.log(`[backfill] Skip ${day} (already done)`)
        continue
      }

      const dayStart = new Date(day + "T00:00:00Z").getTime()
      const dayEnd   = new Date(day + "T23:59:59Z").getTime()

      try {
        // Sample sessions from this day — balance across tools
        const allCands = buildAnalysisBundle(dayStart, tokenBudget * 10,  // large budget to get all candidates
          { excludeIds: new Set(cp.analyzedIds || []), untilTs: dayEnd, maxSessions: 200 })

        if (!allCands.length) {
          console.log(`[backfill] ${day}: no sessions, skipping`)
          writeCheckpoint({ analyzedDates: [day] })
          alreadyDone.add(day)
          _backfill.done++
          continue
        }

        // Balance across tools: up to 3 sessions per tool, max 8 total
        const byTool = {}
        for (const s of allCands) {
          if (!byTool[s.tool]) byTool[s.tool] = []
          if (byTool[s.tool].length < 3) byTool[s.tool].push(s)
        }
        const balanced = Object.values(byTool).flat().slice(0, 8)
        console.log(`[backfill] ${day}: ${balanced.length} sessions across tools: ${Object.keys(byTool).join(",")}`)

        const result = await runInsightsAnalysis({
          model: mId, overrideDate: day, sinceTs: dayStart, untilTs: dayEnd, maxSessions: 3
        })
        if (result) {
          console.log(`[backfill] ${day}: score ${result.score}/10, ${result.sessions} sessions`)
          alreadyDone.add(day)
        }
      } catch (err) {
        console.error(`[backfill] ${day} error: ${err.message}`)
      }

      _backfill.done++
      // Brief pause between days to avoid rate limiting
      await new Promise(r => setTimeout(r, 2000))
    }
  } catch (err) {
    _backfill.error = err.message
    console.error("[backfill] Fatal error:", err.message)
  } finally {
    _backfill.running = false
  }
  return { done: _backfill.done, skipped: _backfill.skipped }
}

// 6-hour cron: runs once on startup (if due) then every 6h
function scheduleInsightsCron() {
  async function tick() {
    try {
      const cp = readCheckpoint()
      const lastRun = cp.lastAnalyzedAt ? new Date(cp.lastAnalyzedAt).getTime() : 0
      if (Date.now() - lastRun >= INSIGHTS_INTERVAL) {
        console.log("[insights] Running scheduled 6h analysis…")
        const result = await runInsightsAnalysis()
        if (result) console.log(`[insights] Done — score ${result.score}/10, ${result.sessions} sessions`)
        else        console.log("[insights] No new sessions to analyze")
      }
    } catch (err) {
      console.error("[insights] Cron error:", err.message)
    }
  }
  tick()  // run immediately on startup
  setInterval(tick, INSIGHTS_INTERVAL)
}

// ── ccusage / tool detection ──────────────────────────────────────────────────

const CCUSAGE_PATHS = [
  "ccusage",
  path.join(process.env.HOME, ".local", "npm-global", "bin", "ccusage"),
  path.join(process.env.HOME, ".npm-global", "bin", "ccusage"),
  "/usr/local/bin/ccusage",
]

function getCcusageBin() {
  for (const p of CCUSAGE_PATHS) {
    try { execFileSync(p, ["--version"], { encoding: "utf8", stdio: "pipe", timeout: 3000 }); return p }
    catch {}
  }
  return null
}

function isCcusageInstalled() { return !!getCcusageBin() }

function isAgentMemoryInstalled() {
  return fs.existsSync(
    path.join(process.env.HOME, ".local", "npm-global", "lib", "node_modules", "@agentmemory", "agentmemory")
  )
}

function runCcusageJson(...args) {
  const bin = getCcusageBin()
  if (!bin) throw new Error("ccusage not installed")
  const out = execFileSync(bin, [...args, "--json"], { encoding: "utf8", timeout: 45000, stdio: "pipe" })
  const txt = out.trim()
  return txt ? JSON.parse(txt) : []
}

function spawnCcusageJson(...args) {
  return new Promise((resolve, reject) => {
    const bin = getCcusageBin()
    if (!bin) return reject(new Error("ccusage not installed"))
    let out = ""
    const proc = spawn(bin, [...args, "--json"], { stdio: "pipe" })
    proc.stdout.on("data", d => { out += d })
    proc.on("close", () => {
      const txt = out.trim()
      if (!txt) return resolve([])
      try { resolve(JSON.parse(txt)) } catch { resolve([]) }
    })
    proc.on("error", reject)
    setTimeout(() => { proc.kill(); resolve([]) }, 240000)  // 4 min — opencode takes ~2 min
  })
}

function decodeProjPath(encoded, dirs, sessionId, tool) {
  if (dirs[`${tool}-${sessionId}`]) return dirs[`${tool}-${sessionId}`]
  if (!encoded) return null
  const home  = process.env.HOME
  const homeEnc = home.replace(/\//g, "-")        // e.g. "-home-jagadeesh-12581"
  if (encoded.startsWith(homeEnc)) {
    const rest = encoded.slice(homeEnc.length)     // e.g. "-tools-bills"
    return home + rest.replace(/-/g, "/")          // best-effort; ambiguous if dir has '-'
  }
  return "/" + encoded.replace(/-/g, "/")
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

function computeAxonStats() {
  if (!fs.existsSync(SESSIONS_DIR)) return null
  const TC = ["claude", "opencode", "copilot", "codex"]
  const dirs = loadDirs()
  const hourCounts    = Object.fromEntries([...TC, "total"].map(t => [t, new Array(24).fill(0)]))
  const dailyMap      = {}
  const daysByTool    = Object.fromEntries(TC.map(t => [t, new Set()]))
  const sessByTool    = Object.fromEntries(TC.map(t => [t, 0]))
  const msgsByTool    = Object.fromEntries(TC.map(t => [t, 0]))
  const repoMap       = {}   // dir -> { messages, sessions, tools }
  const userByTool    = Object.fromEntries(TC.map(t => [t, 0]))
  const assistByTool  = Object.fromEntries(TC.map(t => [t, 0]))
  let   totalUserMsgs = 0, totalAssistMsgs = 0

  for (const fname of fs.readdirSync(SESSIONS_DIR)) {
    if (!fname.endsWith(".jsonl")) continue
    const tool = fname.split("-")[0]
    if (!TC.includes(tool)) continue
    const sessionId = fname.slice(tool.length + 1, -6)  // strip "tool-" prefix and ".jsonl"
    const dir = dirs[`${tool}-${sessionId}`] || null
    sessByTool[tool]++
    if (dir) {
      if (!repoMap[dir]) repoMap[dir] = { messages: 0, sessions: 0, tools: new Set() }
      repoMap[dir].sessions++
      repoMap[dir].tools.add(tool)
    }
    for (const m of readJSONL(path.join(SESSIONS_DIR, fname))) {
      if (!m.ts) continue
      const dt   = new Date(m.ts)
      const h    = dt.getHours()
      const date = m.ts.slice(0, 10)
      hourCounts[tool][h]++
      hourCounts.total[h]++
      if (!dailyMap[date]) dailyMap[date] = Object.fromEntries([...TC, "total"].map(t => [t, 0]))
      dailyMap[date][tool]++
      dailyMap[date].total++
      daysByTool[tool].add(date)
      msgsByTool[tool]++
      if (dir) repoMap[dir].messages++
      if (m.role === "user")      { userByTool[tool]++;   totalUserMsgs++ }
      else                        { assistByTool[tool]++;  totalAssistMsgs++ }
    }
  }

  const allDates = Object.keys(dailyMap).sort()
  if (!allDates.length) return null

  const peakH = hourCounts.total.indexOf(Math.max(...hourCounts.total))
  const peakHourLabel = peakH === 0 ? "12 AM"
    : peakH < 12 ? `${peakH} AM`
    : peakH === 12 ? "12 PM"
    : `${peakH - 12} PM`

  // Longest streak
  let maxStreak = 0, cs = 0
  for (let i = 0; i < allDates.length; i++) {
    const diff = i === 0 ? 1 : (new Date(allDates[i]) - new Date(allDates[i - 1])) / 86400000
    cs = diff === 1 ? cs + 1 : 1
    if (cs > maxStreak) maxStreak = cs
  }
  // Current streak — count back from today
  let currentStreak = 0
  for (let i = allDates.length - 1; i >= 0; i--) {
    const expected = new Date(Date.now() - currentStreak * 86400000).toISOString().slice(0, 10)
    if (allDates[i] === expected) currentStreak++
    else break
  }

  const totalMsgs = totalUserMsgs + totalAssistMsgs
  const totalSess = TC.reduce((a, t) => a + sessByTool[t], 0)
  const repos = Object.entries(repoMap)
    .map(([path, v]) => ({ path, messages: v.messages, sessions: v.sessions, tools: [...v.tools] }))
    .sort((a, b) => b.messages - a.messages)
    .slice(0, 20)
  return {
    hourCounts,
    daily: allDates.map(date => ({ date, ...dailyMap[date] })),
    peakHour: peakH,
    peakHourLabel,
    currentStreak,
    longestStreak: maxStreak,
    activeDays: allDates.length,
    totalMessages: totalMsgs,
    userMessages: totalUserMsgs,
    assistantMessages: totalAssistMsgs,
    avgMsgsPerSession: totalSess > 0 ? Math.round(totalMsgs / totalSess) : 0,
    firstDate: allDates[0] || null,
    lastDate:  allDates[allDates.length - 1] || null,
    repos,
    byTool: Object.fromEntries(
      TC.map(t => [t, {
        sessions:          sessByTool[t],
        messages:          msgsByTool[t],
        userMessages:      userByTool[t],
        assistantMessages: assistByTool[t],
        days:              daysByTool[t].size,
      }])
    ),
  }
}

async function computeAxonDirectStats() {
  // Read token/cost/model data directly from tool storage — no ccusage involved
  let claudeSessions = [], opencodeSessions = [], copilotSessions = []
  try { claudeSessions   = readClaudeStats()             } catch {}
  try { opencodeSessions = await readOpenCodeStatsAsync() } catch {}
  try { copilotSessions  = readCopilotStats()             } catch {}
  const allSessions = [...claudeSessions, ...opencodeSessions, ...copilotSessions]

  const totalTokens      = allSessions.reduce((a, s) => a + (s.totalTokens       || 0), 0)
  const totalCost        = allSessions.reduce((a, s) => a + (s.totalCost          || 0), 0)
  const totalInput       = allSessions.reduce((a, s) => a + (s.inputTokens        || 0), 0)
  const totalOutput      = allSessions.reduce((a, s) => a + (s.outputTokens       || 0), 0)
  const totalCacheRead   = allSessions.reduce((a, s) => a + (s.cacheReadTokens    || 0), 0)
  const totalCacheCreate = allSessions.reduce((a, s) => a + (s.cacheCreateTokens  || 0), 0)
  const cacheHitPct      = totalCacheRead > 0
    ? Math.round(totalCacheRead / (totalCacheRead + totalInput) * 100) : 0

  const tokensByTool = {}
  for (const s of allSessions) {
    if (!tokensByTool[s.tool]) tokensByTool[s.tool] = {
      tokens: 0, cost: 0, sessions: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
    }
    const t = tokensByTool[s.tool]
    t.tokens           += s.totalTokens       || 0
    t.cost             += s.totalCost          || 0
    t.sessions++
    t.inputTokens      += s.inputTokens        || 0
    t.outputTokens     += s.outputTokens       || 0
    t.cacheReadTokens  += s.cacheReadTokens    || 0
    t.cacheCreateTokens += s.cacheCreateTokens || 0
  }

  const modelMap = {}
  for (const s of allSessions) {
    for (const [mn, mb] of Object.entries(s.modelBreakdowns || {})) {
      if (!modelMap[mn]) modelMap[mn] = { cost: 0, tokens: 0, sessions: 0 }
      modelMap[mn].cost    += mb.cost   || 0
      modelMap[mn].tokens  += mb.tokens || 0
      modelMap[mn].sessions++
    }
  }
  const topModels = Object.entries(modelMap)
    .map(([name, v]) => ({ name, cost: Math.round(v.cost * 100) / 100, tokens: Math.round(v.tokens), sessions: v.sessions }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)

  return { totalTokens, totalCost,
    inputTokens: totalInput, outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead, cacheCreateTokens: totalCacheCreate,
    cacheHitPct, topModels, tokensByTool }
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

  // ── Tool detection status ─────────────────────────────────────────────────
  if (url.pathname === "/api/tools/status" && req.method === "GET") {
    return respond(res, 200, {
      ccusage:      isCcusageInstalled(),
      agentmemory:  isAgentMemoryInstalled(),
    })
  }

  // ── Install ccusage globally ──────────────────────────────────────────────
  if (url.pathname === "/api/tools/install" && req.method === "POST") {
    const { tool } = await parseBody(req)
    if (tool !== "ccusage") return respond(res, 400, { error: "Only ccusage can be auto-installed" })
    try {
      execFileSync("npm", ["install", "-g", "ccusage"], { encoding: "utf8", timeout: 120000, stdio: "pipe" })
      return respond(res, 200, { ok: true })
    } catch (e) { return respond(res, 500, { error: e.message }) }
  }

  // ── Usage data (via ccusage) ──────────────────────────────────────────────
  if (url.pathname === "/api/usage" && req.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1"
    try {
      if (!isCcusageInstalled()) return respond(res, 200, { error: "ccusage not installed — go to Settings to install" })

      // Return cached result if fresh enough (always attach fresh axon stats)
      if (!refresh && fs.existsSync(USAGE_CACHE)) {
        try {
          const cached = JSON.parse(fs.readFileSync(USAGE_CACHE, "utf8"))
          if (Date.now() - cached._ts < USAGE_TTL) {
            delete cached._ts
            const axonMsg = computeAxonStats()
            const axonDirect = await computeAxonDirectStats()
            cached.axon = axonMsg ? { ...axonMsg, ...axonDirect } : axonDirect
            return respond(res, 200, cached)
          }
        } catch {}
      }

      const dirs = loadDirs()
      const allSessions = []

      // Run all three tool queries in parallel
      const results = await Promise.allSettled([
        spawnCcusageJson("claude",   "session"),
        spawnCcusageJson("opencode", "session"),
        spawnCcusageJson("codex",    "session"),
      ])

      for (const [i, tool] of ["claude", "opencode", "codex"].entries()) {
        if (results[i].status !== "fulfilled") continue
        const raw = results[i].value
        const sessions = Array.isArray(raw) ? raw : (raw?.sessions ?? [])
        for (const s of sessions) {
          const encoded = s.projectPath || s.directory || s.period || ""
          // Normalise model breakdowns across all tool formats
          const modelBreakdowns = s.modelBreakdowns
            || (s.models ? Object.entries(s.models).map(([name, v]) => ({ modelName: name, cost: v.cost ?? 0, inputTokens: v.inputTokens ?? 0, outputTokens: v.outputTokens ?? 0, cacheReadTokens: v.cacheReadTokens ?? 0 })) : [])
          allSessions.push({
            tool,
            sessionId:         s.sessionId || "",
            totalTokens:       s.totalTokens       || 0,
            totalCost:         s.totalCost || s.costUSD || 0,
            inputTokens:       s.inputTokens        || 0,
            outputTokens:      s.outputTokens       || 0,
            cacheReadTokens:   s.cacheReadTokens    || 0,
            cacheCreateTokens: s.cacheCreationTokens || 0,
            modelsUsed:        s.modelsUsed || (s.models ? Object.keys(s.models) : []),
            modelBreakdowns,
            firstActivity:     s.firstActivity || s.metadata?.firstActivity || null,
            lastActivity:      s.lastActivity  || s.metadata?.lastActivity  || null,
            dir: decodeProjPath(encoded, dirs, s.sessionId || "", tool),
          })
        }
      }

      const totalTokens      = allSessions.reduce((a, s) => a + s.totalTokens,       0)
      const totalCost        = allSessions.reduce((a, s) => a + s.totalCost,          0)
      const totalInput       = allSessions.reduce((a, s) => a + s.inputTokens,        0)
      const totalOutput      = allSessions.reduce((a, s) => a + s.outputTokens,       0)
      const totalCacheRead   = allSessions.reduce((a, s) => a + s.cacheReadTokens,    0)
      const totalCacheCreate = allSessions.reduce((a, s) => a + s.cacheCreateTokens,  0)
      const cacheHitPct      = totalCacheRead > 0
        ? Math.round(totalCacheRead / (totalCacheRead + totalInput) * 100) : 0

      // Per-tool breakdown
      const toolBreakdown = {}
      for (const s of allSessions) {
        if (!toolBreakdown[s.tool]) toolBreakdown[s.tool] = {
          tokens: 0, cost: 0, sessions: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0,
        }
        const t = toolBreakdown[s.tool]
        t.tokens           += s.totalTokens
        t.cost             += s.totalCost
        t.sessions++
        t.inputTokens      += s.inputTokens
        t.outputTokens     += s.outputTokens
        t.cacheReadTokens  += s.cacheReadTokens
        t.cacheCreateTokens += s.cacheCreateTokens
      }

      // Top models — use modelBreakdowns where available, else distribute by modelsUsed
      const modelMap = {}
      for (const s of allSessions) {
        if (s.modelBreakdowns.length > 0) {
          for (const mb of s.modelBreakdowns) {
            const mn = mb.modelName || mb.name || "?"
            if (!modelMap[mn]) modelMap[mn] = { cost: 0, tokens: 0, sessions: 0 }
            modelMap[mn].cost    += mb.cost || 0
            modelMap[mn].tokens  += (mb.inputTokens || 0) + (mb.outputTokens || 0) + (mb.cacheReadTokens || 0)
            modelMap[mn].sessions++
          }
        } else if (s.modelsUsed.length > 0) {
          const n = s.modelsUsed.length
          for (const mn of s.modelsUsed) {
            if (!modelMap[mn]) modelMap[mn] = { cost: 0, tokens: 0, sessions: 0 }
            modelMap[mn].cost    += s.totalCost    / n
            modelMap[mn].tokens  += s.totalTokens  / n
            modelMap[mn].sessions++
          }
        }
      }
      const topModels = Object.entries(modelMap)
        .map(([name, v]) => ({ name, cost: Math.round(v.cost * 100) / 100, tokens: Math.round(v.tokens), sessions: v.sessions }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 10)

      const daySet = new Set(
        allSessions.map(s => (s.firstActivity || s.lastActivity || "").slice(0, 10)).filter(Boolean)
      )

      // Daily aggregates from session firstActivity (best available without ccusage daily)
      const dailyMap = {}
      for (const s of allSessions) {
        const date = (s.firstActivity || s.lastActivity || "").slice(0, 10)
        if (!date) continue
        if (!dailyMap[date]) dailyMap[date] = { claude: 0, opencode: 0, codex: 0, copilot: 0, total: 0 }
        dailyMap[date][s.tool] = (dailyMap[date][s.tool] || 0) + s.totalTokens
        dailyMap[date].total += s.totalTokens
      }

      const daily = Object.entries(dailyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, d]) => ({ date, claude: d.claude, opencode: d.opencode, codex: d.codex, copilot: d.copilot, total: d.total }))

      // Repos
      const repoMap = {}
      for (const s of allSessions) {
        const key = s.dir || s.sessionId || "unknown"
        if (!repoMap[key]) repoMap[key] = { path: s.dir, tokens: 0, cost: 0, sessions: 0, tools: new Set() }
        repoMap[key].tokens += s.totalTokens
        repoMap[key].cost   += s.totalCost
        repoMap[key].sessions++
        repoMap[key].tools.add(s.tool)
      }
      const repos = Object.values(repoMap)
        .map(r => ({ ...r, tools: [...r.tools] }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 20)

      // Peak hour — which hour of day had the most sessions started
      const hourCounts = new Array(24).fill(0)
      for (const s of allSessions) {
        const ts = s.firstActivity || s.lastActivity
        if (!ts) continue
        const h = new Date(ts).getHours()
        hourCounts[h]++
      }
      const peakHour = hourCounts.indexOf(Math.max(...hourCounts))
      const peakHourLabel = peakHour === 0 ? "12 AM"
        : peakHour < 12 ? `${peakHour} AM`
        : peakHour === 12 ? "12 PM"
        : `${peakHour - 12} PM`

      // Streaks — consecutive active days (using daily map keys)
      const activeDatesSorted = [...daySet].sort()
      let curStreak = 0, maxStreak = 0, streakEnd = ""
      for (let i = 0; i < activeDatesSorted.length; i++) {
        const prev = activeDatesSorted[i - 1]
        const cur  = activeDatesSorted[i]
        const diff = prev
          ? (new Date(cur) - new Date(prev)) / 86400000
          : 1
        curStreak = diff === 1 ? curStreak + 1 : 1
        if (curStreak > maxStreak) { maxStreak = curStreak; streakEnd = cur }
      }
      // Current streak: count back from today
      let currentStreak = 0
      const todayStr = new Date().toISOString().slice(0, 10)
      for (let i = activeDatesSorted.length - 1; i >= 0; i--) {
        const expected = new Date(Date.now() - currentStreak * 86400000).toISOString().slice(0, 10)
        if (activeDatesSorted[i] === expected) currentStreak++
        else break
      }

      // Favorite tool — most tokens
      const toolTotals = { claude: 0, opencode: 0, codex: 0, copilot: 0 }
      for (const s of allSessions) toolTotals[s.tool] = (toolTotals[s.tool] || 0) + s.totalTokens
      const favTool = Object.entries(toolTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "claude"
      const favToolLabel = { claude: "Claude Code", opencode: "OpenCode", codex: "Codex", copilot: "Copilot" }[favTool] ?? favTool

      const result = {
        summary: {
          totalTokens, totalCost,
          inputTokens: totalInput, outputTokens: totalOutput,
          cacheReadTokens: totalCacheRead, cacheCreateTokens: totalCacheCreate,
          cacheHitPct,
          sessions: allSessions.length, activeDays: daySet.size,
          peakHour: peakHourLabel,
          currentStreak, longestStreak: maxStreak,
          favTool: favToolLabel,
          hourCounts,
          byTool: toolBreakdown,
          topModels,
        },
        daily,
        repos,
      }
      try { fs.writeFileSync(USAGE_CACHE, JSON.stringify({ ...result, _ts: Date.now() })) } catch {}
      const axonMsg = computeAxonStats()
      const axonDirect = await computeAxonDirectStats()
      result.axon = axonMsg ? { ...axonMsg, ...axonDirect } : axonDirect
      return respond(res, 200, result)
    } catch (e) { return respond(res, 500, { error: e.message }) }
  }

  // ── Insights backfill ─────────────────────────────────────────────────────
  if (url.pathname === "/api/insights/backfill/start" && req.method === "POST") {
    if (_backfill.running) return respond(res, 200, { status: "already_running", ..._backfill })
    const model = url.searchParams.get("model") || null
    runBackfillAll({ model }).catch(e => console.error("[backfill] unhandled:", e.message))
    return respond(res, 200, { status: "started" })
  }

  if (url.pathname === "/api/insights/backfill/status" && req.method === "GET") {
    return respond(res, 200, { ..._backfill })
  }

  if (url.pathname === "/api/insights/recurring-themes" && req.method === "GET") {
    try {
      const themes = await getRecurringThemes()
      return respond(res, 200, { themes })
    } catch (e) {
      return respond(res, 500, { error: e.message })
    }
  }

  // ── Copilot connection status ─────────────────────────────────────────────
  if (url.pathname === "/api/copilot/status" && req.method === "GET") {
    try {
      const token = getOAuthToken()
      if (token) {
        // Verify it actually works by exchanging for a bearer
        try {
          await getCopilotBearer()
          return respond(res, 200, { connected: true, source: token.startsWith("ghu_") ? "github-oauth" : "token" })
        } catch {
          return respond(res, 200, { connected: false, reason: "Token found but exchange failed" })
        }
      }
      return respond(res, 200, { connected: false, reason: "No GitHub Copilot token found" })
    } catch (e) { return respond(res, 200, { connected: false, reason: e.message }) }
  }

  // ── Copilot device auth start ─────────────────────────────────────────────
  if (url.pathname === "/api/copilot/auth/start" && req.method === "POST") {
    try {
      const r = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "Iv1.b507a08c87ecfe98", scope: "copilot" }),
      })
      const d = await r.json()
      if (!d.device_code) return respond(res, 500, { error: d.error_description || "Device flow failed" })
      _deviceAuth = { device_code: d.device_code, interval: d.interval || 5, expiresAt: Date.now() + (d.expires_in || 900) * 1000, done: false, token: null }
      return respond(res, 200, { user_code: d.user_code, verification_uri: d.verification_uri, interval: d.interval || 5, expires_in: d.expires_in || 900 })
    } catch (e) { return respond(res, 500, { error: e.message }) }
  }

  // ── Copilot device auth poll ──────────────────────────────────────────────
  if (url.pathname === "/api/copilot/auth/poll" && req.method === "GET") {
    if (!_deviceAuth.device_code) return respond(res, 400, { status: "no_session" })
    if (_deviceAuth.done) return respond(res, 200, { status: "done" })
    if (Date.now() > _deviceAuth.expiresAt) return respond(res, 200, { status: "expired" })
    try {
      const r = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: "Iv1.b507a08c87ecfe98", device_code: _deviceAuth.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      })
      const d = await r.json()
      if (d.access_token) {
        // Save token to ~/.config/github-copilot/hosts.json
        const configDir = path.join(HOME, ".config", "github-copilot")
        try {
          fs.mkdirSync(configDir, { recursive: true })
          const hostsPath = path.join(configDir, "hosts.json")
          const existing = fs.existsSync(hostsPath) ? JSON.parse(fs.readFileSync(hostsPath, "utf8")) : {}
          existing["github.com"] = { ...(existing["github.com"] || {}), oauth_token: d.access_token }
          fs.writeFileSync(hostsPath, JSON.stringify(existing, null, 2))
        } catch {}
        _deviceAuth.done = true
        _deviceAuth.token = d.access_token
        _copilotToken.bearer = null  // force re-exchange with new token
        return respond(res, 200, { status: "done" })
      }
      if (d.error === "authorization_pending") return respond(res, 200, { status: "pending" })
      if (d.error === "slow_down") return respond(res, 200, { status: "pending", slow: true })
      return respond(res, 200, { status: "error", error: d.error_description || d.error })
    } catch (e) { return respond(res, 500, { error: e.message }) }
  }

  // ── Copilot models list ───────────────────────────────────────────────────
  if (url.pathname === "/api/copilot/models" && req.method === "GET") {
    try {
      const models = await getCopilotModels()
      return respond(res, 200, { models })
    } catch (e) { return respond(res, 200, { models: [], error: e.message }) }
  }

  // ── On-demand session insights ────────────────────────────────────────────
  if (url.pathname === "/api/session-insights" && req.method === "GET") {
    const refresh = url.searchParams.get("refresh") === "1"
    const model   = url.searchParams.get("model") || null
    try {
      if (!refresh && fs.existsSync(INSIGHTS_CACHE)) {
        try {
          const c = JSON.parse(fs.readFileSync(INSIGHTS_CACHE, "utf8"))
          if (Date.now() - c._ts < INSIGHTS_TTL) { delete c._ts; return respond(res, 200, c) }
        } catch {}
      }
      const result = await runInsightsAnalysis({ forceWindow: null, model })
      if (result) {
        try { fs.writeFileSync(INSIGHTS_CACHE, JSON.stringify({ ...result, _ts: Date.now() })) } catch {}
      }
      return respond(res, 200, result || { error: "No session data found in recent history" })
    } catch (e) { return respond(res, 500, { error: e.message }) }
  }

  // ── Insights history (for graph) ──────────────────────────────────────────
  if (url.pathname === "/api/insights-history" && req.method === "GET") {
    try {
      const records = readInsightsHistory()
      return respond(res, 200, { records })
    } catch (e) { return respond(res, 500, { error: e.message }) }
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
  scheduleInsightsCron()
})
