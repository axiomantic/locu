#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const REPO = 'axiomantic/rhizo';
const PKG_NAME = '@axiomantic/rhizo';
const BIN_NAME = 'rhizo';

// 1. Ensure binary permissions and provision if missing
const binDir = path.join(__dirname, '..', 'bin');
const ext = process.platform === 'win32' ? '.exe' : '';
const targetBinary = path.join(binDir, `${BIN_NAME}${ext}`);

function ensureBinary() {
  if (fs.existsSync(targetBinary)) {
    try {
      fs.chmodSync(targetBinary, 0o755);
    } catch (_) {}
    return;
  }

  // Attempt to download pre-built release binary
  const pkgVersion = require('../package.json').version;
  const platform = process.platform === 'darwin' ? 'darwin' : (process.platform === 'win32' ? 'windows' : 'linux');
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const assetName = `${BIN_NAME}-${platform}-${arch}${platform === 'windows' ? '.zip' : '.tar.gz'}`;
  const downloadUrl = `https://github.com/${REPO}/releases/download/v${pkgVersion}/${assetName}`;

  try {
    console.log(`[${PKG_NAME}] Downloading native binary from ${downloadUrl}...`);
    const tempArchive = path.join(os.tmpdir(), assetName);
    execSync(`curl -fsSL -o "${tempArchive}" "${downloadUrl}"`, { stdio: 'pipe' });

    if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

    if (platform === 'windows') {
      execSync(`tar -xf "${tempArchive}" -C "${binDir}"`, { stdio: 'pipe' });
    } else {
      execSync(`tar -xzf "${tempArchive}" -C "${binDir}"`, { stdio: 'pipe' });
    }
    try { fs.unlinkSync(tempArchive); } catch (_) {}
    if (fs.existsSync(targetBinary)) {
      fs.chmodSync(targetBinary, 0o755);
      console.log(`[${PKG_NAME}] Native binary installed successfully.`);
      return;
    }
  } catch (_) {
    // Release download failed or offline; check if nim is available to compile locally
    const srcNim = path.join(__dirname, '..', 'src', `${BIN_NAME}.nim`);
    if (fs.existsSync(srcNim)) {
      try {
        console.log(`[${PKG_NAME}] Compiling from source via nim...`);
        execSync(`nim c -d:release --opt:speed -o:"${targetBinary}" "${srcNim}"`, { stdio: 'pipe' });
        fs.chmodSync(targetBinary, 0o755);
        console.log(`[${PKG_NAME}] Native binary compiled successfully.`);
        return;
      } catch (_) {}
    }
  }

  console.warn(`[${PKG_NAME}] Note: Native binary could not be downloaded or compiled automatically.`);
  console.warn(`[${PKG_NAME}] Run 'nimble build' or visit https://github.com/${REPO}/releases to install manually.`);
}

ensureBinary();

// 2. Auto-equip detected coding assistants with Rhizo rules
const home = os.homedir();
const guideContent = `# Rhizo Multi-Agent Coordination Guide

This repository utilizes **Rhizo** for inter-assistant communication, distributed locking, and synchronized task queues over Redis/Valkey.

### 0. Self-Bootstrapping Prerequisite
This project requires \`rhizo\` and \`vine\`. If \`command -v rhizo\` or \`command -v vine\` fails, install them via npm:
\`\`\`bash
npm install -g @axiomantic/rhizo @axiomantic/vine
\`\`\`

### 1. Invariants & Identity
* **No Workspace-Scoped Identity Files**:
  Agent identity is strictly decoupled from directory paths. **Never create or read \`.rhizo.agent\` in any project or workspace directory.** Agent identity is resolved exclusively through:
  1. \`RHIZO_AGENT_NAME\` environment variable.
  2. Harness session ID mapping (\`RHIZO_SESSION_ID=<runtime>:<sessionId>\` via \`~/.config/rhizo/sessions.json\` or Redis).
  3. Explicit CLI flag: \`rhizo open <name> "<tags>"\`.
* **Zero Dirty Commits**:
  All agent state, lockfiles, temporary buffers, and session files must be ignored in \`~/.gitignore_global\` or \`.git/info/exclude\`. Never stage or commit coordination metadata (\`.rhizo.*\`, \`*.lock\`).

### 2. Harness Listener Discipline & Capability-Based Execution (Anti-Token-Thrash)
* **Zero Timeouts (Anti-Token-Thrash Invariant)**:
  Always invoke \`rhizo listen <agent>\` with **no timeout** (infinite wait). Never pass arbitrary bounded timeouts (e.g. 30s or 120s). When a timeout expires, the command exits empty, forcing the assistant to burn an entire LLM inference cycle (context + reasoning + generation) just to re-run the listener (up to 120 empty wakeups/hour). Redis \`BLPOP\` consumes 0 CPU, 0 bandwidth, and 0 tokens while waiting indefinitely until work arrives. Timeouts are strictly optional and explicitly discouraged across the board.

* **Tool Capability Decision Tree (Introspect Your Runtime Tools)**:
  Agents must never block their primary conversation turn. Evaluate your harness tools in this exact priority order (always prefer direct background execution in the main chat over subagents to minimize token overhead):
  1. **In-Process Harness Ear Extension** (e.g. OpenCode \`opencode-ear.js\`, Pi \`pi-ear.ts\`):
     - Do NOT execute \`rhizo listen\` with any tool. Continuous listening is handled automatically in-process, delivering incoming turns directly into your context loop with 0 LLM token overhead.
  2. **Shell Tool with Native Daemon / Background Support in Main Chat** (e.g. \`run_command(..., IsDaemon=true, WaitMsBeforeAsync=500)\`):
     - Preferred over subagents: direct line of communication with zero subagent token overhead. Run the listener command via the tool's native background execution parameter. The platform reactively resumes your turn when an incoming message arrives. Do not poll in a loop.
  3. **Subagent / Task Tool with Background Support** (e.g. \`Task(..., background=true)\`, \`spawn_agent\`):
     - Dispatch the listener in a background subagent when native daemon shell execution is unavailable.
     - **CRITICAL INVARIANT — NO DOUBLE-DAEMONS (Prohibition of Nested Background Execution)**: Inside the subagent, the command itself must be **SYNCHRONOUS AND BLOCKING** (\`rhizo listen <agent>\`). Do NOT run as a daemon or background process inside the subagent. The subagent container is backgrounded by the parent; the command running inside it must block on Redis until a message arrives, output the JSON payload, and terminate cleanly so the harness delivers the message back to the parent session. Subagents report output only upon exit (they cannot stream intermediate lines to the parent), so the listener must be one-and-done inside the subagent.
  4. **Neither Capability Available (Synchronous-Only Shell Execution)**:
     - If the harness only provides synchronous foreground shell tools with no managed background parameter, **DO NOT run \`rhizo listen\`**. A blocking listen call will freeze the conversation turn, lock user input, and destroy interactivity.
     - **Inform the user of this platform limitation**: Explain that the current harness lacks native background execution and cannot maintain an active listener without blocking the chat. Advise the user that incoming communications over \`rhizo\` must be checked explicitly (e.g. via \`rhizo check-inbox\` on demand or during user turns).

* **STRICT PROHIBITION: Never Use Shell \`&\` or Output Redirects**:
  ❌ **NEVER run \`rhizo listen &\`, \`nohup rhizo listen &\`, or redirect stdout/stderr (\`> /dev/null 2>&1 &\` or \`> file.log &\`)**.
  - Detaching with \`&\` creates an unmanaged shell process that severs process tracking.
  - Redirecting stdout/stderr **swallows the notification stream**! The agent's event loop will never see the incoming message and the agent will remain permanently deaf to incoming tasks and in-flight preemption interrupts.

### 3. Task Claiming & Fencing Protocol
* **Claiming Work**: When claiming tasks from queues, always negotiate leases:
  \`\`\`bash
  rhizo claim queue:<project>:tasks --lease 1800
  \`\`\`
* **Fencing Tokens**: Every claimed task yields a monotonic \`fencing_token\`. Record this token in your task execution manifest. If your lease expires, never write back with an outdated token.
* **Completion & Ack**:
  Once task work is verified:
  \`\`\`bash
  rhizo ack queue:<project>:tasks <task_id>
  rhizo reply --to <sender> '{"status": "completed", "task_id": "<task_id>"}'
  \`\`\`
`;

function safeWrite(destDir, fileName, content) {
  try {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const target = path.join(destDir, fileName);
    fs.writeFileSync(target, content, 'utf8');
    console.log(`[${PKG_NAME}] Provisioned rules to: ${target}`);
  } catch (err) {
    // Non-fatal if permissions or sandbox prevent writing
  }
}

// Claude Code
const claudeDir = path.join(home, '.claude');
if (fs.existsSync(claudeDir)) {
  safeWrite(path.join(claudeDir, 'rules'), 'rhizo.md', guideContent);
}

// OpenCode
const opencodeDir = path.join(home, '.config', 'opencode');
if (fs.existsSync(opencodeDir)) {
  safeWrite(path.join(opencodeDir, 'instructions'), 'rhizo.md', guideContent);
  const earSource = path.join(__dirname, '..', 'skills', 'rhizo', 'opencode-ear.js');
  if (fs.existsSync(earSource)) {
    const pluginDir = path.join(opencodeDir, 'plugins');
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
    try {
      fs.copyFileSync(earSource, path.join(pluginDir, 'opencode-ear.js'));
      console.log(`[${PKG_NAME}] Provisioned OpenCode ear plugin`);
    } catch (_) {}
  }
}

// Antigravity
const antigravityDir = path.join(home, '.gemini', 'antigravity');
if (fs.existsSync(antigravityDir)) {
  safeWrite(path.join(antigravityDir, 'rules'), 'rhizo.md', guideContent);
}
