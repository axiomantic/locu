#!/usr/bin/env python3
"""
codex_stop_hook.py - OpenAI Codex `Stop` Lifecycle Hook for Locutus.

Runs at the end of a Codex response turn.
If messages are waiting in the Locutus inbox:
  - Drains them atomically
  - Returns `{"decision": "block", "reason": "<messages_text>"}`
  - In Codex, `decision: "block"` on `Stop` creates a continuation prompt
    that acts as a new user prompt, feeding the message directly to the model.
If inbox is empty:
  - Exits with `{}` allowing Codex to stop normally.
"""

import json
import sys
from pathlib import Path

# Add hooks directory to path for hook_utils
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hook_utils import resolve_agent_name, check_inbox, drain_inbox


def main():
    try:
        raw_input = sys.stdin.read()
        payload = json.loads(raw_input) if raw_input.strip() else {}
    except Exception:
        payload = {}

    session_id = payload.get("session_id", "")
    agent_name = resolve_agent_name(session_id, runtime_prefix="codex")

    if not agent_name:
        # Agent not registered on Locutus bus; pass through silently
        print("{}")
        return

    # Check unread count
    count = check_inbox(agent_name)
    if count <= 0:
        print("{}")
        return

    # Drain messages formatted for continuation prompt
    messages_text = drain_inbox(agent_name, format_type="hook")
    if not messages_text:
        print("{}")
        return

    # In Codex, Stop with decision: "block" uses reason as the next prompt
    output = {
        "decision": "block",
        "reason": messages_text
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()
