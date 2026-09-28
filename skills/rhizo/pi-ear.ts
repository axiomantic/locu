/**
 * pi-ear.ts — Native TypeScript Extension for Pi Coding Agent (pi.dev / @earendil-works/pi-coding-agent)
 *
 * Automatically loaded by Pi from ~/.pi/agent/extensions/*.ts (or project .pi/extensions/)
 * via jiti without compilation.
 *
 * Responsibilities:
 * 1. Automatically binds Pi session ID to Locutus agent identity ("pi:<sessionId>" -> "<agent>").
 * 2. Injects LOCUTUS_SESSION_ID and LOCUTUS_AGENT_NAME into tool execution environments.
 * 3. Runs an asynchronous background ear streaming `locutus listen <agent> 0`.
 * 4. Stimulates Pi's conversation turn loop when messages arrive.
 * 5. Handles urgent in-flight preemption for `--immediate` tasks.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

export interface LocutusMessagePayload {
  id: string
  from: string
  to: string
  type: string
  subject: string
  body: string
  urgency?: "immediate" | "soon"
  host?: string
  timestamp?: string
}

export function getLocutusBin(): string {
  if (process.env.LOCUTUS_BIN && existsSync(process.env.LOCUTUS_BIN)) {
    return process.env.LOCUTUS_BIN
  }
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const candidates = [
    join(home, ".local", "bin", "locutus"),
    join(home, ".nimble", "bin", "locutus"),
    "/opt/homebrew/bin/locutus",
    "/usr/local/bin/locutus",
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return "locutus"
}

export function getSessionsFile(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const dir = join(home, ".config", "locutus")
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  return join(dir, "sessions.json")
}

export function loadLocalSessionMap(): Record<string, any> {
  const file = getSessionsFile()
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch {}
  }
  return {}
}

export function saveLocalSessionMapping(sessionKey: string, agentName: string): void {
  const file = getSessionsFile()
  const map = loadLocalSessionMap()
  map[sessionKey] = {
    agent: agentName,
    updated_at: new Date().toISOString(),
  }
  try {
    writeFileSync(file, JSON.stringify(map, null, 2))
  } catch (err: any) {
    console.error(`[locutus-pi-ear] could not save session mapping: ${err?.message}`)
  }
}

export function removeLocalSessionMapping(sessionKey: string): void {
  const file = getSessionsFile()
  const map = loadLocalSessionMap()
  if (map[sessionKey]) {
    delete map[sessionKey]
    try {
      writeFileSync(file, JSON.stringify(map, null, 2))
    } catch (err: any) {
      console.error(`[locutus-pi-ear] could not remove session mapping: ${err?.message}`)
    }
  }
}

export function sanitizeAgentName(name: string): string {
  if (!name) return ""
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)
}

export function resolveSessionAgent(sessionId: string, fallbackTitle?: string): string {
  if (process.env.LOCUTUS_AGENT_NAME) return process.env.LOCUTUS_AGENT_NAME
  const sessionKey = `pi:${sessionId}`
  const map = loadLocalSessionMap()
  if (map[sessionKey]) {
    const val = map[sessionKey]
    return typeof val === "string" ? val : val.agent || val.agent_name || ""
  }
  const cleanTitle = sanitizeAgentName(fallbackTitle || "")
  const autoName = cleanTitle && cleanTitle.length >= 3 ? cleanTitle : `pi-${sessionId.slice(-8)}`
  saveLocalSessionMapping(sessionKey, autoName)
  return autoName
}

export function resolveMessageUrgency(text: string): "immediate" | "soon" {
  try {
    const jsonStart = text.indexOf("{")
    if (jsonStart >= 0) {
      const parsed = JSON.parse(text.slice(jsonStart))
      const u = String(parsed.urgency || parsed.delivery || "").toLowerCase()
      if (u === "immediate" || u === "now" || u === "urgent") return "immediate"
    }
  } catch {}
  return "soon"
}

export async function deliverPiPrompt(pi: any, text: string): Promise<void> {
  if (typeof pi?.sendMessage === "function") {
    await pi.sendMessage(text)
  } else if (typeof pi?.sendPrompt === "function") {
    await pi.sendPrompt(text)
  } else if (typeof pi?.session?.promptAsync === "function") {
    await pi.session.promptAsync({ body: { parts: [{ type: "text", text }] } })
  } else if (typeof pi?.session?.prompt === "function") {
    await pi.session.prompt({ body: { parts: [{ type: "text", text }] } })
  } else {
    // Fallback: emit to standard output
    console.log(text)
  }
}

export async function interruptPiIfBusy(pi: any): Promise<void> {
  if (process.env.LOCUTUS_INTERRUPT === "0") return
  try {
    if (typeof pi?.abort === "function") {
      await pi.abort()
    } else if (typeof pi?.session?.abort === "function") {
      await pi.session.abort()
    }
  } catch (err: any) {
    console.error(`[locutus-pi-ear] could not abort Pi session: ${err?.message}`)
  }
}

/**
 * Main Pi Extension entrypoint.
 * Registered by Pi during startup.
 */
export default function LocutusPiExtension(pi: any) {
  if (process.env.LOCUTUS_EAR_DISABLED === "1") return {}

  const locutusBin = getLocutusBin()
  let activeProc: any = null
  let running = true

  // 1. Register locutus CLI tool natively in Pi
  if (typeof pi?.registerTool === "function") {
    pi.registerTool({
      name: "locutus",
      description: "Inter-agent communication bus, distributed locks, queues, and task dispatch over Redis.",
      parameters: {
        type: "object",
        properties: {
          subcommand: {
            type: "string",
            description: "Subcommand to execute (open, send, reply, broadcast, request, claim, ack, status, who)",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Arguments to pass to locutus CLI",
          },
        },
        required: ["subcommand"],
      },
      execute: async ({ subcommand, args = [] }: { subcommand: string; args?: string[] }) => {
        const fullArgs = [subcommand, ...args]
        const res = spawnSync(locutusBin, fullArgs, { encoding: "utf8" })
        return {
          stdout: res.stdout,
          stderr: res.stderr,
          exitCode: res.status,
        }
      },
    })
  }

  // 2. Lifecycle hooks
  const onSessionStart = async (sessionInfo?: any) => {
    const sessionId = sessionInfo?.id || sessionInfo?.sessionId || "default"
    const title = sessionInfo?.title || ""
    const agentName = resolveSessionAgent(sessionId, title)

    // Set process environment for child tools
    process.env.LOCUTUS_SESSION_ID = `pi:${sessionId}`
    process.env.LOCUTUS_AGENT_NAME = agentName

    // Start background listener fiber
    if (activeProc) {
      try { activeProc.kill() } catch {}
      activeProc = null
    }

    const startListener = async () => {
      while (running) {
        try {
          const child = spawn(locutusBin, ["listen", agentName, "0"], {
            stdio: ["ignore", "pipe", "pipe"],
          })
          activeProc = child

          let stdoutData = ""
          child.stdout?.on("data", (chunk) => {
            stdoutData += chunk.toString("utf8")
            let idx: number
            while ((idx = stdoutData.indexOf("\n")) >= 0) {
              const line = stdoutData.slice(0, idx).trim()
              stdoutData = stdoutData.slice(idx + 1)
              if (line) {
                const urgency = resolveMessageUrgency(line)
                ;(async () => {
                  if (urgency === "immediate") {
                    await interruptPiIfBusy(pi)
                  }
                  let promptText = `[locutus:${agentName}] ${line}`
                  try {
                    const parsed = JSON.parse(line)
                    const from = parsed.from || "unknown"
                    const host = parsed.host ? ` [host: ${parsed.host}]` : ""
                    const subj = parsed.subject ? ` (subject: "${parsed.subject}")` : ""
                    const urg = (parsed.urgency === "immediate") ? " [URGENT: IMMEDIATE]" : ""
                    const body = parsed.body || ""
                    promptText = `[LOCUTUS BUS message for @${agentName} from @${from}${host}${subj}${urg}]:\n${body}`
                  } catch {}
                  await deliverPiPrompt(pi, promptText)
                })()
              }
            }
          })

          await new Promise((resolve) => {
            child.on("close", resolve)
            child.on("error", resolve)
          })

          if (!running) break
          // Small backoff before restart
          await new Promise((r) => setTimeout(r, 500))
        } catch {
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }

    startListener().catch(() => {})
  }

  if (typeof pi?.on === "function") {
    pi.on("session_start", onSessionStart)
    pi.on("session.start", onSessionStart)
    pi.on("session_end", () => {
      running = false
      if (activeProc) {
        try { activeProc.kill() } catch {}
      }
      if (process.env.LOCUTUS_SESSION_ID) {
        removeLocalSessionMapping(process.env.LOCUTUS_SESSION_ID)
      }
    })
  }

  // Initial trigger if session already active
  if (pi?.session?.id) {
    onSessionStart(pi.session)
  }

  return {
    name: "locutus-pi-ear",
    cleanup: () => {
      running = false
      if (activeProc) {
        try { activeProc.kill() } catch {}
      }
    }
  }
}
