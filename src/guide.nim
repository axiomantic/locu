# src/guide.nim
# Manages installable/uninstallable demarcated documentation blocks in AGENTS.md
# for the Locutus multi-agent coordination mesh.
# Uses atomic temporary file writes and strict balanced-marker validation
# to ensure zero file corruption or data loss.

import std/[os, strutils]

const
  GuideVersion* = "v1.0"
  BeginMarker* = "<!-- BEGIN LOCUTUS GUIDE [" & GuideVersion & "] -->"
  EndMarker* = "<!-- END LOCUTUS GUIDE -->"
  MarkerPrefix* = "<!-- BEGIN LOCUTUS GUIDE"

const CanonicalGuideContent* = """
<!-- BEGIN LOCUTUS GUIDE [v1.0] -->
<!-- DO NOT EDIT DIRECTLY: Managed by `locutus guide install` -->

## Locutus Multi-Agent Coordination Guide

This repository utilizes **Locutus / Locu** for inter-assistant communication, distributed locking, and synchronized task queues over Redis/Valkey.

### 0. Self-Bootstrapping Prerequisite
This project requires `locu` and `braid`. If `command -v locu` or `command -v braid` fails, install them via npm:
```bash
npm install -g @axiomantic/locu @axiomantic/braid
```

### 1. Invariants & Identity
* **No Workspace-Scoped Identity Files**:
  Agent identity is strictly decoupled from directory paths. **Never create or read `.locutus.agent` in any project or workspace directory.** Agent identity is resolved exclusively through:
  1. `LOCUTUS_AGENT_NAME` environment variable.
  2. Harness session ID mapping (`LOCUTUS_SESSION_ID=<runtime>:<sessionId>` via `~/.config/locutus/sessions.json` or Redis).
  3. Explicit CLI flag: `locutus open <name> "<tags>"`.
* **Zero Dirty Commits**:
  All agent state, lockfiles, temporary buffers, and session files must be ignored in `~/.gitignore_global` or `.git/info/exclude`. Never stage or commit coordination metadata (`.locutus.*`, `*.lock`).

### 2. Harness Listener Discipline & Capability-Based Execution (Anti-Token-Thrash)
* **Zero Timeouts (Anti-Token-Thrash Invariant)**:
  Always invoke `locutus listen <agent>` with **no timeout** (infinite wait). Never pass arbitrary bounded timeouts (e.g. 30s or 120s). When a timeout expires, the command exits empty, forcing the assistant to burn an entire LLM inference cycle (context + reasoning + generation) just to re-run the listener (up to 120 empty wakeups/hour). Redis `BLPOP` consumes 0 CPU, 0 bandwidth, and 0 tokens while waiting indefinitely until work arrives. Timeouts are strictly optional and explicitly discouraged across the board.

* **Tool Capability Decision Tree (Introspect Your Runtime Tools)**:
  Agents must never block their primary conversation turn. Evaluate your harness tools in this exact priority order (always prefer direct background execution in the main chat over subagents to minimize token overhead):
  1. **In-Process Harness Ear Extension** (e.g. OpenCode `opencode-ear.js`, Pi `pi-ear.ts`):
     - Do NOT execute `locutus listen` with any tool. Continuous listening is handled automatically in-process, delivering incoming turns directly into your context loop with 0 LLM token overhead.
  2. **Shell Tool with Native Daemon / Background Support in Main Chat** (e.g. `run_command(..., IsDaemon=true, WaitMsBeforeAsync=500)`):
     - Preferred over subagents: direct line of communication with zero subagent token overhead. Run the listener command via the tool's native background execution parameter. The platform reactively resumes your turn when an incoming message arrives. Do not poll in a loop.
  3. **Subagent / Task Tool with Background Support** (e.g. `Task(..., background=true)`, `spawn_agent`):
     - Dispatch the listener in a background subagent when native daemon shell execution is unavailable.
     - **CRITICAL INVARIANT — NO DOUBLE-DAEMONS (Prohibition of Nested Background Execution)**: Inside the subagent, the command itself must be **SYNCHRONOUS AND BLOCKING** (`locutus listen <agent>`). Do NOT run as a daemon or background process inside the subagent. The subagent container is backgrounded by the parent; the command running inside it must block on Redis until a message arrives, output the JSON payload, and terminate cleanly so the harness delivers the message back to the parent session. Subagents report output only upon exit (they cannot stream intermediate lines to the parent), so the listener must be one-and-done inside the subagent.
  4. **Neither Capability Available (Synchronous-Only Shell Execution)**:
     - If the harness only provides synchronous foreground shell tools with no managed background parameter, **DO NOT run `locutus listen`**. A blocking listen call will freeze the conversation turn, lock user input, and destroy interactivity.
     - **Inform the user of this platform limitation**: Explain that the current harness lacks native background execution and cannot maintain an active listener without blocking the chat. Advise the user that incoming communications over `locutus` must be checked explicitly (e.g. via `locutus check-inbox` on demand or during user turns).

* **STRICT PROHIBITION: Never Use Shell `&` or Output Redirects**:
  ❌ **NEVER run `locutus listen &`, `nohup locutus listen &`, or redirect stdout/stderr (`> /dev/null 2>&1 &` or `> file.log &`)**.
  - Detaching with `&` creates an unmanaged shell process that severs process tracking.
  - Redirecting stdout/stderr **swallows the notification stream**! The agent's event loop will never see the incoming message and the agent will remain permanently deaf to incoming tasks and in-flight preemption interrupts.

### 3. Task Claiming & Fencing Protocol
* **Claiming Work**: When claiming tasks from queues, always negotiate leases:
  ```bash
  locutus claim queue:<project>:tasks --lease 1800
  ```
* **Fencing Tokens**: Every claimed task yields a monotonic `fencing_token`. Record this token in your task execution manifest. If your lease expires, never write back with an outdated token.
* **Completion & Ack**:
  Once task work is verified:
  ```bash
  locutus ack queue:<project>:tasks <task_id>
  locutus reply --to <sender> '{"status": "completed", "task_id": "<task_id>"}'
  ```
<!-- END LOCUTUS GUIDE -->"""

type GuideStatus* = enum
  gsNotFound,
  gsInstalled,
  gsMalformed,
  gsFileMissing

proc checkGuide*(targetPath: string): GuideStatus =
  if not fileExists(targetPath):
    return gsFileMissing

  let content = readFile(targetPath)
  let hasBegin = content.contains(MarkerPrefix)
  let hasEnd = content.contains(EndMarker)

  if hasBegin and hasEnd:
    return gsInstalled
  elif hasBegin xor hasEnd:
    return gsMalformed
  else:
    return gsNotFound

proc installGuide*(targetPath: string): tuple[success: bool, message: string] =
  let status = checkGuide(targetPath)

  if status == gsMalformed:
    return (false, "Error: Malformed markers detected in " & targetPath & " (one marker found without matching pair). Aborting to prevent data loss.")

  let pid = getCurrentProcessId()
  let tmpPath = targetPath & ".tmp." & $pid

  try:
    if status == gsFileMissing:
      createDir(targetPath.splitPath.head)
      let initialContent = "# AGENTS.md — Locutus Multi-Agent Guide\n\n" & CanonicalGuideContent & "\n"
      writeFile(tmpPath, initialContent)
      moveFile(tmpPath, targetPath)
      return (true, "Created " & targetPath & " and installed Locutus Guide [" & GuideVersion & "].")

    let content = readFile(targetPath)

    if status == gsInstalled:
      # In-place update between markers
      let lines = content.splitLines()
      var newLines: seq[string] = @[]
      var inBlock = false
      var replaced = false

      for line in lines:
        if line.contains(MarkerPrefix):
          inBlock = true
          if not replaced:
            newLines.add(CanonicalGuideContent)
            replaced = true
          continue
        elif inBlock and line.contains(EndMarker):
          inBlock = false
          continue

        if not inBlock:
          newLines.add(line)

      writeFile(tmpPath, newLines.join("\n") & "\n")
      moveFile(tmpPath, targetPath)
      return (true, "Updated Locutus Guide to [" & GuideVersion & "] in " & targetPath & ".")

    else: # gsNotFound
      var updated = content.strip(trailing = true)
      if updated.len > 0:
        updated.add("\n\n")
      updated.add(CanonicalGuideContent & "\n")

      writeFile(tmpPath, updated)
      moveFile(tmpPath, targetPath)
      return (true, "Appended Locutus Guide [" & GuideVersion & "] to " & targetPath & ".")

  except Exception as e:
    if fileExists(tmpPath):
      try: removeFile(tmpPath)
      except CatchableError: discard
    return (false, "Error installing guide: " & e.msg)

proc uninstallGuide*(targetPath: string): tuple[success: bool, message: string] =
  let status = checkGuide(targetPath)

  if status == gsFileMissing:
    return (false, "Error: Target file " & targetPath & " does not exist.")

  if status == gsMalformed:
    return (false, "Error: Malformed markers detected in " & targetPath & " (one marker found without matching pair). Aborting to prevent data loss.")

  if status == gsNotFound:
    return (true, "Notice: Locutus Guide not found in " & targetPath & ". Nothing to uninstall.")

  let pid = getCurrentProcessId()
  let tmpPath = targetPath & ".tmp." & $pid

  try:
    let content = readFile(targetPath)
    let lines = content.splitLines()
    var newLines: seq[string] = @[]
    var inBlock = false

    for line in lines:
      if line.contains(MarkerPrefix):
        inBlock = true
        continue
      elif inBlock and line.contains(EndMarker):
        inBlock = false
        continue

      if not inBlock:
        newLines.add(line)

    var resultText = newLines.join("\n").strip(trailing = true)
    if resultText.len > 0:
      resultText.add("\n")

    writeFile(tmpPath, resultText)
    moveFile(tmpPath, targetPath)
    return (true, "Successfully uninstalled Locutus Guide from " & targetPath & ".")

  except Exception as e:
    if fileExists(tmpPath):
      try: removeFile(tmpPath)
      except CatchableError: discard
    return (false, "Error uninstalling guide: " & e.msg)
