#!/usr/bin/env python3
"""AGY canonical worker helper for Muse (custom.agy-worker).

CANDIDATE, NOT CONNECTED. This helper is inert until the owner
completes the connection gate: a registered custom.agy-worker
credential must exist (the worker identity token the control plane
issued for Muse, entered once by the owner through Muse's secure
connection page — never in chat, never in a file, never in an
argument). The credential reaches requests only through the
dynamic-credential surrogate; Muse swaps in the real token on an
approved request to the registered gateway host.

Contract: the CANONICAL AGY gateway (Postgres authority
EXISTING_POSTGRES_D049) worker surface —
POST /v1/worker/tenants/:tenant/workspaces/:workspace/projects/:project/<action>
with action in arrive|claim|ack|heartbeat|checkpoint|result|readback,
plus GET /health. The worker identity (worker id, scopes) is derived
by the gateway from the bearer token; this helper never sends a
worker id and the surface rejects body-supplied identity overrides.

This is deliberately NOT the gateway-shadow contract: no /register,
no self-provisioning (the provisioned 'arrive' action replaces it),
no x-agy-* identity headers, no callback sending (callback delivery
is the control plane's server-side driver; the worker reads callback
state through readback).

Outcomes are reported, never retried blindly: a 5xx or a transport
failure on a POST is UNCERTAIN (exit 3) — the gateway may have
committed; reconcile with readback before any retry. A rejected
request is BLOCKED (exit 2) with the gateway's error code.
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

CREDENTIAL = "custom.agy-worker"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused, verify the endpoint")


def fail(code, message):
    print(json.dumps({"status": "BLOCKED", "code": code, "detail": message}))
    sys.exit(2)


def uncertain(code, message):
    print(json.dumps({"status": "UNCERTAIN", "code": code, "detail": message,
                      "reconcile": "for a lost claim run: recover --run-id <owner run id> "
                                   "(read-only, returns your own live lease); when a lease file "
                                   "exists use readback; never resend blindly"}))
    sys.exit(3)


def config():
    url = os.environ.get("AGY_WORKER_GATEWAY_URL", "").strip()
    if not url:
        fail("NOT_CONNECTED",
             "AGY_WORKER_GATEWAY_URL is not configured. The owner connection gate has not been completed.")
    parsed = urllib.parse.urlparse(url)
    if parsed.username or parsed.password or not parsed.hostname:
        fail("GATEWAY_URL_INVALID", "gateway URL must be a bare origin with no credentials")
    if parsed.scheme == "https":
        pass
    elif parsed.scheme == "http" and parsed.hostname in LOOPBACK_HOSTS:
        pass  # loopback only, mirroring the gateway's own callback rule; used by local tests
    else:
        fail("GATEWAY_URL_INVALID", "gateway URL must be https (http is allowed only for loopback tests)")
    scope = {
        "tenant": os.environ.get("AGY_WORKER_TENANT", "gl").strip(),
        "workspace": os.environ.get("AGY_WORKER_WORKSPACE", "legacy-workspace").strip(),
        "project": os.environ.get("AGY_WORKER_PROJECT", "GL_QUALIFICATION").strip(),
    }
    if not all(scope.values()):
        fail("SCOPE_INVALID", "tenant/workspace/project must all be non-empty")
    return parsed.geturl().rstrip("/"), parsed.hostname, scope


def request(method, path, body=None, auth=True):
    base, host, _scope = config()
    req = urllib.request.Request(base + path, method=method,
                                 data=json.dumps(body).encode("utf-8") if body is not None else None)
    if body is not None:
        req.add_header("content-type", "application/json")
    if auth:
        add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=[host])
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
            return read_json_response(response)
    except urllib.error.HTTPError as error:
        code = None
        try:
            payload = json.loads(error.read().decode("utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("error"), str):
                code = payload["error"]
        except Exception:
            pass
        if error.code >= 500:
            uncertain("GATEWAY_OUTCOME_UNCERTAIN", f"gateway returned HTTP {error.code} for {path}")
        fail(code or "GATEWAY_REJECTED", f"gateway returned HTTP {error.code} for {path}")
    except Exception as error:  # transport failure on a POST may still have committed
        if method == "POST":
            uncertain("GATEWAY_OUTCOME_UNCERTAIN", f"{path} failed in transport: {type(error).__name__}")
        fail("GATEWAY_UNREACHABLE", f"{path} failed in transport: {type(error).__name__}")


def worker_path(scope, action):
    return (f"/v1/worker/tenants/{scope['tenant']}/workspaces/{scope['workspace']}"
            f"/projects/{scope['project']}/{action}")


def load_lease(path):
    try:
        with open(path, encoding="utf-8") as handle:
            lease = json.load(handle)
    except Exception:
        fail("LEASE_FILE_INVALID", "lease file is missing or not JSON")
    if not isinstance(lease, dict):
        fail("LEASE_FILE_INVALID", "lease file is not a JSON object")
    # Accept the claim answer verbatim ({status, task:{taskId,
    # leaseToken, attempt}}) or a flat {task_id, lease_token, attempt}.
    task = lease.get("task") if isinstance(lease.get("task"), dict) else {}
    task_id = lease.get("task_id") or task.get("taskId")
    lease_token = lease.get("lease_token") or task.get("leaseToken")
    attempt = lease.get("attempt") if isinstance(lease.get("attempt"), int) else task.get("attempt")
    if not task_id or not lease_token or not isinstance(attempt, int):
        fail("LEASE_FILE_INVALID", "lease file needs task_id, lease_token and integer attempt "
                                  "(save the claim output as the lease file)")
    return {"task_id": task_id, "lease_token": lease_token, "attempt": attempt}


def redact(value):
    if isinstance(value, dict):
        return {k: ("<redacted>" if k == "lease_token" else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def load_json_file(path, code):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        fail(code, f"file {path} is missing or not JSON")
    if not isinstance(data, dict):
        fail(code, f"file {path} must contain a JSON object")
    return data


def main():
    parser = argparse.ArgumentParser(description="AGY canonical worker helper (custom.agy-worker)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("health")
    sub.add_parser("arrive")
    recover = sub.add_parser("recover")
    recover.add_argument("--run-id", required=True,
                         help="the owner-issued run id from this worker's assignment")
    claim = sub.add_parser("claim")
    claim.add_argument("--lease-seconds", type=int, default=None)
    for name in ["ack", "heartbeat", "checkpoint", "result", "readback"]:
        cmd = sub.add_parser(name)
        cmd.add_argument("--lease-file", required=True)
        if name == "heartbeat":
            cmd.add_argument("--lease-seconds", type=int, default=None)
        if name == "checkpoint":
            cmd.add_argument("--external-id", required=True)
            cmd.add_argument("--state-file", default=None)
        if name == "result":
            cmd.add_argument("--result-file", required=True)
            cmd.add_argument("--external-operation-id", required=True)
    args = parser.parse_args()

    _base, _host, scope = config()
    if args.command == "health":
        data = request("GET", "/health", auth=False)
        if data.get("canonical_authority") != "EXISTING_POSTGRES_D049":
            fail("GATEWAY_AUTHORITY_MISMATCH", "gateway health did not confirm EXISTING_POSTGRES_D049 authority")
        if data.get("status") != "READY":
            fail("GATEWAY_NOT_READY", f"gateway health status is {data.get('status')!r}, not READY")
        print(json.dumps(data))
        return
    if args.command == "arrive":
        print(json.dumps(redact(request("POST", worker_path(scope, "arrive"), {}))))
        return
    if args.command == "recover":
        # Lost-claim recovery: read-only. Returns this worker's own
        # live lease for the run (save the output as the lease file
        # and continue), or NOT_FOUND / NO_ACTIVE_LEASE with no task
        # data. It never claims, extends, or retries anything.
        print(json.dumps(request("POST", worker_path(scope, "recover"), {"run_id": args.run_id})))
        return
    if args.command == "claim":
        body = {}
        if args.lease_seconds is not None:
            if not 30 <= args.lease_seconds <= 900:
                fail("INVALID_LEASE_SECONDS", "lease seconds must stay within 30 to 900")
            body["lease_seconds"] = args.lease_seconds
        # Claim output is printed unredacted on purpose: it IS the lease
        # file (save it verbatim; treat it as a credential).
        print(json.dumps(request("POST", worker_path(scope, "claim"), body)))
        return
    lease = load_lease(args.lease_file)
    if args.command == "readback":
        print(json.dumps(redact(request("POST", worker_path(scope, "readback"), {"task_id": lease["task_id"]}))))
        return
    if args.command == "ack":
        data = request("POST", worker_path(scope, "ack"), lease)
    elif args.command == "heartbeat":
        body = dict(lease)
        if args.lease_seconds is not None:
            if not 30 <= args.lease_seconds <= 900:
                fail("INVALID_LEASE_SECONDS", "lease seconds must stay within 30 to 900")
            body["lease_seconds"] = args.lease_seconds
        data = request("POST", worker_path(scope, "heartbeat"), body)
    elif args.command == "checkpoint":
        body = dict(lease)
        body["external_id"] = args.external_id
        if args.state_file:
            body["state"] = load_json_file(args.state_file, "STATE_FILE_INVALID")
        data = request("POST", worker_path(scope, "checkpoint"), body)
    elif args.command == "result":
        body = dict(lease)
        body["result"] = load_json_file(args.result_file, "RESULT_FILE_INVALID")
        body["evidence"] = {"external_operation_id": args.external_operation_id}
        data = request("POST", worker_path(scope, "result"), body)
    print(json.dumps(redact(data)))


if __name__ == "__main__":
    main()
