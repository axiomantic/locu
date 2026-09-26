# tests/test_config.py
# Automated tests for Locutus configuration and locutus.toml parsing.

import subprocess
import tempfile
import json
import os
from pathlib import Path

LOCUTUS_BIN = Path(__file__).parent.parent / "bin" / "locutus"

def run_locutus(*args, cwd=None, env=None):
    cmd = [str(LOCUTUS_BIN)] + list(args)
    run_env = os.environ.copy()
    for k in list(run_env.keys()):
        if k.startswith("LOCUTUS_"):
            del run_env[k]
    if env:
        run_env.update(env)
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, env=run_env)
    return proc.returncode, proc.stdout, proc.stderr

def test_config_defaults():
    with tempfile.TemporaryDirectory() as tmpdir:
        # Isolate from user's global ~/.config/locutus/config.toml
        code, out, err = run_locutus("config", "show", "--format", "json", cwd=tmpdir, env={"XDG_CONFIG_HOME": tmpdir, "HOME": tmpdir})
        assert code == 0, f"Error: {err}"
        data = json.loads(out)
        assert data["redis_url"]["value"] == "redis://127.0.0.1:6379"
        assert data["prefix"]["value"] == "locutus:"
        assert data["heartbeat_ttl"]["value"] == "150"
        assert data["listen_timeout"]["value"] == "0"
        assert data["message_ttl"]["value"] == "604800"

def test_config_reads_locutus_toml():
    with tempfile.TemporaryDirectory() as tmpdir:
        toml_path = Path(tmpdir) / "locutus.toml"
        toml_content = """# locutus.toml - Custom Project Configuration
redis_url = "redis://redis.internal:6379"
prefix = "mycustom:"
project = "custom-project"
encrypt = true
heartbeat_ttl = 120

[profiles.staging]
redis_url = "rediss://staging.internal:6380"
prefix = "stg:locutus:"
"""
        toml_path.write_text(toml_content)

        # Default profile from toml
        code, out, err = run_locutus("config", "show", "--config", str(toml_path), "--format", "json")
        assert code == 0, f"Error: {err}"
        data = json.loads(out)
        
        assert data["redis_url"]["value"] == "redis://redis.internal:6379"
        assert data["prefix"]["value"] == "mycustom:"
        assert data["project"]["value"] == "custom-project"
        assert data["encrypt"]["value"] == "true"
        assert data["heartbeat_ttl"]["value"] == "120"

        # Staging profile from toml
        code2, out2, err2 = run_locutus("config", "show", "--config", str(toml_path), "--profile", "staging", "--format", "json")
        assert code2 == 0, f"Error: {err2}"
        data2 = json.loads(out2)
        assert data2["redis_url"]["value"] == "rediss://staging.internal:6380"
        assert data2["prefix"]["value"] == "stg:locutus:"

def test_config_cli_overrides():
    code, out, err = run_locutus(
        "config", "show",
        "--redis-url", "redis://cli-override:6379",
        "--prefix", "cli:",
        "--project", "test-project",
        "--format", "json"
    )
    assert code == 0, f"Error: {err}"
    data = json.loads(out)
    assert data["redis_url"]["value"] == "redis://cli-override:6379"
    assert data["prefix"]["value"] == "cli:"
    assert data["project"]["value"] == "test-project"
    assert data["redis_url"]["source"] == "cli flag"
