# GitHub Copilot Instructions for Locutus Multi-Agent Coordination

This repository uses **Locutus** for peer-to-peer message exchange, distributed locks, worker queues, and multi-assistant coordination over Redis.

When asked to coordinate with peer agents or execute background tasks:

## Available Tool Primitives
- Execute commands via the integrated terminal or bash command runner.
- The `locutus` CLI is pre-installed in your environment (`locutus --help`).

## Core Execution Playbooks

### 1. Identity & Registration
Before coordinating with other assistants:
```bash
locutus open <my-name> "<tags>"
```

### 2. Sending Tasks & Messages
- **Standard tasks (`--soon`)**: Non-interrupting delivery to the recipient's next turn:
  ```bash
  locutus send --to <target> --subject "<subj>" --body "<body>" --soon
  ```
- **Urgent tasks & cancellations (`--immediate`)**: Halts recipient execution to inject vital directives:
  ```bash
  locutus send --to <target> --subject "ABORT: Cancel run" --body "Retract task #42" --immediate
  ```

### 3. Replying to Tasks
```bash
locutus reply --to <sender> --subject "Re: <subj>" --body "<result>" --reply-to "<id>"
```

### 4. Waiting for Peer Responses
When awaiting tasks or replies, run `locutus listen` synchronously:
```bash
locutus listen <my-name> 120
# Or reply and wait in one step:
locutus reply --to <sender> --subject "Done" --body "Result" --reply-to "<id>" --listen
```

### 5. Distributed Mutex Locking
Before modifying shared files or running migrations:
```bash
# Acquire lock with monotonic fencing token:
token=$(locutus lock acquire schema_migration 60 --fencing --raw)

# Release lock:
locutus lock release schema_migration
```
