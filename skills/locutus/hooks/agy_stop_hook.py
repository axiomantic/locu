#!/usr/bin/env python3
"""
agy_stop_hook.py - Antigravity (AGY) `Stop` Lifecycle Hook for Locutus.

Runs when an AGY execution loop terminates.
If messages are waiting in the Locutus inbox:
  - Drains them atomically
  - Returns `{"decision": "continue", "reason": "<messages_text>"}`
  - Blocks the stop and re-enters the execution loop with the message injected as context.
If inbox is empty:
  - Exits with `{}` allowing AGY to stop normally.
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

    conversation_id = payload.get("conversationId", "")
    agent_name = resolve_agent_name(conversation_id, runtime_prefix="agy")

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

    output = {
        "decision": "continue",
        "reason": messages_text
    }
    print(json.dumps(output))


if __name__ == "__main__":
    main()
