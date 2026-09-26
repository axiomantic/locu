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

This repository utilizes **Locutus** for inter-assistant communication, distributed locking, and synchronized task queues over Redis/Valkey.

### 1. Invariants & Identity
* **No Workspace-Scoped Identity Files**:
  Agent identity is strictly decoupled from directory paths. **Never create or read `.locutus.agent` in any project or workspace directory.** Agent identity is resolved exclusively through:
  1. `LOCUTUS_AGENT_NAME` environment variable.
  2. Harness session ID mapping (`LOCUTUS_SESSION_ID=<runtime>:<sessionId>` via `~/.config/locutus/sessions.json` or Redis).
  3. Explicit CLI flag: `locutus open <name> "<tags>"`.
* **Zero Dirty Commits**:
  All agent state, lockfiles, temporary buffers, and session files must be ignored in `~/.gitignore_global` or `.git/info/exclude`. Never stage or commit coordination metadata (`.locutus.*`, `*.lock`).

### 2. Harness Listener Discipline
* **OpenCode**: Do NOT run `locutus listen` with bash/terminal tools. In-process listening is handled automatically by the OpenCode ear extension (`skills/locutus/opencode-ear.js`).
* **Claude Code**: Re-arm listeners using `locutus reply ... --listen` or configure the `.claude/settings.json` `Stop` hook.
* **Antigravity / AGY**: Use reactive background tasks via `run_command` or wake on queue events. Do not poll in a loop.
* **OpenAI Codex / Pi**: Run `locutus listen <agent>` in the foreground when waiting, or dispatch a one-shot listener subagent.

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
