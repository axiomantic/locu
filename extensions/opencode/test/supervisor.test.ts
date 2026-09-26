// extensions/opencode/test/supervisor.test.ts
// Native TypeScript unit tests for supervisor.ts module.

import { describe, it, expect } from "bun:test"
import { resolveMessageUrgency } from "../src/supervisor"

describe("supervisor module", () => {
  it("resolves message urgency correctly", () => {
    expect(resolveMessageUrgency('{"urgency":"immediate"}')).toBe("immediate")
    expect(resolveMessageUrgency('{"delivery":"now"}')).toBe("immediate")
    expect(resolveMessageUrgency('{"urgency":"urgent"}')).toBe("immediate")
    expect(resolveMessageUrgency('{"urgency":"soon"}')).toBe("soon")
    expect(resolveMessageUrgency("plain text message")).toBe("soon")
    expect(resolveMessageUrgency("{malformed")).toBe("soon")
  })
})
