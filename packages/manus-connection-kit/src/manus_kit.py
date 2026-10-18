"""Manus Connection Kit: standard-library API adapter and shared durable journal."""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = '0.1.1'
MAX_BYTES = 2 * 1024 * 1024
BASE = 'https://api.manus.ai/v2/'
OPS = {'create', 'read', 'resume', 'stop'}
PHASES = ['PLAN','BUILD','PACKAGE_BUILT','INSTALL_TEST','LIVE_TEST','QA','FINAL_CALLBACK']
TOKEN = re.compile(r'^[A-Za-z0-9_.:-]{1,160}$')
SENSITIVE_FIELDS = {'api_key','apikey','access_token','refresh_token','client_secret','password','authorization','cookie'}

class KitError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)

def dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def strict_load(raw):
    def pairs(items):
        result = {}
        for k,v in items:
            if k in result: raise KitError('DUPLICATE_JSON_KEY')
            result[k] = v
        return result
    def constant(_): raise KitError('NON_FINITE_JSON_NUMBER')
    try: return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError): raise KitError('INVALID_JSON') from None

def digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()

def identity(value):
    if not isinstance(value, dict) or set(value) != {'task_id','worker_id','attempt','idempotency_key'}:
        raise KitError('IDENTITY_SCHEMA_DENIED')
    if type(value['attempt']) is not int or value['attempt'] < 1: raise KitError('ATTEMPT_DENIED')
    if any(not isinstance(value[k],str) or not TOKEN.fullmatch(value[k]) for k in ('task_id','worker_id','idempotency_key')):
        raise KitError('IDENTITY_DENIED')
    return dict(value)

def load_key():
    value = os.environ.get('MANUS_API_KEY')
    if not value and sys.platform == 'win32':
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
                value,_ = winreg.QueryValueEx(key,'MANUS_API_KEY')
        except OSError: pass
    return value.strip() if isinstance(value,str) else ''

def redact(value, key=''):
    if isinstance(value,dict):
        return {k:'[REDACTED]' if k.lower().replace('-','_') in SENSITIVE_FIELDS else redact(v,key) for k,v in value.items()}
    if isinstance(value,list): return [redact(v,key) for v in value]
    if isinstance(value,str):
        if key: value = value.replace(key,'[REDACTED]')
        return re.sub(r'(?i)\b(Bearer|Basic)\s+[A-Za-z0-9_./+=-]+',r'\1 [REDACTED]',value)
    return value

class Journal:
    def __init__(self, root, *, now=time.time):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True,exist_ok=True)
        self.now = now
        self.db = sqlite3.connect(self.root/'journal.sqlite',timeout=10,isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=10000;
          CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, body TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, identity TEXT NOT NULL, action TEXT NOT NULL,
            fingerprint TEXT NOT NULL, state TEXT NOT NULL, provider_id TEXT, result TEXT);
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at REAL, action TEXT, data TEXT);
          CREATE TABLE IF NOT EXISTS dispatch(task_id TEXT PRIMARY KEY, identity TEXT NOT NULL, grant_id TEXT,
            ack TEXT, phase TEXT, heartbeat REAL, callback TEXT, acceptance TEXT);
          CREATE TABLE IF NOT EXISTS checkpoint_log(task_id TEXT, phase TEXT, evidence TEXT, status TEXT, at REAL,
            PRIMARY KEY(task_id,phase));
          CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, payload TEXT, delivery TEXT, acceptance TEXT);
        ''')
    def close(self): self.db.close()
    def event(self, action, data):
        self.db.execute('INSERT INTO events(at,action,data) VALUES (?,?,?)',(self.now(),action,dumps(data)))
    def transaction(self, fn):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            result=fn();self.db.execute('COMMIT');return result
        except BaseException:
            self.db.execute('ROLLBACK');raise
    def authority_key(self,create=False):
        path=self.root/'controller-authority.key'
        if create and not path.exists():
            try:
                fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(fd,'wb') as f:f.write(secrets.token_bytes(32))
            except FileExistsError:pass
        if not path.exists():raise KitError('CONTROLLER_AUTHORITY_NOT_INITIALIZED')
        return path.read_bytes()
    def issue_grant(self,ctx,callback_target,authorization,*,ttl=600,scope=None,max_creates=1):
        ctx=identity(ctx)
        if not isinstance(authorization,str) or not authorization.strip():raise KitError('OWNER_AUTHORIZATION_REQUIRED')
        if not TOKEN.fullmatch(callback_target):raise KitError('CALLBACK_TARGET_DENIED')
        scope=scope or sorted(OPS)
        if not set(scope)<=OPS or not scope:raise KitError('GRANT_SCOPE_DENIED')
        if type(ttl) is not int or not 1<=ttl<=900 or type(max_creates) is not int or not 0<=max_creates<=1:
            raise KitError('GRANT_LIMIT_DENIED')
        now=self.now(); body={'grant_id':'GRANT-'+secrets.token_hex(16),'identity':ctx,
            'issued_at':now,'expires_at':now+ttl,'scope':scope,'max_creates':max_creates,
            'callback_target':callback_target,'authorization':authorization}
        signature=hmac.new(self.authority_key(True),dumps(body).encode(),hashlib.sha256).hexdigest()
        envelope={'body':body,'signature':signature}
        self.db.execute('INSERT INTO grants(id,body) VALUES (?,?)',(body['grant_id'],dumps(envelope)))
        self.event('CONTROLLER_GRANT_ISSUED',{'grant_id':body['grant_id'],'identity':ctx,'expires_at':body['expires_at']})
        return envelope
    def assert_grant(self,envelope,operation=None,*,allow_expired_read=False):
        if not isinstance(envelope,dict) or set(envelope)!={'body','signature'}:raise KitError('GRANT_SCHEMA_DENIED')
        body=envelope['body']
        if not isinstance(body,dict):raise KitError('GRANT_SCHEMA_DENIED')
        identity(body.get('identity'))
        expected=hmac.new(self.authority_key(),dumps(body).encode(),hashlib.sha256).hexdigest()
        if not isinstance(envelope['signature'],str) or not hmac.compare_digest(expected,envelope['signature']):
            raise KitError('GRANT_SIGNATURE_DENIED')
        row=self.db.execute('SELECT * FROM grants WHERE id=?',(body.get('grant_id'),)).fetchone()
        if not row or row['revoked'] or row['body']!=dumps(envelope):raise KitError('GRANT_REVOKED_OR_CHANGED')
        if self.now()<body['issued_at'] or (self.now()>=body['expires_at'] and not allow_expired_read):raise KitError('GRANT_EXPIRED')
        if operation and operation not in body['scope']:raise KitError('GRANT_OPERATION_DENIED')
        return body
    def reserve(self,ctx,action,key,payload):
        identity(ctx)
        if not TOKEN.fullmatch(key):raise KitError('COMMAND_KEY_DENIED')
        identifier=digest([ctx['task_id'],ctx['idempotency_key'],action,key]);fp=digest(payload)
        def transaction():
            old=self.db.execute('SELECT * FROM intents WHERE id=?',(identifier,)).fetchone()
            if old:
                old_ctx=strict_load(old['identity'])
                if old_ctx['worker_id']!=ctx['worker_id']:raise KitError('INTENT_WORKER_OWNERSHIP_DENIED')
                if old['fingerprint']!=fp:raise KitError('IDEMPOTENCY_CONFLICT')
                if old['state']=='ACKED':return identifier,strict_load(old['result'])
                raise KitError('OUTCOME_UNCERTAIN_RECONCILE_NO_RETRY')
            self.db.execute('INSERT INTO intents VALUES (?,?,?,?,?,NULL,NULL)',
              (identifier,dumps(ctx),action,fp,'PENDING'))
            return identifier,None
        return self.transaction(transaction)
    def finish(self,identifier,result,provider_id=None):
        self.db.execute('UPDATE intents SET state=?,result=?,provider_id=COALESCE(?,provider_id) WHERE id=?',
            ('ACKED',dumps(result),provider_id,identifier))
    def uncertain(self,identifier,code):
        self.db.execute('UPDATE intents SET state=? WHERE id=?',('UNCERTAIN',identifier))
        self.event('ACTION_UNCERTAIN',{'intent_id':identifier,'error':code})
    def task_row(self,ctx):
        row=self.db.execute("SELECT * FROM intents WHERE action='create' AND id=?",
            (digest([ctx['task_id'],ctx['idempotency_key'],'create','create']),)).fetchone()
        if not row or not row['provider_id']:raise KitError('PROVIDER_TASK_ID_REQUIRED_NO_RESUBMISSION')
        if strict_load(row['identity'])['worker_id']!=ctx['worker_id']:raise KitError('INTENT_WORKER_OWNERSHIP_DENIED')
        return row
    def pending(self):
        return [dict(r) for r in self.db.execute('SELECT id,action,state,provider_id FROM intents ORDER BY rowid')]
    def ack_dispatch(self,envelope,executor_thread_id,receipt):
        body=self.assert_grant(envelope);ctx=body['identity']
        if not TOKEN.fullmatch(executor_thread_id) or not isinstance(receipt,dict) or receipt.get('transport_status')!='RECEIVED_BY_EXECUTOR':
            raise KitError('ACTUAL_DISPATCH_RECEIPT_REQUIRED')
        ack={'status':'ACK',**ctx,'grant_id':body['grant_id'],'lease_id':body['grant_id'],
             'timestamp':self.now(),'callback_target':body['callback_target'],'executor_thread_id':executor_thread_id,
             'dispatch_receipt':receipt}
        def operation():
            old=self.db.execute('SELECT * FROM dispatch WHERE task_id=?',(ctx['task_id'],)).fetchone()
            if old:
                if old['identity']!=dumps(ctx):raise KitError('DISPATCH_IDENTITY_CONFLICT')
                return strict_load(old['ack'])
            self.db.execute('INSERT INTO dispatch VALUES (?,?,?,?,?,?,NULL,NULL)',
                (ctx['task_id'],dumps(ctx),body['grant_id'],dumps(ack),None,self.now()))
            return ack
        return self.transaction(operation)
    def heartbeat(self,envelope):
        body=self.assert_grant(envelope);ctx=body['identity']
        row=self.db.execute('SELECT * FROM dispatch WHERE task_id=?',(ctx['task_id'],)).fetchone()
        if not row or row['identity']!=dumps(ctx):raise KitError('ACK_REQUIRED')
        self.db.execute('UPDATE dispatch SET heartbeat=?,grant_id=? WHERE task_id=?',(self.now(),body['grant_id'],ctx['task_id']))
        return self.dispatch_status(ctx['task_id'])
    def dispatch_status(self,task_id,stale_after=90):
        row=self.db.execute('SELECT * FROM dispatch WHERE task_id=?',(task_id,)).fetchone()
        if not row or not row['ack']:return {'status':'BLOCKED','reason':'ACK_MISSING'}
        grant=self.db.execute('SELECT * FROM grants WHERE id=?',(row['grant_id'],)).fetchone()
        expiry=strict_load(grant['body'])['body']['expires_at'] if grant else 0
        if not grant or grant['revoked'] or self.now()>=expiry:return {'status':'STALE','reason':'GRANT_EXPIRED','phase':row['phase']}
        if self.now()-row['heartbeat']>stale_after:return {'status':'STALE','reason':'HEARTBEAT_MISSING','phase':row['phase']}
        return {'status':'ACTIVE','phase':row['phase'],'heartbeat':row['heartbeat'],'grant_id':row['grant_id']}
    def checkpoint(self,envelope,phase,evidence,status='PASS'):
        body=self.assert_grant(envelope);ctx=body['identity']
        if phase not in PHASES or status not in {'PASS','FAIL','BLOCKED','EXTERNAL_LIMIT','UNVERIFIED'}:
            raise KitError('CHECKPOINT_SCHEMA_DENIED')
        if not isinstance(evidence,dict) or not evidence.get('evidence_id'):raise KitError('CHECKPOINT_EVIDENCE_REQUIRED')
        def transaction():
            row=self.db.execute('SELECT * FROM dispatch WHERE task_id=?',(ctx['task_id'],)).fetchone()
            if not row or row['identity']!=dumps(ctx):raise KitError('ACK_REQUIRED_BEFORE_PLAN')
            if self.dispatch_status(ctx['task_id'])['status']!='ACTIVE':raise KitError('STALE_EXECUTOR_DENIED')
            previous=self.db.execute('SELECT * FROM checkpoint_log WHERE task_id=? AND phase=?',(ctx['task_id'],phase)).fetchone()
            if previous:
                if previous['evidence']!=dumps(evidence) or previous['status']!=status:raise KitError('CHECKPOINT_CONFLICT')
                return dict(previous)
            index=PHASES.index(phase)
            closure_only=phase=='FINAL_CALLBACK' and status!='PASS'
            if index and not closure_only and row['phase']!=PHASES[index-1]:raise KitError('CHECKPOINT_ORDER_DENIED')
            if index and not closure_only:
                prior=self.db.execute('SELECT status FROM checkpoint_log WHERE task_id=? AND phase=?',(ctx['task_id'],PHASES[index-1])).fetchone()
                if not prior or prior['status']!='PASS':raise KitError('PREVIOUS_CHECKPOINT_NOT_PASS')
            if phase=='FINAL_CALLBACK' and status=='PASS' and (not row['callback'] or not row['acceptance']):
                raise KitError('CALLBACK_DELIVERY_AND_AGY_ACCEPTANCE_REQUIRED')
            self.db.execute('INSERT INTO checkpoint_log VALUES (?,?,?,?,?)',(ctx['task_id'],phase,dumps(evidence),status,self.now()))
            self.db.execute('UPDATE dispatch SET phase=?,heartbeat=? WHERE task_id=?',(phase,self.now(),ctx['task_id']))
            return {'phase':phase,'status':status,'evidence':evidence}
        return self.transaction(transaction)
    def delivery(self,envelope,receipt):
        ctx=self.assert_grant(envelope)['identity']
        if not isinstance(receipt,dict) or not receipt.get('delivery_id') or receipt.get('target')!=envelope['body']['callback_target']:
            raise KitError('CALLBACK_DELIVERY_RECEIPT_REQUIRED')
        if self.db.execute('UPDATE dispatch SET callback=? WHERE task_id=?',(dumps(receipt),ctx['task_id'])).rowcount!=1:
            raise KitError('ACK_REQUIRED')
    def acceptance(self,envelope,record):
        ctx=self.assert_grant(envelope)['identity']
        if not isinstance(record,dict) or not isinstance(record.get('reviewer'),str) or not record['reviewer'].strip() or record.get('reviewer')==ctx['worker_id'] or record.get('status')!='PASS' or not record.get('evidence_id'):
            raise KitError('INDEPENDENT_AGY_ACCEPTANCE_REQUIRED')
        row=self.db.execute('SELECT callback FROM dispatch WHERE task_id=?',(ctx['task_id'],)).fetchone()
        if not row or not row['callback']:raise KitError('DELIVERY_REQUIRED_BEFORE_ACCEPTANCE')
        self.db.execute('UPDATE dispatch SET acceptance=? WHERE task_id=?',(dumps(record),ctx['task_id']))
    def callback(self,envelope,payload):
        body=self.assert_grant(envelope,allow_expired_read=True)
        receipt={'identity':body['identity'],'target':body['callback_target'],'payload':payload}
        identifier='CALLBACK-'+digest(receipt)
        self.db.execute('INSERT OR IGNORE INTO outbox VALUES (?,?,NULL,NULL)',(identifier,dumps(receipt)))
        return {'callback_id':identifier,'status':'DURABLE_OUTBOX_AWAITING_DELIVERY','target':body['callback_target']}

class Api:
    def __init__(self,key,*,transport=None,now=time.time):
        if not isinstance(key,str) or not key.strip():raise KitError('MANUS_API_KEY_ABSENT')
        self._key=key.strip();self.transport=transport;self.now=now
    def request(self,endpoint,*,params=None,body=None):
        if endpoint not in {'user.me','usage.availableCredits','task.create','task.detail','task.listMessages','task.sendMessage','task.stop'}:
            raise KitError('ENDPOINT_DENIED')
        if self.transport:
            result=self.transport(endpoint,params or {},body)
        else:
            url=BASE+endpoint
            if params:url+='?'+urllib.parse.urlencode(params)
            headers={'x-manus-api-key':self._key,'Accept':'application/json'}
            raw=None
            if body is not None:headers['Content-Type']='application/json';raw=dumps(body).encode()
            request=urllib.request.Request(url,data=raw,headers=headers,method='POST' if body is not None else 'GET')
            # Redirects could forward auth; no automatic retry at transport layer.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*_):return None
            try:
                with urllib.request.build_opener(NoRedirect()).open(request,timeout=20) as response:
                    raw_response=response.read(MAX_BYTES+1)
                    if len(raw_response)>MAX_BYTES:raise KitError('PROVIDER_RESPONSE_TOO_LARGE')
                result=strict_load(raw_response)
            except urllib.error.HTTPError as e:raise KitError('PROVIDER_HTTP_'+str(e.code)) from None
            except (urllib.error.URLError,TimeoutError,OSError):raise KitError('PROVIDER_TRANSPORT_UNCERTAIN') from None
        if not isinstance(result,dict) or result.get('ok') is not True:raise KitError('PROVIDER_RESPONSE_UNVERIFIED')
        return redact(result,self._key)
    def check_prompt(self,prompt):
        if not isinstance(prompt,str) or not prompt.strip() or len(prompt)>8000 or self._key in prompt:
            raise KitError('PROMPT_DENIED')

def credits(response):
    value=response.get('data',response.get('credits',response))
    if not isinstance(value,dict) or type(value.get('total_credits')) is not int or value['total_credits']<0:
        raise KitError('CREDIT_SCHEMA_UNVERIFIED')
    return {k:v for k,v in value.items() if k in {'total_credits','free_credits','periodic_credits','addon_credits','event_credits','next_refresh_time'}}

def task_id(value):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}',value):raise KitError('PROVIDER_TASK_ID_DENIED')
    return value

def terminal(detail,messages):
    task=detail.get('task');events=messages.get('messages')
    if not isinstance(task,dict) or not isinstance(events,list):raise KitError('RESULT_SCHEMA_UNVERIFIED')
    status=next((e.get('status_update',{}).get('agent_status') for e in events if e.get('type')=='status_update'),task.get('status'))
    assistant=next((n for n,e in enumerate(events) if e.get('type')=='assistant_message' and isinstance(e.get('assistant_message',{}).get('content'),str)),None)
    user=next((n for n,e in enumerate(events) if e.get('type')=='user_message'),None)
    latest=events[assistant] if assistant is not None and (user is None or assistant<user) else None
    stopped=status=='stopped' and task.get('has_running_background_jobs') is False and latest is not None and messages.get('has_more') is False
    return {'provider_status':status,'detail_status':task.get('status'),'background_jobs':task.get('has_running_background_jobs'),
        'text':latest['assistant_message']['content'] if latest else None,
        'closure':'STOPPED_WITH_REPLY' if stopped else ('VERIFIED_FAIL' if status=='error' else 'UNCERTAIN_OR_PENDING'),
        'acceptance':'UNVERIFIED_REQUIRES_TASK_RUBRIC'}

class Adapter:
    def __init__(self,journal,api):self.journal=journal;self.api=api
    def auth(self):
        result=self.api.request('user.me');user=result.get('user_id')
        if not isinstance(user,str) or not user:raise KitError('AUTH_USER_ID_UNVERIFIED')
        clean={'AUTH_VERIFIED':True,'api_key_present':True,'user_id_sha256':hashlib.sha256(user.encode()).hexdigest(),
            'request_id':result.get('request_id'),'observed_at':self.journal.now()}
        self.journal.event('AUTH_READBACK',clean);return clean
    def resource(self):
        result={'credits':credits(self.api.request('usage.availableCredits')),'observed_at':self.journal.now()}
        self.journal.event('RESOURCE_READBACK',result);return result
    def create(self,envelope,prompt):
        grant=self.journal.assert_grant(envelope,'create');self.api.check_prompt(prompt);ctx=grant['identity']
        identifier,cached=self.journal.reserve(ctx,'create','create',{'prompt':prompt,'profile':'lite'})
        if cached:return {**cached,'cached':True}
        try:
            if grant['max_creates']<1:raise KitError('CREATE_BUDGET_DENIED')
            self.auth();available=self.resource()
            if available['credits']['total_credits']<=0:raise KitError('CREDITS_EXHAUSTED')
            self.journal.assert_grant(envelope,'create')
            result=self.api.request('task.create',body={'message':{'content':prompt,'connectors':[],'enable_skills':[]},
                'agent_profile':'lite','interactive_mode':False,'share_visibility':'private'})
            provider=task_id(result.get('task_id'))
            clean={'provider_task_id':provider,'request_id':result.get('request_id'),'profile':'lite','status':'ACKED',
                'identity':ctx,'grant_id':grant['grant_id'],'credits_before':available['credits'],'observed_at':self.journal.now()}
            self.journal.finish(identifier,clean,provider);self.journal.event('TASK_CREATE_ACK',clean);return clean
        except KitError as e:self.journal.uncertain(identifier,e.code);raise
        except BaseException:self.journal.uncertain(identifier,'LOCAL_FAILURE_AFTER_RESERVATION');raise
    def read(self,envelope,*,reconcile=False):
        grant=self.journal.assert_grant(envelope,'read',allow_expired_read=reconcile);ctx=grant['identity']
        row=self.journal.task_row(ctx);provider=task_id(row['provider_id'])
        detail=self.api.request('task.detail',params={'task_id':provider})
        events=[];cursor=None;has_more=True;seen=set()
        for page in range(5):
            params={'task_id':provider,'order':'desc','limit':50,'verbose':'false'}
            if cursor:params['cursor']=cursor
            response=self.api.request('task.listMessages',params=params)
            if not isinstance(response.get('messages'),list):raise KitError('MESSAGES_SCHEMA_UNVERIFIED')
            if type(response.get('has_more')) is not bool:raise KitError('PAGINATION_SCHEMA_UNVERIFIED')
            events.extend(response['messages']);has_more=response['has_more'];cursor=response.get('next_cursor')
            if not has_more:break
            if not isinstance(cursor,str) or not cursor or cursor in seen:break
            seen.add(cursor)
        messages={'ok':True,'messages':events,'has_more':has_more}
        result={'provider_task_id':provider,'result':terminal(detail,messages),'detail':detail,'messages':messages,
            'pages':page+1,'read_only_reconciliation':reconcile,'observed_at':self.journal.now()}
        self.journal.event('TASK_READBACK',result);return result
    def resume(self,envelope,prompt,command_key,reason):
        grant=self.journal.assert_grant(envelope,'resume');self.api.check_prompt(prompt)
        if not isinstance(reason,str) or not reason.strip():raise KitError('RESUME_REASON_REQUIRED')
        ctx=grant['identity'];row=self.journal.task_row(ctx);current=self.read(envelope)
        if current['result']['provider_status'] not in {'stopped','waiting'}:raise KitError('RESUME_STATE_NOT_ELIGIBLE')
        task=current['detail']['task'];event_type=task.get('status_detail',{}).get('waiting_for_event_type')
        if current['result']['provider_status']=='waiting' and event_type not in {'messageAskUser','cascadeAskUser'}:
            raise KitError('UNKNOWN_WAITING_ACTION_DENIED')
        identifier,cached=self.journal.reserve(ctx,'resume',command_key,{'prompt':prompt,'reason':reason})
        if cached:return {**cached,'cached':True}
        try:
            if self.resource()['credits']['total_credits']<=0:raise KitError('CREDITS_EXHAUSTED')
            self.journal.assert_grant(envelope,'resume')
            ack=self.api.request('task.sendMessage',body={'task_id':task_id(row['provider_id']),
                'message':{'content':prompt,'connectors':[],'enable_skills':[]},'clear_connectors':True,'agent_profile':'lite','interactive_mode':False})
            result={'provider_task_id':row['provider_id'],'status':'RESUME_ACKED','request_id':ack.get('request_id'),'new_task_create':False}
            self.journal.finish(identifier,result,row['provider_id']);self.journal.event('TASK_RESUME_ACK',result);return result
        except KitError as e:self.journal.uncertain(identifier,e.code);raise
        except BaseException:self.journal.uncertain(identifier,'LOCAL_FAILURE_AFTER_RESERVATION');raise
    def stop(self,envelope,command_key='stop'):
        grant=self.journal.assert_grant(envelope,'stop');ctx=grant['identity'];row=self.journal.task_row(ctx)
        identifier,cached=self.journal.reserve(ctx,'stop',command_key,{'task_id':row['provider_id']})
        if cached:return {**cached,'cached':True}
        try:
            ack=self.api.request('task.stop',body={'task_id':task_id(row['provider_id'])})
            result={'provider_task_id':row['provider_id'],'status':'STOP_ACKED','request_id':ack.get('request_id'),'terminal_verified':False}
            self.journal.finish(identifier,result,row['provider_id']);return result
        except KitError as e:self.journal.uncertain(identifier,e.code);raise
        except BaseException:self.journal.uncertain(identifier,'LOCAL_FAILURE_AFTER_RESERVATION');raise

def default_state():
    return Path(os.environ.get('LOCALAPPDATA',str(Path.home()/'.local/share')))/'manus-connection-kit'

def grant_from_file(path):
    if not path:raise KitError('CONTROLLER_GRANT_FILE_REQUIRED')
    return strict_load(Path(path).read_bytes())

def main(argv=None):
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(description='Manus Connection Kit, no automatic retries')
    parser.add_argument('--state',default=str(default_state()))
    parser.add_argument('--grant',default=os.environ.get('MANUS_KIT_GRANT_FILE'))
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ['auth-health','credits','read','journal-status','self-test','mcp']:sub.add_parser(name)
    p=sub.add_parser('create');p.add_argument('--prompt',required=True)
    p=sub.add_parser('resume');p.add_argument('--prompt',required=True);p.add_argument('--command-key',required=True);p.add_argument('--reason',required=True)
    p=sub.add_parser('stop');p.add_argument('--command-key',default='stop')
    p=sub.add_parser('issue-grant')
    for name in ['task-id','worker-id','idempotency-key','callback-target','authorization','out']:p.add_argument('--'+name,required=True)
    p.add_argument('--attempt',type=int,default=1);p.add_argument('--ttl',type=int,default=600)
    args=parser.parse_args(argv)
    journal=None
    try:
        source=Path(__file__).resolve().parents[1];state=Path(args.state).expanduser().resolve()
        if state==source or source in state.parents:raise KitError('STATE_MUST_BE_OUTSIDE_PACKAGE')
        if args.command=='self-test':
            result={'LOCAL_SELF_TEST':'PASS','python':sys.version.split()[0],'sqlite':sqlite3.sqlite_version,
              'api_key_present':bool(load_key()),'network_requests':0,'AUTH_VERIFIED':'UNVERIFIED',
              'LIVE_EXECUTION_PASS':'UNVERIFIED','scope':'Runtime detection only; use packaged unit tests for functional evidence'}
        else:
            journal=Journal(state)
            if args.command=='issue-grant':
                destination=Path(args.out).resolve()
                if destination==source or source in destination.parents:raise KitError('GRANT_MUST_BE_OUTSIDE_PACKAGE')
                if destination.exists():raise KitError('GRANT_OUTPUT_EXISTS')
                ctx={'task_id':args.task_id,'worker_id':args.worker_id,'attempt':args.attempt,'idempotency_key':args.idempotency_key}
                result=journal.issue_grant(ctx,args.callback_target,args.authorization,ttl=args.ttl)
                destination.parent.mkdir(parents=True,exist_ok=True)
                with destination.open('x',encoding='utf-8') as f:f.write(dumps(result)+'\n')
                result={'grant_id':result['body']['grant_id'],'identity':ctx,'expires_at':result['body']['expires_at'],
                    'grant_file':str(destination),'signature_printed':False}
            elif args.command=='journal-status':result={'intents':journal.pending(),'network_requests':0}
            elif args.command=='mcp':
                from mcp_server import serve
                serve(journal,load_key(),args.grant);return 0
            else:
                adapter=Adapter(journal,Api(load_key()))
                if args.command=='auth-health':result=adapter.auth()
                elif args.command=='credits':result=adapter.resource()
                elif args.command=='read':result=adapter.read(grant_from_file(args.grant),reconcile=True)
                elif args.command=='create':result=adapter.create(grant_from_file(args.grant),args.prompt)
                elif args.command=='resume':result=adapter.resume(grant_from_file(args.grant),args.prompt,args.command_key,args.reason)
                else:result=adapter.stop(grant_from_file(args.grant),args.command_key)
        print(dumps(result));return 0
    except KitError as e:print(dumps({'status':'FAIL_OR_BLOCKED','error':e.code}));return 1
    except (OSError,ValueError,KeyError,TypeError,sqlite3.Error):
        print(dumps({'status':'FAIL_OR_BLOCKED','error':'LOCAL_INPUT_OR_STATE_REJECTED'}));return 1
    finally:
        if journal:journal.close()

if __name__=='__main__':raise SystemExit(main())
