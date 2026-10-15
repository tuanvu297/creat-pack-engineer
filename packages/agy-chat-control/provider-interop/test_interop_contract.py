from pathlib import Path
from datetime import datetime,timezone,timedelta
import unittest,json,copy
from interop_contract import validate_task,compile_prompt,artifact_path,validate_compiled_handoff,assess_recovery,ContractError
R=Path(__file__).resolve().parent;TARGET='01a13499-9300-72a3-8944-87f9b3fd2362'
class Contracts(unittest.TestCase):
 def setUp(self):
  self.t=json.loads((R/'task-envelope.example.json').read_text(encoding='utf-8'));self.now=datetime.fromisoformat(self.t['lease']['issued_at'])+timedelta(seconds=1)
 def valid(self,t):return validate_task(t,expected_callback=TARGET,now=self.now)
 def test_strict_fixed_template_compiles(self):self.assertIn('INTEROP-TEMPLATE-v0.2',compile_prompt(self.t,expected_callback=TARGET,now=self.now))
 def test_observed_live_placeholder_rejected_both_workers(self):
  for w in ['manus','muse']:
   v=json.loads((R/(w+'-actual-output.json')).read_text(encoding='utf-8'))
   with self.assertRaisesRegex(ContractError,'CONCRETE_OUTPUT_SCHEMA_REQUIRED'):validate_compiled_handoff(v['compiled_task'])
 def test_lease_required_after_schema_fixed(self):
  t=copy.deepcopy(self.t);del t['lease']
  with self.assertRaises(ContractError):self.valid(t)
 def test_expired_lease_rejected(self):
  with self.assertRaisesRegex(ContractError,'LEASE_EXPIRED'):validate_task(self.t,expected_callback=TARGET,now=self.now+timedelta(hours=1))
 def test_lease_wrong_worker_rejected(self):
  t=copy.deepcopy(self.t);t['lease']['owner']='OTHER'
  with self.assertRaisesRegex(ContractError,'LEASE_OWNER'):self.valid(t)
 def test_callback_cannot_redirect(self):
  t=copy.deepcopy(self.t);t['callback']['target_thread_id']='untrusted-thread'
  with self.assertRaisesRegex(ContractError,'CALLBACK_TARGET'):self.valid(t)
 def test_unknown_billing_not_eligible(self):
  t=copy.deepcopy(self.t);t['resource']['eligibility']='UNKNOWN_BILLING'
  with self.assertRaisesRegex(ContractError,'RESOURCE_ELIGIBILITY'):self.valid(t)
 def test_missing_or_mismatched_qa_blocks(self):
  t=copy.deepcopy(self.t);t['QA_CONTRACT_VERSION']='1.0'
  with self.assertRaisesRegex(ContractError,'QA_CONTRACT'):self.valid(t)
 def test_external_action_cannot_expand(self):
  t=copy.deepcopy(self.t);t['scope']['allow_external_actions']=True
  with self.assertRaisesRegex(ContractError,'EXTERNAL_ACTION'):self.valid(t)
 def test_secret_input_denied(self):
  t=copy.deepcopy(self.t);t['inputs']=[{'text':'MANUS_API_KEY='+('SYNTHETIC_BLOCK_THIS_'*3)}]
  with self.assertRaisesRegex(ContractError,'SECRET_CONTENT'):self.valid(t)
 def test_path_containment_windows_and_posix(self):
  for p in ['../outside.md','C:/outside.md','staging/../../outside','\\\\host\\share','/tmp/x','staging\\x.md']:
   with self.assertRaises(ContractError):artifact_path(p)
  self.assertEqual(artifact_path('staging/plan.md'),'staging/plan.md')
 def test_uncertain_never_resubmits(self):
  for s in ['PENDING','UNCERTAIN','SESSION_START_PENDING','SEND_PENDING']:
   self.assertFalse(assess_recovery({'state':s})['submit_allowed']);self.assertFalse(assess_recovery({'state':s,'provider_id':'same-id'})['submit_allowed'])
 def test_acked_only_collects(self):self.assertEqual(assess_recovery({'state':'ACKED','provider_id':'same-id'}),{'action':'COLLECT_SAME_PROVIDER','submit_allowed':False})
 def test_unknown_recovery_state_fail_closed(self):self.assertFalse(assess_recovery({'state':'RUN_ANYTHING'})['submit_allowed'])
 def test_critical_false_pass_zero_in_observed_results(self):
  for w in ['manus','muse']:
   v=json.loads((R/(w+'-actual-output.json')).read_text(encoding='utf-8'));rows={x['case_id']:x for x in v['reviews']}
   self.assertEqual(rows['H1']['decision'],'REJECT');self.assertEqual(rows['H3']['decision'],'REJECT')
 def test_manus_severity_gap_is_retained(self):
  q=json.loads((R/'probe-evaluation.json').read_text(encoding='utf-8'));self.assertEqual(q['results']['manus']['SEVERITY_MISSED_CRITICAL'],1);self.assertEqual(q['results']['muse']['SEVERITY_MISSED_CRITICAL'],0)
if __name__=='__main__':unittest.main(verbosity=2)
