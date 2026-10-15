import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from manus_kit import Adapter,Api,Journal,KitError,dumps,strict_load,terminal,redact,credits
from mcp_server import Server

class Fixture:
    def __init__(self):self.calls=[];self.fail_create=False;self.status='stopped';self.more=False
    def __call__(self,endpoint,params,body):
        self.calls.append((endpoint,params,body))
        if endpoint=='user.me':return {'ok':True,'user_id':'synthetic-user'}
        if endpoint=='usage.availableCredits':return {'ok':True,'total_credits':100,'free_credits':100}
        if endpoint=='task.create':
            if self.fail_create:raise KitError('PROVIDER_TRANSPORT_UNCERTAIN')
            return {'ok':True,'task_id':'synthetic-task-1','request_id':'synthetic-request'}
        if endpoint=='task.detail':return {'ok':True,'task':{'status':self.status,'has_running_background_jobs':False}}
        if endpoint=='task.listMessages':return {'ok':True,'messages':[{'type':'assistant_message','assistant_message':{'content':'synthetic reply'}}], 'has_more':self.more}
        return {'ok':True,'request_id':'synthetic-request'}

class KitTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.clock=[1000.0]
        self.j=Journal(self.temp.name,now=lambda:self.clock[0]);self.ctx={'task_id':'task-1','worker_id':'worker-1','attempt':1,'idempotency_key':'key-1'}
        self.grant=self.j.issue_grant(self.ctx,'callback-1','synthetic test authorization',ttl=600)
        self.f=Fixture();self.a=Adapter(self.j,Api('synthetic-binding',transport=self.f))
    def tearDown(self):self.j.close();self.temp.cleanup()
    def create(self):return self.a.create(self.grant,'synthetic prompt')
    def ack(self):return self.j.ack_dispatch(self.grant,'native-thread-1',{'transport_status':'RECEIVED_BY_EXECUTOR','source':'synthetic controlled transport'})
    def count(self,op):return sum(x[0]==op for x in self.f.calls)
    def test_duplicate_json(self):
        with self.assertRaises(KitError):strict_load('{"x":1,"x":2}')
    def test_nonfinite_json(self):
        with self.assertRaises(KitError):strict_load('{"x":NaN}')
    def test_serialize_nonfinite(self):
        with self.assertRaises(ValueError):dumps({'x':float('nan')})
    def test_key_redaction(self):
        x=redact({'client_secret':'synthetic','text':'secret-binding'},'secret-binding')
        self.assertEqual(x,{'client_secret':'[REDACTED]','text':'[REDACTED]'})
    def test_credit_bool_denied(self):
        with self.assertRaises(KitError):credits({'total_credits':True})
    def test_missing_auth(self):
        with self.assertRaises(KitError):Api('')
    def test_foreign_signature_denied(self):
        g=strict_load(dumps(self.grant));g['body']['identity']['worker_id']='another-worker'
        with self.assertRaises(KitError):self.a.create(g,'synthetic prompt')
        self.assertEqual(self.f.calls,[])
    def test_expiry_before_side_effect(self):
        self.clock[0]=1600
        with self.assertRaises(KitError):self.create()
        self.assertEqual(self.f.calls,[])
    def test_create_once(self):
        first=self.create();second=self.create()
        self.assertEqual(first['provider_task_id'],second['provider_task_id']);self.assertTrue(second['cached'])
        self.assertEqual(self.count('task.create'),1)
    def test_create_payload_conflict(self):
        self.create()
        with self.assertRaises(KitError):self.a.create(self.grant,'different payload')
        self.assertEqual(self.count('task.create'),1)
    def test_unknown_create_not_retried(self):
        self.f.fail_create=True
        with self.assertRaises(KitError):self.create()
        with self.assertRaises(KitError):self.create()
        self.assertEqual(self.count('task.create'),1);self.assertEqual(self.j.pending()[0]['state'],'UNCERTAIN')
    def test_create_persistence_across_restart(self):
        self.create();self.j.close();self.j=Journal(self.temp.name,now=lambda:self.clock[0])
        self.a=Adapter(self.j,Api('synthetic-binding',transport=self.f));self.create();self.assertEqual(self.count('task.create'),1)
    def test_read_does_not_create(self):
        self.create();result=self.a.read(self.grant)
        self.assertEqual(result['result']['closure'],'STOPPED_WITH_REPLY');self.assertEqual(self.count('task.create'),1)
    def test_expired_read_reconciliation(self):
        self.create();self.clock[0]=1600;self.a.read(self.grant,reconcile=True)
        with self.assertRaises(KitError):self.a.stop(self.grant)
        self.assertEqual(self.count('task.stop'),0)
    def test_stop_once(self):
        self.create();self.a.stop(self.grant);self.a.stop(self.grant)
        self.assertEqual(self.count('task.stop'),1)
    def test_resume_same_task(self):
        self.create();x=self.a.resume(self.grant,'follow-up','resume-1','provider state readback')
        self.assertFalse(x['new_task_create']);self.assertEqual(self.count('task.create'),1);self.assertEqual(self.count('task.sendMessage'),1)
    def test_resume_busy_denied(self):
        self.create();self.f.status='running'
        with self.assertRaises(KitError):self.a.resume(self.grant,'follow-up','resume-1','test')
        self.assertEqual(self.count('task.sendMessage'),0)
    def test_pagination_incomplete_not_terminal(self):
        self.create();self.f.more=True;x=self.a.read(self.grant)
        self.assertEqual(x['result']['closure'],'UNCERTAIN_OR_PENDING')
    def test_malformed_pagination_denied(self):
        self.create()
        for value in [None,'false',0,1,[],{}]:
            with self.subTest(value=value):
                self.f.more=value
                with self.assertRaisesRegex(KitError,'PAGINATION_SCHEMA_UNVERIFIED'):self.a.read(self.grant)
        self.assertEqual(self.count('task.create'),1)
    def test_missing_pagination_denied(self):
        self.create()
        original=self.f.__call__
        def omit(endpoint,params,body):
            response=original(endpoint,params,body)
            if endpoint=='task.listMessages':response.pop('has_more',None)
            return response
        self.a.api=Api('synthetic-binding',transport=omit)
        with self.assertRaisesRegex(KitError,'PAGINATION_SCHEMA_UNVERIFIED'):self.a.read(self.grant)
        self.assertEqual(self.count('task.create'),1)
    def test_terminal_requires_explicit_pagination_false(self):
        detail={'task':{'status':'stopped','has_running_background_jobs':False}}
        event={'type':'assistant_message','assistant_message':{'content':'reply'}}
        for marker in [None,'false',0,1,[],{},True]:
            self.assertEqual(terminal(detail,{'messages':[event],'has_more':marker})['closure'],'UNCERTAIN_OR_PENDING')
        self.assertEqual(terminal(detail,{'messages':[event]})['closure'],'UNCERTAIN_OR_PENDING')
        self.assertEqual(terminal(detail,{'messages':[event],'has_more':False})['closure'],'STOPPED_WITH_REPLY')
    def test_background_jobs_not_terminal(self):
        result=terminal({'task':{'status':'stopped','has_running_background_jobs':True}},
           {'messages':[{'type':'assistant_message','assistant_message':{'content':'reply'}}]})
        self.assertEqual(result['closure'],'UNCERTAIN_OR_PENDING')
    def test_old_reply_not_terminal(self):
        result=terminal({'task':{'status':'stopped','has_running_background_jobs':False}},
           {'messages':[{'type':'user_message'},{'type':'assistant_message','assistant_message':{'content':'old'}}]})
        self.assertEqual(result['closure'],'UNCERTAIN_OR_PENDING')
    def test_before_ack_plan_denied(self):
        with self.assertRaises(KitError):self.j.checkpoint(self.grant,'PLAN',{'evidence_id':'test-evid'})
    def test_ack_has_required_binding(self):
        ack=self.ack()
        for k in ['task_id','worker_id','attempt','idempotency_key','grant_id','lease_id','timestamp','callback_target']:
            self.assertIn(k,ack)
    def test_ack_needs_actual_receipt(self):
        with self.assertRaises(KitError):self.j.ack_dispatch(self.grant,'native-thread-1',{'transport_status':'QUEUED_ONLY'})
    def test_heartbeat_stale(self):
        self.ack();self.clock[0]+=91;self.assertEqual(self.j.dispatch_status('task-1')['status'],'STALE')
        with self.assertRaises(KitError):self.j.checkpoint(self.grant,'PLAN',{'evidence_id':'test-evid'})
    def test_fresh_heartbeat_restores_progress(self):
        self.ack();self.clock[0]+=91;self.j.heartbeat(self.grant)
        self.assertEqual(self.j.checkpoint(self.grant,'PLAN',{'evidence_id':'test-evid'})['status'],'PASS')
    def test_checkpoint_order(self):
        self.ack()
        with self.assertRaises(KitError):self.j.checkpoint(self.grant,'BUILD',{'evidence_id':'test-evid'})
    def test_no_final_pass_without_delivery_and_acceptance(self):
        self.ack()
        for phase in ['PLAN','BUILD','PACKAGE_BUILT','INSTALL_TEST','LIVE_TEST','QA']:
            self.j.checkpoint(self.grant,phase,{'evidence_id':'evidence-'+phase})
        with self.assertRaises(KitError):self.j.checkpoint(self.grant,'FINAL_CALLBACK',{'evidence_id':'evidence-final'})
        self.j.delivery(self.grant,{'delivery_id':'delivery-1','target':'callback-1'})
        with self.assertRaises(KitError):self.j.acceptance(self.grant,{'reviewer':'worker-1','status':'PASS','evidence_id':'qa-self'})
        self.j.acceptance(self.grant,{'reviewer':'AGY-control-plane','status':'PASS','evidence_id':'qa-independent'})
        self.assertEqual(self.j.checkpoint(self.grant,'FINAL_CALLBACK',{'evidence_id':'evidence-final'})['status'],'PASS')
    def test_callback_outbox_is_not_delivery(self):
        self.assertEqual(self.j.callback(self.grant,{'result':'synthetic'})['status'],'DURABLE_OUTBOX_AWAITING_DELIVERY')
    def test_acceptance_missing_reviewer_denied(self):
        self.ack();self.j.delivery(self.grant,{'delivery_id':'delivery-1','target':'callback-1'})
        with self.assertRaises(KitError):self.j.acceptance(self.grant,{'status':'PASS','evidence_id':'test-evidence'})
    def test_blocked_closure_without_full_pipeline(self):
        self.ack();self.j.checkpoint(self.grant,'PLAN',{'evidence_id':'plan-evidence'})
        self.assertEqual(self.j.checkpoint(self.grant,'FINAL_CALLBACK',{'evidence_id':'closure-evidence'},'BLOCKED')['status'],'BLOCKED')
    def test_mcp_no_authority_tool(self):
        s=Server(self.j,'synthetic-binding',None,api=Api('synthetic-binding',transport=self.f))
        self.assertIn('error',s.handle({'jsonrpc':'2.0','id':1,'method':'tools/list'}))
        s.handle({'jsonrpc':'2.0','id':2,'method':'initialize','params':{'protocolVersion':'2025-11-25','clientInfo':{'name':'test','version':'1'}}})
        s.handle({'jsonrpc':'2.0','method':'notifications/initialized'})
        tools=s.handle({'jsonrpc':'2.0','id':3,'method':'tools/list'})['result']['tools']
        self.assertEqual(len(tools),8);self.assertFalse(any('grant' in t['name'] for t in tools))
        result=s.handle({'jsonrpc':'2.0','id':4,'method':'tools/call','params':{'name':'manus_task_create','arguments':{'prompt':'test','grant':'caller authority'}}})
        self.assertTrue(result['result']['isError']);self.assertEqual(self.f.calls,[])
    def test_stdio_fresh_process_no_key(self):
        env=dict(os.environ);env.pop('MANUS_API_KEY',None)
        p=subprocess.run([sys.executable,str(Path(__file__).parents[1]/'bin/manus-kit.py'),'--state',self.temp.name,'mcp'],
          input='\n'.join([dumps({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2025-11-25','clientInfo':{'name':'test','version':'1'}}}),
            dumps({'jsonrpc':'2.0','method':'notifications/initialized'}),dumps({'jsonrpc':'2.0','id':2,'method':'tools/list'})])+'\n',
          text=True,capture_output=True,env=env,timeout=20)
        self.assertEqual(p.returncode,0);lines=[strict_load(s) for s in p.stdout.splitlines()]
        self.assertEqual(len(lines),2);self.assertEqual(lines[1]['result']['tools'][0]['name'],'manus_auth_health')

if __name__=='__main__':unittest.main(verbosity=2)
