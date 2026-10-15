import concurrent.futures,json,math,sqlite3,sys,tempfile,threading,time,unittest
from pathlib import Path
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from queue_store import Store,Denied,digest,loads,dump
from daemon import Daemon,parse_comment,HostLock

class QueueTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.now=[1000.0];self.s=Store(self.temp.name,lambda:self.now[0])
  self.payload={'mission_id':'mission1','task_id':'task1','target_executor':'worker1','attempt':1,'idempotency_key':'idem1','nonce':'nonce1',
   'a':19,'b':23,'owner_scope_ref':'synthetic-owner-scope','callback_target':'control1','QA_CONTRACT_VERSION':'1.1','task_kind':'codex_nonce_sum'}
  self.authorization={'payload_sha256':digest(self.payload),'owner_scope_ref':'synthetic-owner-scope','expires_at':2000,'github_login':'tuanvu297'}
  self.source={'comment_id':1,'verified_login':'tuanvu297'}
 def tearDown(self):self.s.close();self.temp.cleanup()
 def submit(self):return self.s.submit(self.payload,self.authorization,self.source)
 def claim(self):self.submit();return self.s.claim('mission1','worker1','instance1')
 def ack(self):
  g=self.claim();self.s.ack(g,{'transport_status':'RECEIVED_BY_EXECUTOR','pid':123,'instance_id':'instance1'});return g
 def completed(self):
  g=self.ack()
  for phase in ['PLAN','RUNNING','CHECKPOINT']:self.s.checkpoint(g,phase,{'evidence_id':phase})
  self.s.turn_started(g,'turn1');self.s.complete(g,{'nonce':'nonce1','sum':42});return g
 def test_duplicate_json_denied(self):
  with self.assertRaises(Denied):loads('{"a":1,"a":2}')
 def test_nan_denied(self):
  with self.assertRaises(Denied):loads('{"x":NaN}')
 def test_serialization_nan_denied(self):
  with self.assertRaises(ValueError):dump({'x':math.nan})
 def test_submission_not_execution(self):
  self.submit();r=self.s.status('mission1');self.assertEqual(r['status'],'QUEUED');self.assertIsNone(r['ACK']);self.assertIsNone(r['turn_id'])
 def test_duplicate_submission_cached(self):
  self.submit();self.assertTrue(self.submit()['cached']);self.assertEqual(len(self.s.status()),1)
 def test_payload_conflict_denied(self):
  self.submit();self.payload['a']=20;self.authorization['payload_sha256']=digest(self.payload)
  with self.assertRaisesRegex(Denied,'CONFLICT'):self.submit()
 def test_unknown_owner_binding_denied(self):
  self.payload['nonce']='different'
  with self.assertRaisesRegex(Denied,'BINDING'):self.submit()
 def test_unknown_ingress_author_denied(self):
  self.source['verified_login']='another'
  with self.assertRaisesRegex(Denied,'INGRESS'):self.submit()
 def test_missing_authority_login_denied(self):
  self.authorization.pop('github_login');self.source['verified_login']=None
  with self.assertRaisesRegex(Denied,'INGRESS'):self.submit()
 def test_owner_expired_before_submit(self):
  self.now[0]=2000
  with self.assertRaisesRegex(Denied,'EXPIRED'):self.submit()
 def test_wrong_worker_cannot_claim(self):
  self.submit()
  with self.assertRaisesRegex(Denied,'WORKER'):self.s.claim('mission1','wrong','instance1')
 def test_single_claim_under_race(self):
  self.submit()
  def work(i):
   s=Store(self.temp.name,lambda:self.now[0])
   try:s.claim('mission1','worker1','instance'+str(i));return True
   except Denied:return False
   finally:s.close()
  with concurrent.futures.ThreadPoolExecutor(4)as e:self.assertEqual(sum(e.map(work,range(4))),1)
 def test_nonfinite_ttl_denied(self):
  self.submit()
  for ttl in [math.nan,math.inf,0,-1,121,True]:
   with self.assertRaises(Denied):self.s.claim('mission1','worker1','instance1',ttl)
 def test_forged_grant_denied(self):
  g=self.claim();g['body']['worker_id']='wrong'
  with self.assertRaisesRegex(Denied,'SIGNATURE'):self.s.assert_grant(g)
 def test_ack_receipt_required(self):
  g=self.claim()
  with self.assertRaisesRegex(Denied,'RECEIPT'):self.s.ack(g,{'transport_status':'QUEUED_ONLY','pid':123,'instance_id':'instance1'})
 def test_ack_correct_instance_required(self):
  g=self.claim()
  with self.assertRaisesRegex(Denied,'RECEIPT'):self.s.ack(g,{'transport_status':'RECEIVED_BY_EXECUTOR','pid':123,'instance_id':'other'})
 def test_plan_before_ack_denied(self):
  g=self.claim()
  with self.assertRaisesRegex(Denied,'ACK_REQUIRED'):self.s.checkpoint(g,'PLAN',{'evidence_id':'plan'})
 def test_checkpoint_order_enforced(self):
  g=self.ack()
  with self.assertRaisesRegex(Denied,'ORDER'):self.s.checkpoint(g,'CHECKPOINT',{'evidence_id':'bad'})
 def test_checkpoint_evidence_required(self):
  g=self.ack()
  with self.assertRaisesRegex(Denied,'EVIDENCE'):self.s.checkpoint(g,'PLAN',{})
 def test_grant_expiry_no_mutation(self):
  g=self.ack();self.now[0]+=45
  with self.assertRaisesRegex(Denied,'EXPIRED'):self.s.checkpoint(g,'PLAN',{'evidence_id':'test'})
 def test_heartbeat_renews_and_fences_old_grant(self):
  g=self.ack();self.now[0]+=31;fresh=self.s.heartbeat(g)
  with self.assertRaisesRegex(Denied,'FENCED'):self.s.assert_grant(g)
  self.s.assert_grant(fresh)
 def test_no_renew_after_owner_expiry(self):
  g=self.ack();self.now[0]=2000
  with self.assertRaisesRegex(Denied,'EXPIRED'):self.s.heartbeat(g)
 def test_stale_heartbeat_surfaces(self):
  self.ack();self.now[0]+=16;self.s.sweep();self.assertEqual(self.s.status('mission1')['status'],'STALE')
 def test_no_reclaim_after_stale(self):
  self.ack();self.now[0]+=16;self.s.sweep()
  with self.assertRaisesRegex(Denied,'NO_REPLAY'):self.s.claim('mission1','worker1','instance2')
 def test_intent_persisted_payload_and_unknown_no_retry(self):
  self.submit();self.s.reserve('mission1','MODEL_TURN',self.payload)
  self.assertEqual(loads(self.s.db.execute('SELECT payload FROM intents').fetchone()[0]),self.payload)
  with self.assertRaisesRegex(Denied,'NO_BLIND_RETRY'):self.s.reserve('mission1','MODEL_TURN',self.payload)
 def test_intent_ack_cached(self):
  self.submit();self.s.reserve('mission1','MODEL_TURN',self.payload);self.s.receipt('mission1','MODEL_TURN',{'turn_id':'turn1'})
  self.assertEqual(self.s.reserve('mission1','MODEL_TURN',self.payload),{'turn_id':'turn1'})
 def test_restart_blocks_inflight_no_replay(self):
  self.ack();self.s.close();self.s=Store(self.temp.name,lambda:self.now[0]);self.s.recovery()
  self.assertEqual(self.s.status('mission1')['status'],'UNCERTAIN')
  with self.assertRaises(Denied):self.s.claim('mission1','worker1','instance2')
 def test_result_needs_real_turn(self):
  g=self.ack()
  for p in ['PLAN','RUNNING','CHECKPOINT']:self.s.checkpoint(g,p,{'evidence_id':p})
  with self.assertRaisesRegex(Denied,'REAL_EXECUTION'):self.s.complete(g,{'nonce':'nonce1','sum':42})
 def test_wrong_result_denied(self):
  g=self.completed()
  for bad in [{'nonce':'wrong','sum':42},{'nonce':'nonce1','sum':True},{'nonce':'nonce1','sum':43}]:
   with self.assertRaisesRegex(Denied,'RUBRIC'):self.s.complete(g,bad)
 def test_callback_send_ack_not_delivery(self):
  self.completed();self.s.reserve('mission1','CALLBACK_POST',{'callback_id':'cb'});self.s.receipt('mission1','CALLBACK_POST',{'comment_id':2})
  self.assertEqual(self.s.status('mission1')['status'],'CHECKPOINT')
 def test_delivery_requires_readback(self):
  self.completed()
  with self.assertRaisesRegex(Denied,'READBACK'):self.s.delivery('mission1',{'comment_id':2,'readback_match':False})
 def test_independent_acceptance_needs_delivery(self):
  self.completed()
  with self.assertRaisesRegex(Denied,'DELIVERY'):self.s.acceptance('mission1',{},self.source)
 def test_producer_cannot_self_accept(self):
  self.completed();self.s.delivery('mission1',{'comment_id':2,'readback_match':True})
  with self.assertRaisesRegex(Denied,'INDEPENDENT'):self.s.acceptance('mission1',{'reviewer_id':'worker1'},self.source)
 def test_acceptance_result_and_receipt_bound(self):
  self.completed();self.s.delivery('mission1',{'comment_id':2,'readback_match':True})
  review={'reviewer_id':'AGY-ASSISTANT-CONTROL','status':'VERIFIED_PASS_SCOPED','callback_comment_id':2,'result_sha256':digest({'nonce':'nonce1','sum':42}),
   'QA_CONTRACT_VERSION':'1.1','acceptance_criteria_ids':['AC'+str(i).zfill(2) for i in range(1,11)],'evidence_ids':['synthetic-callback']}
  self.s.acceptance('mission1',review,{'verified_login':'tuanvu297','comment_id':3});self.assertEqual(self.s.status('mission1')['status'],'AGY_REVIEW_REPORTED')
  self.s.confirm_native_acceptance('mission1',{'verification_method':'mcp__codex_app.read_thread','target_chat_id':'6acb1ce3-e37c-83ec-9eb7-f795fd5243c1',
   'reviewer_message_id':'synthetic-independent-message','native_turn_id':'synthetic-turn','status':'PASS_SCOPED','result_sha256':review['result_sha256']})
  self.assertEqual(self.s.status('mission1')['status'],'AGY_ACCEPTED')
 def test_acceptance_kept_across_restart(self):
  self.test_acceptance_result_and_receipt_bound();self.s.close();self.s=Store(self.temp.name,lambda:self.now[0]);self.s.recovery()
  self.assertEqual(self.s.status('mission1')['status'],'AGY_ACCEPTED')
 def test_duplicate_json_ingress_rejected(self):self.assertIsNone(parse_comment({'body':'AGY_MISSION_V1\n{"a":1,"a":2}'},'AGY_MISSION_V1'))
 def test_unknown_comment_not_task(self):self.assertIsNone(parse_comment({'body':'ENGINEERING HANDOFF'},'AGY_MISSION_V1'))
 def test_identity_boolean_denied(self):
  self.payload['attempt']=True;self.authorization['payload_sha256']=digest(self.payload)
  with self.assertRaisesRegex(Denied,'ATTEMPT'):self.submit()
 def test_legacy_journal_migration_preserves_unknown_intent(self):
  with tempfile.TemporaryDirectory()as root:
   d=sqlite3.connect(Path(root)/'queue.sqlite');d.execute('CREATE TABLE intents(id TEXT PRIMARY KEY,mission TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT)')
   d.execute('INSERT INTO intents VALUES(?,?,?,?,?,NULL)',('m:MODEL_TURN','m','MODEL_TURN',digest({'old':'unknown'}),'PENDING'));d.commit();d.close()
   s=Store(root,lambda:self.now[0])
   try:
    self.assertIsNone(s.db.execute('SELECT payload FROM intents').fetchone()[0])
    with self.assertRaisesRegex(Denied,'NO_BLIND_RETRY'):s.reserve('m','MODEL_TURN',{'old':'unknown'})
    self.assertIsNone(s.reserve('new','MODEL_TURN',{'new':'fixture'}))
   finally:s.close()
 def test_receipt_not_erased_by_other_transaction_rollback(self):
  self.submit();self.s.reserve('mission1','MODEL_TURN',self.payload);started=threading.Event()
  def rollback():
   def op():started.set();time.sleep(.08);raise Denied('synthetic rollback')
   try:self.s.atomic(op)
   except Denied:pass
  t=threading.Thread(target=rollback);t.start();started.wait(1);self.s.receipt('mission1','MODEL_TURN',{'turn_id':'durable-turn'});t.join()
  self.assertEqual(self.s.reserve('mission1','MODEL_TURN',self.payload),{'turn_id':'durable-turn'})
 def test_legacy_acceptance_declaration_denied(self):
  self.completed();self.s.delivery('mission1',{'comment_id':2,'readback_match':True})
  with self.assertRaisesRegex(Denied,'CONTRACT'):self.s.acceptance('mission1',{'reviewer_id':'AGY-ASSISTANT-CONTROL','status':'VERIFIED_PASS_SCOPED','callback_comment_id':2,'result_sha256':digest({'nonce':'nonce1','sum':42})},self.source)
 def test_native_receipt_missing_cannot_promote(self):
  self.completed();self.s.delivery('mission1',{'comment_id':2,'readback_match':True})
  review={'reviewer_id':'AGY-ASSISTANT-CONTROL','status':'VERIFIED_PASS_SCOPED','callback_comment_id':2,'result_sha256':digest({'nonce':'nonce1','sum':42}),
   'QA_CONTRACT_VERSION':'1.1','acceptance_criteria_ids':['AC'+str(i).zfill(2) for i in range(1,11)],'evidence_ids':['synthetic']}
  self.s.acceptance('mission1',review,self.source)
  with self.assertRaisesRegex(Denied,'NATIVE'):self.s.confirm_native_acceptance('mission1',{'status':'PASS_SCOPED'})
  self.assertEqual(self.s.status('mission1')['status'],'AGY_REVIEW_REPORTED')
 def test_callback_recovery_requires_exact_immutable_payload(self):
  self.completed();body={'callback_id':'fixture'};self.s.reserve('mission1','CALLBACK_POST',body);self.s.recovery()
  with self.assertRaisesRegex(Denied,'RECONCILIATION'):self.s.delivery('mission1',{'comment_id':2,'readback_match':True},recovery=True)
  self.s.receipt('mission1','CALLBACK_POST',{'comment_id':2,'reconciled':True})
  self.s.delivery('mission1',{'comment_id':2,'readback_match':True,'payload_sha256':digest(body)},recovery=True)
  self.assertEqual(self.s.status('mission1')['status'],'CALLBACK_DELIVERED')
 def test_losing_claim_cannot_terminalize_winner(self):
  self.claim();self.assertFalse(self.s.fail_queued('mission1','CLAIM_STATE_DENIED_NO_REPLAY'))
  self.assertEqual(self.s.status('mission1')['status'],'CLAIMED')
 def test_queued_external_limit_guarded(self):
  self.submit();self.assertTrue(self.s.fail_queued('mission1','OWNER_SCOPE_EXPIRED'))
  self.assertEqual(self.s.status('mission1')['status'],'EXTERNAL_LIMIT')
 def test_owner_ux_recipe_dynamic_input_only(self):
  self.authorization={'mode':'BOUNDED_OWNER_UX_NONCE_SUM','binding':{k:v for k,v in self.payload.items()if k not in {'nonce','a','b'}},'owner_scope_ref':self.payload['owner_scope_ref'],'expires_at':2000,'github_login':'tuanvu297'}
  self.payload['nonce']='control-generated-fresh-nonce';self.payload['a']=11;self.payload['b']=32
  self.submit();self.assertEqual(self.s.status('mission1')['status'],'QUEUED')
 def test_owner_ux_recipe_cannot_change_identity(self):
  self.authorization={'mode':'BOUNDED_OWNER_UX_NONCE_SUM','binding':{k:v for k,v in self.payload.items()if k not in {'nonce','a','b'}},'owner_scope_ref':self.payload['owner_scope_ref'],'expires_at':2000,'github_login':'tuanvu297'}
  self.payload['mission_id']='unregistered-mission'
  with self.assertRaisesRegex(Denied,'BINDING'):self.submit()
 def test_owner_ux_cannot_expand_task_class(self):
  self.authorization={'mode':'BOUNDED_OWNER_UX_NONCE_SUM','binding':{k:v for k,v in self.payload.items()if k not in {'nonce','a','b'}},'owner_scope_ref':self.payload['owner_scope_ref'],'expires_at':2000,'github_login':'tuanvu297'}
  self.payload['task_kind']='arbitrary_shell'
  with self.assertRaisesRegex(Denied,'SCOPE'):self.submit()
 def test_owner_ux_acceptance_ingress_registered_second_id(self):
  self.completed();self.s.delivery('mission1',{'comment_id':2,'readback_match':True})
  review={'mission_id':'mission1','reviewer_id':'AGY-ASSISTANT-CONTROL','status':'VERIFIED_PASS_SCOPED','callback_comment_id':2,'result_sha256':digest({'nonce':'nonce1','sum':42}),
   'QA_CONTRACT_VERSION':'1.1','acceptance_criteria_ids':['AC'+str(i).zfill(2) for i in range(1,11)],'evidence_ids':['synthetic']}
  d=Daemon.__new__(Daemon);d.store=self.s;d.config={'mission':{'mission_id':'original-A1'},'owner_ux_authorization':{'binding':{'mission_id':'mission1'}},'authorization':{'github_login':'tuanvu297'}};d.poll_error=None
  d.process_ingress([{'id':3,'body':'AGY_ACCEPTANCE_V1\n'+dump(review),'user':{'login':'tuanvu297'},'url':'synthetic'}])
  self.assertEqual(self.s.status('mission1')['status'],'AGY_REVIEW_REPORTED')
 def test_unregistered_acceptance_ingress_denied(self):
  self.completed();self.s.delivery('mission1',{'comment_id':2,'readback_match':True})
  d=Daemon.__new__(Daemon);d.store=self.s;d.config={'mission':{'mission_id':'other-A1'},'authorization':{'github_login':'tuanvu297'}};d.poll_error=None
  d.process_ingress([{'id':3,'body':'AGY_ACCEPTANCE_V1\n'+dump({'mission_id':'mission1'}),'user':{'login':'tuanvu297'}}])
  self.assertEqual(self.s.status('mission1')['status'],'CALLBACK_DELIVERED')
 def test_missing_optional_policy_malformed_comment_does_not_block_valid_mission(self):
  for optional in [{},{'owner_ux_authorization':None}]:
   d=Daemon.__new__(Daemon);d.store=self.s;d.config={'mission':self.payload,'authorization':self.authorization,**optional};d.poll_error=None
   bad={'id':9,'body':'AGY_MISSION_V1\n'+dump({'a':1}),'user':{'login':'untrusted-user'}}
   valid={'id':1,'body':'AGY_MISSION_V1\n'+dump(self.payload),'user':{'login':'tuanvu297'},'url':'synthetic'}
   d.process_ingress([bad,valid])
   self.assertEqual(self.s.db.execute('SELECT status FROM observations WHERE id=?',('9',)).fetchone()[0],'MISSION_SCHEMA_DENIED')
   self.assertEqual(self.s.status('mission1')['status'],'QUEUED')
 def test_malformed_review_identity_does_not_block_following_mission(self):
  d=Daemon.__new__(Daemon);d.store=self.s;d.config={'mission':self.payload,'authorization':self.authorization};d.poll_error=None
  comments=[{'id':10+i,'body':'AGY_ACCEPTANCE_V1\n'+dump({'mission_id':identity}),'user':{'login':'untrusted-user'}}for i,identity in enumerate([[],{},None,42])]
  comments.append({'id':1,'body':'AGY_MISSION_V1\n'+dump(self.payload),'user':{'login':'tuanvu297'},'url':'synthetic'})
  d.process_ingress(comments)
  self.assertEqual(self.s.status('mission1')['status'],'QUEUED')

if __name__=='__main__':unittest.main(verbosity=2)
