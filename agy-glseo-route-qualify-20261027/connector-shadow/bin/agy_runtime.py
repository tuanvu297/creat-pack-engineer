#!/usr/bin/env python3
"""AGY Runtime gateway-shadow worker helper for Muse (custom.agy-runtime).

PREPARED, NOT CONNECTED. This helper is inert until the owner completes the
connection gate: a registered custom.agy-runtime credential must exist and
AGY_RUNTIME_GATEWAY_URL / AGY_RUNTIME_WORKER_ID must be configured. It never
reads a token from a file, an argument or this chat. The credential comes from
the registered connection through the dynamic-credential surrogate and is
swapped for the real value only on an approved request to the registered host.

Scope is deliberately bounded to the worker-side gateway contract:
health, register, claim, ack, heartbeat, checkpoint, result, callback.
There is no create-task, QA, admin, deploy or publish command here.

Outcomes are reported, never retried blindly: a 5xx or a network failure on a
POST is UNCERTAIN (the gateway may have committed) and this helper exits with
code 3 without repeating the call. Reconcile with a read before any retry.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response  # noqa: E402

CREDENTIAL = "custom.agy-runtime"
PROVIDER = "MUSE"
IDENTITY_FIELDS = ["task_id", "attempt_id", "idempotency_key", "trace_id",
                   "worker_id", "lease_token", "fence"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def fail(code, message):
    print(json.dumps({"status": "BLOCKED", "code": code, "detail": message}))
    sys.exit(2)


def uncertain(code, message):
    print(json.dumps({"status": "UNCERTAIN", "code": code, "detail": message,
                      "reconcile": "read gateway state for this task before any retry"}))
    sys.exit(3)


def config():
    url = os.environ.get("AGY_RUNTIME_GATEWAY_URL", "").strip()
    worker = os.environ.get("AGY_RUNTIME_WORKER_ID", "").strip()
    if not url or not worker:
        fail("NOT_CONNECTED",
             "AGY_RUNTIME_GATEWAY_URL and AGY_RUNTIME_WORKER_ID are not configured. "
             "The owner connection gate has not been completed.")
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        fail("GATEWAY_URL_INVALID", "gateway URL must be a bare https origin with no credentials")
    return parsed.geturl().rstrip("/"), parsed.hostname, worker


def post(path, body, headers=None, worker_header=None):
    base, host, worker = config()
    request = urllib.request.Request(base + path, method="POST",
                                     data=json.dumps(body).encode("utf-8"))
    request.add_header("content-type", "application/json")
    if worker_header:
        request.add_header("x-agy-worker-id", worker)
    for key, value in (headers or {}).items():
        request.add_header(key, value)
    add_surrogate_to_request(request, CREDENTIAL, allowed_hosts=[host])
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            return read_json_response(response)
    except urllib.error.HTTPError as error:
        if error.code >= 500:
            uncertain("GATEWAY_OUTCOME_UNCERTAIN", f"gateway returned HTTP {error.code} for {path}")
        fail("GATEWAY_REJECTED", f"gateway returned HTTP {error.code} for {path}")
    except Exception as error:  # network failure on a POST may still have committed
        uncertain("GATEWAY_OUTCOME_UNCERTAIN", f"{path} failed in transport: {type(error).__name__}")


def get_health():
    base, host, _worker = config()
    request = urllib.request.Request(base + "/health", method="GET")
    add_surrogate_to_request(request, CREDENTIAL, allowed_hosts=[host])
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=10) as response:
            return read_json_response(response)
    except Exception as error:
        fail("GATEWAY_HEALTH_UNVERIFIED", f"health failed in transport: {type(error).__name__}")


def load_lease(path):
    try:
        with open(path, encoding="utf-8") as handle:
            lease = json.load(handle)
    except Exception:
        fail("LEASE_FILE_INVALID", "lease file is missing or not JSON")
    if not isinstance(lease, dict) or any(not lease.get(k) for k in IDENTITY_FIELDS):
        fail("LEASE_FILE_INVALID", "lease file lacks a required identity field")
    return lease


def identity_headers(lease):
    return {"x-agy-" + k.replace("_", "-"): str(lease[k]) for k in IDENTITY_FIELDS}


def redact(value):
    if isinstance(value, dict):
        return {k: ("<redacted>" if k == "lease_token" else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def main():
    parser = argparse.ArgumentParser(description="AGY Runtime gateway-shadow worker helper")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    register = sub.add_parser("register")
    register.add_argument("--capabilities", required=True,
                          help="comma separated capability list from the owner approved scope")
    claim = sub.add_parser("claim")
    claim.add_argument("--lease-seconds", type=int, default=120)
    for name in ["ack", "heartbeat", "checkpoint", "result", "callback"]:
        cmd = sub.add_parser(name)
        cmd.add_argument("--lease-file", required=True)
        if name == "heartbeat":
            cmd.add_argument("--lease-seconds", type=int, default=120)
        if name == "checkpoint":
            cmd.add_argument("--version", type=int, required=True)
            cmd.add_argument("--state-file", required=True)
        if name == "result":
            cmd.add_argument("--result-version", type=int, default=1)
            cmd.add_argument("--result-status", required=True)
            cmd.add_argument("--output-file", required=True)
            cmd.add_argument("--external-operation-id", required=True)
        if name == "callback":
            cmd.add_argument("--callback-id", required=True)
    args = parser.parse_args()

    _base, _host, worker = config()
    if args.command == "health":
        data = get_health()
        if data.get("gateway") != "PASS" or data.get("canonical_authority") != "EXISTING_POSTGRES_D049":
            fail("GATEWAY_AUTHORITY_MISMATCH", "gateway health did not confirm EXISTING_POSTGRES_D049 authority")
        print(json.dumps(redact(data)))
        return
    if args.command == "register":
        capabilities = [c.strip() for c in args.capabilities.split(",") if c.strip()]
        if not capabilities:
            fail("CAPABILITIES_REQUIRED", "register needs at least one capability")
        data = post("/workers/register",
                    {"worker_id": worker, "provider": PROVIDER, "role": "WORKER",
                     "capabilities": capabilities,
                     "permissions": ["read", "analyze", "planning", "qa"]},
                    worker_header=True)
        print(json.dumps(redact(data)))
        return
    if args.command == "claim":
        if not 30 <= args.lease_seconds <= 900:
            fail("INVALID_LEASE_SECONDS", "lease seconds must stay within 30 to 900")
        data = post("/tasks/claim",
                    {"provider": PROVIDER, "role": "WORKER", "lease_seconds": args.lease_seconds},
                    worker_header=True)
        print(json.dumps(redact(data)))
        return
    lease = load_lease(args.lease_file)
    if lease["worker_id"] != worker:
        fail("LEASE_WORKER_MISMATCH", "lease belongs to a different worker than AGY_RUNTIME_WORKER_ID")
    headers = identity_headers(lease)
    if args.command == "ack":
        data = post("/ack", {}, headers)
    elif args.command == "heartbeat":
        data = post("/heartbeat", {"lease_seconds": args.lease_seconds}, headers)
    elif args.command == "checkpoint":
        try:
            state = json.load(open(args.state_file, encoding="utf-8"))
        except Exception:
            fail("STATE_FILE_INVALID", "checkpoint state file is missing or not JSON")
        data = post("/checkpoint", {"version": args.version, "state": state}, headers)
    elif args.command == "result":
        try:
            output = json.load(open(args.output_file, encoding="utf-8"))
        except Exception:
            fail("OUTPUT_FILE_INVALID", "result output file is missing or not JSON")
        data = post("/result",
                    {"result_version": args.result_version, "result_status": args.result_status,
                     "output": output,
                     "evidence": {"external_operation_id": args.external_operation_id,
                                  "qa_state": "PENDING"}},
                    headers)
    elif args.command == "callback":
        data = post("/callback",
                    {"callback_id": args.callback_id, "callback_status": "PENDING",
                     "target": "CHATGPT_ASSISTANT_CONTROL_PLANE",
                     "callback_payload": {"event": "RESULT_READY", "task_id": lease["task_id"],
                                          "attempt_id": lease["attempt_id"],
                                          "trace_id": lease["trace_id"],
                                          "qa_state": "PENDING"}},
                    headers)
    print(json.dumps(redact(data)))


if __name__ == "__main__":
    main()
