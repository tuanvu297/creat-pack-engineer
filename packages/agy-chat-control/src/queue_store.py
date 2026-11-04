"""Host-local durable queue. No automatic replay of accepted/uncertain actions."""
import hashlib,hmac,json,math,os,re,secrets,sqlite3,threading,time,uuid
from pathlib import Path

VERSION='0.2.0'
ACTIVE={'CLAIMED','ACKED','RUNNING','CHECKPOINT'}
TOKEN=re.compile(r'^[A-Za-z0-9_.:-]{1,180}$')

class Denied(RuntimeError):pass
def loads(raw):
 def pairs(items):
  d={}
  for k,v in items:
   if k in d:raise Denied('DUPLICATE_JSON_KEY')
   d[k]=v
  return d
 def constant(s):raise Denied('NONFINITE_JSON')
 return json.loads(raw,object_pairs_hook=pairs,parse_constant=constant)
def dump(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False)
def digest(value):return hashlib.sha256(dump(value).encode()).hexdigest()
def token(s):
 if not isinstance(s,str) or not TOKEN.fullmatch(s):raise Denied('IDENTITY_DENIED')
 return s

class Store:
 def __init__(self,path,now=time.time):
  self.root=Path(path).resolve();self.root.mkdir(parents=True,exist_ok=True);self.now=now;self.lock=threading.RLock()
  self.db=sqlite3.connect(self.root/'queue.sqlite',timeout=10,isolation_level=None,check_same_thread=False);self.db.row_factory=sqlite3.Row
  self.db.execute('PRAGMA journal_mode=WAL');self.db.execute('PRAGMA synchronous=FULL');self.db.execute('PRAGMA busy_timeout=10000')
  self.db.executescript('''CREATE TABLE IF NOT EXISTS missions(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL,
   payload TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL,
   worker TEXT, instance TEXT, grant TEXT, heartbeat REAL, owner_expiry REAL NOT NULL, ack TEXT,
   turn_id TEXT, result TEXT, callback_id TEXT, delivery TEXT, acceptance TEXT, fault TEXT,
   created REAL NOT NULL, updated REAL NOT NULL);
   CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,mission TEXT NOT NULL,kind TEXT NOT NULL,actor TEXT NOT NULL,data TEXT NOT NULL,ts REAL NOT NULL);
   CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,mission TEXT NOT NULL,kind TEXT NOT NULL,hash TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,body TEXT NOT NULL,signature TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS observations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,status TEXT NOT NULL);''')
  if 'payload' not in {r['name'] for r in self.db.execute('PRAGMA table_info(intents)')}:
   self.db.execute('ALTER TABLE intents ADD COLUMN payload TEXT')
   self.db.execute('PRAGMA user_version=2')
  p=self.root/'host-authority.key'
  if not p.exists():
   try:
    fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(fd,'wb') as f:f.write(secrets.token_bytes(32))
   except FileExistsError:pass
  self.key=p.read_bytes()
 def close(self):self.db.close()
 def atomic(self,operation):
  with self.lock:
   self.db.execute('BEGIN IMMEDIATE')
   try:value=operation();self.db.execute('COMMIT');return value
   except BaseException:self.db.execute('ROLLBACK');raise
 def event(self,mission,kind,actor,data):
  with self.lock:self.db.execute('INSERT INTO events(mission,kind,actor,data,ts) VALUES(?,?,?,?,?)',(mission,kind,actor,dump(data),self.now()))
 def row(self,mission):
  r=self.db.execute('SELECT * FROM missions WHERE id=?',(mission,)).fetchone()
  if not r:raise Denied('MISSION_NOT_FOUND')
  return r
 def submit(self,payload,authorization,source):
  from text_contract import KINDS,validate
  text_task=isinstance(payload,dict)and isinstance(payload.get('task_kind'),str)and payload['task_kind']in KINDS
  expected={'mission_id','task_id','target_executor','attempt','idempotency_key','nonce','a','b','owner_scope_ref','callback_target','QA_CONTRACT_VERSION','task_kind'}
  if text_task:validate(payload,Denied)
  elif not isinstance(payload,dict) or set(payload)!=expected:raise Denied('MISSION_SCHEMA_DENIED')
  for k in ['mission_id','task_id','target_executor','idempotency_key']+([]if text_task else['nonce']):token(payload[k])
  if type(payload['attempt']) is not int or payload['attempt']!=1:raise Denied('ATTEMPT_DENIED')
  if payload['QA_CONTRACT_VERSION']!='1.1' or(not text_task and payload['task_kind']!='codex_nonce_sum'):raise Denied('SCOPE_NOT_IMPLEMENTED')
  if not text_task and any(type(payload[k]) is not int or not -10000<=payload[k]<=10000 for k in ['a','b']):raise Denied('INPUT_DENIED')
  expiry=authorization.get('expires_at')
  if type(expiry) not in {int,float} or not math.isfinite(expiry) or self.now()>=expiry:raise Denied('OWNER_SCOPE_EXPIRED')
  bound=digest(payload)==authorization.get('payload_sha256')
  if authorization.get('mode')=='BOUNDED_SUPPLIED_TEXT':
   prefix=authorization.get('mission_prefix');kinds=authorization.get('allowed_kinds')
   if not isinstance(prefix,str)or len(prefix)<9 or not TOKEN.fullmatch(prefix)or not isinstance(kinds,list)or not kinds or any(not isinstance(k,str)or k not in KINDS for k in kinds):raise Denied('TEXT_POLICY_SCHEMA_DENIED')
   if any(not isinstance(authorization.get(k),str)or not TOKEN.fullmatch(authorization[k])for k in ['target_executor','callback_target','owner_scope_ref']):raise Denied('TEXT_POLICY_BINDING_REQUIRED')
   bound=text_task and payload['task_kind']in kinds and payload['target_executor']==authorization.get('target_executor')and payload['callback_target']==authorization.get('callback_target')and payload['mission_id'].startswith(prefix)
  if authorization.get('mode')=='BOUNDED_OWNER_UX_NONCE_SUM':
   binding=authorization.get('binding')
   bound=isinstance(binding,dict) and set(binding)==expected-{'nonce','a','b'} and all(payload[k]==v for k,v in binding.items())
  if not bound or payload['owner_scope_ref']!=authorization.get('owner_scope_ref'):raise Denied('OWNER_AUTHORIZATION_BINDING_DENIED')
  login=authorization.get('github_login')
  if not isinstance(login,str) or not login or not isinstance(source,dict) or not isinstance(source.get('verified_login'),str) or not source['verified_login'] or source['verified_login']!=login or type(source.get('comment_id'))is not int or source['comment_id']<=0:raise Denied('AUTHENTICATED_INGRESS_REQUIRED')
  def op():
   if self.now()>=expiry:raise Denied('OWNER_SCOPE_EXPIRED')
   old=self.db.execute('SELECT * FROM missions WHERE id=? OR idem=?',(payload['mission_id'],payload['idempotency_key'])).fetchone()
   if old:
    if old['hash']!=digest(payload):raise Denied('IDEMPOTENCY_PAYLOAD_CONFLICT')
    return {'mission_id':old['id'],'status':old['status'],'cached':True}
   if authorization.get('mode')=='BOUNDED_SUPPLIED_TEXT':
    cap=authorization.get('max_missions');count=self.db.execute('SELECT count(*) FROM missions').fetchone()[0]
    if type(cap)is not int or not 1<=cap<=50 or count>=cap:raise Denied('TASK_SCOPED_MISSION_LIMIT')
   now=self.now();self.db.execute('INSERT INTO missions(id,idem,payload,hash,status,attempt,owner_expiry,created,updated) VALUES(?,?,?,?,?,?,?,?,?)',
    (payload['mission_id'],payload['idempotency_key'],dump(payload),digest(payload),'QUEUED',1,expiry,now,now))
   self.event(payload['mission_id'],'QUEUED','AGY-CONTROL-INGRESS',source)
   return {'mission_id':payload['mission_id'],'status':'QUEUED','cached':False}
  return self.atomic(op)
 def claim(self,mission,worker,instance,ttl=45):
  token(worker);token(instance)
  if type(ttl) not in {int,float} or not math.isfinite(ttl) or not 10<=ttl<=120:raise Denied('LEASE_TTL_DENIED')
  def op():
   r=self.row(mission);payload=loads(r['payload'])
   if r['status']!='QUEUED':raise Denied('CLAIM_STATE_DENIED_NO_REPLAY')
   if payload['target_executor']!=worker or self.now()>=r['owner_expiry']:raise Denied('WORKER_OR_OWNER_SCOPE_DENIED')
   body={'grant_id':'G-'+uuid.uuid4().hex,'mission_id':mission,'task_id':payload['task_id'],'worker_id':worker,'instance_id':instance,
    'attempt':r['attempt'],'idempotency_key':r['idem'],'issued_at':self.now(),'expires_at':min(self.now()+ttl,r['owner_expiry']),
    'callback_target':payload['callback_target'],'scope':[payload['task_kind'],'read_own_status','checkpoint','callback'],'ttl':ttl}
   self._save_grant(body);self.db.execute('UPDATE missions SET status=?,worker=?,instance=?,grant=?,heartbeat=?,updated=? WHERE id=?',
    ('CLAIMED',worker,instance,body['grant_id'],self.now(),self.now(),mission))
   self.event(mission,'CLAIMED',worker,{'instance_id':instance,'grant_id':body['grant_id'],'lease_expires_at':body['expires_at']})
   return self.envelope(body)
  return self.atomic(op)
 def envelope(self,body):return {'body':body,'signature':hmac.new(self.key,dump(body).encode(),hashlib.sha256).hexdigest()}
 def _save_grant(self,body):
  env=self.envelope(body);self.db.execute('INSERT INTO grants VALUES(?,?,?)',(body['grant_id'],dump(body),env['signature']))
 def assert_grant(self,env):
  if not isinstance(env,dict) or set(env)!={'body','signature'}:raise Denied('GRANT_SCHEMA_DENIED')
  b=env['body'];known=self.db.execute('SELECT * FROM grants WHERE id=?',(b.get('grant_id'),)).fetchone()
  if not known or known['body']!=dump(b) or not isinstance(env['signature'],str) or not hmac.compare_digest(self.envelope(b)['signature'],env['signature']):raise Denied('GRANT_SIGNATURE_DENIED')
  r=self.row(b['mission_id'])
  if r['worker']!=b['worker_id'] or r['instance']!=b['instance_id'] or r['grant']!=b['grant_id']:raise Denied('GRANT_FENCED')
  if self.now()>=b['expires_at'] or self.now()>=r['owner_expiry']:raise Denied('GRANT_EXPIRED')
  if r['status'] not in ACTIVE:raise Denied('EXECUTOR_STATE_DENIED')
  return b,r
 def ack(self,env,receipt):
  def op():
   b,r=self.assert_grant(env)
   if r['status']!='CLAIMED':raise Denied('ACK_STATE_DENIED')
   if not isinstance(receipt,dict) or receipt.get('transport_status')!='RECEIVED_BY_EXECUTOR' or type(receipt.get('pid')) is not int or receipt['pid']<=0 or receipt.get('instance_id')!=b['instance_id']:raise Denied('ACTUAL_EXECUTOR_RECEIPT_REQUIRED')
   ack={k:b[k] for k in ['mission_id','task_id','worker_id','instance_id','attempt','idempotency_key','grant_id','issued_at','expires_at','callback_target']}
   ack.update({'lease_id':b['grant_id'],'timestamp':self.now(),'executor_receipt':receipt})
   self.db.execute('UPDATE missions SET status=?,ack=?,updated=? WHERE id=?',('ACKED',dump(ack),self.now(),b['mission_id']))
   self.event(b['mission_id'],'ACKED',b['worker_id'],ack);return ack
  return self.atomic(op)
 def heartbeat(self,env):
  def op():
   b,r=self.assert_grant(env);self.db.execute('UPDATE missions SET heartbeat=?,updated=? WHERE id=?',(self.now(),self.now(),b['mission_id']))
   if self.now()+15>=b['expires_at']:
    fresh={**b,'grant_id':'G-'+uuid.uuid4().hex,'issued_at':self.now(),'expires_at':min(self.now()+b['ttl'],r['owner_expiry'])}
    self._save_grant(fresh);self.db.execute('UPDATE missions SET grant=? WHERE id=?',(fresh['grant_id'],b['mission_id']))
    self.event(b['mission_id'],'LEASE_RENEWED',b['worker_id'],{k:fresh[k] for k in ['grant_id','issued_at','expires_at']});return self.envelope(fresh)
   return env
  return self.atomic(op)
 def checkpoint(self,env,phase,evidence):
  order=['PLAN','RUNNING','CHECKPOINT']
  def op():
   b,r=self.assert_grant(env)
   if not r['ack']:raise Denied('ACK_REQUIRED_BEFORE_PLAN')
   if not isinstance(evidence,dict) or not evidence.get('evidence_id'):raise Denied('CHECKPOINT_EVIDENCE_REQUIRED')
   events=self.db.execute("SELECT data FROM events WHERE mission=? AND kind='PHASE' ORDER BY seq",(b['mission_id'],)).fetchall()
   previous=[loads(e['data'])['phase'] for e in events]
   if phase not in order or previous!=order[:order.index(phase)]:raise Denied('CHECKPOINT_ORDER_DENIED')
   status='ACKED' if phase=='PLAN' else phase
   self.db.execute('UPDATE missions SET status=?,heartbeat=?,updated=? WHERE id=?',(status,self.now(),self.now(),b['mission_id']))
   self.event(b['mission_id'],'PHASE',b['worker_id'],{'phase':phase,**evidence});return {'phase':phase,'status':status}
  return self.atomic(op)
 def reserve(self,mission,kind,payload):
  identifier=mission+':'+kind
  def op():
   old=self.db.execute('SELECT * FROM intents WHERE id=?',(identifier,)).fetchone()
   if old:
    if old['hash']!=digest(payload):raise Denied('INTENT_CONFLICT')
    if old['state']!='ACKED':raise Denied('UNCERTAIN_INTENT_NO_BLIND_RETRY')
    return loads(old['receipt'])
   self.db.execute('INSERT INTO intents(id,mission,kind,hash,state,receipt,payload) VALUES(?,?,?,?,?,NULL,?)',(identifier,mission,kind,digest(payload),'PENDING',dump(payload)))
   self.event(mission,'INTENT_RESERVED','HOST',{'kind':kind,'payload_sha256':digest(payload)});return None
  return self.atomic(op)
 def receipt(self,mission,kind,value):
  def op():
   if self.db.execute('UPDATE intents SET state=?,receipt=? WHERE id=?',('ACKED',dump(value),mission+':'+kind)).rowcount!=1:raise Denied('INTENT_REQUIRED_FOR_RECEIPT')
   self.event(mission,'INTENT_ACK','HOST',{'kind':kind,'receipt':value})
  self.atomic(op)
 def turn_started(self,env,turn_id):
  def op():
   b,r=self.assert_grant(env);token(turn_id)
   self.db.execute('UPDATE missions SET turn_id=?,updated=? WHERE id=?',(turn_id,self.now(),b['mission_id']))
   self.event(b['mission_id'],'PROVIDER_TURN_ACK',b['worker_id'],{'turn_id':turn_id})
  self.atomic(op)
 def complete(self,env,result):
  def op():
   b,r=self.assert_grant(env);p=loads(r['payload'])
   if r['status']!='CHECKPOINT' or not r['turn_id']:raise Denied('REAL_EXECUTION_REQUIRED')
   text_task=p['task_kind']!='codex_nonce_sum'
   if text_task:
    from text_contract import validate_result
    validate_result(result,p['task_id'],Denied)
   elif not isinstance(result,dict) or result.get('nonce')!=p['nonce'] or type(result.get('sum'))is not int or result['sum']!=p['a']+p['b']:raise Denied('RESULT_RUBRIC_FAIL')
   self.db.execute('UPDATE missions SET result=?,updated=? WHERE id=?',(dump(result),self.now(),b['mission_id']))
   self.event(b['mission_id'],'RESULT_SCHEMA_VALIDATED_SEMANTIC_QA_PENDING'if text_task else'RESULT_VERIFIED',b['worker_id'],{'result':result,'turn_id':r['turn_id']})
  self.atomic(op)
 def delivery(self,mission,receipt,recovery=False):
  def op():
   r=self.row(mission)
   if not r['result'] or r['status'] not in ({'CHECKPOINT','UNCERTAIN'}if recovery else {'CHECKPOINT'}):raise Denied('VERIFIED_RESULT_REQUIRED')
   if not isinstance(receipt,dict) or type(receipt.get('comment_id'))is not int or receipt['comment_id']<=0 or receipt.get('readback_match')is not True:raise Denied('CALLBACK_READBACK_REQUIRED')
   if recovery:
    intent=self.db.execute('SELECT payload FROM intents WHERE id=?',(mission+':CALLBACK_POST',)).fetchone()
    if not intent or not intent['payload'] or receipt.get('payload_sha256')!=digest(loads(intent['payload'])):raise Denied('EXACT_PERSISTED_CALLBACK_RECONCILIATION_REQUIRED')
   self.db.execute('UPDATE missions SET status=?,delivery=?,updated=? WHERE id=?',('CALLBACK_DELIVERED',dump(receipt),self.now(),mission))
   self.event(mission,'CALLBACK_DELIVERED','CALLBACK-ADAPTER',receipt)
  self.atomic(op)
 def acceptance(self,mission,record,source):
  def op():
   r=self.row(mission)
   if r['status']!='CALLBACK_DELIVERED':raise Denied('DELIVERY_REQUIRED_BEFORE_ACCEPTANCE')
   criteria=['AC'+str(i).zfill(2) for i in range(1,11)]
   if record.get('reviewer_id')!='AGY-ASSISTANT-CONTROL' or record.get('status')!='VERIFIED_PASS_SCOPED' or record.get('callback_comment_id')!=loads(r['delivery'])['comment_id'] or record.get('result_sha256')!=digest(loads(r['result'])) or record.get('QA_CONTRACT_VERSION')!='1.1' or record.get('acceptance_criteria_ids')!=criteria or not record.get('evidence_ids'):raise Denied('INDEPENDENT_ACCEPTANCE_CONTRACT_DENIED')
   if source.get('verified_login')!='tuanvu297' or not source.get('comment_id'):raise Denied('AUTHENTICATED_REVIEW_RECEIPT_REQUIRED')
   self.db.execute('UPDATE missions SET status=?,acceptance=?,updated=? WHERE id=?',('AGY_REVIEW_REPORTED',dump({'record':record,'source':source}),self.now(),mission))
   self.event(mission,'AGY_REVIEW_REPORTED','AGY-ASSISTANT-CONTROL',{'record':record,'source':source,'native_receipt':'UNVERIFIED'})
  self.atomic(op)
 def confirm_native_acceptance(self,mission,receipt):
  def op():
   r=self.row(mission)
   if r['status']!='AGY_REVIEW_REPORTED':raise Denied('REVIEW_REPORT_REQUIRED')
   if not isinstance(receipt,dict) or receipt.get('verification_method')!='mcp__codex_app.read_thread' or receipt.get('target_chat_id')!='6acb1ce3-e37c-83ec-9eb7-f795fd5243c1' or not receipt.get('reviewer_message_id') or not receipt.get('native_turn_id') or receipt.get('status')!='PASS_SCOPED' or receipt.get('result_sha256')!=digest(loads(r['result'])):raise Denied('ACTUAL_NATIVE_INDEPENDENT_READBACK_REQUIRED')
   record=loads(r['acceptance']);record['native_readback']=receipt
   self.db.execute('UPDATE missions SET status=?,acceptance=?,updated=? WHERE id=?',('AGY_ACCEPTED',dump(record),self.now(),mission));self.event(mission,'AGY_ACCEPTED','TRUSTED-HOST-NATIVE-RECEIPT-VERIFIER',receipt)
  self.atomic(op)
 def fail(self,mission,code,status='BLOCKED'):
  if status not in {'BLOCKED','STALE','VERIFIED_FAIL','EXTERNAL_LIMIT','UNCERTAIN'}:raise Denied('FAIL_STATUS_DENIED')
  def op():
   r=self.row(mission)
   if r['status'] in {'AGY_ACCEPTED','CALLBACK_DELIVERED'}:raise Denied('ACCEPTED_STATE_IMMUTABLE')
   self.db.execute('UPDATE missions SET status=?,fault=?,updated=? WHERE id=?',(status,dump({'code':code}),self.now(),mission))
   self.event(mission,status,'HOST',{'code':code})
  self.atomic(op)
 def fail_queued(self,mission,code):
  def op():
   r=self.row(mission)
   if r['status']!='QUEUED':return False
   self.db.execute('UPDATE missions SET status=?,fault=?,updated=? WHERE id=?',('EXTERNAL_LIMIT',dump({'code':code}),self.now(),mission));self.event(mission,'EXTERNAL_LIMIT','HOST',{'code':code});return True
  return self.atomic(op)
 def sweep(self,stale_after=15):
  with self.lock:
   for r in self.db.execute('SELECT * FROM missions').fetchall():
    if r['status'] in ACTIVE:
     g=self.db.execute('SELECT body FROM grants WHERE id=?',(r['grant'],)).fetchone()
     expiry=loads(g['body'])['expires_at'] if g else 0
     if self.now()-r['heartbeat']>stale_after or self.now()>=expiry:self.fail(r['id'],'HEARTBEAT_OR_GRANT_STALE','STALE')
 def recovery(self):
  with self.lock:
   for r in self.db.execute('SELECT * FROM missions').fetchall():
    if r['status'] in ACTIVE:self.fail(r['id'],'DAEMON_RESTART_RECONCILE_REQUIRED_NO_REPLAY','UNCERTAIN')
 def status(self,mission=None):
  with self.lock:
   rows=[self.row(mission)] if mission else self.db.execute('SELECT * FROM missions ORDER BY created').fetchall()
   result=[]
   for r in rows:
    events=[{'seq':e['seq'],'kind':e['kind'],'actor':e['actor'],'data':loads(e['data']),'timestamp':e['ts']} for e in self.db.execute('SELECT * FROM events WHERE mission=? ORDER BY seq',(r['id'],))]
    result.append({'mission_id':r['id'],'status':r['status'],'payload_sha256':r['hash'],'worker_id':r['worker'],'instance_id':r['instance'],'grant_id':r['grant'],'heartbeat':r['heartbeat'],
     'ACK':loads(r['ack']) if r['ack'] else None,'turn_id':r['turn_id'],'result':loads(r['result']) if r['result'] else None,
     'callback_delivery':loads(r['delivery']) if r['delivery'] else None,'AGY_acceptance':loads(r['acceptance']) if r['acceptance'] else None,'fault':loads(r['fault']) if r['fault'] else None,'events':events})
   return result[0] if mission else result
