// extensions/opencode/src/index.ts
// Main entry point for OpenCode Locutus Ear plugin.

import {
  getLocutusBin,
  sanitizeAgentName,
  isSessionSupposedToListen,
  resolveSessionAgent,
  setMappedAgent,
  closeSessionAgent,
  removeMappedAgent
} from "./sessions"
import {
  interruptSessionIfBusy,
  deliverPrompt,
  resolveMessageUrgency,
  verifyAndEnsureListener,
  stopAgentListener,
  startAgentListener,
  syncSessions,
  isListenerAlive,
  sessionToAgent
} from "./supervisor"
import { getOrientationReminder } from "./orientation"
import type { PluginContext, OpenCodeEvent } from "./types"

let armed = false

export const LocutusEar = async (ctx: PluginContext) => {
  if (process.env.LOCUTUS_EAR_DISABLED === "1") return {}
  const client = ctx.client
  const directory = ctx.directory || process.cwd()

  if (!armed) {
    armed = true
    // Initial bootstrap: if global LOCUTUS_AGENT_NAME is set, listen for it
    if (process.env.LOCUTUS_AGENT_NAME) {
      startAgentListener(client, process.env.LOCUTUS_AGENT_NAME, directory, null)
    }
    // Discover live sessions and arm listener only for active registered sessions
    syncSessions(client, directory).catch((e) => console.error("[locutus-ear]", e))
  }

  return {
    "shell.env": async ({ sessionID }: { sessionID?: string }, output: { env?: Record<string, string> }) => {
      if (sessionID && output && output.env) {
        const sessionKey = `opencode:${sessionID}`
        output.env.LOCUTUS_SESSION_ID = sessionKey
        let name = isSessionSupposedToListen(sessionID)
        if (!name) {
          // Auto-resolve or register for active command execution session
          name = resolveSessionAgent(sessionID)
        }
        if (name) {
          output.env.LOCUTUS_AGENT_NAME = name
          verifyAndEnsureListener(client, sessionID, directory)
        }
      }
    },
    event: async ({ event }: { event?: OpenCodeEvent }) => {
      if (!event) return
      if (event.type === "session.created" && event.properties?.info?.id) {
        const s = event.properties.info
        if (isSessionSupposedToListen(s.id)) {
          verifyAndEnsureListener(client, s.id, directory)
        }
      } else if (event.type === "session.deleted" && event.properties?.info?.id) {
        const sid = event.properties.info.id
        closeSessionAgent(`opencode:${sid}`)
        removeMappedAgent(`opencode:${sid}`)
        const agent = sessionToAgent.get(sid)
        if (agent) {
          stopAgentListener(agent)
          sessionToAgent.delete(sid)
        }
      } else if (
        (event.type === "session.resumed" || event.type === "session.selected" || event.type === "session.updated") &&
        event.properties?.info?.id
      ) {
        const sid = event.properties.info.id
        // Verify listener is active for resumed session if supposed to have one
        verifyAndEnsureListener(client, sid, directory)
      }
    }
  }
}

// Attach static helpers for backwards compatibility with tests and callers
(LocutusEar as any).getLocutusBin = getLocutusBin;
(LocutusEar as any).sanitizeAgentName = sanitizeAgentName;
(LocutusEar as any).interruptSessionIfBusy = interruptSessionIfBusy;
(LocutusEar as any).deliverPrompt = deliverPrompt;
(LocutusEar as any).resolveMessageUrgency = resolveMessageUrgency;
(LocutusEar as any).isSessionSupposedToListen = isSessionSupposedToListen;
(LocutusEar as any).verifyAndEnsureListener = verifyAndEnsureListener;
(LocutusEar as any).closeSessionAgent = closeSessionAgent;
(LocutusEar as any).isListenerAlive = isListenerAlive;
(LocutusEar as any).setMappedAgent = setMappedAgent;
(LocutusEar as any).getOrientationReminder = getOrientationReminder;

export default LocutusEar
