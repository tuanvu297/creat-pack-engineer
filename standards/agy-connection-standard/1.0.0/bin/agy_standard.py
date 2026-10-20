#!/usr/bin/env python3
"""Offline AGY standard integrity and preflight guard. Never sends network requests."""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
VERSION = "1.0.0"
ROOT = Path(__file__).resolve().parents[1]
PINNED = {
    "canonical_authority": "EXISTING_POSTGRES_D049",
    "supabase_mode": "SHADOW_STAGING_ONLY",
    "global_routing": "LEGACY",
    "production": False,
    "work_executor_fallback": False,
    "uncertain_action": "RECONCILE_ONLY",
    "change_authority": "OWNER_NEW_VERSION_ONLY",
}

class ContractError(Exception):
    pass

def require(ok, code):
    if not ok:
        raise ContractError(code)

def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

def object_fields(value, fields, code):
    require(isinstance(value, dict) and set(value) == set(fields), code)

def text(value):
    return isinstance(value, str) and 0 < len(value) <= 4096

def safe_path(name):
    require(isinstance(name, str) and name and "\\" not in name and ":" not in name, "UNSAFE_MANIFEST_PATH")
    p = Path(name)
    require(not p.is_absolute() and all(x not in ("", ".", "..") for x in name.split("/")), "UNSAFE_MANIFEST_PATH")
    require(not any(re.fullmatch(r"(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?", x) for x in p.parts), "RESERVED_PATH")
    require(not any(x.endswith((" ", ".")) for x in p.parts), "UNSAFE_MANIFEST_PATH")
    return p

def verify_tree(root):
    root = Path(root).resolve()
    require(not Path(root / "MANIFEST.json").is_symlink(), "LINK_FORBIDDEN")
    manifest = read_json(root / "MANIFEST.json")
    require(manifest.get("package_version") == VERSION, "VERSION_MISMATCH")
    expected = {"MANIFEST.json"}
    folded = {"manifest.json"}
    for item in manifest.get("files", []):
        rel = safe_path(item["path"])
        name = rel.as_posix()
        require(name.casefold() not in folded, "DUPLICATE_OR_CASE_COLLISION")
        folded.add(name.casefold())
        target = root / rel
        for ancestor in [target, *target.parents]:
            if ancestor == root.parent:
                break
            require(not ancestor.is_symlink() and not (hasattr(ancestor, "is_junction") and ancestor.is_junction()), "LINK_FORBIDDEN")
        require(target.resolve().is_relative_to(root), "PATH_ESCAPE")
        require(target.is_file() and target.stat().st_size == item["bytes"], "FILE_SIZE_MISMATCH")
        require(hashlib.sha256(target.read_bytes()).hexdigest() == item["sha256"], "HASH_MISMATCH")
        expected.add(name)
    actual = set()
    for p in root.rglob("*"):
        require(not p.is_symlink() and not (hasattr(p, "is_junction") and p.is_junction()), "LINK_FORBIDDEN")
        if p.is_file():
            actual.add(p.relative_to(root).as_posix())
    require(expected == actual, "UNTRACKED_OR_MISSING_FILE")
    policy = read_json(root / "config/policy.lock.json")
    require(policy.get("standard_version") == VERSION, "POLICY_VERSION_MISMATCH")
    require(all(policy.get(k) == v for k, v in PINNED.items()), "LOCKED_INVARIANT_CHANGED")
    return {"status": "PASS", "scope": "OFFLINE_PACKAGE_INTEGRITY_AND_POLICY", "files": len(expected), "version": VERSION, "live_auth_tested": False}

def validate_request(m):
    object_fields(m, ["standard_version", "scope", "identity", "worker", "executor_runtime", "objective", "connection_id", "action", "source", "authorization", "budget", "qa", "forecast", "execution"], "ENVELOPE_FIELDS_DENIED")
    require(m["standard_version"] == VERSION, "VERSION_MISMATCH")
    object_fields(m["scope"], ["tenant_id", "workspace_id", "project_id"], "SCOPE_FIELDS_DENIED")
    require(all(text(v) for v in m["scope"].values()), "SCOPE_REQUIRED")
    object_fields(m["identity"], ["mission_id", "task_id", "attempt", "idempotency_key"], "IDENTITY_FIELDS_DENIED")
    require(all(text(m["identity"][k]) for k in ["mission_id", "task_id", "idempotency_key"]), "IDENTITY_REQUIRED")
    require(type(m["identity"]["attempt"]) is int and m["identity"]["attempt"] >= 1, "ATTEMPT_DENIED")
    require(all(text(m[k]) for k in ["worker", "executor_runtime", "objective", "connection_id"]), "EXECUTOR_REQUIRED")
    require(m["action"] in ["DISPATCH", "STATUS", "RESULT", "CALLBACK", "RECONCILE", "STOP"], "ACTION_DENIED")
    object_fields(m["source"], ["checkpoint_id", "source_ref"], "SOURCE_FIELDS_DENIED")
    require(all(text(v) for v in m["source"].values()), "SOURCE_REQUIRED")
    object_fields(m["authorization"], ["grant_ref", "scope_confirmed"], "AUTH_FIELDS_DENIED")
    require(text(m["authorization"]["grant_ref"]) and m["authorization"]["scope_confirmed"] is True, "AUTH_SCOPE_REQUIRED")
    object_fields(m["budget"], ["decision", "currency", "maximum_new_spend"], "BUDGET_FIELDS_DENIED")
    require(type(m["budget"]["maximum_new_spend"]) is int, "BUDGET_TYPE_DENIED")
    require(m["budget"] == {"decision": "APPROVED_EXISTING_RESOURCES_ONLY", "currency": "USD", "maximum_new_spend": 0}, "BUDGET_NOT_APPROVED")
    object_fields(m["qa"], ["contract_version", "result_timeout_ms", "qa_timeout_ms"], "QA_FIELDS_DENIED")
    require(m["qa"]["contract_version"] == "1.1", "QA_VERSION_DENIED")
    require(all(type(m["qa"][k]) is int and 1000 <= m["qa"][k] <= 3600000 for k in ["result_timeout_ms", "qa_timeout_ms"]), "BOUNDED_DEADLINE_REQUIRED")
    object_fields(m["forecast"], ["success_path", "most_likely", "failure_step", "unknowns", "cost_exposure", "rollback"], "FORECAST_FIELDS_DENIED")
    require(all(text(v) for v in m["forecast"].values()), "FORECAST_REQUIRED")
    object_fields(m["execution"], ["environment", "canonical_authority", "supabase_mode", "global_routing", "production", "work_executor_fallback"], "EXECUTION_FIELDS_DENIED")
    require(m["execution"]["environment"] in ["local_test", "staging"], "ENVIRONMENT_DENIED")
    require(all(m["execution"][k] == PINNED[k] and type(m["execution"][k]) is type(PINNED[k]) for k in ["canonical_authority", "supabase_mode", "global_routing", "production", "work_executor_fallback"]), "LOCKED_INVARIANT_CHANGED")
    return m

def identity_key(m):
    return digest([m["scope"], m["identity"]])

def decide(m, ledger, catalog):
    validate_request(m)
    object_fields(ledger, ["entries"], "LEDGER_FIELDS_DENIED")
    require(isinstance(ledger["entries"], list), "LEDGER_INVALID")
    key = identity_key(m)
    entries = [e for e in ledger["entries"] if e.get("identity_key") == key]
    require(len(entries) <= 1, "LEDGER_IDENTITY_COLLISION")
    if entries:
        e = entries[0]
        object_fields(e, ["identity_key", "payload_sha256", "state", "operation_id"], "LEDGER_ENTRY_INVALID")
        require(e["payload_sha256"] == digest(m), "IDEMPOTENCY_CONFLICT")
        require(e["state"] in ["INTENT", "UNCERTAIN", "ACCEPTED", "RESULT_READY", "QA_TIMEOUT", "COMPLETE", "CONFIRMED_NOT_SENT"], "LEDGER_STATE_INVALID")
        if e["state"] in ["INTENT", "UNCERTAIN"]:
            return {"decision": "RECONCILIATION_REQUIRED", "dispatch_permitted": False}
        if e["state"] in ["ACCEPTED", "RESULT_READY", "QA_TIMEOUT", "COMPLETE"]:
            require(text(e["operation_id"]), "OPERATION_ID_REQUIRED")
            return {"decision": "READ_ONLY_CONTINUATION", "dispatch_permitted": False, "operation_id": e["operation_id"], "qa_resolution_required": e["state"] == "QA_TIMEOUT"}
        return {"decision": "EXPLICIT_OPERATOR_REASSESSMENT_REQUIRED", "dispatch_permitted": False}
    connection = next((c for c in catalog["connections"] if c["id"] == m["connection_id"]), None)
    require(connection is not None, "ROUTE_UNKNOWN")
    if connection["status"] == "BLOCKED_PRODUCT_BINDING":
        return {"decision": "BLOCKED_PRODUCT_BINDING", "dispatch_permitted": False}
    if connection["status"] != "OBSERVED_BOUNDED":
        return {"decision": "LIVE_CAPABILITY_UNVERIFIED", "dispatch_permitted": False}
    require(m["action"] in connection["actions"], "ROUTE_ACTION_DENIED")
    if m["action"] != "DISPATCH":
        return {"decision": "NO_EXISTING_OPERATION_IDENTITY", "dispatch_permitted": False}
    return {"decision": "ELIGIBLE_FOR_LIVE_PREFLIGHT", "dispatch_permitted": False, "live_auth_tested": False, "reason": "Offline guard cannot authorize or prove an actual connection."}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("doctor")
    d = sub.add_parser("decide")
    d.add_argument("--request", required=True)
    d.add_argument("--ledger", required=True)
    args = parser.parse_args()
    try:
        integrity = verify_tree(ROOT)
        if args.command == "doctor":
            result = integrity
        else:
            result = decide(read_json(args.request), read_json(args.ledger), read_json(ROOT / "config/connections.snapshot.json"))
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result.get("status") == "PASS" or result.get("decision") == "ELIGIBLE_FOR_LIVE_PREFLIGHT" else 3
    except ContractError as error:
        print(json.dumps({"status": "BLOCKED", "code": str(error), "dispatch_permitted": False}))
        return 2
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        print(json.dumps({"status": "BLOCKED", "code": "STANDARD_OR_INPUT_INVALID", "dispatch_permitted": False}))
        return 2

if __name__ == "__main__":
    raise SystemExit(main())

