// extensions/opencode/src/index.ts
// Main entry point for OpenCode Rhizo Ear plugin.

import {
  getRhizoBin,
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

const armedDirectories = new Set<string>()

export const RhizoEar = async (ctx: PluginContext) => {
  if (process.env.RHIZO_EAR_DISABLED === "1") return {}
  const client = ctx.client
  const directory = ctx.directory || process.cwd()
  console.error("[rhizo-ear] init directory:", directory)

  if (!armedDirectories.has(directory)) {
    armedDirectories.add(directory)
    // Initial bootstrap: if global RHIZO_AGENT_NAME is set, listen for it
    const envAgent = process.env.RHIZO_AGENT_NAME
    if (envAgent) {
      startAgentListener(client, envAgent, directory, null)
    }
    // Discover live sessions and arm listener for active registered sessions
    syncSessions(client, directory).catch((e) => console.error("[rhizo-ear]", e))
  }

  return {
    "shell.env": async ({ sessionID }: { sessionID?: string }, output: { env?: Record<string, string> }) => {
      if (sessionID && output && output.env) {
        const sessionKey = `opencode:${sessionID}`
        output.env.RHIZO_SESSION_ID = sessionKey
        let name = isSessionSupposedToListen(sessionID)
        if (!name) {
          // Auto-resolve or register for active command execution session
          name = resolveSessionAgent(sessionID)
        }
        if (name) {
          output.env.RHIZO_AGENT_NAME = name
          verifyAndEnsureListener(client, sessionID, directory)
        }
      }
    },
    event: async ({ event }: { event?: OpenCodeEvent }) => {
      if (!event) return
      if (event.type === "session.created" && event.properties?.info?.id) {
        const s = event.properties.info
        let name = isSessionSupposedToListen(s.id)
        if (!name) {
          name = resolveSessionAgent(s.id, s.title)
        }
        if (name) {
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
        const s = event.properties.info
        let name = isSessionSupposedToListen(s.id)
        if (!name) {
          name = resolveSessionAgent(s.id, s.title)
        }
        if (name) {
          verifyAndEnsureListener(client, s.id, directory)
        }
      }
    }
  }
}

// Attach static helpers for tests and callers
const attachHelpers = (fn: any) => {
  fn.getRhizoBin = getRhizoBin;
  fn.sanitizeAgentName = sanitizeAgentName;
  fn.interruptSessionIfBusy = interruptSessionIfBusy;
  fn.deliverPrompt = deliverPrompt;
  fn.resolveMessageUrgency = resolveMessageUrgency;
  fn.isSessionSupposedToListen = isSessionSupposedToListen;
  fn.verifyAndEnsureListener = verifyAndEnsureListener;
  fn.closeSessionAgent = closeSessionAgent;
  fn.isListenerAlive = isListenerAlive;
  fn.setMappedAgent = setMappedAgent;
  fn.getOrientationReminder = getOrientationReminder;
  return fn;
};

attachHelpers(RhizoEar);

export default RhizoEar

