#!/usr/bin/env python3
"""
session_lifecycle_hook.py - SessionStart & SessionEnd Lifecycle Hook for Locutus.

Automatically registers sessions on the Locutus bus on startup/resume,
and cleanly unregisters and releases locks when the session ends.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

# Add hooks directory to path for hook_utils
sys.path.insert(0, str(Path(__file__).resolve().parent))
from hook_utils import (
    find_locutus_bin,
    resolve_agent_name,
    save_session_mapping,
    remove_session_mapping,
)


def detect_runtime(payload: dict) -> str:
    if "conversationId" in payload:
        return "agy"
    if "turn_id" in payload or "model" in payload:
        return "codex"
    return "claude"


def handle_session_start(payload: dict, runtime: str):
    locutus_bin = find_locutus_bin()
    session_id = payload.get("session_id") or payload.get("conversationId") or ""
    if not session_id:
        print("{}")
        return

    session_key = f"{runtime}:{session_id}"

    # Check existing or configured agent name
    agent_name = resolve_agent_name(session_id, runtime_prefix=runtime)
    if not agent_name:
        short_id = session_id[:8] if len(session_id) >= 8 else session_id
        agent_name = f"{runtime}-{short_id}"

    # Save session mapping locally
    save_session_mapping(session_key, agent_name)

    # Register with locutus open
    try:
        subprocess.run(
            [locutus_bin, "open", agent_name, "--session-id", session_key],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        pass

    notice = f"[LOCUTUS BUS] Session active on bus as '@{agent_name}'. Run 'locutus who' to discover peers, or 'locutus send' to message them."
    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": notice
        }
    }
    print(json.dumps(output))


def handle_session_end(payload: dict, runtime: str):
    locutus_bin = find_locutus_bin()
    session_id = payload.get("session_id") or payload.get("conversationId") or ""
    if not session_id:
        print("{}")
        return

    session_key = f"{runtime}:{session_id}"
    agent_name = resolve_agent_name(session_id, runtime_prefix=runtime)

    if agent_name:
        try:
            subprocess.run(
                [locutus_bin, "close", agent_name, "--session-id", session_key],
                capture_output=True,
                text=True,
                timeout=5,
            )
        except Exception:
            pass

    remove_session_mapping(session_key)
    print("{}")


def main():
    mode = sys.argv[1].lower() if len(sys.argv) > 1 else ""

    try:
        raw_input = sys.stdin.read()
        payload = json.loads(raw_input) if raw_input.strip() else {}
    except Exception:
        payload = {}

    event_name = payload.get("hook_event_name", "").lower()
    runtime = detect_runtime(payload)

    if mode in ["start", "sessionstart"] or event_name == "sessionstart":
        handle_session_start(payload, runtime)
    elif mode in ["end", "sessionend"] or event_name == "sessionend":
        handle_session_end(payload, runtime)
    else:
        # Default fallback: check if event is start or end
        if "reason" in payload and payload.get("reason") == "other":
            handle_session_end(payload, runtime)
        else:
            handle_session_start(payload, runtime)


if __name__ == "__main__":
    main()
