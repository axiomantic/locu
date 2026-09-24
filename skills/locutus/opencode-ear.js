// locutus-ear.js — continuous Locutus bus ear for opencode.
//
// Loaded from the `plugin` array in opencode.json (a source .js is not picked
// up from ~/.config/opencode/plugins/ in this setup). Add its absolute path:
//
//   "plugin": [
//     "/Users/elijah/.agents/skills/locutus/opencode-ear.js",
//     ...
//   ]
//
// On startup it resolves an agent identity (LOCUTUS_AGENT_NAME, or
// <project>/.locutus.agent) and, if one is present, spawns `locutus listen
// <name>` as a child and streams its stdout. Each stdout line is one
// authenticated Locutus message (a single JSON object). Every message is
// injected into the active opencode session as a new user turn via
// client.session.prompt — the only primitive available to wake the assistant.
// `locutus listen` exits after one delivery, so the child is re-armed
// immediately, keeping the ear open while the assistant works. No polling.
//
// Dormant unless an identity resolves. Set LOCUTUS_EAR_DISABLED=1 to disable.

import { readFileSync } from "node:fs"
import { join } from "node:path"

function resolveName(directory) {
  if (process.env.LOCUTUS_AGENT_NAME) return process.env.LOCUTUS_AGENT_NAME
  try {
    const v = readFileSync(join(directory || process.cwd(), ".locutus.agent"), "utf8").trim()
    if (v) return v
  } catch {
    // no .locutus.agent
  }
  return ""
}

let armed = false

async function* listenLines(name, cwd) {
  let firstSpawnFailure = true
  for (;;) {
    let proc
    try {
      proc = Bun.spawn(["locutus", "listen", name], { cwd, stdout: "pipe", stderr: "pipe" })
      firstSpawnFailure = true
    } catch (e) {
      if (firstSpawnFailure) {
        console.error("[locutus-ear] could not spawn `locutus listen`: " + (e && e.message))
        firstSpawnFailure = false
      }
      await new Promise((r) => setTimeout(r, 500))
      continue
    }

    const dec = new TextDecoder()
    const reader = proc.stdout.getReader()
    let buf = ""
    try {
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
    } catch {
      // stream closed / child killed; fall through and re-arm
    }
  }
}

async function runEar({ client, directory }) {
  const name = resolveName(directory)
  if (!name) {
    console.error("[locutus-ear] no agent identity (set LOCUTUS_AGENT_NAME or .locutus.agent); dormant")
    return
  }
  const cwd = directory || process.cwd()

  let busy = false
  const queue = []

  async function sessionId() {
    try {
      const res = await client.session.list()
      const list = Array.isArray(res) ? res : res && res.data
      if (!Array.isArray(list) || list.length === 0) return null
      const live = list
        .filter((s) => !(s.time && s.time.archived))
        .sort((a, b) => ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0))
      return live[0].id || null
    } catch {
      return null
    }
  }

  function next() {
    busy = false
    if (queue.length) offer(queue.shift())
  }

  async function run(text, attempt) {
    try {
      const id = await sessionId()
      if (!id) throw new Error("no opencode session")
      await client.session.prompt({
        path: { id },
        body: { parts: [{ type: "text", text }] },
      })
      next()
    } catch {
      if (attempt >= 8) {
        queue.unshift(text)
        next()
      } else {
        setTimeout(() => run(text, attempt + 1), 250 * (attempt + 1))
      }
    }
  }

  function offer(text) {
    if (busy) {
      queue.push(text)
      return
    }
    busy = true
    run(text, 0)
  }

  console.error(`[locutus-ear] armed for ${name}`)

  for await (const line of listenLines(name, cwd)) {
    offer(`[locutus:${name}] ${line}`)
  }
}

export const LocutusEar = async (ctx) => {
  if (process.env.LOCUTUS_EAR_DISABLED === "1") return {}
  if (armed) return {}
  armed = true
  runEar(ctx).catch((e) => console.error("[locutus-ear]", e))
  return {}
}

export default LocutusEar