#!/usr/bin/env python3
"""Local adapter demonstration. No provider calls, credential access or blind retry."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import sys

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()

def save(path, value):
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".journal-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        Path(temp).unlink(missing_ok=True)

def execute(task, state_root):
    required = ("mission_id", "task_id", "attempt", "idempotency_key", "payload")
    if not isinstance(task, dict) or any(k not in task for k in required):
        raise ValueError("task contract incomplete")
    if any(not isinstance(task[k], str) or not task[k] or len(task[k]) > 200 for k in required[:2] + ("idempotency_key",)):
        raise ValueError("invalid task identity")
    if type(task["attempt"]) is not int or task["attempt"] < 1:
        raise ValueError("invalid attempt")
    if not isinstance(task["payload"], dict) or not isinstance(task["payload"].get("text"), str):
        raise ValueError("payload.text is required")
    if len(task["payload"]["text"].encode()) > 100_000:
        raise ValueError("payload too large")
    root = Path(state_root).resolve(); root.mkdir(parents=True, exist_ok=True)
    identity = {k: task[k] for k in ("mission_id", "task_id", "idempotency_key")}
    # Same mission/task cannot bypass the journal by changing key or attempt.
    stem = digest({k: task[k] for k in ("mission_id", "task_id")})
    payload_hash = digest(task["payload"])
    journal, lock = root / (stem + ".json"), root / (stem + ".lock")
    if journal.is_symlink() or lock.is_symlink():
        raise ValueError("journal symlink rejected")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return {**identity, "status": "UNCERTAIN", "note": "Active/stale lock. Inspect journal and provider state; do not resend."}
    os.close(fd)
    try:
        if journal.exists():
            prior = json.loads(journal.read_text(encoding="utf-8"))
            if prior["payload_sha256"] != payload_hash or prior["idempotency_key"] != task["idempotency_key"]:
                raise ValueError("identity/payload conflict")
            if prior["status"] == "DONE":
                return {**prior, "reused": True}
            return {**prior, "status": "UNCERTAIN", "note": "Reconcile journal/provider before any new attempt."}
        receipt = {**identity, "attempt": task["attempt"], "payload_sha256": payload_hash,
                   "status": "PREPARED", "provider": "local_demo", "auth": "UNVERIFIED",
                   "created_at": datetime.now(timezone.utc).isoformat()}
        save(journal, receipt)
        receipt["status"] = "PENDING"; save(journal, receipt)
        # Replace only this bounded operation with a real provider adapter.
        # Persist provider request ID and reconcile unknown outcomes before retrying.
        text = task["payload"]["text"]
        receipt["result"] = {"characters": len(text), "words": len(text.split()), "lines": len(text.splitlines())}
        receipt["status"] = "DONE"; save(journal, receipt)
        return {**receipt, "reused": False}
    finally:
        lock.unlink(missing_ok=True)

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(); parser.add_argument("task"); parser.add_argument("--state", required=True)
    args = parser.parse_args()
    try:
        result = execute(json.loads(Path(args.task).read_text(encoding="utf-8")), args.state)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 3 if result["status"] == "UNCERTAIN" else 0
    except (OSError, ValueError, KeyError, TypeError):
        print(json.dumps({"status": "UNCERTAIN", "note": "Inspect local journal; input rejected or execution outcome not confirmed. Do not blind retry."}))
        return 3

if __name__ == "__main__":
    raise SystemExit(main())
