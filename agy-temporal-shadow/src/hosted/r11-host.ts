import {createServer,type Server} from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {TemporalBridge} from '../temporal/bridge.js';
import type {Mission,Binding,WorkerReceipt} from '../temporal/contracts.js';
import {digest} from '../gateway-shadow/journal.js';

export const isNative=(m:Mission)=>['CODEX_ENGINEERING_COMMAND','R11_HOSTED_ENGINEERING'].includes(m.executor_worker_id);
export const r11Context={gateway:'http://127.0.0.1:8799',worker:'R11-HOSTED',endpoint:'http://127.0.0.1:8800',capabilities:['code']};
const root='/data/r11-hosted';
let server:Server|undefined;
const token=randomBytes(32).toString('hex');
let active:{bridge:TemporalBridge;m:Mission;b:Binding}|undefined;
let running=false;
const hash=(v:string)=>createHash('sha256').update(v).digest();

// A bounded, private transport for the unchanged R11 journal/worker contract.
// This is backed by scoped PostgreSQL, never an in-memory queue or Supabase.
async function listen(){
 if(server)return;
 server=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  try{
   const supplied=req.headers.authorization?.replace(/^Bearer /,'')??'';
   if(!timingSafeEqual(hash(supplied),hash(token)))throw new Error('UNAUTHORIZED');
   const ctx=active;if(!ctx)throw new Error('NO_ACTIVE_MISSION');
   const {bridge,m,b}=ctx;
   if(req.method==='GET'&&req.url==='/health'){
    await bridge.project(m);
    res.end(JSON.stringify({gateway:'PASS',canonical_authority:'EXISTING_POSTGRES_D049',state_plane:{status:'PASS',mode:'SHADOW_STAGING',canonical_authority:'EXISTING_POSTGRES_D049'}}));return;
   }
   if(req.method!=='POST')throw new Error('POST_REQUIRED');
   let bytes=0;const chunks:Buffer[]=[];
   for await(const c of req){bytes+=c.length;if(bytes>65536)throw new Error('REQUEST_TOO_LARGE');chunks.push(Buffer.from(c));}
   const p=JSON.parse(Buffer.concat(chunks).toString());
   const response=await bridge.tx(m,async c=>{
    const row=(await c.query('SELECT document FROM agy_hosted_r11 WHERE workflow_id=$1 FOR UPDATE',[b.workflow_id])).rows[0];
    if(!row)throw new Error('R11_TASK_MISSING');
    const d=row.document;
    const save=async(path:string,result:any)=>{
     d.events.push({path,at:new Date().toISOString(),status:result.status});
     await c.query('UPDATE agy_hosted_r11 SET document=$2 WHERE workflow_id=$1',[b.workflow_id,d]);return result;
    };
    if(req.url==='/workers/register'){
     if(p.worker_id!==r11Context.worker||p.provider!=='R11')throw new Error('WORKER_IDENTITY_DENIED');
     d.registered=true;return save(req.url,{status:'PASS',worker_id:p.worker_id,health:'ONLINE'});
    }
    if(req.url==='/tasks/claim'){
     if(req.headers['x-agy-worker-id']!==r11Context.worker||!d.registered)throw new Error('WORKER_IDENTITY_DENIED');
     if(d.stage!=='QUEUED')return {status:'EMPTY'};
     const t=(await c.query('SELECT lease_token,attempt,status FROM agy_tasks WHERE task_id=$1 FOR UPDATE',[b.db_task_id])).rows[0];
     if(!t||t.lease_token!==b.lease_token||t.attempt!==b.lease_attempt||t.status!=='RUNNING')throw new Error('TASK_FENCE_DENIED');
     d.lease={task_id:b.db_task_id,mission_id:m.mission_id,attempt_id:'ATT-'+b.workflow_id,attempt_no:1,idempotency_key:m.idempotency_key,trace_id:m.task_id,worker_id:r11Context.worker,lease_token:b.lease_token,fence:b.lease_attempt,expires_at:new Date(Date.now()+120000).toISOString(),payload:{name:'Bounded hosted source verification',taskType:'code',payload:{command:'verify_gateway_contract',operation_id:d.operation_id},risk:'LOW',estimatedCost:0,permissionGranted:true,safetyApproved:true,requiredCapabilities:['code'],requiredPermissions:['read'],timeoutSeconds:120},acceptance_criteria:{qa_contract_version:'1.1'}};
     d.stage='LEASED';return save(req.url,{status:'LEASED',...d.lease});
    }
    const lease=d.lease;
    if(!lease||['task_id','attempt_id','idempotency_key','trace_id'].some(k=>String(req.headers['x-agy-'+k.replaceAll('_','-')])!==String(lease[k])))throw new Error('TASK_IDENTITY_DENIED');
    if(req.url==='/callback'){
     if(d.stage!=='RESULT_SUBMITTED'||p.callback_status!=='PENDING'||p.callback_payload?.qa_state!=='PENDING'||p.callback_id!=='CB-'+digest([lease.task_id,lease.attempt_id,1]))throw new Error('CALLBACK_CONTRACT_DENIED');
     if(d.callback&&digest(d.callback)!==digest(p))throw new Error('CALLBACK_CONFLICT');
     d.callback=p;return save(req.url,{status:'PENDING',callback_id:p.callback_id,task_id:lease.task_id,attempt_id:lease.attempt_id});
    }
    if(['worker_id','lease_token','fence'].some(k=>String(req.headers['x-agy-'+k.replaceAll('_','-')])!==String(lease[k]))||Date.parse(lease.expires_at)<=Date.now())throw new Error('TASK_FENCE_DENIED');
    const t=(await c.query('SELECT lease_token,attempt FROM agy_tasks WHERE task_id=$1 FOR UPDATE',[b.db_task_id])).rows[0];
    if(t.lease_token!==lease.lease_token||t.attempt!==lease.fence)throw new Error('TASK_FENCE_DENIED');
    const reply={task_id:lease.task_id,attempt_id:lease.attempt_id,fence:lease.fence};
    if(req.url==='/ack'){
     if(d.stage!=='LEASED')throw new Error('ACK_STATE_DENIED');
     d.stage='ACKED';return save(req.url,{...reply,status:'ACKED'});
    }
    if(req.url==='/heartbeat'){
     if(!['ACKED','RUNNING','CHECKPOINTED'].includes(d.stage))throw new Error('HEARTBEAT_STATE_DENIED');
     lease.expires_at=new Date(Date.now()+120000).toISOString();if(d.stage==='ACKED')d.stage='RUNNING';
     await c.query("UPDATE agy_tasks SET heartbeat_at=now(),lease_expires_at=now()+interval '120 seconds' WHERE task_id=$1",[b.db_task_id]);
     return save(req.url,{...reply,status:d.stage,expires_at:lease.expires_at});
    }
    if(req.url==='/checkpoint'){
     if(!['RUNNING','CHECKPOINTED'].includes(d.stage)||![1,2].includes(p.version)||p.state?.submissionState!==(p.version===1?'INTENT':'ACCEPTED'))throw new Error('CHECKPOINT_STATE_DENIED');
     if(p.version===2&&(!d.checkpoints['1']||p.state.externalId!==d.operation_id))throw new Error('ACCEPTED_IDENTITY_DENIED');
     if(d.checkpoints[p.version]&&digest(d.checkpoints[p.version])!==digest(p.state))throw new Error('CHECKPOINT_CONFLICT');
     d.checkpoints[p.version]=p.state;d.stage='CHECKPOINTED';return save(req.url,{...reply,status:d.stage,version:p.version});
    }
    if(req.url==='/result'){
     if(d.stage!=='CHECKPOINTED'||!d.checkpoints['2']||p.result_status!=='RESULT_READY'||p.evidence?.external_operation_id!==d.operation_id||p.evidence?.qa_state!=='PENDING')throw new Error('RESULT_STATE_DENIED');
     d.result=p;d.stage='RESULT_SUBMITTED';return save(req.url,{...reply,status:d.stage,result_version:p.result_version,result_status:p.result_status,queue_archived:true});
    }
    throw new Error('UNKNOWN_ACTION');
   });
   res.end(JSON.stringify(response));
  }catch(e){const code=e instanceof Error?e.message:'REQUEST_FAILED';res.statusCode=code==='UNAUTHORIZED'?401:409;res.end(JSON.stringify({error:/^[A-Z_]+$/.test(code)?code:'REQUEST_FAILED'}));}
 });
 await new Promise<void>((ok,no)=>{server!.once('error',no);server!.listen(8799,'127.0.0.1',ok);});
}

export function executorEnv(){
 // An allowlist, not a blacklist: DB, bootstrap, identities and Supabase never enter R11.
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','LANG'].includes(k.toUpperCase())));
 return {...env,AGY_STAGE_ONLY:'true',AGY_WORKER_TRANSPORT:'GATEWAY_SHADOW',AGY_STATE_MODE:'SHADOW_STAGING',AGY_CANONICAL_AUTHORITY:'EXISTING_POSTGRES_D049',AGY_ORCHESTRATION_MODE:'LEGACY',AGY_WORKER_ID:r11Context.worker,AGY_GATEWAY_URL:r11Context.gateway,AGY_R11_CONNECTOR_URL:r11Context.endpoint,AGY_R11_CAPABILITIES_JSON:'["code"]',AGY_GATEWAY_STATE_DIR:root,AGY_GATEWAY_TOKEN:token};
}
export async function hostedR11Control(command:unknown){
 if(process.env.AGY_HOSTED_R11!=='true'||process.env.AGY_HOSTED_STAGING!=='true'||process.env.AGY_STAGE_ONLY!=='true'||!['init','inspect','resume','probe'].includes(String(command)))throw new Error('R11_CONTROL_DENIED');
 const child=spawn(process.execPath,[fileURLToPath(new URL('./r11-executor.js',import.meta.url)),String(command)],{env:executorEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',d=>output=(output+d).slice(-8192));child.stderr.on('data',d=>output=(output+d).slice(-8192));
 const timer=setTimeout(()=>child.kill('SIGTERM'),20000);
 const code=await new Promise<number|null>(ok=>{child.once('error',()=>ok(null));child.once('close',ok);});clearTimeout(timer);
 let result;try{result=JSON.parse(output.trim());}catch{throw new Error('R11_CONTROL_FAILED');}
 return {exit_code:code,...result};
}
export async function runHostedR11(bridge:TemporalBridge,m:Mission,b:Binding){
 if(process.env.AGY_HOSTED_R11!=='true'||process.env.AGY_HOSTED_STAGING!=='true'||process.env.AGY_STAGE_ONLY!=='true')return {state:'BLOCKED_ROUTE' as const};
 if(running)return {state:'BLOCKED_ROUTE' as const};
 running=true;active={bridge,m,b};
 const pool=bridge.pool(m),operation=randomUUID();
 try{
  // A conflicting preexisting native operation can only reconcile; it never spawns again.
  const inserted=await pool.query('INSERT INTO agy_temporal_native_operations(workflow_id,attempt,operation_id,request_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING operation_id',[b.workflow_id,b.attempt,operation,'r11-'+operation]);
  if(!inserted.rowCount)return {state:'UNCERTAIN' as const};
  await pool.query('INSERT INTO agy_hosted_r11(workflow_id,document) VALUES($1,$2)',[b.workflow_id,{operation_id:operation,stage:'QUEUED',events:[],checkpoints:{}}]);
  await listen();
  const child=spawn(process.execPath,[fileURLToPath(new URL('./r11-executor.js',import.meta.url))],{env:executorEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output=(output+d).slice(-2048));child.stderr.on('data',d=>output=(output+d).slice(-2048));
  const timer=setTimeout(()=>child.kill('SIGTERM'),Math.min(m.ack_timeout_ms-1000,110000));
  const code=await new Promise<number|null>(ok=>{child.once('error',()=>ok(null));child.once('close',ok);});clearTimeout(timer);
  if(code!==0){await pool.query("UPDATE agy_temporal_native_operations SET error=$3 WHERE workflow_id=$1 AND attempt=$2",[b.workflow_id,b.attempt,{code:'R11_OUTCOME_RECONCILE_REQUIRED'}]);return {state:'UNCERTAIN' as const};}
  const d=(await pool.query('SELECT document FROM agy_hosted_r11 WHERE workflow_id=$1',[b.workflow_id])).rows[0].document;
  if(!d.callback||d.result?.result_status!=='RESULT_READY')return {state:'UNCERTAIN' as const};
  const file=join(root,'operations',operation,'result.json'),bytes=await readFile(file),result=JSON.parse(bytes.toString());
  if(result.operation_id!==operation||result.typecheck!=='PASS'||result.executor_worker_id!=='R11_HOSTED_ENGINEERING')throw new Error('R11_ARTIFACT_DENIED');
  const receipt:WorkerReceipt={task_id:m.task_id,attempt:b.attempt,idempotency_key:m.idempotency_key,executor_worker_id:m.executor_worker_id,operation_id:operation};
  let childResult:any;try{childResult=JSON.parse(output.trim());}catch{throw new Error('R11_CHILD_RESULT_INVALID');}
  if(childResult.outcome!=='RESULT_SUBMITTED'||Object.keys(childResult.negative_probes??{}).sort().join(',')!=='fence,identity,worker'||!Object.values(childResult.negative_probes).every(x=>x===409))throw new Error('R11_NEGATIVE_PROBE_FAILED');
  await pool.query("UPDATE agy_temporal_native_operations SET state='COMPLETE',ack=$3,checkpoint=$4,result=$5,updated_at=now() WHERE workflow_id=$1 AND attempt=$2",[b.workflow_id,b.attempt,receipt,{submissionState:'ACCEPTED',r11:true},{...result,artifact_ref:file,artifact_sha256:createHash('sha256').update(bytes).digest('hex'),r11_events:d.events,negative_probes:childResult.negative_probes,journal_dir:root,qa_state:'PENDING'}]);
  await pool.query("SELECT pg_notify('agy_temporal_result',$1)",[b.workflow_id]);
  return {state:'ACKED' as const,receipt};
 }finally{active=undefined;running=false;}
}
