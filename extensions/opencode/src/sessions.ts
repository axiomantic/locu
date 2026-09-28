// extensions/opencode/src/sessions.ts
// Manages global session-to-agent mapping in ~/.config/locutus/sessions.json.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import type { SessionMap, SessionEntry } from "./types"

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

export function getSessionsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  return join(home, ".config", "locutus", "sessions.json")
}

export function readLocalSessionMap(): SessionMap {
  try {
    return JSON.parse(readFileSync(getSessionsPath(), "utf8")) as SessionMap
  } catch {
    return {}
  }
}

export function getMappedAgent(sessionKey: string): string | null {
  const map = readLocalSessionMap()
  const entry = map[sessionKey]
  if (!entry) return null
  if (typeof entry === "string") return entry
  if (entry.status && entry.status === "closed") return null
  return entry.agent || null
}

export function isSessionSupposedToListen(sessionId?: string | null): string | null {
  if (!sessionId) return null

  const sessionKey = `opencode:${sessionId}`
  const map = readLocalSessionMap()
  const entry = map[sessionKey]

  // If explicitly closed or disabled, must not listen
  if (entry && typeof entry === "object" && (entry.status === "closed" || entry.disabled === true)) {
    return null
  }

  if (process.env.LOCUTUS_AGENT_NAME) return process.env.LOCUTUS_AGENT_NAME

  if (!entry) return null
  const name = typeof entry === "string" ? entry : entry.agent
  return name || null
}

export function getSessionIdForAgent(agentName: string): string | null {
  const map = readLocalSessionMap()
  for (const [key, val] of Object.entries(map)) {
    if (typeof val === "object" && val.status === "closed") continue
    const name = typeof val === "string" ? val : val?.agent
    if (name === agentName && key.startsWith("opencode:")) {
      return key.slice("opencode:".length)
    }
  }
  return null
}

export function setMappedAgent(sessionKey: string, agentName: string, status = "active"): void {
  try {
    const p = getSessionsPath()
    mkdirSync(dirname(p), { recursive: true })
    const map = readLocalSessionMap()
    map[sessionKey] = {
      agent: agentName,
      status: status,
      updated_at: new Date().toISOString()
    }
    writeFileSync(p, JSON.stringify(map, null, 2) + "\n")
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[locutus-ear] could not write session mapping:", msg)
  }
}

export function closeSessionAgent(sessionKey: string): void {
  try {
    const p = getSessionsPath()
    const map = readLocalSessionMap()
    if (map[sessionKey]) {
      if (typeof map[sessionKey] === "object") {
        (map[sessionKey] as SessionEntry).status = "closed";
        (map[sessionKey] as SessionEntry).closed_at = new Date().toISOString()
      } else {
        map[sessionKey] = {
          agent: map[sessionKey] as string,
          status: "closed",
          closed_at: new Date().toISOString()
        }
      }
      writeFileSync(p, JSON.stringify(map, null, 2) + "\n")
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[locutus-ear] could not close session mapping:", msg)
  }
}

export function removeMappedAgent(sessionKey: string): void {
  try {
    const p = getSessionsPath()
    const map = readLocalSessionMap()
    if (map[sessionKey]) {
      delete map[sessionKey]
      writeFileSync(p, JSON.stringify(map, null, 2) + "\n")
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[locutus-ear] could not remove session mapping:", msg)
  }
}

export function sanitizeAgentName(name?: string | null): string {
  if (!name) return ""
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)
}

export function resolveSessionAgent(sessionId?: string | null, fallbackName?: string | null): string {
  if (sessionId) {
    const map = readLocalSessionMap()
    const entry = map[`opencode:${sessionId}`]
    if (entry && typeof entry === "object" && (entry.status === "closed" || entry.disabled === true)) {
      return ""
    }
    const supposed = isSessionSupposedToListen(sessionId)
    if (supposed) return supposed
  }
  if (process.env.LOCUTUS_AGENT_NAME) return process.env.LOCUTUS_AGENT_NAME
  if (sessionId) {
    const sanitized = sanitizeAgentName(fallbackName)
    const autoName = sanitized && sanitized.length >= 3 ? sanitized : `opencode-${sessionId.slice(-8)}`
    setMappedAgent(`opencode:${sessionId}`, autoName, "active")
    return autoName
  }
  return ""
}
