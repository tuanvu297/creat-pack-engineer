#!/usr/bin/env python3
"""Offline structural validator for the AGY Muse Alignment seed package."""
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(path: Path):
    rows = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise AssertionError(f"{path}:{lineno}: invalid JSON: {exc}") from exc
    return rows


def main() -> int:
    manifest = load_json(ROOT / "MANIFEST.json")
    assert manifest["production_authority"] is False
    assert manifest["private_reasoning_transfer"] is False
    assert manifest["promotion"] == "TEST_ONLY"
    assert manifest["live_muse_training"] == "NOT_DISPATCHED_BY_THIS_COMMIT"

    schemas = [
        load_json(ROOT / "schemas/task-contract.schema.json"),
        load_json(ROOT / "schemas/handoff.schema.json"),
        load_json(ROOT / "schemas/qa-result.schema.json"),
    ]
    for schema in schemas:
        assert schema.get("$schema", "").endswith("2020-12/schema")
        assert schema.get("type") == "object"
        assert schema.get("required")

    gold = load_jsonl(ROOT / "evals/gold-cases.jsonl")
    transfer = load_jsonl(ROOT / "evals/unseen-transfer-seed.jsonl")
    ids = [row["id"] for row in gold + transfer]
    assert len(ids) == len(set(ids)), "duplicate eval IDs"
    assert len(gold) >= 5
    assert len(transfer) >= 5

    competency = load_json(ROOT / "learning/competency.json")
    assert competency["worker"] == "muse"
    assert competency["status"] == "UNVERIFIED_INITIAL"
    assert all(value is None for value in competency["metrics"].values())

    print(f"PASS: schemas={len(schemas)} gold={len(gold)} unseen={len(transfer)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
