import { spawn as nodeSpawn } from "node:child_process"
import { createInterface } from "node:readline"
import {
  getLocutusBin,
  isSessionSupposedToListen,
  resolveSessionAgent,
  getSessionIdForAgent
} from "./sessions"
import type { ListenerState, ActiveListener, OpenCodeClient, SubprocessHandle, OpenCodeSessionInfo } from "./types"

export const activeListeners = new Map<string, ActiveListener>() // agentName -> { state, targetSessionId }
export const sessionToAgent = new Map<string, string>() // sessionId -> agentName

export function isListenerAlive(agentName: string): boolean {
  const listener = activeListeners.get(agentName)
  if (!listener || !listener.state) return false
  if (listener.state.aborted) return false
  if (!listener.state.proc) return false
  const proc = listener.state.proc as any
  if (typeof proc.exitCode === "number" && proc.exitCode !== null) return false
  if (proc.killed) return false
  return true
}

export async function* listenLines(name: string, cwd: string, state: ListenerState): AsyncGenerator<string> {
  let firstSpawnFailure = true
  const bin = getLocutusBin()
  for (;;) {
    if (state?.aborted) break
    let proc: SubprocessHandle | null = null
    try {
      if (typeof Bun !== "undefined" && Bun?.spawn) {
        proc = Bun.spawn([bin, "listen", name], { cwd, stdout: "pipe", stderr: "pipe" }) as unknown as SubprocessHandle
      } else {
        proc = nodeSpawn(bin, ["listen", name], { cwd, stdio: ["ignore", "pipe", "pipe"] }) as unknown as SubprocessHandle
      }
      if (state) state.proc = proc
      firstSpawnFailure = true
    } catch (err: unknown) {
      if (firstSpawnFailure) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error("[locutus-ear] could not spawn `" + bin + " listen`: " + msg)
        firstSpawnFailure = false
      }
      await new Promise((r) => setTimeout(r, 500))
      continue
    }

    if (!proc || !proc.stdout) {
      await new Promise((r) => setTimeout(r, 500))
      continue
    }

    try {
      if (typeof (proc.stdout as any).getReader === "function") {
        // Bun Web ReadableStream
        const dec = new TextDecoder()
        const reader = (proc.stdout as any).getReader()
        let buf = ""
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let i
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            const t = line.trim()
            if (t) yield t
          }
        }
        const t = buf.trim()
        if (t) yield t
      } else {
        // Node.js Readable stream
        const rl = createInterface({ input: proc.stdout as NodeJS.ReadableStream })
        for await (const line of rl) {
          const t = line.trim()
          if (t) yield t
        }
      }
    } catch {
      // stream closed / child killed; fall through and re-arm unless aborted
    }
    if (state?.aborted) break
  }
}

export async function interruptSessionIfBusy(client: OpenCodeClient, sessionId: string): Promise<void> {
  if (process.env.LOCUTUS_INTERRUPT === "0") return
  if (!client?.session) return

  try {
    let isBusy = false
    if (typeof client.session.status === "function") {
      const statusRes = await client.session.status()
      const statuses = (statusRes && statusRes.data) || statusRes || {}
      const current = statuses[sessionId]
      if (current && (current.type === "busy" || current.type === "retry")) {
        isBusy = true
      }
    }

    if (isBusy && typeof client.session.abort === "function") {
      console.error(`[locutus-ear] session ${sessionId} is busy; aborting to deliver Locutus message...`)
      await client.session.abort({ path: { id: sessionId } })
      // Wait briefly for OpenCode fiber to transition to idle
      for (let i = 0; i < 7; i++) {
        await new Promise((r) => setTimeout(r, 50))
        if (typeof client.session.status === "function") {
          const sRes = await client.session.status().catch(() => null)
          const sMap = (sRes && sRes.data) || sRes || {}
          if (!sMap[sessionId] || sMap[sessionId].type === "idle") break
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[locutus-ear] could not interrupt session ${sessionId}:`, msg)
  }
}

export async function deliverPrompt(client: OpenCodeClient, sessionId: string, text: string): Promise<void> {
  const payload = {
    path: { id: sessionId },
    body: { parts: [{ type: "text", text }] },
  }

  if (typeof client?.session?.promptAsync === "function") {
    await client.session.promptAsync(payload)
  } else if (typeof client?.session?.prompt === "function") {
    await client.session.prompt(payload)
  } else {
    throw new Error("client.session has no prompt or promptAsync method")
  }
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

export function stopAgentListener(name: string): void {
  const listener = activeListeners.get(name)
  if (listener) {
    if (listener.state) listener.state.aborted = true
    if (listener.state?.proc?.kill) {
      try {
        listener.state.proc.kill()
      } catch {}
    }
    activeListeners.delete(name)
  }
}

export function startAgentListener(
  client: OpenCodeClient,
  name: string,
  cwd: string,
  targetSessionId: string | null
): void {
  if (targetSessionId) {
    const existingAgent = sessionToAgent.get(targetSessionId)
    if (existingAgent && existingAgent !== name) {
      stopAgentListener(existingAgent)
    }
    sessionToAgent.set(targetSessionId, name)
  }

  if (activeListeners.has(name)) return
  const state: ListenerState = { aborted: false, proc: null }
  activeListeners.set(name, { state, targetSessionId })

  let busy = false
  const queue: string[] = []

  function next() {
    busy = false
    if (queue.length) {
      const item = queue.shift()
      if (item) offer(item)
    }
  }

  async function resolveTargetSession(): Promise<string | null> {
    if (targetSessionId) return targetSessionId
    const mappedSid = getSessionIdForAgent(name)
    if (mappedSid) return mappedSid
    try {
      if (!client.session?.list) return null
      const res = await client.session.list()
      const list: OpenCodeSessionInfo[] = Array.isArray(res) ? res : (res && "data" in res && Array.isArray(res.data) ? res.data : [])
      if (!Array.isArray(list) || list.length === 0) return null
      const live = list
        .filter((s) => !(s.time && s.time.archived))
        .sort((a, b) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0))
      return live[0]?.id || null
    } catch {
      return null
    }
  }

  async function run(text: string, attempt: number) {
    try {
      const id = await resolveTargetSession()
      if (!id) throw new Error("no opencode session")

      let isImmediate = false
      if (process.env.LOCUTUS_INTERRUPT !== "0") {
        if (process.env.LOCUTUS_ABORT_ON_BUSY === "1" || process.env.LOCUTUS_INTERRUPT === "1") {
          isImmediate = true
        } else {
          isImmediate = resolveMessageUrgency(text) === "immediate"
        }
      }

      if (isImmediate) {
        await interruptSessionIfBusy(client, id)
      }
      await deliverPrompt(client, id, text)
      next()
    } catch (err) {
      if (attempt >= 8) {
        queue.unshift(text)
        next()
      } else {
        setTimeout(() => run(text, attempt + 1), 250 * (attempt + 1))
      }
    }
  }

  function offer(text: string) {
    if (busy) {
      queue.push(text)
      return
    }
    busy = true
    run(text, 0)
  }

  console.error(`[locutus-ear] armed for ${name} (bin: ${getLocutusBin()})`)

  ;(async () => {
    try {
      for await (const line of listenLines(name, cwd, state)) {
        if (state.aborted) break
        offer(`[locutus:${name}] ${line}`)
      }
    } catch (e) {
      console.error(`[locutus-ear] listener error for ${name}:`, e)
    } finally {
      activeListeners.delete(name)
    }
  })()
}

export function verifyAndEnsureListener(
  client: OpenCodeClient,
  sessionId?: string | null,
  cwd: string = process.cwd()
): boolean {
  if (!sessionId) return false
  const agentName = isSessionSupposedToListen(sessionId)
  if (!agentName) {
    // Session is NOT supposed to have a listener. Ensure any existing one is stopped.
    const runningAgent = sessionToAgent.get(sessionId)
    if (runningAgent) {
      stopAgentListener(runningAgent)
      sessionToAgent.delete(sessionId)
    }
    return false
  }

  // Session IS supposed to have a listener for agentName
  sessionToAgent.set(sessionId, agentName)
  if (!isListenerAlive(agentName)) {
    console.error(`[locutus-ear] Verifying session ${sessionId}: reviving listener for @${agentName}`)
    startAgentListener(client, agentName, cwd, sessionId)
    return true
  }

  return true
}

export async function syncSessions(client: OpenCodeClient, directory?: string): Promise<void> {
  const cwd = directory || process.cwd()
  console.error(`[locutus-ear] syncSessions called for cwd: ${cwd}`)
  try {
    if (!client.session?.list) {
      console.error(`[locutus-ear] client.session.list is not available!`)
      return
    }
    const res = await client.session.list()
    console.error(`[locutus-ear] client.session.list in ${cwd}:`, typeof res === "object" ? JSON.stringify(res).slice(0, 200) : res)
    const list: OpenCodeSessionInfo[] = Array.isArray(res) ? res : (res && "data" in res && Array.isArray(res.data) ? res.data : [])
    if (!Array.isArray(list)) return

    for (const s of list) {
      if (s.time && s.time.archived) continue
      const name = isSessionSupposedToListen(s.id)
      if (name) {
        verifyAndEnsureListener(client, s.id, cwd)
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("[locutus-ear] could not sync sessions:", msg)
  }
}
