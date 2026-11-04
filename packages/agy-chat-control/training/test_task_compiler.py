import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from task_compiler import prepare, ContractError, validate_task

ROOT = Path(__file__).resolve().parents[1]
CALLBACK = '01a13499-9300-72a3-8944-87f9b3fd2362'


class FreshWorkflow(unittest.TestCase):
    def setUp(self):
        self.template = json.loads((ROOT/'provider-interop/task-envelope.example.json').read_text())
        self.now = datetime(2026, 10, 15, 8, tzinfo=timezone.utc)

    def test_expired_example_is_replaced_without_mutating_history(self):
        old = self.template['lease'].copy()
        task, prompt = prepare(self.template, expected_callback=CALLBACK,
                               deadline=(self.now+timedelta(hours=1)).isoformat(), now=self.now)
        self.assertEqual(self.template['lease'], old)
        self.assertEqual(task['lease']['issued_at'], self.now.isoformat())
        self.assertEqual(task['lease']['expires_at'], (self.now+timedelta(seconds=600)).isoformat())
        self.assertIn(task['task_id'], prompt)

    def test_deadline_caps_lease(self):
        end = (self.now+timedelta(seconds=20)).isoformat()
        task, _ = prepare(self.template, expected_callback=CALLBACK, deadline=end, now=self.now)
        self.assertEqual(task['lease']['expires_at'], end)

    def test_expired_deadline_denied(self):
        with self.assertRaisesRegex(ContractError, 'DEADLINE_EXPIRED'):
            prepare(self.template, expected_callback=CALLBACK, deadline=self.now.isoformat(), now=self.now)

    def test_later_send_must_revalidate(self):
        task, _ = prepare(self.template, expected_callback=CALLBACK,
                          deadline=(self.now+timedelta(hours=1)).isoformat(), now=self.now)
        with self.assertRaisesRegex(ContractError, 'LEASE_EXPIRED'):
            validate_task(task, expected_callback=CALLBACK, now=self.now+timedelta(seconds=600))

    def test_scope_or_retry_cannot_be_repaired_by_lease_refresh(self):
        self.template['retry']['uncertain_action'] = 'retry_three_times'
        with self.assertRaisesRegex(ContractError, 'NO_BLIND_RETRY'):
            prepare(self.template, expected_callback=CALLBACK,
                    deadline=(self.now+timedelta(hours=1)).isoformat(), now=self.now)

    def test_ttl_bounds(self):
        for ttl in [0, 901, True]:
            with self.assertRaises(ContractError):
                prepare(self.template, expected_callback=CALLBACK, ttl_seconds=ttl,
                        deadline=(self.now+timedelta(hours=1)).isoformat(), now=self.now)


if __name__ == '__main__':
    unittest.main(verbosity=2)
