// extensions/opencode/test/sessions.test.ts
// Native TypeScript unit tests for sessions.ts module.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  sanitizeAgentName,
  isSessionSupposedToListen,
  setMappedAgent,
  closeSessionAgent,
  removeMappedAgent,
  readLocalSessionMap
} from "../src/sessions"
import { writeFileSync, unlinkSync, existsSync } from "node:fs"
import { join } from "node:path"

describe("sessions module", () => {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const sessionsPath = join(home, ".config", "locutus", "sessions.json")
  let originalContent: string | null = null

  beforeEach(() => {
    if (existsSync(sessionsPath)) {
      originalContent = readFileSyncSafe(sessionsPath)
    } else {
      originalContent = null
    }
  })

  afterEach(() => {
    if (originalContent !== null) {
      writeFileSync(sessionsPath, originalContent)
    } else if (existsSync(sessionsPath)) {
      unlinkSync(sessionsPath)
    }
  })

  function readFileSyncSafe(p: string): string {
    try {
      const { readFileSync } = require("node:fs")
      return readFileSync(p, "utf8")
    } catch {
      return "{}"
    }
  }

  it("sanitizes agent names according to DNS-like rules", () => {
    expect(sanitizeAgentName("My Agent 123!")).toBe("my-agent-123")
    expect(sanitizeAgentName("---agent---")).toBe("agent")
    expect(sanitizeAgentName("a".repeat(40)).length).toBe(32)
    expect(sanitizeAgentName("")).toBe("")
    expect(sanitizeAgentName(null)).toBe("")
  })

  it("handles active vs closed sessions correctly in isSessionSupposedToListen", () => {
    const testSessionId = `test-sess-${Date.now()}`
    const testKey = `opencode:${testSessionId}`

    setMappedAgent(testKey, "worker-1", "active")
    expect(isSessionSupposedToListen(testSessionId)).toBe("worker-1")

    closeSessionAgent(testKey)
    expect(isSessionSupposedToListen(testSessionId)).toBeNull()

    const map = readLocalSessionMap()
    expect(typeof map[testKey]).toBe("object")
    expect((map[testKey] as any).status).toBe("closed")

    removeMappedAgent(testKey)
    expect(readLocalSessionMap()[testKey]).toBeUndefined()
  })
})
