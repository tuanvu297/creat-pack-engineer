#!/usr/bin/env python3
"""Mocked-transport tests for the custom.agy-worker CLI candidate.

Evidence class: MOCKED. A local stub HTTP server returns canned
canonical-contract responses; the dynamic-credential surrogate is
replaced by a stub that records the request and attaches a fake
bearer token. These tests prove the CLI's request shapes, outcome
mapping (BLOCKED vs UNCERTAIN), and local guards only — they prove
nothing about AGY semantics (the loopback integration test against
the real gateway code covers that, labelled local).

Run: python3 test/agy-worker-cli-mocked.test.py [path-to-agy_worker.py]
"""
import io
import json
import os
import sys
import threading
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CLI_PATH = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser(
    "~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py")
sys.path.insert(0, os.path.dirname(CLI_PATH))
import agy_worker  # noqa: E402

RECORD = []
LEASE = {"status": "LEASED", "task": {"taskId": "11111111-1111-1111-1111-111111111111",
                                      "leaseToken": "22222222-2222-2222-2222-222222222222", "attempt": 1}}


class Stub(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        RECORD.append(("GET", self.path, dict(self.headers), None))
        if self.path == "/health":
            if os.environ.get("STUB_HEALTH_MODE") == "shadow":
                return self._send(200, {"status": "READY", "canonical_authority": "SHADOW"})
            return self._send(200, {"status": "READY", "canonical_authority": "EXISTING_POSTGRES_D049",
                                    "production": False})
        return self._send(404, {"error": "NOT_FOUND"})

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        RECORD.append(("POST", self.path, dict(self.headers), raw.decode() if raw else None))
        if "/projects/BOOM/" in self.path:
            return self._send(500, {"error": "INTERNAL"})
        if "/projects/DENIED/" in self.path:
            return self._send(403, {"error": "PROJECT_SCOPE_DENIED"})
        action = self.path.rsplit("/", 1)[-1]
        return self._send(200, {
            "arrive": {"status": "READY", "worker_id": "MUSE-QUAL-WORKER"},
            "claim": LEASE,
            "ack": {"status": "RUNNING"},
            "heartbeat": {"status": "HEARTBEAT"},
            "checkpoint": {"status": "CHECKPOINTED", "version": 1},
            "result": {"status": "RESULT_SUBMITTED", "callback": {"callback_id": "cb-1", "status": "PENDING"}},
            "readback": {"task": {"task_id": LEASE["task"]["taskId"], "status": "QA"}, "callback": {"callback_id": "cb-1", "status": "PENDING"}},
        }.get(action, {"status": "OK"}))


def fake_surrogate(request, credential, allowed_hosts=None):
    assert credential == "custom.agy-worker", credential
    assert allowed_hosts and allowed_hosts[0] in ("127.0.0.1", "localhost"), allowed_hosts
    request.add_header("Authorization", "Bearer stub-token")


agy_worker.add_surrogate_to_request = fake_surrogate


def run_cli(argv, env_extra=None):
    env = {"AGY_WORKER_GATEWAY_URL": BASE, "AGY_WORKER_TENANT": "gl",
           "AGY_WORKER_WORKSPACE": "legacy-workspace", "AGY_WORKER_PROJECT": "GL_QUALIFICATION"}
    env.update(env_extra or {})
    old_env = dict(os.environ)
    os.environ.update(env)
    old_argv = sys.argv
    sys.argv = ["agy_worker.py"] + argv
    out = io.StringIO()
    code = 0
    try:
        with redirect_stdout(out):
            agy_worker.main()
    except SystemExit as e:
        code = e.code or 0
    finally:
        sys.argv = old_argv
        os.environ.clear()
        os.environ.update(old_env)
    text = out.getvalue().strip()
    return code, json.loads(text) if text else None


def main():
    global BASE
    server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    BASE = f"http://127.0.0.1:{server.server_address[1]}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    failures = []

    def check(name, cond, detail=""):
        print(("PASS " if cond else "FAIL ") + name + ("" if cond else f" :: {detail}"))
        if not cond:
            failures.append(name)

    # health: authority verified, NO credential attached to the health call
    code, data = run_cli(["health"])
    check("health ok", code == 0 and data["canonical_authority"] == "EXISTING_POSTGRES_D049")
    health_rec = [r for r in RECORD if r[1] == "/health"][-1]
    check("health carries no credential", "Authorization" not in health_rec[2])

    # health against a wrong-authority gateway is refused
    os.environ["STUB_HEALTH_MODE"] = "shadow"
    code, data = run_cli(["health"])
    check("health authority mismatch blocked", code == 2 and data["code"] == "GATEWAY_AUTHORITY_MISMATCH", str(data))
    del os.environ["STUB_HEALTH_MODE"]

    # arrive + claim: canonical paths, bearer attached, claim shape round-trips
    code, data = run_cli(["arrive"])
    check("arrive ok", code == 0 and data["status"] == "READY")
    code, claim = run_cli(["claim"])
    check("claim ok", code == 0 and claim["status"] == "LEASED")
    worker_posts = [r for r in RECORD if r[0] == "POST"]
    check("canonical worker path", worker_posts[-1][1] ==
          "/v1/worker/tenants/gl/workspaces/legacy-workspace/projects/GL_QUALIFICATION/claim", worker_posts[-1][1])
    check("bearer attached", worker_posts[-1][2].get("Authorization") == "Bearer stub-token")
    check("no worker id in claim body", "worker" not in (worker_posts[-1][3] or ""))

    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(claim, fh)
        lease_file = fh.name
    code, data = run_cli(["ack", "--lease-file", lease_file])
    check("ack ok from claim-shaped lease file", code == 0 and data["status"] == "RUNNING")
    ack_body = json.loads([r for r in RECORD if r[1].endswith("/ack")][-1][3])
    check("ack body carries lease identity", ack_body["task_id"] == LEASE["task"]["taskId"]
          and ack_body["lease_token"] == LEASE["task"]["leaseToken"] and ack_body["attempt"] == 1, str(ack_body))
    code, data = run_cli(["readback", "--lease-file", lease_file])
    check("readback ok", code == 0 and data["task"]["status"] == "QA")

    # outcome mapping: 403 -> BLOCKED with the gateway code; 500 -> UNCERTAIN exit 3
    code, data = run_cli(["claim"], {"AGY_WORKER_PROJECT": "DENIED"})
    check("403 blocked with gateway code", code == 2 and data["code"] == "PROJECT_SCOPE_DENIED", str(data))
    code, data = run_cli(["claim"], {"AGY_WORKER_PROJECT": "BOOM"})
    check("500 uncertain", code == 3 and data["status"] == "UNCERTAIN" and "readback" in data["reconcile"], str(data))

    # local guards
    code, data = run_cli(["claim"], {"AGY_WORKER_GATEWAY_URL": "http://example.com"})
    check("non-loopback http refused", code == 2 and data["code"] == "GATEWAY_URL_INVALID", str(data))
    code, data = run_cli(["ack", "--lease-file", "/nonexistent/lease.json"])
    check("missing lease file refused locally", code == 2 and data["code"] == "LEASE_FILE_INVALID", str(data))
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump({"task_id": "x"}, fh)
        bad_lease = fh.name
    code, data = run_cli(["ack", "--lease-file", bad_lease])
    check("incomplete lease refused locally", code == 2 and data["code"] == "LEASE_FILE_INVALID", str(data))

    # transport failure on a POST (closed port) -> UNCERTAIN, never a blind retry
    code, data = run_cli(["claim"], {"AGY_WORKER_GATEWAY_URL": "http://127.0.0.1:1"})
    check("transport failure uncertain", code == 3 and data["status"] == "UNCERTAIN", str(data))

    server.shutdown()
    print(f"\n{len(failures)} failures" if failures else "\nALL MOCKED CLI TESTS PASS")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
