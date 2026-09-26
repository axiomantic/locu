// @bun
// src/sessions.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
function getLocutusBin() {
  if (process.env.LOCUTUS_BIN && existsSync(process.env.LOCUTUS_BIN)) {
    return process.env.LOCUTUS_BIN;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    join(home, ".local", "bin", "locutus"),
    join(home, ".nimble", "bin", "locutus"),
    "/opt/homebrew/bin/locutus",
    "/usr/local/bin/locutus"
  ];
  for (const p of candidates) {
    if (existsSync(p))
      return p;
  }
  return "locutus";
}
function getSessionsPath() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".config", "locutus", "sessions.json");
}
function readLocalSessionMap() {
  try {
    return JSON.parse(readFileSync(getSessionsPath(), "utf8"));
  } catch {
    return {};
  }
}
function isSessionSupposedToListen(sessionId) {
  if (!sessionId)
    return null;
  if (process.env.LOCUTUS_AGENT_NAME)
    return process.env.LOCUTUS_AGENT_NAME;
  const sessionKey = `opencode:${sessionId}`;
  const map = readLocalSessionMap();
  const entry = map[sessionKey];
  if (!entry)
    return null;
  if (typeof entry === "object" && (entry.status === "closed" || entry.disabled === true)) {
    return null;
  }
  const name = typeof entry === "string" ? entry : entry.agent;
  return name || null;
}
function getSessionIdForAgent(agentName) {
  const map = readLocalSessionMap();
  for (const [key, val] of Object.entries(map)) {
    if (typeof val === "object" && val.status === "closed")
      continue;
    const name = typeof val === "string" ? val : val?.agent;
    if (name === agentName && key.startsWith("opencode:")) {
      return key.slice("opencode:".length);
    }
  }
  return null;
}
function setMappedAgent(sessionKey, agentName, status = "active") {
  try {
    const p = getSessionsPath();
    mkdirSync(dirname(p), { recursive: true });
    const map = readLocalSessionMap();
    map[sessionKey] = {
      agent: agentName,
      status,
      updated_at: new Date().toISOString()
    };
    writeFileSync(p, JSON.stringify(map, null, 2) + `
`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[locutus-ear] could not write session mapping:", msg);
  }
}
function closeSessionAgent(sessionKey) {
  try {
    const p = getSessionsPath();
    const map = readLocalSessionMap();
    if (map[sessionKey]) {
      if (typeof map[sessionKey] === "object") {
        map[sessionKey].status = "closed";
        map[sessionKey].closed_at = new Date().toISOString();
      } else {
        map[sessionKey] = {
          agent: map[sessionKey],
          status: "closed",
          closed_at: new Date().toISOString()
        };
      }
      writeFileSync(p, JSON.stringify(map, null, 2) + `
`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[locutus-ear] could not close session mapping:", msg);
  }
}
function removeMappedAgent(sessionKey) {
  try {
    const p = getSessionsPath();
    const map = readLocalSessionMap();
    if (map[sessionKey]) {
      delete map[sessionKey];
      writeFileSync(p, JSON.stringify(map, null, 2) + `
`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[locutus-ear] could not remove session mapping:", msg);
  }
}
function sanitizeAgentName(name) {
  if (!name)
    return "";
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}
function resolveSessionAgent(sessionId, fallbackName) {
  if (sessionId) {
    const supposed = isSessionSupposedToListen(sessionId);
    if (supposed)
      return supposed;
  }
  if (process.env.LOCUTUS_AGENT_NAME)
    return process.env.LOCUTUS_AGENT_NAME;
  if (sessionId) {
    const sanitized = sanitizeAgentName(fallbackName);
    const autoName = sanitized && sanitized.length >= 3 ? sanitized : `opencode-${sessionId.slice(-8)}`;
    setMappedAgent(`opencode:${sessionId}`, autoName, "active");
    return autoName;
  }
  return "";
}

// src/supervisor.ts
var activeListeners = new Map;
var sessionToAgent = new Map;
function isListenerAlive(agentName) {
  const listener = activeListeners.get(agentName);
  if (!listener || !listener.state)
    return false;
  if (listener.state.aborted)
    return false;
  if (!listener.state.proc)
    return false;
  if (typeof listener.state.proc.exitCode === "number" && listener.state.proc.exitCode !== null)
    return false;
  return true;
}
async function* listenLines(name, cwd, state) {
  let firstSpawnFailure = true;
  const bin = getLocutusBin();
  for (;; ) {
    if (state?.aborted)
      break;
    let proc = null;
    try {
      proc = typeof Bun !== "undefined" && Bun?.spawn ? Bun.spawn([bin, "listen", name], { cwd, stdout: "pipe", stderr: "pipe" }) : null;
      if (state)
        state.proc = proc;
      firstSpawnFailure = true;
    } catch (err) {
      if (firstSpawnFailure) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[locutus-ear] could not spawn `" + bin + " listen`: " + msg);
        firstSpawnFailure = false;
      }
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    if (!proc || !proc.stdout) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    const dec = new TextDecoder;
    const reader = proc.stdout.getReader();
    let buf = "";
    try {
      for (;; ) {
        const { done, value } = await reader.read();
        if (done)
          break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf(`
`)) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const t2 = line.trim();
          if (t2)
            yield t2;
        }
      }
      const t = buf.trim();
      if (t)
        yield t;
    } catch {}
    if (state?.aborted)
      break;
  }
}
async function interruptSessionIfBusy(client, sessionId) {
  if (process.env.LOCUTUS_INTERRUPT === "0")
    return;
  if (!client?.session)
    return;
  try {
    let isBusy = false;
    if (typeof client.session.status === "function") {
      const statusRes = await client.session.status();
      const statuses = statusRes && statusRes.data || statusRes || {};
      const current = statuses[sessionId];
      if (current && (current.type === "busy" || current.type === "retry")) {
        isBusy = true;
      }
    }
    if (isBusy && typeof client.session.abort === "function") {
      console.error(`[locutus-ear] session ${sessionId} is busy; aborting to deliver Locutus message...`);
      await client.session.abort({ path: { id: sessionId } });
      for (let i = 0;i < 7; i++) {
        await new Promise((r) => setTimeout(r, 50));
        if (typeof client.session.status === "function") {
          const sRes = await client.session.status().catch(() => null);
          const sMap = sRes && sRes.data || sRes || {};
          if (!sMap[sessionId] || sMap[sessionId].type === "idle")
            break;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[locutus-ear] could not interrupt session ${sessionId}:`, msg);
  }
}
async function deliverPrompt(client, sessionId, text) {
  const payload = {
    path: { id: sessionId },
    body: { parts: [{ type: "text", text }] }
  };
  if (typeof client?.session?.promptAsync === "function") {
    await client.session.promptAsync(payload);
  } else if (typeof client?.session?.prompt === "function") {
    await client.session.prompt(payload);
  } else {
    throw new Error("client.session has no prompt or promptAsync method");
  }
}
function resolveMessageUrgency(text) {
  try {
    const jsonStart = text.indexOf("{");
    if (jsonStart >= 0) {
      const parsed = JSON.parse(text.slice(jsonStart));
      const u = String(parsed.urgency || parsed.delivery || "").toLowerCase();
      if (u === "immediate" || u === "now" || u === "urgent")
        return "immediate";
    }
  } catch {}
  return "soon";
}
function stopAgentListener(name) {
  const listener = activeListeners.get(name);
  if (listener) {
    if (listener.state)
      listener.state.aborted = true;
    if (listener.state?.proc?.kill) {
      try {
        listener.state.proc.kill();
      } catch {}
    }
    activeListeners.delete(name);
  }
}
function startAgentListener(client, name, cwd, targetSessionId) {
  if (targetSessionId) {
    const existingAgent = sessionToAgent.get(targetSessionId);
    if (existingAgent && existingAgent !== name) {
      stopAgentListener(existingAgent);
    }
    sessionToAgent.set(targetSessionId, name);
  }
  if (activeListeners.has(name))
    return;
  const state = { aborted: false, proc: null };
  activeListeners.set(name, { state, targetSessionId });
  let busy = false;
  const queue = [];
  function next() {
    busy = false;
    if (queue.length) {
      const item = queue.shift();
      if (item)
        offer(item);
    }
  }
  async function resolveTargetSession() {
    if (targetSessionId)
      return targetSessionId;
    const mappedSid = getSessionIdForAgent(name);
    if (mappedSid)
      return mappedSid;
    try {
      if (!client.session?.list)
        return null;
      const res = await client.session.list();
      const list = Array.isArray(res) ? res : res && ("data" in res) && Array.isArray(res.data) ? res.data : [];
      if (!Array.isArray(list) || list.length === 0)
        return null;
      const live = list.filter((s) => !(s.time && s.time.archived)).sort((a, b) => (b.time && b.time.updated || 0) - (a.time && a.time.updated || 0));
      return live[0]?.id || null;
    } catch {
      return null;
    }
  }
  async function run(text, attempt) {
    try {
      const id = await resolveTargetSession();
      if (!id)
        throw new Error("no opencode session");
      let isImmediate = false;
      if (process.env.LOCUTUS_INTERRUPT !== "0") {
        if (process.env.LOCUTUS_ABORT_ON_BUSY === "1" || process.env.LOCUTUS_INTERRUPT === "1") {
          isImmediate = true;
        } else {
          isImmediate = resolveMessageUrgency(text) === "immediate";
        }
      }
      if (isImmediate) {
        await interruptSessionIfBusy(client, id);
      }
      await deliverPrompt(client, id, text);
      next();
    } catch (err) {
      if (attempt >= 8) {
        queue.unshift(text);
        next();
      } else {
        setTimeout(() => run(text, attempt + 1), 250 * (attempt + 1));
      }
    }
  }
  function offer(text) {
    if (busy) {
      queue.push(text);
      return;
    }
    busy = true;
    run(text, 0);
  }
  console.error(`[locutus-ear] armed for ${name} (bin: ${getLocutusBin()})`);
  (async () => {
    try {
      for await (const line of listenLines(name, cwd, state)) {
        if (state.aborted)
          break;
        offer(`[locutus:${name}] ${line}`);
      }
    } catch (e) {
      console.error(`[locutus-ear] listener error for ${name}:`, e);
    } finally {
      activeListeners.delete(name);
    }
  })();
}
function verifyAndEnsureListener(client, sessionId, cwd = process.cwd()) {
  if (!sessionId)
    return false;
  const agentName = isSessionSupposedToListen(sessionId);
  if (!agentName) {
    const runningAgent = sessionToAgent.get(sessionId);
    if (runningAgent) {
      stopAgentListener(runningAgent);
      sessionToAgent.delete(sessionId);
    }
    return false;
  }
  sessionToAgent.set(sessionId, agentName);
  if (!isListenerAlive(agentName)) {
    console.error(`[locutus-ear] Verifying session ${sessionId}: reviving listener for @${agentName}`);
    startAgentListener(client, agentName, cwd, sessionId);
    return true;
  }
  return true;
}
async function syncSessions(client, directory) {
  const cwd = directory || process.cwd();
  try {
    if (!client.session?.list)
      return;
    const res = await client.session.list();
    const list = Array.isArray(res) ? res : res && ("data" in res) && Array.isArray(res.data) ? res.data : [];
    if (!Array.isArray(list))
      return;
    for (const s of list) {
      if (s.time && s.time.archived)
        continue;
      if (isSessionSupposedToListen(s.id)) {
        verifyAndEnsureListener(client, s.id, cwd);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[locutus-ear] could not sync sessions:", msg);
  }
}

// src/orientation.ts
function getOrientationReminder(sessionId) {
  if (sessionId) {
    const sessionKey = `opencode:${sessionId}`;
    const map = readLocalSessionMap();
    const entry = map[sessionKey];
    if (typeof entry === "object" && entry.status !== "closed") {
      const workspacePath = entry.strand_path || entry.rifttree_path;
      if (workspacePath) {
        const taskLabel = entry.task_id ? `for task '${entry.task_id}' ` : "";
        return `[LOCUTUS CONTEXT ANCHOR: You have an active isolated workspace/strand ${taskLabel}at: ` + `${workspacePath}. Do not commit changes to the canonical repository root. ` + `Verify with 'git status' inside your workspace.]`;
      }
    }
  }
  return `[LOCUTUS NOTICE: If this task was operating in an isolated workspace/strand, inspect active workspaces ` + `(e.g., via 'braid list' or checking ~/Development/workspaces/) and .braid.json to reorient ` + `yourself before making edits in the canonical repository root.]`;
}

// src/index.ts
var armed = false;
var LocutusEar = async (ctx) => {
  if (process.env.LOCUTUS_EAR_DISABLED === "1")
    return {};
  const client = ctx.client;
  const directory = ctx.directory || process.cwd();
  if (!armed) {
    armed = true;
    if (process.env.LOCUTUS_AGENT_NAME) {
      startAgentListener(client, process.env.LOCUTUS_AGENT_NAME, directory, null);
    }
    syncSessions(client, directory).catch((e) => console.error("[locutus-ear]", e));
  }
  return {
    "shell.env": async ({ sessionID }, output) => {
      if (sessionID && output && output.env) {
        const sessionKey = `opencode:${sessionID}`;
        output.env.LOCUTUS_SESSION_ID = sessionKey;
        let name = isSessionSupposedToListen(sessionID);
        if (!name) {
          name = resolveSessionAgent(sessionID);
        }
        if (name) {
          output.env.LOCUTUS_AGENT_NAME = name;
          verifyAndEnsureListener(client, sessionID, directory);
        }
      }
    },
    event: async ({ event }) => {
      if (!event)
        return;
      if (event.type === "session.created" && event.properties?.info?.id) {
        const s = event.properties.info;
        if (isSessionSupposedToListen(s.id)) {
          verifyAndEnsureListener(client, s.id, directory);
        }
      } else if (event.type === "session.deleted" && event.properties?.info?.id) {
        const sid = event.properties.info.id;
        closeSessionAgent(`opencode:${sid}`);
        removeMappedAgent(`opencode:${sid}`);
        const agent = sessionToAgent.get(sid);
        if (agent) {
          stopAgentListener(agent);
          sessionToAgent.delete(sid);
        }
      } else if ((event.type === "session.resumed" || event.type === "session.selected" || event.type === "session.updated") && event.properties?.info?.id) {
        const sid = event.properties.info.id;
        verifyAndEnsureListener(client, sid, directory);
      }
    }
  };
};
LocutusEar.getLocutusBin = getLocutusBin;
LocutusEar.sanitizeAgentName = sanitizeAgentName;
LocutusEar.interruptSessionIfBusy = interruptSessionIfBusy;
LocutusEar.deliverPrompt = deliverPrompt;
LocutusEar.resolveMessageUrgency = resolveMessageUrgency;
LocutusEar.isSessionSupposedToListen = isSessionSupposedToListen;
LocutusEar.verifyAndEnsureListener = verifyAndEnsureListener;
LocutusEar.closeSessionAgent = closeSessionAgent;
LocutusEar.isListenerAlive = isListenerAlive;
LocutusEar.setMappedAgent = setMappedAgent;
LocutusEar.getOrientationReminder = getOrientationReminder;
var src_default = LocutusEar;
export {
  src_default as default,
  LocutusEar
};
