# AGENTS.md — Locutus & Multi-Agent Workspace Guide

This repository guide establishes the invariants, directory conventions, build-cache configurations, and reconciliation protocols for AI coding agents operating across projects.

<!-- BEGIN RHIZO GUIDE [v1.0] -->
<!-- DO NOT EDIT DIRECTLY: Managed by `rhizo guide install` -->

## Rhizo Multi-Agent Coordination Guide

This repository utilizes **Rhizo** for inter-assistant communication, distributed locking, and synchronized task queues over Redis/Valkey.

### 0. Self-Bootstrapping Prerequisite
This project requires `rhizo` and `vine`. If `command -v rhizo` or `command -v vine` fails, install them via npm:
```bash
npm install -g @axiomantic/rhizo @axiomantic/vine
```
*(In restricted environments without global install permissions, prefix commands with `npx -y @axiomantic/rhizo` or `npx -y @axiomantic/vine`).*

### 1. Invariants & Identity
* **No Workspace-Scoped Identity Files**:
  Agent identity is strictly decoupled from directory paths. **Never create or read `.rhizo.agent` in any project or workspace directory.** Agent identity is resolved exclusively through:
  1. `RHIZO_AGENT_NAME` environment variable.
  2. Harness session ID mapping (`RHIZO_SESSION_ID=<runtime>:<sessionId>` via `~/.config/rhizo/sessions.json` or Redis).
  3. Explicit CLI flag: `rhizo open <name> "<tags>"`.
* **Zero Dirty Commits**:
  All agent state, lockfiles, temporary buffers, and session files must be ignored in `~/.gitignore_global` or `.git/info/exclude`. Never stage or commit coordination metadata (`.rhizo.*`, `*.lock`).

### 2. Harness Listener Discipline & Capability-Based Execution (Anti-Token-Thrash)
* **Zero Timeouts (Anti-Token-Thrash Invariant)**:
  Always invoke `rhizo listen <agent>` with **no timeout** (infinite wait). Never pass arbitrary bounded timeouts (e.g. 30s or 120s). When a timeout expires, the command exits empty, forcing the assistant to burn an entire LLM inference cycle (context + reasoning + generation) just to re-run the listener (up to 120 empty wakeups/hour). Redis `BLPOP` consumes 0 CPU, 0 bandwidth, and 0 tokens while waiting indefinitely until work arrives. Timeouts are strictly optional and explicitly discouraged across the board.

* **Tool Capability Decision Tree (Introspect Your Runtime Tools)**:
  Agents must never block their primary conversation turn. Evaluate your harness tools in this exact priority order (always prefer direct background execution in the main chat over subagents to minimize token overhead):
  1. **In-Process Harness Ear Extension** (e.g. OpenCode `opencode-ear.js`, Pi `pi-ear.ts`):
     - Do NOT execute `rhizo listen` with any tool. Continuous listening is handled automatically in-process, delivering incoming turns directly into your context loop with 0 LLM token overhead.
  2. **Shell Tool with Native Daemon / Background Support in Main Chat** (e.g. `run_command(..., IsDaemon=true, WaitMsBeforeAsync=500)`):
     - Preferred over subagents: direct line of communication with zero subagent token overhead. Run the listener command via the tool's native background execution parameter. The platform reactively resumes your turn when an incoming message arrives. Do not poll in a loop.
  3. **Subagent / Task Tool with Background Support** (e.g. `Task(..., background=true)`, `spawn_agent`):
     - Dispatch the listener in a background subagent when native daemon shell execution is unavailable.
     - **CRITICAL INVARIANT — NO DOUBLE-DAEMONS (Prohibition of Nested Background Execution)**: Inside the subagent, the command itself must be **SYNCHRONOUS AND BLOCKING** (`rhizo listen <agent>`). Do NOT run as a daemon or background process inside the subagent. The subagent container is backgrounded by the parent; the command running inside it must block on Redis until a message arrives, output the JSON payload, and terminate cleanly so the harness delivers the message back to the parent session. Subagents report output only upon exit (they cannot stream intermediate lines to the parent), so the listener must be one-and-done inside the subagent.
  4. **Neither Capability Available (Synchronous-Only Shell Execution)**:
     - If the harness only provides synchronous foreground shell tools with no managed background parameter, **DO NOT run `rhizo listen`**. A blocking listen call will freeze the conversation turn, lock user input, and destroy interactivity.
     - **Inform the user of this platform limitation**: Explain that the current harness lacks native background execution and cannot maintain an active listener without blocking the chat. Advise the user that incoming communications over `rhizo` must be checked explicitly (e.g. via `rhizo check-inbox` on demand or during user turns).

* **STRICT PROHIBITION: Never Use Shell `&` or Output Redirects**:
  ❌ **NEVER run `rhizo listen &`, `nohup rhizo listen &`, or redirect stdout/stderr (`> /dev/null 2>&1 &` or `> file.log &`)**.
  - Detaching with `&` creates an unmanaged shell process that severs process tracking.
  - Redirecting stdout/stderr **swallows the notification stream**! The agent's event loop will never see the incoming message and the agent will remain permanently deaf to incoming tasks and in-flight preemption interrupts.

### 3. Task Claiming & Fencing Protocol
* **Claiming Work**: When claiming tasks from queues, always negotiate leases:
  ```bash
  rhizo claim queue:<project>:tasks --lease 1800
  ```
* **Fencing Tokens**: Every claimed task yields a monotonic `fencing_token`. Record this token in your task execution manifest. If your lease expires, never write back with an outdated token.
* **Completion & Ack**:
  Once task work is verified:
  ```bash
  rhizo ack queue:<project>:tasks <task_id>
  rhizo reply --to <sender> '{"status": "completed", "task_id": "<task_id>"}'
  ```
<!-- END RHIZO GUIDE -->

<!-- BEGIN VINE GUIDE [v1.0] -->
<!-- DO NOT EDIT DIRECTLY: Managed by `vine guide install` -->

## Vine Workspace & Strand Coordination Guide

Vine manages zero-cost APFS copy-on-write workspaces (**Strands**), polyglot build cache normalizers, and the Two-Key integration gate for parallel agent development.

### 0. Self-Bootstrapping Prerequisite
This project requires `rhizo` and `vine`. If `command -v rhizo` or `command -v vine` fails, install them via npm:
```bash
npm install -g @axiomantic/rhizo @axiomantic/vine
```

### 1. Invariants & Strand Identity
* **No Workspace-Scoped Identity Files**:
  Agent identity is strictly decoupled from directory paths. Never create or read `.rhizo.agent` or `.vine.agent` in any project or strand directory.
* **Zero Dirty Commits**:
  All strand state, lockfiles, temporary buffers, and manifests must be ignored in `~/.gitignore_global` or `.git/info/exclude`. Never stage or commit coordination metadata (`.vine.json`, `workspaces/`).
* **Compaction Recovery**:
  Whenever starting a session or recovering from context compaction, inspect active strands before editing canonical files:
  ```bash
  vine list 2>/dev/null || rift list 2>/dev/null || ls -la ~/Development/workspaces/ 2>/dev/null || true
  ```
  If an assigned task has an active `.vine.json`, re-anchor to that directory instead of touching the canonical repository root.

---

### 2. When to Spin a Strand vs. Working in Trunk
* **Spin an Isolated Strand when**:
  - The repository contains Git submodules (e.g., PebbleOS).
  - The task requires complex, multi-file refactoring or high risk of breaking `main`.
  - Parallel subagents or assistants are operating simultaneously on different tasks.
* **Work Directly in Trunk when**:
  - The task is a trivial 1-file documentation fix, typo correction, or minor configuration tweak.

---

### 3. Strand Provisioning Protocol

#### Step 1: Directory Setup
All strands live outside canonical repositories to prevent recursive indexing and IDE thrashing:
```bash
STRAND_DIR="$HOME/Development/workspaces/<project>/<task-slug>/<repo>"
mkdir -p "$(dirname "$STRAND_DIR")"
```

#### Step 2: Submodule Pre-Flight Check & Workspace Creation
1. **Check for Uninitialized Submodules**:
   ```bash
   if git submodule status 2>/dev/null | grep -q '^-'; then
     echo "WARNING: Canonical repository has uninitialized submodules. Initialize first before cloning!"
   fi
   ```
2. **Clone Workspace via APFS Copy-on-Write**:
   - **Repositories with Submodules (e.g. PebbleOS)**:
     Use `rift` (native APFS CoW cloning of working tree + `.git/modules` in ~9s with 0 extra blocks):
     ```bash
     rift create --into "$(dirname "$STRAND_DIR")" --name "<repo>"
     ```
   - **Monolithic Repositories without Submodules (e.g. rhizo, redis)**:
     Use native Git worktree:
     ```bash
     git worktree add "$STRAND_DIR" -b "<branch>"
     ```
3. **Stat Cache Warmup**:
   Silences APFS inode change time (`ctime`) differences in <15ms:
   ```bash
   git -C "$STRAND_DIR" update-index --refresh >/dev/null 2>&1 || true
   ```

#### Step 3: The Universal APFS CoW Vendoring Fast-Path
Clone pre-built dependency caches from the canonical repository in <80ms without consuming physical disk space:
```bash
CANONICAL_REPO="$HOME/Development/<project>"
VENDORED_DIRS=("deps" "nimbledeps" "vendor" "node_modules" ".zig-cache")

for vdir in "${VENDORED_DIRS[@]}"; do
  if [ -d "$CANONICAL_REPO/$vdir" ] && [ ! -d "$STRAND_DIR/$vdir" ]; then
    cp -c -R "$CANONICAL_REPO/$vdir" "$STRAND_DIR/$vdir"
  fi
done
```

#### Step 4: Python Virtual Environment (`.venv`) Policy
1. Inspect `$CANONICAL_REPO/.venv/pyvenv.cfg`.
2. **If `relocatable = true`**: Safe to APFS clone:
   ```bash
   cp -c -R "$CANONICAL_REPO/.venv" "$STRAND_DIR/.venv"
   ```
3. **If NOT relocatable**: **Do not blind-copy** (prevents mutating parent environment via absolute shebangs).
   - Check `vine.toml` for `venv_policy`:
     - If `recreate`: Run `UV_VENV_RELOCATABLE=1 uv venv "$STRAND_DIR/.venv"` (~12ms).
     - If `prompt` (default): Ask user whether to recreate or skip.

#### Step 5: Non-Destructive Polyglot `.envrc` Setup
Place this `.envrc` in `$STRAND_DIR` and run `direnv allow "$STRAND_DIR"`:
```bash
# Source parent repository .envrc if present (non-destructive chaining)
[ -f "$HOME/Development/<project>/.envrc" ] && source_env "$HOME/Development/<project>/.envrc"

export PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
export CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/dev-workspaces/$(basename "$PROJECT_ROOT")"
mkdir -p "$CACHE_ROOT"

# C / C++ Ccache normalization across Strands
if command -v ccache >/dev/null 2>&1; then
    export CCACHE_BASEDIR="$(dirname "$PROJECT_ROOT")"
    export CCACHE_NOHASHDIR=1
fi

# Rust Target / Sccache
[ -f "$PROJECT_ROOT/Cargo.toml" ] && export CARGO_TARGET_DIR="$CACHE_ROOT/cargo-target"

# Python uv clone mode
export UV_LINK_MODE="clone"

# Nim Nimcache
export NIMCACHE="$CACHE_ROOT/nimcache"
```

#### Step 6: Initialize Strand Manifest (`.vine.json`)
```json
{
  "task_id": "<task-id>",
  "project": "<project>",
  "strand_path": "<strand-dir>",
  "branch": "<branch>",
  "base_branch": "<base-branch>",
  "base_commit": "<base-commit-sha>",
  "status": "IN_PROGRESS",
  "created_at": "2026-09-26T12:00:00Z"
}
```

---

### 4. Turn-End & Weaving Protocol (The Two-Key Rule)

Never declare a task complete or attempt to weave without passing both keys:

#### Key 1: In-Memory Conflict Gate
```bash
BASE_BRANCH="${BASE_BRANCH:-main}"
git merge-tree --write-tree "$BASE_BRANCH" HEAD
```
- **Exit 0**: Clean mechanical merge.
- **Exit 1**: Conflicts detected. Resolve conflicts *inside the Strand* before touching canonical trunk.

#### Key 2: Live Compiler & Test Suite Gate (Zero Green Mirage)
Execute the project's actual build and test suite inside the Strand:
```bash
# Inferred or from vine.toml [verification] test_command:
$BUILD_AND_TEST_COMMAND
```
*Never bypass this gate. `git merge-tree` only verifies text mergeability, not compilation or semantic correctness.*

#### Step 3: Weave into Canonical Trunk
Once Key 1 and Key 2 pass 100% green:
```bash
cd "$CANONICAL_REPO"
# Fetch branch directly from isolated Strand
git fetch "$STRAND_DIR" <branch>:<branch>
# Fast-forward merge
git merge --ff-only <branch>
```

#### Step 4: Prune & Cleanup
```bash
rm -rf "$STRAND_DIR"
command -v rift >/dev/null 2>&1 && rift prune >/dev/null 2>&1 || true
```
<!-- END VINE GUIDE -->

<!-- BEGIN GARDEN GUIDE [v1.0] -->
<!-- DO NOT EDIT DIRECTLY: Managed by `garden guide install` -->

## Garden Multi-Agent Swarm & Ceremony Guide

Garden directs high-level methodology, persona deliberations, and synchronized task execution on top of Rhizo (transport) and Vine (workspace integrator).

### 0. Self-Bootstrapping Prerequisite
This project requires `rhizo`, `vine`, and `garden`. If missing, install via npm:
```bash
npm install -g @axiomantic/rhizo @axiomantic/vine @axiomantic/garden
```

### 1. Invariants & Epistemic Protocol
* **Zero Theatrical Dialogue**:
  Every dialectical exchange must cite empirical evidence obtained from tool execution (file line citations, test suite runs, AST analysis, compiler output). Theatrical roleplay without tool grounding is strictly prohibited.
* **Single-Source Planning**:
  All tasks, locks, and strands must be coordinated via `implementation_plan.md`. Dynamic progress must be tracked in lockstep with plan checkboxes (`- [ ]` to `- [x]`) and harness To-Do tracking.
* **Emergent Design Addendum Protocol**:
  Workers discovering architectural discrepancies cannot unilaterally deviate from `design.md`. They must submit a formal `addendum_<topic>.md` with rationale, await Orchestrator ratification, update `design.md`, and refresh `implementation_plan.md`.

### 2. Fleet Lifecycle & Multiplexer Discipline
* **Tmux Multiplexing**:
  All swarm workers run inside managed tmux panes created via `garden launch` or `scripts/launch_tmux_swarm.sh`. Never detach unmanaged background processes with `&` or redirect output.
* **Continuous Listening**:
  Workers must keep their Rhizo listener active (`rhizo listen <agent>`) with zero-timeout infinite wait to prevent token thrashing.

### 3. The Two-Key Gate & Strand Weaving
Never weave a strand into the canonical trunk without passing both keys:
* **Key 1 (Mechanical)**: In-memory conflict pre-check (`git merge-tree --write-tree`).
* **Key 2 (Semantic)**: Automated compiler and test suite run inside the strand.
* **Weave**: `vine weave && rhizo ack queue:<project>:tasks <task_id>`
<!-- END GARDEN GUIDE -->



