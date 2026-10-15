import json,sys,tempfile,time,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'src'))
from queue_store import Store,Denied,digest
from text_contract import validate_result
from daemon import Daemon
from runtime_health import assess

class TextContractTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.now=1000;self.s=Store(self.temp.name,lambda:self.now)
  self.p={'mission_id':'AGY-CHAT-1','task_id':'AGY-CHAT-1:T1','target_executor':'worker1','attempt':1,'idempotency_key':'AGY-CHAT-1:ONCE','objective':'Review supplied task contract','context':'Synthetic test only','acceptance':['Do not infer live access'],'owner_scope_ref':'OWNER_CHAT_CONTROL_WORKERS_20261015','callback_target':'engineer-chat','QA_CONTRACT_VERSION':'1.1','task_kind':'task_compile'}
  self.a={'mode':'BOUNDED_SUPPLIED_TEXT','github_login':'tuanvu297','expires_at':2000,'owner_scope_ref':self.p['owner_scope_ref'],'allowed_kinds':['task_compile','code_review','supplied_text_analysis'],'mission_prefix':'AGY-CHAT-','target_executor':'worker1','callback_target':'engineer-chat','max_missions':2}
  self.source={'verified_login':'tuanvu297','comment_id':1}
 def tearDown(self):self.s.close();self.temp.cleanup()
 def submit(self,p=None):return self.s.submit(p or self.p,self.a,self.source)
 def test_text_queued_not_executed(self):self.assertEqual(self.submit()['status'],'QUEUED');self.assertIsNone(self.s.status(self.p['mission_id'])['ACK'])
 def test_text_identity_dedupe_conflict(self):
  self.submit();self.assertTrue(self.submit()['cached']);self.p['context']='replacement'
  with self.assertRaisesRegex(Denied,'CONFLICT'):self.submit()
 def test_callback_and_target_bound(self):
  for key in ['callback_target','target_executor','owner_scope_ref']:
   p={**self.p,key:'other'}
   with self.assertRaisesRegex(Denied,'BINDING'):self.submit(p)
 def test_mission_prefix_bound(self):
  with self.assertRaisesRegex(Denied,'BINDING'):self.submit({**self.p,'mission_id':'arbitrary1'})
 def test_caps_and_dedupe(self):
  self.submit();self.submit({**self.p,'mission_id':'AGY-CHAT-2','idempotency_key':'AGY-CHAT-2:ONCE'})
  self.assertTrue(self.submit()['cached'])
  with self.assertRaisesRegex(Denied,'MISSION_LIMIT'):self.submit({**self.p,'mission_id':'AGY-CHAT-3','idempotency_key':'AGY-CHAT-3:ONCE'})
 def test_expired_owner_denied(self):
  self.now=2000
  with self.assertRaisesRegex(Denied,'EXPIRED'):self.submit()
 def test_extra_action_field_denied(self):
  with self.assertRaisesRegex(Denied,'SCHEMA'):self.submit({**self.p,'shell':'anything'})
 def test_bounded_context_and_acceptance(self):
  for key,value in [('context','x'*16001),('objective',''),('acceptance',[]),('acceptance',[True])]:
   with self.assertRaises(Denied):self.submit({**self.p,key:value})
 def test_known_secret_signature_denied(self):
  p={**self.p,'context':'sk-'+''.join(['A']*30)}
  with self.assertRaisesRegex(Denied,'SECRET'):self.submit(p)
 def test_secret_in_acceptance_denied(self):
  with self.assertRaisesRegex(Denied,'SECRET'):self.submit({**self.p,'acceptance':['sk-'+''.join(['A']*30)]})
 def test_secret_in_identity_metadata_denied(self):
  for field in ['task_id','idempotency_key','owner_scope_ref','callback_target']:
   with self.assertRaisesRegex(Denied,'SECRET'):self.submit({**self.p,field:'ghp_'+''.join(['A']*36)})
 def test_empty_or_missing_policy_denied(self):
  for prefix in ['',None,'A']:
   self.a['mission_prefix']=prefix
   with self.assertRaisesRegex(Denied,'POLICY_SCHEMA'):self.submit()
 def test_policy_missing_scope_callback_cannot_match_null(self):
  for k in ['owner_scope_ref','callback_target','target_executor']:
   original=self.a.pop(k);p={**self.p,k:None}
   with self.assertRaises(Denied):self.submit(p)
   self.a[k]=original
 def test_expiry_rechecked_after_transaction_wait(self):
  original=self.s.atomic
  def delayed(op):self.now=2001;return original(op)
  self.s.atomic=delayed
  with self.assertRaisesRegex(Denied,'EXPIRED'):self.submit()
  self.assertEqual(len(self.s.status()),0)
 def test_input_aggregate_bound(self):
  p={**self.p,'objective':'o'*4000,'context':'c'*16000,'acceptance':['a'*500]*10}
  with self.assertRaisesRegex(Denied,'INPUT_TOTAL'):self.submit(p)
 def test_result_aggregate_budget_before_callback(self):
  r={'task_id':self.p['task_id'],'summary':'s'*6000,'steps':['step'],'evidence':[],'limitations':[],'needs_owner_action':False}
  with self.assertRaisesRegex(Denied,'TOTAL_BOUND'):validate_result(r,self.p['task_id'],Denied)
 def test_execution_receipt_and_schema_do_not_imply_semantic_acceptance(self):
  self.submit();g=self.s.claim(self.p['mission_id'],'worker1','instance1');self.assertIn('task_compile',g['body']['scope'])
  self.s.ack(g,{'transport_status':'RECEIVED_BY_EXECUTOR','pid':123,'instance_id':'instance1'})
  for phase in ['PLAN','RUNNING','CHECKPOINT']:self.s.checkpoint(g,phase,{'evidence_id':phase})
  r={'task_id':self.p['task_id'],'summary':'Some text','steps':[],'evidence':[],'limitations':['Supplied text only'],'needs_owner_action':False}
  with self.assertRaisesRegex(Denied,'REAL_EXECUTION'):self.s.complete(g,r)
  self.s.turn_started(g,'real-turn-id');self.s.complete(g,r)
  status=self.s.status(self.p['mission_id']);self.assertEqual(status['status'],'CHECKPOINT');self.assertIsNone(status['AGY_acceptance'])
  self.assertEqual(status['events'][-1]['kind'],'RESULT_SCHEMA_VALIDATED_SEMANTIC_QA_PENDING')
 def test_wrong_result_identity_denied(self):
  with self.assertRaisesRegex(Denied,'SCHEMA'):validate_result({'task_id':'other'},self.p['task_id'],Denied)
 def test_cached_running_true_is_stale(self):
  result=assess({'daemon_alive':True,'emitted_at':900,'binding':{'pid':123}},now=1000,probe=lambda _:True)
  self.assertEqual(result['status'],'STALE');self.assertFalse(result['daemon_alive_verified'])
 def test_dead_pid_overrides_fresh_true(self):self.assertEqual(assess({'daemon_alive':True,'emitted_at':1000,'binding':{'pid':123}},now=1001,probe=lambda _:False)['status'],'STOPPED')
 def test_fresh_pid_is_verified(self):self.assertTrue(assess({'daemon_alive':True,'emitted_at':1000,'binding':{'pid':123}},now=1001,probe=lambda _:True)['daemon_alive_verified'])
 def test_unknown_pid_not_verified(self):self.assertFalse(assess({'daemon_alive':True,'emitted_at':1000,'binding':{'pid':123}},now=1001,probe=lambda _:None)['daemon_alive_verified'])
 def test_v2_ingress_and_duplicate_observation(self):
  d=Daemon.__new__(Daemon);d.store=self.s;d.config={'mission':self.p,'authorization':self.a};d.poll_error=None
  c={'id':1,'body':'AGY_MISSION_V2\n'+json.dumps(self.p),'user':{'login':'tuanvu297'}};d.process_ingress([c]);d.process_ingress([c]);self.assertEqual(len(self.s.status()),1)

if __name__=='__main__':unittest.main()
