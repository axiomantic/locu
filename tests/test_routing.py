# tests/test_routing.py
# Automated tests for Locutus native task routing, route linter, and fail-fast behavior.

import subprocess
import tempfile
import json
import os
from pathlib import Path
import pytest

import sys

_bin_dir = Path(__file__).parent.parent / "bin"
LOCUTUS_BIN = _bin_dir / ("rhizo.exe" if sys.platform == "win32" or (_bin_dir / "rhizo.exe").exists() else "rhizo")
if not LOCUTUS_BIN.exists():
    LOCUTUS_BIN = _bin_dir / ("locutus.exe" if sys.platform == "win32" or (_bin_dir / "locutus.exe").exists() else "locutus")

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

def test_route_lint_valid_config():
    with tempfile.TemporaryDirectory() as tmpdir:
        routes_file = Path(tmpdir) / "locu-routes.yaml"
        routes_file.write_text("""
version: "1.0"
service:
  url: "http://127.0.0.1:8000"
  timeout_seconds: 5.0
questions:
  domain:
    type: choice
    instructions: "Which domain?"
    options: ["database", "frontend", "api", "firmware"]
    aggregate: max_confidence
  urgency:
    type: score
    instructions: "How urgent is this?"
    criteria: ["low", "medium", "critical"]
    aggregate: max
routes:
  - name: "db-route"
    match:
      domain.choice: "database"
    target:
      queue: "queue:swarm:database"
      tags: ["db", "sql"]
      lease_seconds: 1800
  - name: "firmware-worker"
    match:
      domain.choice: "firmware"
    target:
      queue: "queue:worker:worker-claude"
      tags: ["firmware"]
      lease_seconds: 2400
""")
        code, out, err = run_locutus("route", "lint", cwd=tmpdir)
        assert code == 0, f"Lint failed unexpectedly: {err}\n{out}"
        assert "valid" in out.lower()
        assert "db-route" in out
        assert "firmware-worker" in out

def test_route_lint_catches_invalid_syntax_and_schema():
    with tempfile.TemporaryDirectory() as tmpdir:
        routes_file = Path(tmpdir) / "locu-routes.yaml"
        routes_file.write_text("""
version: "1.0"
questions:
  domain:
    type: choice
    instructions: "Which domain?"
    options: ["api", "database"]
routes:
  - name: "bad-route"
    match:
      nonexistent.choice: "api"
    target:
      queue: "queue:swarm:api"
""")
        code, out, err = run_locutus("route", "lint", cwd=tmpdir)
        assert code == 1
        assert "nonexistent" in err or "nonexistent" in out

def test_route_fail_fast_on_missing_config():
    with tempfile.TemporaryDirectory() as tmpdir:
        code, out, err = run_locutus("route", "some task", cwd=tmpdir)
        assert code == 1
        assert "not found" in err.lower() or "missing" in err.lower()

def test_route_fail_fast_when_laya_unreachable():
    with tempfile.TemporaryDirectory() as tmpdir:
        routes_file = Path(tmpdir) / "locu-routes.yaml"
        # Point to closed port 59999
        routes_file.write_text("""
version: "1.0"
service:
  url: "http://127.0.0.1:59999"
  timeout_seconds: 1.0
questions:
  domain:
    type: choice
    instructions: "Which domain?"
    options: ["api", "database"]
routes:
  - name: "api-route"
    match:
      domain.choice: "api"
    target:
      queue: "queue:swarm:api"
""")
        code, out, err = run_locutus("route", "Fix database deadlock", cwd=tmpdir)
        assert code == 1
        assert "unreachable" in err.lower() or "connection" in err.lower()

import http.server
import socketserver
import threading

class MockLayaHandler(http.server.BaseHTTPRequestHandler):
    last_auth = None
    last_model = None
    last_body = None

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok","mock":true,"loaded_models":["mock"],"device":"cpu"}')
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path in ["/v1/systemone", "/v1/predict"]:
            MockLayaHandler.last_auth = self.headers.get("Authorization")
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length).decode("utf-8")
            data = json.loads(body)
            MockLayaHandler.last_model = data.get("model")
            MockLayaHandler.last_body = data
            state = data.get("state", "").lower()

            domain = "api"
            if "sql" in state or "database" in state or "query" in state:
                domain = "database"
            elif "firmware" in state or "stm32" in state:
                domain = "firmware"
            elif "ui" in state or "frontend" in state:
                domain = "frontend"

            resp = {
                "model": "laya-mock",
                "answers": {
                    "domain": {
                        "type": "choice",
                        "choice": domain,
                        "confidence": 0.95,
                        "probabilities": {domain: 0.95}
                    },
                    "urgency": {
                        "type": "score",
                        "score": 1.5 if "slow" in state or "urgent" in state else 0.5,
                        "probabilities": {"0": 0.1, "1": 0.8, "2": 0.1}
                    }
                }
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

@pytest.fixture(scope="module")
def mock_laya_server():
    server = socketserver.TCPServer(("127.0.0.1", 0), MockLayaHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()

def test_route_dry_run_and_enqueue_with_mock(mock_laya_server):
    """Test full routing triage and Redis enqueuing without skipping in CI."""
    with tempfile.TemporaryDirectory() as tmpdir:
        routes_file = Path(tmpdir) / "locu-routes.yaml"
        routes_file.write_text(f"""
version: "1.0"
service:
  url: "{mock_laya_server}"
  timeout_seconds: 5.0
questions:
  domain:
    type: choice
    instructions: "Which domain does this belong to?"
    options: ["database", "frontend", "api", "firmware"]
    aggregate: max_confidence
  urgency:
    type: score
    instructions: "How urgent is this?"
    criteria: ["low", "medium", "critical"]
    aggregate: max
routes:
  - name: "database-route"
    match:
      domain.choice: "database"
    target:
      queue: "queue:swarm:database"
      tags: ["db", "sql"]
      lease_seconds: 1800
  - name: "api-route"
    match:
      domain.choice: "api"
    target:
      queue: "queue:swarm:api"
      tags: ["api"]
      lease_seconds: 1800
""")
        # 1. Dry run inspection
        code, out, err = run_locutus("route", "Slow SQL query on users table missing foreign key index", cwd=tmpdir)
        assert code == 0, f"Error: {err}"
        data = json.loads(out)
        assert data["matched_rule"] == "database-route"
        assert data["target"]["queue"] == "queue:swarm:database"
        assert "sql" in data["target"]["tags"]

        # 2. Atomic enqueue --route
        code, out, err = run_locutus("enqueue", "--route", "Slow SQL query on users table missing foreign key index", cwd=tmpdir)
        assert code == 0, f"Error: {err}"
        msg_id = out.strip()
        assert msg_id.startswith("msg_")

def test_route_live_dry_run_and_enqueue():
    """Optional live verification against local Laya service on port 8000 when available."""
    import urllib.request
    try:
        urllib.request.urlopen("http://127.0.0.1:8000/healthz", timeout=1.0)
    except Exception:
        # If live service is offline, skip this optional test (the mock test above guarantees CI coverage)
        return

    with tempfile.TemporaryDirectory() as tmpdir:
        routes_file = Path(tmpdir) / "locu-routes.yaml"
        routes_file.write_text("""
version: "1.0"
service:
  url: "http://127.0.0.1:8000"
  timeout_seconds: 5.0
questions:
  domain:
    type: choice
    instructions: "Which domain does this belong to?"
    options: ["database", "frontend", "api", "firmware"]
    aggregate: max_confidence
  urgency:
    type: score
    instructions: "How urgent is this?"
    criteria: ["low", "medium", "critical"]
    aggregate: max
routes:
  - name: "database-route"
    match:
      domain.choice: "database"
    target:
      queue: "queue:swarm:database"
      tags: ["db", "sql"]
      lease_seconds: 1800
""")
        code, out, err = run_locutus("route", "Slow SQL query on users table", cwd=tmpdir)
        assert code == 0, f"Error: {err}"
        data = json.loads(out)
        assert data["matched_rule"] == "database-route"

def test_route_cli_overrides_service_model_and_api_key(mock_laya_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        routes_file = Path(tmpdir) / "rhizo-routes.yaml"
        # Base config has dummy closed port 59999
        routes_file.write_text("""
version: "1.0"
service:
  url: "http://127.0.0.1:59999"
questions:
  domain:
    type: choice
    instructions: "Which domain?"
    options: ["database", "api"]
routes:
  - name: "database-route"
    match:
      domain.choice: "database"
    target:
      queue: "queue:swarm:database"
""")
        # CLI overrides service-url, model, and api-key
        code, out, err = run_locutus(
            "route", "Slow SQL query on users table",
            "--service-url", mock_laya_server,
            "--model", "kev-4b",
            "--api-key", "secret-token-123",
            cwd=tmpdir
        )
        assert code == 0, f"Error: {err}"
        data = json.loads(out)
        assert data["matched_rule"] == "database-route"
        assert MockLayaHandler.last_auth == "Bearer secret-token-123"
        assert MockLayaHandler.last_model == "kev-4b"

def test_route_env_overrides_api_key_and_model(mock_laya_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        routes_file = Path(tmpdir) / "rhizo-routes.yaml"
        routes_file.write_text("""
version: "1.0"
service:
  url: "http://127.0.0.1:59999"
questions:
  domain:
    type: choice
    instructions: "Which domain?"
    options: ["database", "api"]
routes:
  - name: "database-route"
    match:
      domain.choice: "database"
    target:
      queue: "queue:swarm:database"
""")
        code, out, err = run_locutus(
            "route", "Slow SQL query on users table",
            cwd=tmpdir,
            env={
                "RHIZO_SERVICE_URL": mock_laya_server,
                "RHIZO_API_KEY": "env-token-xyz",
                "RHIZO_MODEL": "decider-4b"
            }
        )
        assert code == 0, f"Error: {err}"
        assert MockLayaHandler.last_auth == "Bearer env-token-xyz"
        assert MockLayaHandler.last_model == "decider-4b"

def test_route_local_routes_overlay(mock_laya_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        # Base routes file has a failing URL and team routes
        base_file = Path(tmpdir) / "rhizo-routes.yaml"
        base_file.write_text("""
version: "1.0"
service:
  url: "http://127.0.0.1:59999"
questions:
  domain:
    type: choice
    instructions: "Which domain?"
    options: ["database", "api", "firmware"]
routes:
  - name: "team-database-route"
    match:
      domain.choice: "database"
    target:
      queue: "queue:swarm:database"
""")
        # Local uncommitted file overrides service URL and API key, and adds a local test rule
        local_file = Path(tmpdir) / "rhizo-routes.local.yaml"
        local_file.write_text(f"""
service:
  url: "{mock_laya_server}"
  api_key: "local-secret-bearer"
  model: "laya-local-v1"
routes:
  - name: "local-intercept-route"
    match:
      domain.choice: "firmware"
    target:
      queue: "queue:worker:local-debug-worker"
""")
        # 1. Test team rule routed through local service URL
        code, out, err = run_locutus("route", "Slow SQL query on users table", cwd=tmpdir)
        assert code == 0, f"Error: {err}"
        data = json.loads(out)
        assert data["matched_rule"] == "team-database-route"
        assert MockLayaHandler.last_auth == "Bearer local-secret-bearer"
        assert MockLayaHandler.last_model == "laya-local-v1"

        # 2. Test local intercepted rule takes priority
        code2, out2, err2 = run_locutus("route", "Flash STM32 firmware on target board", cwd=tmpdir)
        assert code2 == 0, f"Error: {err2}"
        data2 = json.loads(out2)
        assert data2["matched_rule"] == "local-intercept-route"
        assert data2["target"]["queue"] == "queue:worker:local-debug-worker"

def test_route_lint_with_local_overlay(mock_laya_server):
    with tempfile.TemporaryDirectory() as tmpdir:
        base_file = Path(tmpdir) / "rhizo-routes.yaml"
        base_file.write_text("""
version: "1.0"
service:
  url: "http://127.0.0.1:8000"
questions:
  domain:
    type: choice
    instructions: "Which domain?"
    options: ["database", "api"]
routes:
  - name: "base-rule"
    match:
      domain.choice: "database"
    target:
      queue: "queue:swarm:database"
""")
        local_file = Path(tmpdir) / "rhizo-routes.local.yaml"
        local_file.write_text(f"""
service:
  url: "{mock_laya_server}"
  model: "kev-custom"
  api_key: "test-lint-key"
""")
        code, out, err = run_locutus("route", "lint", cwd=tmpdir)
        assert code == 0, f"Error: {err}"
        assert "valid" in out.lower()
        assert "rhizo-routes.local.yaml" in out
        assert "kev-custom" in out
        assert "configured" in out.lower()

