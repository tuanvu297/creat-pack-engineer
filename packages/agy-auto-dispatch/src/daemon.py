import argparse,hashlib,http.server,json,os,secrets,sys,threading,time,uuid
from pathlib import Path
from appserver_client import AppServer
from queue_store import Store,Denied,digest,dump,loads

WORKER='AGY-PRIMARY-PERSISTENT'

class HostLock:
 def __init__(self,path):
  self.file=open(path,'a+b');self.file.seek(0)
  if os.name=='nt':
   import msvcrt
   self.file.write(b'0');self.file.flush();self.file.seek(0);msvcrt.locking(self.file.fileno(),msvcrt.LK_NBLCK,1)
  else:
   import fcntl
   fcntl.flock(self.file.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
 def close(self):self.file.close()

def parse_comment(comment,prefix):
 body=comment.get('body','')
 if not isinstance(body,str) or not body.startswith(prefix+'\n') or len(body)>24000:return None
 try:value=loads(body[len(prefix)+1:])
 except (ValueError,Denied):return None
 return value if isinstance(value,dict) else None

class Daemon:
 def __init__(self,state,config):
  self.root=Path(state).resolve();self.root.mkdir(parents=True,exist_ok=True)
  if Path(__file__).resolve().parents[1]in self.root.parents or self.root==Path(__file__).resolve().parents[1]:raise Denied('PRIVATE_STATE_OUTSIDE_PACKAGE_REQUIRED')
  self.host_lock=HostLock(self.root/'daemon.lock');self.store=Store(self.root);self.store.recovery();self.config=config;self.snapshot_lock=threading.RLock()
  self.instance='INSTANCE-'+uuid.uuid4().hex;self.stop=threading.Event();self.app=None;self.last_poll=None;self.poll_error=None
  self.binding={'logical_worker_id':WORKER,'instance_id':self.instance,'pid':os.getpid(),'primary_monitor_thread':config['primary_monitor_thread'],
   'native_thread_activation':'NOT_CLAIMED_ACTIVE_WRITER_LOCK','provider_context':'EPHEMERAL_NO_STORED_WORK','started_at':time.time(),'transport':'app-server JSON-RPC stdio','store':str(self.root/'queue.sqlite')}
  (self.root/'binding.json').write_text(dump(self.binding)+'\n',encoding='utf-8')
 def snapshot(self):
  with self.snapshot_lock:
   status={'binding':self.binding,'daemon_alive':not self.stop.is_set(),'last_ingress_poll':self.last_poll,'ingress_error':self.poll_error,'missions':self.store.status()}
   p=self.root/('status-'+uuid.uuid4().hex+'.tmp');p.write_text(json.dumps(status,indent=2)+'\n',encoding='utf-8')
   try:p.replace(self.root/'status.json')
   except PermissionError:self.poll_error='STATUS_FILE_TEMPORARILY_LOCKED_DB_REMAINS_AUTHORITATIVE'
   return status
 def watcher(self):
  while not self.stop.wait(1):
   try:self.store.sweep();self.snapshot()
   except Exception:self.poll_error='WATCHER_ERROR_UNVERIFIED'
 def serve(self):
  outer=self
  class Handler(http.server.BaseHTTPRequestHandler):
   def do_GET(self):
    if self.path not in {'/','/status','/health'}:self.send_error(404);return
    raw=(json.dumps(outer.snapshot(),indent=2)+'\n').encode()
    self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(raw)
   def log_message(self,*args):pass
  self.http=http.server.ThreadingHTTPServer(('127.0.0.1',self.config['status_port']),Handler)
  threading.Thread(target=self.http.serve_forever,daemon=True).start()
 def process_ingress(self,comments):
  with self.store.lock:self._process_ingress(comments)
 def _process_ingress(self,comments):
  self.reconcile_callbacks(comments)
  owner_ux_policy=self.config.get('owner_ux_authorization')or{}
  owner_ux_id=(owner_ux_policy.get('binding')or{}).get('mission_id')
  if not isinstance(owner_ux_id,str)or not owner_ux_id:owner_ux_id=None
  for c in comments:
   source={'comment_id':c.get('id'),'url':c.get('url'),'verified_login':(c.get('user')or{}).get('login')}
   payload=parse_comment(c,'AGY_MISSION_V1')
   if payload:
    existing=self.store.db.execute('SELECT * FROM observations WHERE id=?',(str(c.get('id')),)).fetchone()
    if existing:
     if existing['hash']!=digest(payload):self.poll_error='PROCESSED_MISSION_COMMENT_EDITED_NO_REPLAY'
     continue
    authorization=self.config['authorization']
    if owner_ux_id and payload.get('mission_id')==owner_ux_id:authorization=owner_ux_policy
    try:self.store.submit(payload,authorization,source);status='ACCEPTED'
    except Denied as e:status=str(e)
    self.store.db.execute('INSERT OR IGNORE INTO observations VALUES(?,?,?)',(str(c.get('id')),digest(payload),status))
   review=parse_comment(c,'AGY_ACCEPTANCE_V1')
   review_missions={self.config['mission']['mission_id']}
   if owner_ux_id:review_missions.add(owner_ux_id)
   if review and isinstance(review.get('mission_id'),str)and review['mission_id']in review_missions:
    try:
     current=self.store.status(review['mission_id'])
     if current['status']=='CALLBACK_DELIVERED':self.store.acceptance(review['mission_id'],review,source)
    except Denied as e:self.poll_error='REVIEW_'+str(e)
 def reconcile_callbacks(self,comments):
  for row in self.store.db.execute("SELECT m.id,i.payload FROM missions m JOIN intents i ON i.mission=m.id WHERE m.status='UNCERTAIN' AND m.result IS NOT NULL AND i.kind='CALLBACK_POST'").fetchall():
   if not row['payload']:continue
   expected=loads(row['payload']);matches=[c for c in comments if (c.get('user')or{}).get('login')==self.config['authorization']['github_login'] and parse_comment(c,'AGY_CALLBACK_V1')==expected]
   if len(matches)==1:
    c=matches[0];self.store.receipt(row['id'],'CALLBACK_POST',{'comment_id':c['id'],'callback_id':expected['callback_id'],'reconciled_read_only':True})
    self.store.delivery(row['id'],{'comment_id':c['id'],'url':c['url'],'readback_match':True,'payload_sha256':digest(expected),'reconciled_read_only':True},recovery=True)
   elif len(matches)>1:self.poll_error='AMBIGUOUS_CALLBACK_READBACK_NO_REPLAY'
 def execute(self,mission):
  try:env=self.store.claim(mission,WORKER,self.instance)
  except Denied as e:
   self.store.fail_queued(mission,str(e));return
  last_hb=[0.0]
  def beat():
   nonlocal env
   self.store.assert_grant(env)
   if time.monotonic()-last_hb[0]>=2:
    if self.app.p.poll()is not None:raise Denied('APPSERVER_PROCESS_EXITED')
    env=self.store.heartbeat(env);last_hb[0]=time.monotonic();self.snapshot()
  try:
   self.store.ack(env,{'transport_status':'RECEIVED_BY_EXECUTOR','pid':os.getpid(),'instance_id':self.instance,'app_server_pid':self.app.p.pid,'ephemeral_context_id':self.app.thread})
   self.store.checkpoint(env,'PLAN',{'evidence_id':'ACK-'+env['body']['grant_id']})
   payload=loads(self.store.row(mission)['payload']);self.store.checkpoint(env,'RUNNING',{'evidence_id':'EXECUTOR-'+self.instance})
   rates=self.app.rpc('account/rateLimits/read',{},heartbeat=beat)
   rate=rates.get('rateLimits',{});windows=[rate.get('primary'),rate.get('secondary')]
   if not windows or not any(isinstance(w,dict)for w in windows):raise Denied('RESOURCE_TELEMETRY_UNVERIFIED')
   if any(isinstance(w,dict)and w.get('usedPercent',100)>=95 for w in windows):raise Denied('RESOURCE_RESERVE_EXHAUSTED')
   self.store.event(mission,'RESOURCE_READBACK',WORKER,{'account_type':'chatgpt','model':self.app.model,'primary':rate.get('primary'),'secondary':rate.get('secondary'),'monetary_cost':'UNKNOWN','included_route_only':True})
   if self.store.reserve(mission,'MODEL_TURN',payload)is not None:raise Denied('MODEL_ALREADY_DISPATCHED_NO_REPLAY')
   turn_id=self.app.start_turn(payload,beat);self.store.receipt(mission,'MODEL_TURN',{'turn_id':turn_id,'context_id':self.app.thread})
   self.store.turn_started(env,turn_id)
   result,proof=self.app.result(turn_id,beat,timeout=self.config.get('turn_timeout',120))
   self.store.checkpoint(env,'CHECKPOINT',{'evidence_id':'TURN-'+turn_id,'provider':proof})
   self.store.complete(env,result);beat();self.deliver(mission,beat)
  except Exception as e:
   code=str(e) if isinstance(e,Denied)else type(e).__name__
   has_intent=self.store.db.execute('SELECT 1 FROM intents WHERE mission=? AND kind=?',(mission,'MODEL_TURN')).fetchone()
   status='UNCERTAIN' if has_intent else 'EXTERNAL_LIMIT'
   try:self.store.fail(mission,code,status)
   except Denied:pass
   self.poll_error=code;self.snapshot()
 def callback_body(self,mission):
  r=self.store.status(mission)
  owner_ux=mission==self.config.get('owner_ux_authorization',{}).get('binding',{}).get('mission_id')
  return {'callback_id':'CB-'+mission,'mission_id':mission,'worker_id':WORKER,'status':'RESULT_VERIFIED','result':r['result'],
   'result_sha256':digest(r['result']),'ACK':r['ACK'],'turn_id':r['turn_id'],'source_snapshot_sha256':self.config['source_snapshot_sha256'],
   'events':r['events'],'callback_target':self.config['mission']['callback_target'],
   'claim_scope':'Logical daemon executor; ephemeral provider context; existing Work monitor; not exact desktop thread activation',
   'trigger_provenance':('FRESH_OWNER_UX_REQUEST_REPORTED_BY_CONTROL; native actual human input remains verification gate' if owner_ux else 'Owner-authorized engineer-delegated bounded control-chat pilot; not a separately observed human control-chat message'),
   'AGY_acceptance':'UNVERIFIED_AWAITING_SEPARATE_REVIEW','new_stored_Work':0,'model_turns':1,'mutation_retries':0}
 def deliver(self,mission,beat):
  payload=self.callback_body(mission);body='AGY_CALLBACK_V1\n'+dump(payload)
  old=self.store.reserve(mission,'CALLBACK_POST',payload)
  if old:comment_id=old['comment_id']
  else:
   result=self.app.github('github.add_comment_to_issue',{'repo_full_name':'tuanvu297/creat-pack-engineer','pr_number':2,'comment':body},heartbeat=beat)
   comment_id=result.get('id')
   if not comment_id:raise Denied('CALLBACK_POST_ACK_UNVERIFIED')
   self.store.receipt(mission,'CALLBACK_POST',{'comment_id':comment_id,'callback_id':payload['callback_id']})
  comments=self.app.comments(heartbeat=beat);matches=[c for c in comments if parse_comment(c,'AGY_CALLBACK_V1')==payload]
  if len(matches)!=1 or matches[0]['id']!=comment_id:raise Denied('CALLBACK_EXACT_READBACK_UNVERIFIED')
  self.store.delivery(mission,{'comment_id':comment_id,'url':matches[0]['url'],'callback_id':payload['callback_id'],'readback_match':True,'destination':'GitHub issue2; AGY control-chat ingestion/acceptance separate'})
 def run(self):
  try:
   self.app=AppServer(self.config['codex_binary'],str(Path(__file__).resolve().parents[1]));self.binding['app_server_pid']=self.app.p.pid;self.binding['provider_context_id']=self.app.thread
   self.serve();threading.Thread(target=self.watcher,daemon=True).start();self.snapshot()
   while not self.stop.is_set() and not (self.root/'STOP').exists():
    try:
     comments=self.app.comments();self.last_poll=time.time();self.poll_error=None;self.process_ingress(comments)
     with self.store.lock:queued=self.store.db.execute("SELECT id FROM missions WHERE status='QUEUED' ORDER BY created").fetchall()
     for r in queued:self.execute(r['id'])
    except Exception as e:self.poll_error=str(e) if isinstance(e,Denied)else type(e).__name__
    self.snapshot();self.stop.wait(self.config.get('poll_seconds',8))
  finally:
   self.stop.set()
   if self.app:self.app.close()
   if hasattr(self,'http'):self.http.shutdown()
   self.snapshot();self.store.close();self.host_lock.close()

def main():
 p=argparse.ArgumentParser();p.add_argument('--state',required=True);p.add_argument('--config',required=True);a=p.parse_args()
 config=loads(Path(a.config).read_text(encoding='utf-8'));Daemon(a.state,config).run()
if __name__=='__main__':main()
