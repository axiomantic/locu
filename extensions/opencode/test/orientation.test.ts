// extensions/opencode/test/orientation.test.ts
// Native TypeScript unit tests for orientation.ts module.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { getOrientationReminder } from "../src/orientation"
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("orientation module", () => {
  const home = process.env.HOME || process.env.USERPROFILE || ""
  const sessionsPath = join(home, ".config", "locutus", "sessions.json")
  let originalContent: string | null = null

  beforeEach(() => {
    if (existsSync(sessionsPath)) {
      originalContent = readFileSync(sessionsPath, "utf8")
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

  it("returns neutral orientation notice when no active session is provided", () => {
    const notice = getOrientationReminder()
    expect(notice).toContain("LOCUTUS NOTICE")
    expect(notice).toContain("braid list")
    expect(notice).toContain("canonical repository root")
  })

  it("returns contextual anchor when session has an active strand_path", () => {
    const testSessionId = `test-strand-${Date.now()}`
    const map = {
      [`opencode:${testSessionId}`]: {
        agent: "worker-t1",
        status: "active",
        task_id: "T-1049",
        strand_path: "/Users/test/workspaces/PebbleOS/T-1049"
      }
    }
    writeFileSync(sessionsPath, JSON.stringify(map, null, 2))

    const anchor = getOrientationReminder(testSessionId)
    expect(anchor).toContain("LOCUTUS CONTEXT ANCHOR")
    expect(anchor).toContain("T-1049")
    expect(anchor).toContain("/Users/test/workspaces/PebbleOS/T-1049")
    expect(anchor).toContain("Do not commit changes to the canonical repository root")
  })

  it("returns contextual anchor when session has an active legacy rifttree_path", () => {
    const testSessionId = `test-rift-${Date.now()}`
    const map = {
      [`opencode:${testSessionId}`]: {
        agent: "worker-t1",
        status: "active",
        task_id: "T-1049",
        rifttree_path: "/Users/test/worktrees/PebbleOS/T-1049"
      }
    }
    writeFileSync(sessionsPath, JSON.stringify(map, null, 2))

    const anchor = getOrientationReminder(testSessionId)
    expect(anchor).toContain("LOCUTUS CONTEXT ANCHOR")
    expect(anchor).toContain("T-1049")
    expect(anchor).toContain("/Users/test/worktrees/PebbleOS/T-1049")
    expect(anchor).toContain("Do not commit changes to the canonical repository root")
  })

  it("falls back to neutral notice if session is closed", () => {
    const testSessionId = `test-closed-${Date.now()}`
    const map = {
      [`opencode:${testSessionId}`]: {
        agent: "worker-t1",
        status: "closed",
        task_id: "T-1049",
        rifttree_path: "/Users/test/worktrees/PebbleOS/T-1049"
      }
    }
    writeFileSync(sessionsPath, JSON.stringify(map, null, 2))

    const notice = getOrientationReminder(testSessionId)
    expect(notice).toContain("LOCUTUS NOTICE")
    expect(notice).not.toContain("LOCUTUS CONTEXT ANCHOR")
  })
})
