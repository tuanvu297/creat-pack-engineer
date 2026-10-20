import copy
import importlib.util
import json
import sys
import tempfile
import contextlib
import shutil
import uuid
import unittest
from pathlib import Path
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("guard", ROOT/"bin/agy_standard.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

@contextlib.contextmanager
def writable_fixture():
    base = ROOT.parent.resolve()
    target = base / ("agy-standard-test-" + uuid.uuid4().hex)
    target.mkdir()
    try:
        yield str(target)
    finally:
        resolved = target.resolve()
        if resolved.parent != base or not resolved.name.startswith("agy-standard-test-"):
            raise RuntimeError("Fixture cleanup path escaped intended test directory")
        shutil.rmtree(resolved)

class StandardTests(unittest.TestCase):
    def setUp(self):
        self.request = guard.read_json(ROOT/"examples/task-envelope.json")
        self.catalog = guard.read_json(ROOT/"config/connections.snapshot.json")
        self.ledger = {"entries": []}

    def decide(self):
        return guard.decide(self.request, self.ledger, self.catalog)

    def old(self, state, operation="op-one"):
        self.ledger["entries"] = [{"identity_key": guard.identity_key(self.request), "payload_sha256": guard.digest(self.request), "state": state, "operation_id": operation}]

    def test_new_request_only_preflight_never_dispatch(self):
        result = self.decide()
        self.assertEqual(result["decision"], "ELIGIBLE_FOR_LIVE_PREFLIGHT")
        self.assertFalse(result["dispatch_permitted"])
        self.assertFalse(result["live_auth_tested"])

    def test_unknown_secret_field_rejected(self):
        self.request["api_token"] = "placeholder"
        with self.assertRaisesRegex(guard.ContractError, "ENVELOPE_FIELDS_DENIED"): self.decide()

    def test_no_production(self):
        self.request["execution"]["production"] = True
        with self.assertRaisesRegex(guard.ContractError, "LOCKED_INVARIANT"): self.decide()

    def test_no_supabase_promotion(self):
        self.request["execution"]["supabase_mode"] = "CANONICAL"
        with self.assertRaisesRegex(guard.ContractError, "LOCKED_INVARIANT"): self.decide()

    def test_no_work_fallback(self):
        self.request["execution"]["work_executor_fallback"] = True
        with self.assertRaisesRegex(guard.ContractError, "LOCKED_INVARIANT"): self.decide()

    def test_authority_preserved(self):
        self.request["execution"]["canonical_authority"] = "OTHER"
        with self.assertRaisesRegex(guard.ContractError, "LOCKED_INVARIANT"): self.decide()

    def test_global_legacy_preserved(self):
        self.request["execution"]["global_routing"] = "PROMOTE"
        with self.assertRaisesRegex(guard.ContractError, "LOCKED_INVARIANT"): self.decide()

    def test_attempt_bool_is_not_integer_identity(self):
        self.request["identity"]["attempt"] = True
        with self.assertRaisesRegex(guard.ContractError, "ATTEMPT_DENIED"): self.decide()

    def test_scope_required(self):
        self.request["scope"]["workspace_id"] = ""
        with self.assertRaisesRegex(guard.ContractError, "SCOPE_REQUIRED"): self.decide()

    def test_worker_and_runtime_required(self):
        self.request["executor_runtime"] = ""
        with self.assertRaisesRegex(guard.ContractError, "EXECUTOR_REQUIRED"): self.decide()

    def test_explicit_authorization_reference_required(self):
        self.request["authorization"]["grant_ref"] = ""
        with self.assertRaisesRegex(guard.ContractError, "AUTH_SCOPE_REQUIRED"): self.decide()

    def test_budget_unknown_blocks(self):
        self.request["budget"]["decision"] = "UNKNOWN"
        with self.assertRaisesRegex(guard.ContractError, "BUDGET_NOT_APPROVED"): self.decide()

    def test_bool_cannot_mask_budget(self):
        self.request["budget"]["maximum_new_spend"] = False
        with self.assertRaisesRegex(guard.ContractError, "BUDGET_TYPE_DENIED"): self.decide()

    def test_no_new_spend(self):
        self.request["budget"]["maximum_new_spend"] = 1
        with self.assertRaisesRegex(guard.ContractError, "BUDGET_NOT_APPROVED"): self.decide()

    def test_deadlines_bounded(self):
        self.request["qa"]["qa_timeout_ms"] = 0
        with self.assertRaisesRegex(guard.ContractError, "BOUNDED_DEADLINE"): self.decide()

    def test_forecast_required(self):
        self.request["forecast"]["rollback"] = ""
        with self.assertRaisesRegex(guard.ContractError, "FORECAST_REQUIRED"): self.decide()

    def test_pending_intent_no_blind_retry(self):
        self.old("INTENT", "")
        self.assertEqual(self.decide(), {"decision":"RECONCILIATION_REQUIRED","dispatch_permitted":False})

    def test_uncertain_accepted_no_blind_retry(self):
        self.old("UNCERTAIN", "accepted-response-lost")
        self.assertEqual(self.decide()["decision"], "RECONCILIATION_REQUIRED")

    def test_accepted_only_continues_same_operation(self):
        self.old("ACCEPTED", "retained-one")
        r = self.decide()
        self.assertEqual(r["decision"], "READ_ONLY_CONTINUATION")
        self.assertEqual(r["operation_id"], "retained-one")
        self.assertFalse(r["dispatch_permitted"])

    def test_changed_payload_same_identity_blocks(self):
        self.old("ACCEPTED")
        self.request["objective"] = "different payload"
        with self.assertRaisesRegex(guard.ContractError, "IDEMPOTENCY_CONFLICT"): self.decide()

    def test_timeout_requires_qa_resolution_not_replay(self):
        self.old("QA_TIMEOUT")
        result = self.decide()
        self.assertTrue(result["qa_resolution_required"])
        self.assertFalse(result["dispatch_permitted"])

    def test_duplicate_ledger_identity_blocks(self):
        self.old("ACCEPTED")
        self.ledger["entries"].append(copy.deepcopy(self.ledger["entries"][0]))
        with self.assertRaisesRegex(guard.ContractError, "LEDGER_IDENTITY_COLLISION"): self.decide()

    def test_confirmed_rejection_is_not_automatic_retry(self):
        self.old("CONFIRMED_NOT_SENT", "")
        self.assertEqual(self.decide()["decision"], "EXPLICIT_OPERATOR_REASSESSMENT_REQUIRED")

    def test_unknown_ledger_state_blocks(self):
        self.old("invented")
        with self.assertRaisesRegex(guard.ContractError, "LEDGER_STATE_INVALID"): self.decide()

    def test_native_missing_binding_blocks(self):
        self.request["connection_id"] = "CHATGPT_NATIVE"
        self.assertEqual(self.decide()["decision"], "BLOCKED_PRODUCT_BINDING")

    def test_other_ai_is_not_certified(self):
        self.request["connection_id"] = "GEMINI_OTHER_AI"
        self.assertEqual(self.decide()["decision"], "LIVE_CAPABILITY_UNVERIFIED")

    def test_unknown_route_blocks(self):
        self.request["connection_id"] = "UNKNOWN"
        with self.assertRaisesRegex(guard.ContractError, "ROUTE_UNKNOWN"): self.decide()

    def test_no_history_for_status_is_not_dispatch(self):
        self.request["action"] = "STATUS"
        self.assertEqual(self.decide()["decision"], "NO_EXISTING_OPERATION_IDENTITY")

    def test_missing_accepted_operation_id_blocks(self):
        self.old("ACCEPTED", "")
        with self.assertRaisesRegex(guard.ContractError, "OPERATION_ID_REQUIRED"): self.decide()

    def test_path_traversal_and_windows_absolute_denied(self):
        for path in ["../escape","a/../escape","C:/secret","C:\\secret","/absolute","a//b","CON.txt","foo."]:
            with self.subTest(path=path), self.assertRaises(guard.ContractError): guard.safe_path(path)

    def test_real_package_manifest(self):
        self.assertEqual(guard.verify_tree(ROOT)["status"], "PASS")

    def test_tampered_payload_is_detected(self):
        with writable_fixture() as temp:
            t = Path(temp)
            (t/"config").mkdir()
            p = t/"config/policy.lock.json"
            p.write_text(json.dumps(guard.read_json(ROOT/"config/policy.lock.json")), encoding="utf-8")
            manifest = {"package_version":"1.0.0","files":[{"path":"config/policy.lock.json","bytes":p.stat().st_size,"sha256":__import__("hashlib").sha256(p.read_bytes()).hexdigest()}]}
            (t/"MANIFEST.json").write_text(json.dumps(manifest),encoding="utf-8")
            self.assertEqual(guard.verify_tree(t)["status"], "PASS")
            p.write_text("{}")
            with self.assertRaises(guard.ContractError): guard.verify_tree(t)

    def test_untracked_file_is_detected(self):
        with writable_fixture() as temp:
            t=Path(temp)
            (t/"MANIFEST.json").write_text(json.dumps({"package_version":"1.0.0","files":[]}))
            (t/"unexpected").write_text("one")
            with self.assertRaisesRegex(guard.ContractError,"UNTRACKED_OR_MISSING_FILE"): guard.verify_tree(t)

if __name__ == "__main__":
    unittest.main()

