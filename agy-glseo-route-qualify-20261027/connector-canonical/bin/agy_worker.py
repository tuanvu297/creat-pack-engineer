#!/usr/bin/env python3
"""AGY canonical worker client — CANDIDATE (AGY-GLSEO-ROUTE-QUALIFY-20261027).

Client for the bounded worker namespace on the EXISTING canonical hosted
staging entrypoint:

    POST /v1/worker/tenants/gl/workspaces/legacy-workspace/projects/GL_AUTOMATION/{claim,ack,heartbeat,checkpoint,result,readback}

Exact-host allowlist (feasibility supplement, owner-set): the base URL must
be exactly https://agy-temporal-staging-staging.up.railway.app — no other
host, no private *.railway.internal name, no arbitrary endpoint is ever
accepted, and redirects are refused. The bearer token is attached only
through the Muse dynamic-credentials surrogate for connection
"custom.agy-worker" and is never read from files, arguments, environment
or logs by this script.

Semantics mirror the worker journal discipline: a POST whose outcome is
unknown (transport failure or HTTP 5xx) is reported UNCERTAIN (exit 3) and
is NEVER retried automatically; a 4xx rejection is BLOCKED (exit 2).
Lease tokens are redacted from all output.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "custom-connectors", "custom.agy-runtime", "bin"))
try:
    from dynamic_credentials import add_surrogate_to_request, read_json_response  # noqa: E402
except Exception:  # pragma: no cover - connector runtime provides this module
    add_surrogate_to_request = None
    read_json_response = None

ALLOWED_BASE = "https://agy-temporal-staging-staging.up.railway.app"
CREDENTIAL = "custom.agy-worker"
SCOPE_PATH = "/v1/worker/tenants/gl/workspaces/legacy-workspace/projects/GL_AUTOMATION"
ACTIONS = ("claim", "ack", "heartbeat", "checkpoint", "result", "readback")


def blocked(code, message):
    print(json.dumps({"status": "BLOCKED", "code": code, "detail": message}))
    sys.exit(2)


def uncertain(code, message):
    print(json.dumps({"status": "UNCERTAIN", "code": code, "detail": message,
                      "guidance": "Do not resend blindly; reconcile via readback first."}))
    sys.exit(3)


def redact(value):
    if isinstance(value, dict):
        return {k: ("<redacted>" if k in ("leaseToken", "lease_token") else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ACTIONS:
        blocked("USAGE", f"usage: agy_worker.py <{'|'.join(ACTIONS)}> [json-payload]")
    action = sys.argv[1]
    payload = {}
    if len(sys.argv) > 2:
        try:
            payload = json.loads(sys.argv[2])
        except Exception:
            blocked("BAD_PAYLOAD", "second argument must be a JSON object")
    base = os.environ.get("AGY_WORKER_BASE_URL", ALLOWED_BASE).rstrip("/")
    if base != ALLOWED_BASE:
        blocked("HOST_NOT_ALLOWLISTED", f"base URL must be exactly {ALLOWED_BASE}")
    if add_surrogate_to_request is None:
        blocked("NOT_CONNECTED", "dynamic credentials runtime unavailable; connect custom.agy-worker first")

    url = ALLOWED_BASE + SCOPE_PATH + "/" + action
    body = json.dumps(payload).encode("utf8")
    request = urllib.request.Request(url, data=body, method="POST",
                                     headers={"content-type": "application/json"})
    add_surrogate_to_request(request, CREDENTIAL, allowed_hosts=["agy-temporal-staging-staging.up.railway.app"])

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None

    opener = urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(request, timeout=30) as response:
            result = read_json_response(response)
    except urllib.error.HTTPError as error:
        if error.code >= 500:
            uncertain("GATEWAY_OUTCOME_UNCERTAIN", f"gateway returned HTTP {error.code} for {action}")
        try:
            detail = json.loads(error.read().decode("utf8"))
        except Exception:
            detail = {"error": f"HTTP {error.code}"}
        print(json.dumps(redact({"status": "REJECTED", "http": error.code, **detail})))
        sys.exit(2)
    except Exception as error:
        uncertain("GATEWAY_OUTCOME_UNCERTAIN", f"{action} failed in transport: {type(error).__name__}")
    print(json.dumps(redact(result)))
    sys.exit(0)


if __name__ == "__main__":
    main()
