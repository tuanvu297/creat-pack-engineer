import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ApplicationFailure} from '@temporalio/activity';
import {PostgresStore} from '../postgres-store.js';
import {ProjectPool} from '../platform/scoped-pool.js';
import {validateScope} from '../platform/scope.js';
import type {Activities,Binding,Mission,QaVerdict,WorkerReceipt} from './contracts.js';
export function stable(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable((value as any)[k])).join(',')+'}';
 return JSON.stringify(value);
}
export const digest=(v:unknown)=>createHash('sha256').update(stable(v)).digest('hex');
export const workflowId=(m:Mission)=>'agy-shadow-'+digest([m.tenantId,m.workspaceId,m.projectId,m.idempotency_key]);
function deny(message:string):never{throw ApplicationFailure.nonRetryable(message,'CONTRACT_DENIED');}
export function validateMission(m:Mission){
 validateScope(m);
 if(Object.keys(m).some(k=>!['tenantId','workspaceId','projectId','mission_id','task_id','attempt','idempotency_key','objective','executor_worker_id','source_ref','qa_contract_version','mode','payload','ack_timeout_ms','result_timeout_ms','qa_timeout_ms','max_corrections'].includes(k)))deny('UNKNOWN_MISSION_FIELD');
 if(m.mode!=='TEMPORAL_SHADOW'||m.qa_contract_version!=='1.1'||m.attempt!==1||
  ![m.mission_id,m.task_id,m.idempotency_key,m.objective,m.executor_worker_id,m.source_ref].every(s=>typeof s==='string'&&s.length>0&&s.length<=4096)||
  ![m.ack_timeout_ms,m.result_timeout_ms,m.qa_timeout_ms].every(n=>Number.isInteger(n)&&n>=1000&&n<=3600000)||
  !Number.isInteger(m.max_corrections)||m.max_corrections<0||m.max_corrections>2||!m.payload||Array.isArray(m.payload))deny('INVALID_MISSION');
 // Strict allowlist: shadow input cannot smuggle a real connector, endpoint or instructions.
 if(Object.keys(m.payload).some(k=>!['value','delay_ms','fixture'].includes(k))||
  !Number.isInteger(m.payload.value)||!Number.isInteger(m.payload.delay_ms)||Number(m.payload.delay_ms)<0||Number(m.payload.delay_ms)>30000||
  !['normal','uncertain_after_accept','uncertain_without_accept'].includes(String(m.payload.fixture)))deny('SYNTHETIC_PAYLOAD_REQUIRED');
}
export class TemporalBridge {
 constructor(readonly raw:Pool){}
 pool(m:Mission,subject='temporal-activities'){return new ProjectPool(this.raw,m,subject).asPool();}
 async tx<T>(m:Mission,fn:(c:PoolClient)=>Promise<T>):Promise<T>{
  const c=await this.pool(m).connect();try{await c.query('BEGIN');const value=await fn(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async project(m:Mission){
  validateMission(m);const p=(await this.pool(m).query('SELECT * FROM agy_projects')).rows[0];
  if(!p||p.status!=='ACTIVE'||p.policies?.temporalShadowOnly!==true)deny('ISOLATED_SHADOW_PROJECT_REQUIRED');
  return p;
 }
 async reserve(m:Mission){
  await this.project(m);const id=workflowId(m),hash=digest(m);
  return this.tx(m,async c=>{
   await c.query(`INSERT INTO agy_temporal_missions(mission_id,task_key,idempotency_key,payload_hash,workflow_id,contract,executor_worker_id)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[m.mission_id,m.task_id,m.idempotency_key,hash,id,m,m.executor_worker_id]);
   const row=(await c.query('SELECT * FROM agy_temporal_missions WHERE idempotency_key=$1 FOR UPDATE',[m.idempotency_key])).rows[0];
   if(!row||row.payload_hash!==hash)throw ApplicationFailure.nonRetryable('IDEMPOTENCY_CONFLICT','IDEMPOTENCY_CONFLICT');
   return row;
  });
 }
 async locked<T>(m:Mission,b:Binding,fn:(c:PoolClient,row:any)=>Promise<T>){
  await this.project(m);
  return this.tx(m,async c=>{
   const row=(await c.query('SELECT * FROM agy_temporal_missions WHERE workflow_id=$1 FOR UPDATE',[b.workflow_id])).rows[0];
   if(!row||row.payload_hash!==digest(m)||row.run_id!==b.run_id||row.task_id!==b.db_task_id||row.attempt!==b.attempt||row.lease_token!==b.lease_token)deny('STALE_BINDING');
   const task=(await c.query('SELECT lease_token,attempt,task_type FROM agy_tasks WHERE task_id=$1 FOR UPDATE',[b.db_task_id])).rows[0];
   if(!task||task.lease_token!==b.lease_token||task.attempt!==b.lease_attempt||task.task_type!=='agy-temporal-shadow')deny('TASK_FENCE_DENIED');
   return fn(c,row);
  });
 }
 async receipt(c:PoolClient,row:any,key:string,kind:string,payload:unknown){
  const hash=digest(payload),old=(await c.query('SELECT payload FROM agy_temporal_receipts WHERE workflow_id=$1 AND receipt_key=$2',[row.workflow_id,key])).rows[0];
  if(old){if(digest(old.payload)!==hash)deny('RECEIPT_CONFLICT');return false;}
  await c.query('INSERT INTO agy_temporal_receipts(job_id,task_id,workflow_id,receipt_key,kind,payload) VALUES($1,$2,$3,$4,$5,$6)',[row.job_id,row.task_id,row.workflow_id,key,kind,payload]);
  await c.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,worker_id,detail) VALUES($1,$2,'TEMPORAL_SHADOW',$3,$4)`,[row.job_id,row.task_id,row.executor_worker_id,{kind,receipt_key:key,...(payload as object)}]);
  return true;
 }
 async task(m:Mission,b:Binding){
  const t=(await this.pool(m).query('SELECT * FROM agy_tasks WHERE task_id=$1',[b.db_task_id])).rows[0];
  if(!t||t.lease_token!==b.lease_token||t.attempt!==b.lease_attempt||t.task_type!=='agy-temporal-shadow')deny('TASK_FENCE_DENIED');
  return {taskId:t.task_id,jobId:t.job_id,leaseToken:t.lease_token,attempt:t.attempt,payload:t.payload,...t.policy,status:t.status,leaseExpiresAt:t.lease_expires_at};
 }
 async transition(m:Mission,b:Binding,from:any[],to:any,patch:Record<string,unknown>={}){
  const t=await this.task(m,b);if(t.status===to)return;
  if(!await new PostgresStore(this.pool(m),m).transition(b.db_task_id,b.lease_token,from,to,patch))deny('TASK_TRANSITION_DENIED');
 }
 activities():Activities{return {
  load_project_state:async(m,id,run)=>{
   const row=await this.reserve(m);if(row.workflow_id!==id||(row.run_id&&row.run_id!==run))deny('WORKFLOW_BINDING_CONFLICT');
   const pool=this.pool(m),store=new PostgresStore(pool,m);
   const job=await store.createJob({tenantId:m.tenantId,idempotencyKey:'temporal-shadow:'+m.idempotency_key,objective:m.objective,mode:'SINGLE_WORKFLOW',passThreshold:1,
    tasks:[{idempotencyKey:m.task_id,name:m.objective,taskType:'agy-temporal-shadow',payload:m.payload,requiredCapabilities:['AGY_TEMPORAL_SYNTHETIC_ONLY'],risk:'LOW',deterministic:true,permissionGranted:true,safetyApproved:true,estimatedCost:0,estimatedQuota:0,maxRetry:2}]});
   const b=await this.tx(m,async c=>{
    const r=(await c.query('SELECT * FROM agy_temporal_missions WHERE workflow_id=$1 FOR UPDATE',[id])).rows[0];
    if(r.run_id&&r.run_id!==run)deny('WORKFLOW_BINDING_CONFLICT');
    let t=(await c.query('SELECT * FROM agy_tasks WHERE job_id=$1 AND idempotency_key=$2 FOR UPDATE',[job.jobId,m.task_id])).rows[0];
    if(t.status==='QUEUED')t=(await c.query(`UPDATE agy_tasks SET status='CLAIMED',claimed_by=$2,lease_token=gen_random_uuid(),lease_expires_at=now()+interval '30 seconds',heartbeat_at=now(),attempt=attempt+1 WHERE task_id=$1 RETURNING *`,[t.task_id,m.executor_worker_id])).rows[0];
    if(!t.lease_token)deny('TASK_NOT_CLAIMED');
    await c.query(`UPDATE agy_temporal_missions SET run_id=$2,job_id=$3,task_id=$4,lease_token=$5,attempt=$6,updated_at=now() WHERE workflow_id=$1`,[id,run,job.jobId,t.task_id,t.lease_token,t.attempt]);
    return {workflow_id:id,run_id:run,job_id:job.jobId,db_task_id:t.task_id,lease_token:t.lease_token,attempt:r.attempt,lease_attempt:t.attempt};
   });
   await this.transition(m,b,['CLAIMED'],'RUNNING');return b;
  },
  dispatch_worker:async(m,b)=>{
   if(m.executor_worker_id!=='AGY_TEMPORAL_SYNTHETIC')return {state:'BLOCKED_ROUTE'};
   const task=await this.task(m,b),store=new PostgresStore(this.pool(m),m);
   const key=`${m.idempotency_key}:attempt:${b.attempt}`;
   await store.saveSubmissionIntent(task,'agy-temporal-synthetic',key);
   // A single transaction creates exactly one bounded DB-only synthetic effect.
   return this.locked(m,b,async(c,row)=>{
    if(m.payload.fixture==='uncertain_without_accept'){await this.receipt(c,row,`intent:${b.attempt}`,'SUBMISSION_UNCERTAIN',{attempt:b.attempt,idempotency_key:key});return {state:'UNCERTAIN' as const};}
    const hash=digest([task.payload,b.attempt]);
    await c.query(`INSERT INTO agy_temporal_synthetic_operations(workflow_id,attempt,idempotency_key,payload_hash,operation_id,ready_at,output)
     VALUES($1,$2,$3,$4,$5,now()+($6::double precision*interval '1 millisecond'),$7) ON CONFLICT DO NOTHING`,[b.workflow_id,b.attempt,key,hash,randomUUID(),m.payload.delay_ms,{value:m.payload.value}]);
    const op=(await c.query('SELECT * FROM agy_temporal_synthetic_operations WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt])).rows[0];
    if(op.payload_hash!==hash)deny('OPERATION_PAYLOAD_CONFLICT');
    await this.receipt(c,row,`dispatch:${b.attempt}`,'SYNTHETIC_DISPATCH',{attempt:b.attempt,idempotency_key:key,operation_id:op.operation_id,evidence_class:'CONTROLLED_SYNTHETIC'});
    if(m.payload.fixture==='uncertain_after_accept')return {state:'UNCERTAIN' as const};
    return {state:'ACKED' as const,receipt:{task_id:m.task_id,attempt:b.attempt,idempotency_key:m.idempotency_key,executor_worker_id:m.executor_worker_id,operation_id:op.operation_id}};
   });
  },
  record_executor_ack:async(m,b,r)=>{
   if(r.task_id!==m.task_id||r.attempt!==b.attempt||r.idempotency_key!==m.idempotency_key||r.executor_worker_id!==m.executor_worker_id||!r.operation_id)deny('ACK_IDENTITY_DENIED');
   const already=await this.locked(m,b,async(c,row)=>{
    const old=(await c.query('SELECT payload FROM agy_temporal_receipts WHERE workflow_id=$1 AND receipt_key=$2',[b.workflow_id,`ack:${b.attempt}`])).rows[0];
    if(old){if(stable(old.payload)!==stable(r))deny('ACK_RECEIPT_CONFLICT');return true;}
    const op=(await c.query('SELECT operation_id FROM agy_temporal_synthetic_operations WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt])).rows[0];
    if(op?.operation_id!==r.operation_id)deny('ACK_EVIDENCE_DENIED');return false;
   });
   if(already)return;
   const task=await this.task(m,b);await new PostgresStore(this.pool(m),m).saveCheckpoint(task,r.operation_id,'agy-temporal-synthetic');
   await this.locked(m,b,async(c,row)=>{
    const op=(await c.query('SELECT operation_id FROM agy_temporal_synthetic_operations WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt])).rows[0];
    if(op?.operation_id!==r.operation_id)deny('ACK_EVIDENCE_DENIED');
    if(await this.receipt(c,row,`ack:${b.attempt}`,'EXECUTOR_ACK',r))await c.query("UPDATE agy_temporal_missions SET state='ACKED',operation_id=$2,ack=$3,updated_at=now() WHERE workflow_id=$1",[b.workflow_id,r.operation_id,r]);
   });
  },
  heartbeat_checkpoint:async(m,b)=>{
   await this.project(m);
   // Recovery is an explicit read/reconcile + new fence, never an expired-token renewal.
   // Submission attempt and lease claim attempt are distinct: same operation is resumed.
   return this.tx(m,async c=>{
    const row=(await c.query('SELECT * FROM agy_temporal_missions WHERE workflow_id=$1 FOR UPDATE',[b.workflow_id])).rows[0];
    if(!row||row.payload_hash!==digest(m)||row.run_id!==b.run_id||row.attempt!==b.attempt)deny('STALE_BINDING');
    const t=(await c.query('SELECT *,lease_expires_at>now() AS live FROM agy_tasks WHERE task_id=$1 FOR UPDATE',[b.db_task_id])).rows[0];
    if(row.lease_token!==b.lease_token){
     const previous=(await c.query('SELECT payload FROM agy_temporal_receipts WHERE workflow_id=$1 AND receipt_key=$2',[b.workflow_id,`lease-recovery:${b.lease_token}`])).rows[0];
     if(!previous||previous.payload.lease_token!==row.lease_token||t.lease_token!==row.lease_token)deny('TASK_FENCE_DENIED');
     return {...b,lease_token:row.lease_token,lease_attempt:row.lease_attempt};
    }
    if(t.lease_token!==b.lease_token||t.attempt!==b.lease_attempt)deny('TASK_FENCE_DENIED');
    if(t.status==='QA')return b;
    if(t.status!=='RUNNING')deny('LEASE_STATE_RECONCILE_REQUIRED');
    if(t.live){await c.query("UPDATE agy_tasks SET heartbeat_at=now(),lease_expires_at=now()+interval '30 seconds' WHERE task_id=$1",[b.db_task_id]);return b;}
    const op=(await c.query('SELECT operation_id FROM agy_temporal_synthetic_operations WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt])).rows[0];
    if(!row.ack||!op||op.operation_id!==row.operation_id||t.checkpoint?.externalId!==op.operation_id)deny('LEASE_LOST_RECONCILE_REQUIRED');
    const token=randomUUID(),leaseAttempt=t.attempt+1;
    await c.query("UPDATE agy_tasks SET status='CLAIMED',attempt=$2,lease_token=$3,lease_expires_at=now()+interval '30 seconds',heartbeat_at=now() WHERE task_id=$1",[b.db_task_id,leaseAttempt,token]);
    await c.query("UPDATE agy_tasks SET status='RUNNING' WHERE task_id=$1",[b.db_task_id]);
    const updated={...b,lease_token:token,lease_attempt:leaseAttempt};
    await this.receipt(c,row,`lease-recovery:${b.lease_token}`,'LEASE_RECONCILED',{...updated,operation_id:op.operation_id,resubmitted:false});
    await c.query('UPDATE agy_temporal_missions SET lease_token=$2,lease_attempt=$3,updated_at=now() WHERE workflow_id=$1',[b.workflow_id,token,leaseAttempt]);
    return updated;
   });
  },
  submit_result_evidence:async(m,b)=>{
   const result=await this.locked(m,b,async(c,row)=>{
    if(!row.ack)return {state:'UNCERTAIN' as const};
    const op=(await c.query('SELECT *,ready_at<=now() AS ready FROM agy_temporal_synthetic_operations WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt])).rows[0];
    if(!op)return {state:'UNCERTAIN' as const};if(!op.ready)return {state:'RUNNING' as const};
    const evidence_refs=[`synthetic://${b.workflow_id}/${b.attempt}/${op.operation_id}`];
    const result={output:op.output,evidence_refs,operation_id:op.operation_id,attempt:b.attempt};
    if(await this.receipt(c,row,`result:${b.attempt}`,'RESULT_EVIDENCE',result))await c.query("UPDATE agy_temporal_missions SET result=$2,state='WAIT_QA',qa_state='PENDING',updated_at=now() WHERE workflow_id=$1",[b.workflow_id,result]);
    return {state:'RESULT' as const,evidence_refs};
   });
   if(result.state==='RESULT')await this.transition(m,b,['RUNNING'],'QA',{qaVerdict:'PENDING',qaEvidence:{scope:'SYNTHETIC_ONLY',evidence_refs:result.evidence_refs}});
   return result;
  },
  reconcile_uncertain_operation:async(m,b)=>this.locked(m,b,async(c,row)=>{
   const op=(await c.query('SELECT operation_id FROM agy_temporal_synthetic_operations WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt])).rows[0];
   await this.receipt(c,row,`reconcile:${b.attempt}`,'RECONCILIATION',{attempt:b.attempt,operation_id:op?.operation_id??null,action:op?'RESUME_EXISTING':'BLOCK_NO_RETRY'});
   return op?{state:'ACKED' as const,receipt:{task_id:m.task_id,attempt:b.attempt,idempotency_key:m.idempotency_key,executor_worker_id:m.executor_worker_id,operation_id:op.operation_id}}:{state:'BLOCKED' as const};
  }),
  submit_qa_verdict:async(m,b,q)=>this.locked(m,b,async(c,row)=>{
   const authorized=(await c.query('SELECT payload FROM agy_temporal_receipts WHERE workflow_id=$1 AND receipt_key=$2',[b.workflow_id,`qa-request:${b.attempt}`])).rows[0];
   if(!authorized||stable(authorized.payload)!==stable(q))deny('UNAUTHORIZED_QA_SIGNAL');
   if(!row.ack||!row.result||q.attempt!==b.attempt||q.qa_contract_version!=='1.1'||!q.reviewer_id||q.reviewer_id===m.executor_worker_id||!['PASS','FAIL'].includes(q.verdict)||
    !Array.isArray(q.evidence_refs)||!row.result.evidence_refs.every((r:string)=>q.evidence_refs.includes(r))||(q.verdict==='FAIL'&&!q.corrective_instruction))deny('QA_CONTRACT_DENIED');
   const state=q.verdict==='PASS'?'COMPLETE':b.attempt<=m.max_corrections?'CORRECT':'BLOCKED';
   if(await this.receipt(c,row,`qa:${b.attempt}`,'QA_VERDICT',q)){
    await c.query('INSERT INTO agy_qa_results(task_id,job_id,verdict,evidence,reviewed_by) VALUES($1,$2,$3,$4,$5)',[b.db_task_id,b.job_id,q.verdict,{scope:'SYNTHETIC_ONLY',...q},q.reviewer_id]);
    await c.query('UPDATE agy_temporal_missions SET qa=$2,qa_state=$3,reviewer_id=$4,updated_at=now() WHERE workflow_id=$1',[b.workflow_id,q,q.verdict,q.reviewer_id]);
   }
   return {state};
  }),
  prepare_correction:async(m,b,q)=>{
   // If the Activity committed and its response was lost, return that same next fence.
   const old=(await this.pool(m).query('SELECT payload FROM agy_temporal_receipts WHERE workflow_id=$1 AND receipt_key=$2',[b.workflow_id,`correction:${b.attempt}`])).rows[0];
   if(old){if(old.payload.corrective_instruction!==q.corrective_instruction||!old.payload.next_binding)deny('CORRECTION_RECEIPT_CONFLICT');return old.payload.next_binding as Binding;}
   return this.locked(m,b,async(c,row)=>{
   if(row.qa?.verdict!=='FAIL'||row.qa?.corrective_instruction!==q.corrective_instruction||b.attempt>m.max_corrections)deny('CORRECTION_NOT_AUTHORIZED');
   const token=randomUUID();
   await c.query(`UPDATE agy_tasks SET status='CLAIMED',attempt=attempt+1,lease_token=$2,lease_expires_at=now()+interval '30 seconds',heartbeat_at=now(),checkpoint=NULL,
    policy=jsonb_set(policy,'{corrective_instruction}',$3::jsonb) WHERE task_id=$1 AND status='QA'`,[b.db_task_id,token,JSON.stringify(q.corrective_instruction)]);
   await c.query("UPDATE agy_tasks SET status='RUNNING' WHERE task_id=$1",[b.db_task_id]);
   const next={...b,lease_token:token,attempt:b.attempt+1,lease_attempt:b.lease_attempt+1};
   await this.receipt(c,row,`correction:${b.attempt}`,'CORRECTIVE_REDISPATCH',{attempt:b.attempt+1,corrective_instruction:q.corrective_instruction,executor_worker_id:m.executor_worker_id,next_binding:next});
   await c.query("UPDATE agy_temporal_missions SET attempt=attempt+1,lease_attempt=lease_attempt+1,lease_token=$2,ack=NULL,result=NULL,qa=NULL,qa_state='QA_NOT_STARTED',state='DISPATCH',updated_at=now() WHERE workflow_id=$1",[b.workflow_id,token]);
   return next;
  });},
  write_callback_receipt:async(m,b,state,reason)=>{
   if(!['COMPLETE','BLOCKED','BLOCKED_ROUTE'].includes(state))deny('INVALID_CALLBACK_STATE');
   await this.locked(m,b,async(c,row)=>{
    if(state==='COMPLETE'&&(!row.ack||!row.result||row.qa_state!=='PASS'))deny('MISSING_COMPLETION_EVIDENCE');
    const payload={mission_id:m.mission_id,task_id:m.task_id,attempt:b.attempt,idempotency_key:m.idempotency_key,workflow_id:b.workflow_id,run_id:b.run_id,state,reason:reason??null,
     evidence_refs:row.result?.evidence_refs??[],executor_worker_id:m.executor_worker_id,qa_reviewer_id:row.reviewer_id??null,qa_contract_version:'1.1',native_chat_ingestion:'UNVERIFIED',evidence_class:'CONTROLLED_SYNTHETIC'};
    if(await this.receipt(c,row,`callback:${b.attempt}`,'CALLBACK',payload)){
     await c.query('UPDATE agy_temporal_missions SET state=$2,updated_at=now() WHERE workflow_id=$1',[b.workflow_id,state]);
     // Same canonical task/job ledger, same IDs; no prior events are rewritten.
     await c.query(`UPDATE agy_tasks SET status=$2::agy_task_status,finished_at=now(),updated_at=now() WHERE task_id=$1`,[b.db_task_id,state==='COMPLETE'?'PASS':'BLOCKED']);
     await c.query(`UPDATE agy_jobs SET status=$2::agy_job_status,updated_at=now() WHERE job_id=$1`,[b.job_id,state==='COMPLETE'?'PASS':'BLOCKED']);
    }
   });
  }
 };}
}
