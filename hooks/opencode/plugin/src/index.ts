import type { Plugin } from "@opencode-ai/plugin"
import type { TextPart } from "@opencode-ai/sdk"
import { writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const LOG_DIR = process.env["AI_CHAT_LOG_DIR"] ?? join(homedir(), "ai-chats")

function sessionFile(sessionID: string) {
  const dir = join(LOG_DIR, "sessions")
  mkdirSync(dir, { recursive: true })
  return join(dir, `opencode-${sessionID}.jsonl`)
}

export const server: Plugin = async ({ client }) => ({
  // session.idle fires when the AI finishes responding.
  // We fetch the full message list and overwrite the session file,
  // so there are no duplicates across multiple turns.
  async event({ event }) {
    if (event.type !== "session.idle") return

    const { sessionID } = event.properties
    const res = await client.session.messages({ path: { id: sessionID } })
    if (!res.data) return

    const lines: string[] = []
    for (const { info: msg, parts } of res.data) {
      const ts = new Date(msg.time.created).toISOString()
      const text = parts
        .filter((p): p is TextPart => p.type === "text" && !p.synthetic)
        .map(p => p.text)
        .join("")
      if (text.trim()) {
        lines.push(JSON.stringify({
          ts,
          tool: "opencode",
          session: sessionID,
          role: msg.role,
          content: text,
        }))
      }
    }

    writeFileSync(sessionFile(sessionID), lines.join("\n") + "\n")
  },
})
