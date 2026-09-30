---
name: coding-harness-ear-verification
description: "Development-only verification playbook and test guide for developing and onboarding coding harnesses onto Rhizo. Focuses strictly on interactive computer-use testing of the Continuous Listening (Ear) Invariant, autonomous task acceptance, in-flight preemption/interruptibility, and turn-end re-arming across heterogeneous coding assistants (Claude Code, OpenCode, Antigravity, and future harnesses)."
---

# Coding Harness Ear Verification Playbook (Continuous Listening & Preemption)

> **Development Guide for Harness Engineers & Verification Agents**  
> *This playbook guides testing of new coding harnesses, plugins, and ear extensions to verify continuous background listening and preemption.*

---

## 1. Core Verification Invariants

<CRITICAL>
The Autonomous Loop Invariant: Once an interactive coding harness launches, the test conductor never enters manual keyboard prompts to deliver tasks. All subsequent instructions, handoffs, and interrupts must flow exclusively over the Rhizo Redis bus ('rhizo send', 'rhizo reply', 'rhizo cancel').
</CRITICAL>

<INVARIANT>
Continuous Listening While Working: The background listener must continue running while the harness executes tools and generates tokens. If a harness drops its listener while working, it cannot receive urgent in-flight preemption or cancellation signals.
</INVARIANT>

<INVARIANT>
Zero Timeouts: Listeners must block indefinitely with timeout 0. Bounded timeouts trigger empty turn wakes that exhaust token budgets without work arriving.
</INVARIANT>

<FORBIDDEN>
Never run background daemons or infinite streaming loops inside subagents. Subagents only notify parent chats upon exit. Inside subagents, 'rhizo listen' must be a single-shot synchronous blocking call that exits on message receipt.
</FORBIDDEN>

---

## 2. Harness Capability Archetypes

| Archetype | Examples | Mechanism | Conductor Verification |
| :--- | :--- | :--- | :--- |
| **In-Process Plugin** | OpenCode (`opencode-ear.js`), Pi (`pi-ear.ts`) | Plugin supervises `rhizo listen` internally and injects prompts via SDK. | Verify prompt wakes idle assistant with 0 tool calls. Verify `--immediate` aborts active turns. |
| **Main-Chat Daemon** | Antigravity (`run_command(IsDaemon=true)`) | Background shell process in primary session. | Verify turn resumes reactively on stdout receipt. |
| **Background Subagent** | Claude Code (`Task(background=true)`) | Subagent executes blocking `rhizo listen` until 1 message arrives, then exits. | Verify parent session resumes when subagent terminates. Verify no nested daemons. |
| **Explicit Polling** | Fallback for synchronous shells | Assistant invokes `rhizo check-inbox` during user turns. | Verify assistant does not attempt blocking calls in the foreground. |

---

## 3. The 4-Step Interactive Verification Playbook

When validating a harness using computer use (`macos-mcp` or live GUI):

### Step 1: Idle Waking Test
1. Launch harness in an idle state.
2. Send test task:
   ```bash
   rhizo send --to test-agent --subject "Ping" --body '{"action":"ping"}'
   ```
3. **Pass Criteria**: Harness wakes autonomously without operator keystrokes and acknowledges receipt.

### Step 2: Multi-Turn Chain Test
1. Enqueue 3 sequential tasks:
   ```bash
   rhizo enqueue queue:verify:tasks --subject "Step 1" --body '{"cmd":"echo 1"}'
   rhizo enqueue queue:verify:tasks --subject "Step 2" --body '{"cmd":"echo 2"}'
   rhizo enqueue queue:verify:tasks --subject "Step 3" --body '{"cmd":"echo 3"}'
   ```
2. Instruct agent to drain `queue:verify:tasks`.
3. **Pass Criteria**: Harness processes all 3 tasks consecutively without human prompts between turns.

### Step 3: In-Flight Interrupt Test (`--immediate`)
1. Trigger long-running tool call (e.g. 30s sleep).
2. Dispatch high-priority interrupt:
   ```bash
   rhizo send --to test-agent --immediate --subject "ABORT" --body '{"halt":true}'
   ```
3. **Pass Criteria**: Harness aborts long-running tool immediately or processes interrupt in the active context window.

### Step 4: Environment & Hygiene Audit
Audit after test run:
- [ ] Working tree clean of temporary coordination files.
- [ ] No lingering headless bash processes (`pgrep -fl "rhizo listen"`).
- [ ] Redis inbox and heartbeat keys reflect clean state (`rhizo sweep --dry-run`).
