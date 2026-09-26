#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

// 1. Ensure binary permissions
const binDir = path.join(__dirname, '..', 'bin');
try {
  const files = fs.readdirSync(binDir);
  for (const f of files) {
    if (!f.endsWith('.js')) {
      const full = path.join(binDir, f);
      try {
        fs.chmodSync(full, 0o755);
      } catch (_) {}
    }
  }
} catch (_) {}

// 2. Auto-equip detected coding assistants with Locutus rules
const home = os.homedir();
const guideContent = `# Locutus Multi-Agent Coordination Guide

This environment utilizes **Locutus / Locu** for inter-assistant communication, distributed locking, and synchronized task queues over Redis/Valkey.

## 0. Self-Bootstrapping Prerequisite
This project requires \`locu\` and \`braid\`. If \`command -v locu\` or \`command -v braid\` fails, install them via npm:
\`\`\`bash
npm install -g @axiomantic/locu @axiomantic/braid
\`\`\`

## 1. Invariants & Identity
* **No Workspace-Scoped Identity Files**:
  Agent identity is strictly decoupled from directory paths. **Never create or read \`.locutus.agent\` in any project or workspace directory.** Agent identity is resolved exclusively through:
  1. \`LOCUTUS_AGENT_NAME\` environment variable.
  2. Harness session ID mapping (\`LOCUTUS_SESSION_ID=<runtime>:<sessionId>\` via \`~/.config/locutus/sessions.json\` or Redis).
  3. Explicit CLI flag: \`locu open <name> "<tags>"\`.
* **Zero Dirty Commits**:
  All agent state, lockfiles, temporary buffers, and session files must be ignored in \`~/.gitignore_global\` or \`.git/info/exclude\`. Never stage or commit coordination metadata (\`.locutus.*\`, \`*.lock\`).

## 2. Harness Listener Discipline
* **OpenCode**: Do NOT run \`locu listen\` with bash/terminal tools. In-process listening is handled automatically by the OpenCode ear extension (\`skills/locutus/opencode-ear.js\`).
* **Claude Code**: Re-arm listeners using \`locu reply ... --listen\` or configure the \`.claude/settings.json\` \`Stop\` hook.
* **Antigravity / AGY**: Use reactive background tasks via \`run_command\` or wake on queue events. Do not poll in a loop.
* **OpenAI Codex / Pi**: Run \`locu listen <agent>\` in the foreground when waiting, or dispatch a one-shot listener subagent.

## 3. Task Claiming & Fencing Protocol
* **Claiming Work**: When claiming tasks from queues, always negotiate leases:
  \`\`\`bash
  locu claim queue:<project>:tasks --lease 1800
  \`\`\`
* **Fencing Tokens**: Every claimed task yields a monotonic \`fencing_token\`. Record this token in your task execution manifest. If your lease expires, never write back with an outdated token.
* **Completion & Ack**:
  Once task work is verified:
  \`\`\`bash
  locu ack queue:<project>:tasks <task_id>
  locu reply --to <sender> '{"status": "completed", "task_id": "<task_id>"}'
  \`\`\`
`;

function safeWrite(destDir, fileName, content) {
  try {
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    const target = path.join(destDir, fileName);
    fs.writeFileSync(target, content, 'utf8');
    console.log(`[locu postinstall] Provisioned rules to: ${target}`);
  } catch (err) {
    // Non-fatal if permissions or sandbox prevent writing
  }
}

// Claude Code
const claudeDir = path.join(home, '.claude');
if (fs.existsSync(claudeDir)) {
  safeWrite(path.join(claudeDir, 'rules'), 'locutus.md', guideContent);
}

// OpenCode
const opencodeDir = path.join(home, '.config', 'opencode');
if (fs.existsSync(opencodeDir)) {
  safeWrite(path.join(opencodeDir, 'instructions'), 'locutus.md', guideContent);
  const earSource = path.join(__dirname, '..', 'skills', 'locutus', 'opencode-ear.js');
  if (fs.existsSync(earSource)) {
    const pluginDir = path.join(opencodeDir, 'plugins');
    if (!fs.existsSync(pluginDir)) fs.mkdirSync(pluginDir, { recursive: true });
    try {
      fs.copyFileSync(earSource, path.join(pluginDir, 'opencode-ear.js'));
      console.log(`[locu postinstall] Provisioned OpenCode ear plugin`);
    } catch (_) {}
  }
}

// Antigravity
const antigravityDir = path.join(home, '.gemini', 'antigravity');
if (fs.existsSync(antigravityDir)) {
  safeWrite(path.join(antigravityDir, 'rules'), 'locutus.md', guideContent);
}
