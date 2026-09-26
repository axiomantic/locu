// tests/test_opencode_ear.test.js
// Tests for OpenCode ear plugin session mapping, environment injection, and lifecycle hooks.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import LocutusEar from "../skills/locutus/opencode-ear.js"

describe("opencode-ear plugin", () => {
  let tempHome
  let originalHome

  beforeEach(() => {
    tempHome = join(tmpdir(), "locutus-test-home-" + Math.random().toString(36).slice(2))
    mkdirSync(join(tempHome, ".config", "locutus"), { recursive: true })
    originalHome = process.env.HOME
    process.env.HOME = tempHome
  })

  afterEach(() => {
    process.env.HOME = originalHome
    try {
      rmSync(tempHome, { recursive: true, force: true })
    } catch {}
  })

  it("exports a default function and handles LOCUTUS_EAR_DISABLED", async () => {
    expect(typeof LocutusEar).toBe("function")
    const prev = process.env.LOCUTUS_EAR_DISABLED
    try {
      process.env.LOCUTUS_EAR_DISABLED = "1"
      const res = await LocutusEar({ client: {}, directory: tempHome })
      expect(res).toEqual({})
    } finally {
      if (prev === undefined) delete process.env.LOCUTUS_EAR_DISABLED
      else process.env.LOCUTUS_EAR_DISABLED = prev
    }
  })

  it("injects LOCUTUS_SESSION_ID and LOCUTUS_AGENT_NAME via shell.env hook", async () => {
    // Pre-populate a session mapping
    const sessionsPath = join(tempHome, ".config", "locutus", "sessions.json")
    const initialSessions = {
      "opencode:ses_test_abc": {
        agent: "lead-dev",
        updated_at: new Date().toISOString()
      }
    }
    writeFileSync(sessionsPath, JSON.stringify(initialSessions, null, 2))

    const mockClient = {
      session: {
        list: async () => [{ id: "ses_test_abc", title: "Test Session" }]
      }
    }

    const hooks = await LocutusEar({ client: mockClient, directory: tempHome })
    expect(typeof hooks["shell.env"]).toBe("function")

    const output = { env: {} }
    await hooks["shell.env"]({ sessionID: "ses_test_abc" }, output)

    expect(output.env.LOCUTUS_SESSION_ID).toBe("opencode:ses_test_abc")
    expect(output.env.LOCUTUS_AGENT_NAME).toBe("lead-dev")
  })

  it("auto-assigns agent name for unmapped sessions and cleans up on session.deleted", async () => {
    const sessionsPath = join(tempHome, ".config", "locutus", "sessions.json")
    const mockClient = {
      session: {
        list: async () => []
      }
    }

    const hooks = await LocutusEar({ client: mockClient, directory: tempHome })
    const output = { env: {} }
    await hooks["shell.env"]({ sessionID: "ses_new_999" }, output)

    expect(output.env.LOCUTUS_SESSION_ID).toBe("opencode:ses_new_999")
    expect(output.env.LOCUTUS_AGENT_NAME).toBe("opencode-_new_999")

    // Verify it was written to global sessions.json
    expect(existsSync(sessionsPath)).toBe(true)
    const saved = JSON.parse(readFileSync(sessionsPath, "utf8"))
    expect(saved["opencode:ses_new_999"]).toBeDefined()
    expect(saved["opencode:ses_new_999"].agent).toBe("opencode-_new_999")

    // Fire session.deleted event
    await hooks.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "ses_new_999" } }
      }
    })

    const afterDelete = JSON.parse(readFileSync(sessionsPath, "utf8"))
    expect(afterDelete["opencode:ses_new_999"]).toBeUndefined()
  })

  it("interruptSessionIfBusy aborts busy session unless LOCUTUS_INTERRUPT=0", async () => {
    let abortedId = null
    let statusCallCount = 0

    const mockClient = {
      session: {
        status: async () => {
          statusCallCount++
          return statusCallCount === 1
            ? { "ses_busy_1": { type: "busy" } }
            : { "ses_busy_1": { type: "idle" } }
        },
        abort: async ({ path }) => {
          abortedId = path.id
        }
      }
    }

    // Default: when called on a busy session, aborts it
    await LocutusEar.interruptSessionIfBusy(mockClient, "ses_busy_1")
    expect(abortedId).toBe("ses_busy_1")

    // Idle session: should NOT call abort
    abortedId = null
    const idleClient = {
      session: {
        status: async () => ({ "ses_idle_1": { type: "idle" } }),
        abort: async ({ path }) => { abortedId = path.id }
      }
    }
    await LocutusEar.interruptSessionIfBusy(idleClient, "ses_idle_1")
    expect(abortedId).toBeNull()

    // LOCUTUS_INTERRUPT=0 disables abort even when busy
    const prevInterrupt = process.env.LOCUTUS_INTERRUPT
    try {
      process.env.LOCUTUS_INTERRUPT = "0"
      abortedId = null
      const busyClient = {
        session: {
          status: async () => ({ "ses_busy_2": { type: "busy" } }),
          abort: async ({ path }) => { abortedId = path.id }
        }
      }
      await LocutusEar.interruptSessionIfBusy(busyClient, "ses_busy_2")
      expect(abortedId).toBeNull()
    } finally {
      if (prevInterrupt === undefined) delete process.env.LOCUTUS_INTERRUPT
      else process.env.LOCUTUS_INTERRUPT = prevInterrupt
    }
  })

  it("deliverPrompt prefers promptAsync and falls back to prompt", async () => {
    let promptAsyncCalled = null
    let promptCalled = null

    const modernClient = {
      session: {
        promptAsync: async (payload) => { promptAsyncCalled = payload },
        prompt: async (payload) => { promptCalled = payload }
      }
    }

    await LocutusEar.deliverPrompt(modernClient, "ses_1", "Hello from Locutus")
    expect(promptAsyncCalled).toEqual({
      path: { id: "ses_1" },
      body: { parts: [{ type: "text", text: "Hello from Locutus" }] }
    })
    expect(promptCalled).toBeNull()

    // Fallback client with only prompt
    const legacyClient = {
      session: {
        prompt: async (payload) => { promptCalled = payload }
      }
    }
    await LocutusEar.deliverPrompt(legacyClient, "ses_2", "Fallback turn")
    expect(promptCalled).toEqual({
      path: { id: "ses_2" },
      body: { parts: [{ type: "text", text: "Fallback turn" }] }
    })
  })

  it("resolveMessageUrgency correctly parses immediate vs soon", () => {
    expect(LocutusEar.resolveMessageUrgency('[locutus:agent] {"id":"123","urgency":"immediate"}')).toBe("immediate")
    expect(LocutusEar.resolveMessageUrgency('[locutus:agent] {"id":"123","delivery":"immediate"}')).toBe("immediate")
    expect(LocutusEar.resolveMessageUrgency('[locutus:agent] {"id":"123","urgency":"now"}')).toBe("immediate")
    expect(LocutusEar.resolveMessageUrgency('[locutus:agent] {"id":"123","urgency":"urgent"}')).toBe("immediate")
    expect(LocutusEar.resolveMessageUrgency('[locutus:agent] {"id":"123","urgency":"soon"}')).toBe("soon")
    expect(LocutusEar.resolveMessageUrgency('[locutus:agent] {"id":"123","delivery":"soon"}')).toBe("soon")
    expect(LocutusEar.resolveMessageUrgency('[locutus:agent] {"id":"123"}')).toBe("soon")
    expect(LocutusEar.resolveMessageUrgency('raw text without json')).toBe("soon")
  })

  it("verifies and resumes listeners only for active sessions and ignores closed ones", async () => {
    const sessionsPath = join(tempHome, ".config", "locutus", "sessions.json")
    const testSessions = {
      "opencode:ses_active": {
        agent: "worker-active",
        status: "active",
        updated_at: new Date().toISOString()
      },
      "opencode:ses_closed": {
        agent: "worker-closed",
        status: "closed",
        closed_at: new Date().toISOString()
      }
    }
    writeFileSync(sessionsPath, JSON.stringify(testSessions, null, 2))

    // isSessionSupposedToListen checks
    expect(LocutusEar.isSessionSupposedToListen("ses_active")).toBe("worker-active")
    expect(LocutusEar.isSessionSupposedToListen("ses_closed")).toBeNull()
    expect(LocutusEar.isSessionSupposedToListen("ses_unregistered")).toBeNull()

    const mockClient = {
      session: {
        list: async () => [
          { id: "ses_active", title: "Active Session" },
          { id: "ses_closed", title: "Closed Session" },
          { id: "ses_unregistered", title: "Scratch Session" }
        ]
      }
    }

    const hooks = await LocutusEar({ client: mockClient, directory: tempHome })

    // Closed session verification should return false and not spawn
    const closedResult = LocutusEar.verifyAndEnsureListener(mockClient, "ses_closed", tempHome)
    expect(closedResult).toBe(false)

    // Unregistered session verification should return false
    const unregResult = LocutusEar.verifyAndEnsureListener(mockClient, "ses_unregistered", tempHome)
    expect(unregResult).toBe(false)

    // Active session verification should return true
    const activeResult = LocutusEar.verifyAndEnsureListener(mockClient, "ses_active", tempHome)
    expect(activeResult).toBe(true)

    // Testing session.resumed event
    await hooks.event({
      event: {
        type: "session.resumed",
        properties: { info: { id: "ses_active" } }
      }
    })

    // Now close the active session explicitly
    LocutusEar.closeSessionAgent("opencode:ses_active")
    expect(LocutusEar.isSessionSupposedToListen("ses_active")).toBeNull()
    const afterCloseResult = LocutusEar.verifyAndEnsureListener(mockClient, "ses_active", tempHome)
    expect(afterCloseResult).toBe(false)
  })
})

