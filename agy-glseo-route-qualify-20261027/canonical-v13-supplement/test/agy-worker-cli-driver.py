#!/usr/bin/env python3
"""Loopback driver: drives the REAL custom.agy-worker CLI against a
REAL canonical gateway HTTP server (started by the node loopback
integration test on an ephemeral loopback port, backed by a local
embedded Postgres).

Evidence class: LOCAL. The only stub is the credential swap: the
dynamic-credential surrogate is replaced by a stub attaching the
test identity token, because no registered connection exists in a
test environment. Everything else — HTTP transport, gateway auth,
worker surface, Postgres state — is the real code.

Usage: agy-worker-cli-driver.py <session.json> <path-to-agy_worker.py>
Session: {base_url, token, wrong_token, run_id, result,
          external_operation_id, checkpoint_external_id, workdir}

F5 note: the session deliberately carries NO lease material. The
node phase committed a claim whose response was destroyed with
its socket; this driver starts with zero lease knowledge and
recovers the lease through the CLI's own recover command, using
only its identity and the owner-issued run id.
"""
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout

session = json.load(open(sys.argv[1], encoding="utf-8"))
CLI_PATH = sys.argv[2]
sys.path.insert(0, os.path.dirname(CLI_PATH))
import agy_worker  # noqa: E402

CURRENT = {"token": session["token"]}


def fake_surrogate(request, credential, allowed_hosts=None):
    request.add_header("Authorization", f"Bearer {CURRENT['token']}")


agy_worker.add_surrogate_to_request = fake_surrogate
os.environ["AGY_WORKER_GATEWAY_URL"] = session["base_url"]
os.environ.pop("AGY_WORKER_TENANT", None)
os.environ.pop("AGY_WORKER_WORKSPACE", None)
os.environ.pop("AGY_WORKER_PROJECT", None)


def run_cli(argv):
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
    text = out.getvalue().strip()
    return code, json.loads(text) if text else None


def expect(name, cond, detail=""):
    if not cond:
        print(json.dumps({"ok": False, "step": name, "detail": str(detail)}))
        sys.exit(1)
    print(f"driver PASS {name}")


def main():
    workdir = session["workdir"]
    code, data = run_cli(["health"])
    expect("health", code == 0 and data["canonical_authority"] == "EXISTING_POSTGRES_D049", data)
    code, data = run_cli(["arrive"])
    expect("arrive", code == 0 and data["status"] == "READY", data)

    # F5: zero lease knowledge at start. Recovery by identity +
    # run id only; read-only and repeatable (identical output),
    # and its output becomes the lease file for the lifecycle.
    code, rec1 = run_cli(["recover", "--run-id", session["run_id"]])
    expect("recover finds the lost claim", code == 0 and rec1["status"] == "RECOVERED", rec1)
    expect("recover attempt is the original attempt", rec1["task"]["attempt"] == 1, rec1)
    code, rec2 = run_cli(["recover", "--run-id", session["run_id"]])
    expect("recover repeat is identical and read-only", code == 0 and rec2["task"] == rec1["task"], rec2)
    lease_file = os.path.join(workdir, "lease.json")
    with open(lease_file, "w", encoding="utf-8") as fh:
        json.dump(rec1, fh)

    code, data = run_cli(["readback", "--lease-file", lease_file])
    expect("readback sees disconnected claim", code == 0 and data["task"]["status"] == "CLAIMED", data)
    code, data = run_cli(["ack", "--lease-file", lease_file])
    expect("ack", code == 0 and data["status"] == "RUNNING", data)
    code, data = run_cli(["heartbeat", "--lease-file", lease_file])
    expect("heartbeat", code == 0 and data["status"] == "HEARTBEAT", data)

    state_file = os.path.join(workdir, "state.json")
    with open(state_file, "w", encoding="utf-8") as fh:
        json.dump({"step": "driver"}, fh)
    code, data = run_cli(["checkpoint", "--lease-file", lease_file,
                          "--external-id", session["checkpoint_external_id"], "--state-file", state_file])
    expect("checkpoint", code == 0 and data["status"] == "CHECKPOINTED", data)
    version = data["version"]
    code, data = run_cli(["checkpoint", "--lease-file", lease_file,
                          "--external-id", session["checkpoint_external_id"], "--state-file", state_file])
    expect("checkpoint replay is idempotent", code == 0 and data["status"] == "CHECKPOINTED"
           and data["version"] == version, data)
    other_state = os.path.join(workdir, "state-other.json")
    with open(other_state, "w", encoding="utf-8") as fh:
        json.dump({"step": "other"}, fh)
    code, data = run_cli(["checkpoint", "--lease-file", lease_file,
                          "--external-id", session["checkpoint_external_id"], "--state-file", other_state])
    expect("checkpoint conflict denied", code == 2 and "CHECKPOINT" in str(data.get("code")), data)

    result_file = os.path.join(workdir, "result.json")
    with open(result_file, "w", encoding="utf-8") as fh:
        json.dump(session["result"], fh)
    code, data = run_cli(["result", "--lease-file", lease_file, "--result-file", result_file,
                          "--external-operation-id", session["external_operation_id"]])
    expect("result", code == 0 and data["status"] == "RESULT_SUBMITTED", data)
    callback_id = data["callback"]["callback_id"]

    code, data = run_cli(["readback", "--lease-file", lease_file])
    expect("readback after result", code == 0 and data["task"]["status"] == "QA"
           and data["callback"]["callback_id"] == callback_id
           and data["callback"]["status"] == "PENDING", data)

    code, data = run_cli(["claim"])
    expect("claim after completion is EMPTY", code == 0 and data["status"] == "EMPTY", data)

    CURRENT["token"] = session["wrong_token"]
    code, data = run_cli(["arrive"])
    expect("wrong token blocked", code == 2 and data["code"] == "UNAUTHORIZED", data)

    print(json.dumps({"ok": True, "callback_id": callback_id}))


if __name__ == "__main__":
    main()
