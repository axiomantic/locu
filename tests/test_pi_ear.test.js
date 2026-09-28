// tests/test_pi_ear.test.js
// Tests for Pi Coding Agent extension: tool registration, session mapping, and prompt delivery.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import LocutusPiExtension, {
  resolveMessageUrgency,
  resolveSessionAgent,
  sanitizeAgentName,
  saveLocalSessionMapping,
  removeLocalSessionMapping,
  deliverPiPrompt,
  interruptPiIfBusy,
} from "../skills/locutus/pi-ear.ts"

describe("Pi Coding Agent Extension (pi-ear.ts)", () => {
  let tempHome
  let originalHome

  beforeEach(() => {
    tempHome = join(tmpdir(), "locutus-pi-test-home-" + Math.random().toString(36).slice(2))
    mkdirSync(join(tempHome, ".config", "locutus"), { recursive: true })
    originalHome = process.env.HOME
    process.env.HOME = tempHome
  })

  afterEach(() => {
    process.env.HOME = originalHome
    delete process.env.LOCUTUS_AGENT_NAME
    delete process.env.LOCUTUS_SESSION_ID
    try {
      rmSync(tempHome, { recursive: true, force: true })
    } catch {}
  })

  it("exports main function and respects LOCUTUS_EAR_DISABLED", () => {
    expect(typeof LocutusPiExtension).toBe("function")
    const prev = process.env.LOCUTUS_EAR_DISABLED
    try {
      process.env.LOCUTUS_EAR_DISABLED = "1"
      const res = LocutusPiExtension({})
      expect(res).toEqual({})
    } finally {
      if (prev === undefined) delete process.env.LOCUTUS_EAR_DISABLED
      else process.env.LOCUTUS_EAR_DISABLED = prev
    }
  })

  it("correctly registers locutus tool with Pi", () => {
    let registeredTool = null
    const mockPi = {
      registerTool: (toolDef) => {
        registeredTool = toolDef
      },
      on: () => {},
    }

    LocutusPiExtension(mockPi)
    expect(registeredTool).not.toBeNull()
    expect(registeredTool.name).toBe("locutus")
    expect(registeredTool.parameters.required).toContain("subcommand")
    expect(typeof registeredTool.execute).toBe("function")
  })

  it("binds session to agent name and persists in sessions.json", () => {
    const sessionsPath = join(tempHome, ".config", "locutus", "sessions.json")
    const events = {}
    const mockPi = {
      on: (event, handler) => {
        events[event] = handler
      },
    }

    LocutusPiExtension(mockPi)
    expect(typeof events["session_start"]).toBe("function")

    // Trigger session_start
    events["session_start"]({ id: "ses_pi_100", title: "feature-refactor" })

    expect(process.env.LOCUTUS_SESSION_ID).toBe("pi:ses_pi_100")
    expect(process.env.LOCUTUS_AGENT_NAME).toBe("feature-refactor")

    expect(existsSync(sessionsPath)).toBe(true)
    const map = JSON.parse(readFileSync(sessionsPath, "utf8"))
    expect(map["pi:ses_pi_100"]).toBeDefined()
    expect(map["pi:ses_pi_100"].agent).toBe("feature-refactor")

    // Trigger session_end
    expect(typeof events["session_end"]).toBe("function")
    events["session_end"]()

    const mapAfter = JSON.parse(readFileSync(sessionsPath, "utf8"))
    expect(mapAfter["pi:ses_pi_100"]).toBeUndefined()
  })

  it("resolveMessageUrgency correctly detects immediate vs soon", () => {
    expect(resolveMessageUrgency('{"urgency":"immediate"}')).toBe("immediate")
    expect(resolveMessageUrgency('{"urgency":"urgent"}')).toBe("immediate")
    expect(resolveMessageUrgency('{"urgency":"now"}')).toBe("immediate")
    expect(resolveMessageUrgency('{"delivery":"immediate"}')).toBe("immediate")
    expect(resolveMessageUrgency('{"urgency":"soon"}')).toBe("soon")
    expect(resolveMessageUrgency('{"urgency":"routine"}')).toBe("soon")
    expect(resolveMessageUrgency('raw string')).toBe("soon")
  })

  it("deliverPiPrompt invokes sendMessage, sendPrompt, or session.prompt", async () => {
    let sentMessage = null
    const clientA = {
      sendMessage: async (msg) => { sentMessage = msg }
    }
    await deliverPiPrompt(clientA, "Hello from Locutus")
    expect(sentMessage).toBe("Hello from Locutus")

    let sentPrompt = null
    const clientB = {
      sendPrompt: async (msg) => { sentPrompt = msg }
    }
    await deliverPiPrompt(clientB, "Prompt turn")
    expect(sentPrompt).toBe("Prompt turn")

    let promptPayload = null
    const clientC = {
      session: {
        promptAsync: async (p) => { promptPayload = p }
      }
    }
    await deliverPiPrompt(clientC, "Session payload")
    expect(promptPayload).toEqual({ body: { parts: [{ type: "text", text: "Session payload" }] } })
  })

  it("interruptPiIfBusy triggers abort unless LOCUTUS_INTERRUPT=0", async () => {
    let aborted = false
    const client = {
      abort: async () => { aborted = true }
    }

    await interruptPiIfBusy(client)
    expect(aborted).toBe(true)

    // With LOCUTUS_INTERRUPT=0
    const prev = process.env.LOCUTUS_INTERRUPT
    try {
      process.env.LOCUTUS_INTERRUPT = "0"
      aborted = false
      await interruptPiIfBusy(client)
      expect(aborted).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.LOCUTUS_INTERRUPT
      else process.env.LOCUTUS_INTERRUPT = prev
    }
  })
})
