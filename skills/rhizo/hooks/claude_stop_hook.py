#!/usr/bin/env python3
"""
claude_stop_hook.py - Claude Code `Stop` Lifecycle Hook for Rhizo.

Runs at the end of a Claude Code response turn.
If messages are waiting in the Rhizo inbox:
  - Drains them atomically
  - Returns `{"decision": "block", ...}` with `additionalContext`
  - Forces Claude Code to immediately continue into a new response turn.
If inbox is empty:
  - Exits with `{}` allowing Claude Code to stop normally.
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
    agent_name = resolve_agent_name(session_id, runtime_prefix="claude")

    if not agent_name:
        # Agent not registered on Rhizo bus; pass through silently
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

    output = {
        "decision": "block",
        "reason": f"Received {count} new Rhizo bus message(s)",
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "additionalContext": messages_text
        }
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()
