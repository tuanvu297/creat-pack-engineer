import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from academy import compile_brief, check_receipt, contained_artifact, secret_findings


class Contracts(unittest.TestCase):
    def setUp(self):
        self.brief = dict(tenant_id='test-tenant', workspace_id='test-workspace',
                          project_id='test-project', controller_job_id='test-job',
                          task_id='test-task', attempt=1, idempotency_key='test-key',
                          task_class='VIDEO_PRODUCTION', objective='Training dry run',
                          allowed_tools=['read_approved_asset'], acceptance_criteria=['Actual export'],
                          executor_runtime='TEST_ONLY_RUNTIME')
        self.policy = {'allowed_task_classes': ['VIDEO_PRODUCTION'], 'max_retries': 2,
                       'current_execution_enabled': False}
        self.job = compile_brief(self.brief, self.policy)['job']
        self.receipt = {k: self.job[k] for k in ('tenant_id', 'workspace_id', 'project_id',
                         'controller_job_id', 'task_id', 'attempt', 'idempotency_key')}
        self.receipt.update(worker='Muse', executor_runtime='TEST_ONLY_RUNTIME',
                            status='UNKNOWN', operation_id=None)

    def test_compiler_never_authorizes_from_caller_flags(self):
        self.brief.update(auth_verified=True, cost_authorized=True, grant='invented')
        result = compile_brief(self.brief, {**self.policy, 'current_execution_enabled': True})
        self.assertEqual(result['readiness'], 'BLOCKED')
        self.assertFalse(result['rights_granted'])
        self.assertNotIn('grant', result['job'])

    def test_forbidden_tool_is_denied(self):
        for tool in ['publish', 'arbitrary_shell', 'raw_sql', 'purchase']:
            self.brief['allowed_tools'] = [tool]
            self.assertEqual(compile_brief(self.brief, self.policy)['validation'], 'INVALID')

    def test_no_arbitrary_job_without_acceptance(self):
        self.brief['acceptance_criteria'] = []
        self.assertIn('ACCEPTANCE_REQUIRED', compile_brief(self.brief, self.policy)['errors'])

    def test_bool_cannot_be_attempt(self):
        self.brief['attempt'] = True
        self.assertIn('INVALID_ATTEMPT', compile_brief(self.brief, self.policy)['errors'])

    def test_unknown_does_not_require_new_operation(self):
        result = check_receipt(self.job, self.receipt)
        self.assertEqual(result['validation'], 'CONTRACT_VALID')
        self.assertFalse(result['production_acceptance'])

    def test_every_identity_mismatch_denied(self):
        for key in ('tenant_id', 'workspace_id', 'project_id', 'controller_job_id', 'task_id', 'attempt', 'idempotency_key'):
            receipt = copy.deepcopy(self.receipt)
            receipt[key] = 2 if key == 'attempt' else 'different'
            self.assertEqual(check_receipt(self.job, receipt)['validation'], 'INVALID', key)

    def test_substitute_worker_or_runtime_denied(self):
        for field, val in [('worker', 'ChatGPT'), ('executor_runtime', 'OTHER')]:
            receipt = {**self.receipt, field: val}
            self.assertEqual(check_receipt(self.job, receipt)['validation'], 'INVALID')

    def test_ack_without_real_operation_denied(self):
        result = check_receipt(self.job, {**self.receipt, 'status': 'ACKED'})
        self.assertIn('OPERATION_ID_REQUIRED', result['errors'])

    def test_secret_locations_not_values(self):
        value = {'nested': {'access_token': 'TRAINING_SENTINEL_NOT_A_REAL_SECRET'}}
        locations = secret_findings(value)
        self.assertTrue(locations)
        self.assertNotIn('TRAINING_SENTINEL', json.dumps(locations))

    def test_credential_urls_are_not_accepted_as_artifacts(self):
        self.assertTrue(secret_findings({'url': 'https://example.com/file?token=TEST_ONLY'}))
        self.assertTrue(secret_findings({'url': 'https://user:TEST_ONLY@example.com/file'}))

    def test_path_traversal_and_absolute_paths_denied(self):
        with tempfile.TemporaryDirectory() as root:
            for path in ['../outside', '/etc/file', 'C:/file', '..\\outside']:
                with self.assertRaises(ValueError):
                    contained_artifact(root, path)

    def complete_receipt(self, digest):
        return {**self.receipt, 'status': 'COMPLETE', 'operation_id': 'TEST-OP',
                'artifacts': [{'path': 'artifact.bin', 'sha256': digest}],
                'qa': {'reviewer': 'TEST-INDEPENDENT', 'evidence_refs': ['fixture-only'],
                       'full_motion': 'PASS', 'audio': 'PASS', 'identity_continuity': 'PASS'}}

    def test_completion_cannot_use_fields_instead_of_bytes(self):
        result = check_receipt(self.job, self.complete_receipt('a' * 64))
        self.assertIn('ARTIFACT_BYTES_UNVERIFIED', result['errors'])

    def test_matching_local_hash_still_not_live_acceptance(self):
        with tempfile.TemporaryDirectory() as root:
            data = b'fixture only, not video'
            Path(root, 'artifact.bin').write_bytes(data)
            receipt = self.complete_receipt(hashlib.sha256(data).hexdigest())
            result = check_receipt(self.job, receipt, root)
            self.assertEqual(result['validation'], 'CONTRACT_VALID')
            self.assertFalse(result['production_acceptance'])
            self.assertFalse(result['provider_authenticity_verified'])

    def test_corruption_and_missing_media_qa_fail(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, 'artifact.bin').write_bytes(b'changed')
            receipt = self.complete_receipt('a' * 64)
            receipt['qa']['audio'] = 'UNVERIFIED'
            result = check_receipt(self.job, receipt, root)
            self.assertIn('ARTIFACT_HASH_MISMATCH', result['errors'])
            self.assertIn('QA_UNVERIFIED_AUDIO', result['errors'])

    def test_self_qa_does_not_qualify_independent_review(self):
        receipt = self.complete_receipt('a' * 64)
        receipt['qa']['reviewer'] = 'Muse'
        self.assertIn('INDEPENDENT_REVIEW_REQUIRED', check_receipt(self.job, receipt)['errors'])


if __name__ == '__main__':
    unittest.main()
