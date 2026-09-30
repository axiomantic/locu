---
name: rhizo
description: "Multi-agent coordination, inter-terminal messaging bus, distributed file/mutex locking with monotonic fencing tokens, orchestrating multi-stage DAG task pipelines, cluster health watchdog sweeping, and worker queues over Redis. Use when coordinating work between multiple AI assistants or terminal sessions, acquiring distributed mutex locks before editing shared files or running migrations/deployments, generating monotonic fencing tokens to prevent zombie writes, dispatching tasks or RPC queries to peer agents, producing/consuming from competing-consumer work queues, orchestrating multi-stage pipelines with automatic dependency resolution, reliably claiming tasks with leases and ack/DLQ handling, scattering tasks to a pool for quorum aggregation, sharing scratchpad memory, managing floor control in roundtable brainstorming, setting and checking run cancellation tokens, running blind consensus ballots without anchoring bias, electing resilient mesh leaders with automated lease failover, auditing cluster health and sweeping dead agent/listener garbage, or discovering active teammates and their status. Triggers: 'rhizo', 'coordinate with the other terminal/agent', 'talk to agent', 'send task to', 'ask the other assistant', 'inter-agent chat', 'lock file', 'lock resource', 'mutex lock', 'prevent concurrent edits', 'fencing token', 'monotonic counter', 'zombie writes', 'work queue', 'enqueue task', 'claim task', 'ack task', 'reliable queue', 'dead letter queue', 'dlq', 'blackboard', 'scratchpad', 'shared memory', 'floor control', 'speaker ring', 'moderated roundtable', 'pass floor', 'yield floor', 'cancel task', 'cancel run', 'cancellation token', 'abort run', 'ballot', 'vote', 'consensus', 'blind voting', 'leader election', 'acquire leader', 'failover', 'mesh leader', 'scatter', 'gather', 'quorum', 'workflow', 'dag', 'pipeline', 'task dependencies', 'resolve step', 'workflow next', 'sweep', 'clean dead agents', 'stale locks', 'garbage collection', 'cluster watchdog', 'who is online', 'agent status', 'locutus', 'Redis bus'."
---

# Rhizo: High-Performance Inter-Agent Coordination Bus

## 0. Prerequisite & Bootstrapping

All multi-agent operations require the native `rhizo` CLI. If missing, install globally:
```bash
npm install -g @axiomantic/rhizo
# Or install full triad:
npm install -g @axiomantic/rhizo @axiomantic/vine @axiomantic/garden
```

> [!TIP]
> **Zero-Install Fallback (`npx`)**: In restricted environments where global installations are prohibited, prefix commands with `npx -y @axiomantic/rhizo <command>`.

---

## 1. Core Operational Invariants

<CRITICAL>
Run 'rhizo listen <agent>' with zero timeout (infinite wait). Do not pass bounded timeouts (--timeout 30), because timeout expiry forces empty LLM wakeups that exhaust token budgets.
</CRITICAL>

<FORBIDDEN>
Never execute 'rhizo listen &' or redirect output ('> /dev/null'). Detaching severs process supervision. Redirecting output discards the notification stream, causing permanent agent deafness.
</FORBIDDEN>

<INVARIANT>
Inside background subagents, 'rhizo listen' must execute as a synchronous, blocking foreground command. Subagents notify parents only on process exit. Never launch background daemons inside subagents (no double-daemons).
</INVARIANT>

<INVARIANT>
Identity Allocation: Agent identity must be unique and collision-free across projects. Run 'rhizo name' to acquire an atomically reserved unique codename (held in Redis for 10 minutes). Coding harness subshells do not preserve environment variables across tool turns. Record the literal name output from 'rhizo name' (e.g. 'locutus-sequoia') in your reasoning context and pass it explicitly in all subsequent commands: 'rhizo open <name>', 'rhizo listen <name>'.
</INVARIANT>

<INVARIANT>
Never stage coordination metadata (*.lock, .rhizo.*) into Git. Keep all agent state in ~/.gitignore_global.
</INVARIANT>

---

## 2. Capability-Based Listener Execution

Inspect your available runtime tools and execute the highest matching tier:

| Tier | Capability | Action | Rationale |
| :--- | :--- | :--- | :--- |
| **Tier 1** | In-Process Extension (e.g. OpenCode `opencode-ear.js`, Pi) | **Do not call any listen tool** | Plugin runs listener in-process and injects turns automatically with 0 token overhead. |
| **Tier 2** | Shell tool with daemon support (e.g. Antigravity `run_command(IsDaemon=true)`) | Run `rhizo listen <agent>` as managed daemon | Maintains direct line of communication in main chat with 0 subagent token overhead. |
| **Tier 3** | Subagent tool with background support (e.g. Claude Code `Task(background=true)`) | Dispatch subagent running blocking `rhizo listen <agent>` | Subagent blocks until one message arrives, outputs JSON, and exits to wake parent. |
| **Tier 4** | Synchronous foreground shell only | **Do not run `rhizo listen`**. Call `rhizo check-inbox` | Blocking foreground shell freezes the turn. Poll explicitly during user turns. |

*For exact configuration parameters and tool call snippets, see [references/capability_archetypes.md](references/capability_archetypes.md).*

---

## 3. Causal Command Reference

| Intent | Command | Invariant / Anti-Pattern |
| :--- | :--- | :--- |
| **Reserve Identity** | `rhizo name [prefix] [--ttl 600] [--json]` | Atomically reserve a unique codename from the 1,000-word lexicon (held in Redis for 10 min). |
| **Register & Listen** | `rhizo open [name] [tags] --listen` | Always specify tags to enable group broadcasts (`--tags worker,builder`). |
| **Continuous Ear** | `rhizo listen [name] [--quiet]` | Do not set `--timeout`. Let command block indefinitely until work arrives. |
| **Dispatch Task** | `rhizo send --to <agent> --subject <s> --body <b>` | Use `--type task` for actionable directives, `--type query` for questions. |
| **Direct Reply** | `rhizo reply --to <agent> --subject <s> --body <b>` | Always include `--reply-to <task_id>` when responding to an assigned task. |
| **Synchronous RPC** | `rhizo request --to <agent> --subject <s> --body <b> --raw` | Caller blocks up to 30s. Specialist must respond using `rhizo reply`. |
| **Scatter / Quorum** | `rhizo scatter --targets <@tag\|*> --subject <s> --body <b> --quorum N` | Waits until $N$ distinct agents reply. Exits 1 if timeout expires before quorum. |
| **Claim Work** | `rhizo claim <queue> --lease <sec> [--run-id <id>] --raw` | Negotiate lease duration. If task exceeds lease, renew before writeback. |
| **Acknowledge Work** | `rhizo ack <queue> <task_id>` | Call only after work is verified. Failure to ack returns task to queue (or DLQ). |
| **Acquire Lock** | `rhizo lock <name> [ttl_sec] --fencing --raw` | Always use `--fencing`. If exit code is 1, abort. Never write with an outdated token. |
| **Release Lock** | `rhizo unlock <name>` | Release immediately after write verification. Locks cannot be unlocked by non-owners. |
| **Cancel Run** | `rhizo cancel <run_id> [--reason <text>]` | Cancels all active tasks linked to `run_id`. Workers check via `--run-id`. |
| **Check Inbox** | `rhizo check-inbox [name]` | Non-blocking. Use only under Tier 4 synchronous shells. |
| **Cluster Health** | `rhizo sweep [--dry-run] --raw` | Prunes dead agent registrations and stale listener sockets. |
| **Health Check** | `rhizo ping [--json]` | Sub-millisecond latency and connectivity check to Redis/Valkey. |
| **Reset Project** | `rhizo reset [project] [--all/-a] [--json]` | Sends shutdown poison-pill to active project listeners, unbinds sessions, and purges project keys. Pass `--all` to nuke entire namespace. |
| **Nuke Namespace** | `rhizo nuke [--json]` | Nuclear reset: sends shutdown poison-pill to all listeners, unbinds sessions, and wipes all keys matching `{prefix}*`. |

---

## 4. Essential Coordination Workflows

### A. Agent Identity Allocation & Context Retention
Coding harness tools execute in isolated subshells (`bash -c` / `zsh -c`) that do not preserve shell environment variables across turns (`NAME=$(rhizo name)` is lost in subsequent turns).

1. Acquire an atomically held unique codename:
```bash
rhizo name
# Stdout: locutus-sequoia
```
2. Note the returned codename in your reasoning context (`"My assigned name is locutus-sequoia"`).
3. Pass that literal name in all subsequent tool calls:
```bash
rhizo open locutus-sequoia "backend,worker"
rhizo listen locutus-sequoia
```

### B. Distributed Locking with Monotonic Fencing
Before editing a shared file, database schema, or deployment resource, acquire a fencing token:
```bash
FENCE=$(rhizo lock file:config.json 60 --fencing --raw) || { echo "Lock collision"; exit 1; }
# Perform edits safely...
# Verify token has not been superseded before saving...
rhizo unlock file:config.json
```
<FORBIDDEN>
Never perform shared mutations if your lease expired. If a lease expires, another agent may have acquired a higher fencing token; proceeding causes silent data overwrites (zombie writes).
</FORBIDDEN>

### C. Competing-Consumers Queue with Dead-Letter Leases
Workers claim tasks from shared project queues:
```bash
# 1. Atomically claim task with a 120s lease:
TASK=$(rhizo claim queue:frontend:tasks --lease 120 --raw) || exit 0
TASK_ID=$(echo "$TASK" | jq -r '.id')
# 2. Execute task...
# 3. Confirm completion and release lease:
rhizo ack queue:frontend:tasks "$TASK_ID"
rhizo reply --to orchestrator --subject "Task complete" --body '{"status":"ok"}' --reply-to "$TASK_ID"
```

### D. Quorum Consensus Across Agents
Orchestrators fan out decision proposals and await consensus:
```bash
rhizo scatter --targets "@reviewers" --subject "Architecture Approval" --body '{"proposal":"RFC-101"}' --quorum 2 --timeout 30
```

### E. Global Run Cancellation
When an orchestrator aborts a workflow, all worker loops pass `--run-id` to terminate immediately:
```bash
# Orchestrator abort:
rhizo cancel run-90210 --reason "User requested stop"

# Worker loop awareness (exits 0 immediately if run is cancelled):
rhizo claim queue:build:tasks --lease 60 --run-id run-90210
```

---

## 5. Architectural References

- **Capability Archetypes & Harness Execution**: See [references/capability_archetypes.md](references/capability_archetypes.md)
- **JSON Wire Protocol & Payloads**: See [references/wire_spec.md](references/wire_spec.md)
