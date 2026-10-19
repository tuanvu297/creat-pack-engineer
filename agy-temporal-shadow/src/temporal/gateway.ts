import {Client,WorkflowExecutionAlreadyStartedError,WorkflowIdReusePolicy} from '@temporalio/client';
import {authorize,type Principal} from '../platform/auth.js';
import {TemporalBridge,validateMission,workflowId,stable} from './bridge.js';
import type {Mission,QaVerdict,Snapshot} from './contracts.js';
export class TemporalGateway {
 constructor(readonly bridge:TemporalBridge,readonly client:Client,readonly taskQueue:string,readonly mode:'LEGACY'|'TEMPORAL_SHADOW'){}
 async execute(m:Mission,p:Principal,action:string,body:any={}):Promise<any>{
  authorize(p,m,['submit_qa'].includes(action)?'qa':['dispatch','reconcile','stop'].includes(action)?'write':'read');
  if(this.mode==='LEGACY')return {routing:'LEGACY',temporal_enabled:false,next:'existing ProjectService /jobs API'};
  validateMission(m);
  if(['bootstrap','current_state'].includes(action))return {project:await this.bridge.project(m),missions:(await this.bridge.pool(m,p.subject).query('SELECT mission_id,task_key,state,qa_state,workflow_id,run_id,updated_at FROM agy_temporal_missions WHERE mission_id=$1 ORDER BY created_at',[m.mission_id])).rows,authority:{temporal:'workflow progression/history',postgres:'AGY operational/domain ledger and evidence references'},chat_surface:'UNVERIFIED',production:false};
  if(action==='dispatch'){
   const r=await this.bridge.reserve(m);
   try{
    const handle=await this.client.workflow.start('agyMission',{workflowId:r.workflow_id,taskQueue:this.taskQueue,args:[m],workflowIdReusePolicy:WorkflowIdReusePolicy.REJECT_DUPLICATE});
    return {workflow_id:handle.workflowId,run_id:handle.firstExecutionRunId,duplicate:false,evidence_class:m.executor_worker_id==='R11_HOSTED_ENGINEERING'?'HOSTED_R11_FIXED_SOURCE_CHECK_NO_MODEL':m.executor_worker_id==='CODEX_ENGINEERING_COMMAND'?'NATIVE_CODEX_COMMAND_NO_MODEL':'CONTROLLED_SYNTHETIC'};
   }catch(e){if(!(e instanceof WorkflowExecutionAlreadyStartedError))throw e;
    const d=await this.client.workflow.getHandle(r.workflow_id).describe();return {workflow_id:r.workflow_id,run_id:d.runId,duplicate:true};}
  }
  const pool=this.bridge.pool(m,p.subject),id=workflowId(m);
  if(action==='active_missions')return (await pool.query("SELECT mission_id,task_key,state,qa_state,workflow_id,run_id,updated_at FROM agy_temporal_missions WHERE state NOT IN ('COMPLETE','BLOCKED','BLOCKED_ROUTE') ORDER BY created_at LIMIT 100")).rows;
  const row=(await pool.query('SELECT * FROM agy_temporal_missions WHERE workflow_id=$1',[id])).rows[0];
  if(!row)throw new Error('MISSION_NOT_FOUND');
  // A status request cannot substitute a different contract under an existing key.
  if(stable(m)!==stable(row.contract))throw new Error('IDEMPOTENCY_CONFLICT');
  if(action==='callback_status')return {workflow_id:id,run_id:row.run_id,receipts:(await pool.query("SELECT payload,created_at FROM agy_temporal_receipts WHERE workflow_id=$1 AND kind='CALLBACK' ORDER BY created_at",[id])).rows,native_chat_ingestion:'UNVERIFIED',authority:'POSTGRES_CANONICAL_STORE'};
  const handle=this.client.workflow.getHandle(id);
  if(['task_status','get_run'].includes(action)){
   const d=await handle.describe();let progress:Snapshot|undefined;
   if(d.status.name==='RUNNING')progress=await handle.query<Snapshot>('progress');
   return {postgres:row,temporal:{workflow_id:id,run_id:d.runId,status:d.status.name,progress},authority:'postgres=domain; temporal=progression',native_chat_ingestion:'UNVERIFIED'};
  }
  if(action==='submit_qa'){
   const q:QaVerdict={...body,reviewer_id:p.subject};
   if(p.subject===m.executor_worker_id||p.workerId===m.executor_worker_id||row.executor_worker_id===p.subject)throw new Error('SELF_QA_DENIED');
   if(row.state!=='WAIT_QA'||!row.ack||!row.result||q.attempt!==row.attempt||q.qa_contract_version!=='1.1'||!['PASS','FAIL'].includes(q.verdict)||
    !Array.isArray(q.evidence_refs)||!row.result.evidence_refs.every((r:string)=>q.evidence_refs.includes(r))||(q.verdict==='FAIL'&&(typeof q.corrective_instruction!=='string'||!q.corrective_instruction.trim())))throw new Error('QA_NOT_STARTED_OR_CONTRACT_DENIED');
   await this.bridge.locked(m,{workflow_id:id,run_id:row.run_id,job_id:row.job_id,db_task_id:row.task_id,lease_token:row.lease_token,attempt:row.attempt,lease_attempt:row.lease_attempt},async(c,r)=>{
    await this.bridge.receipt(c,r,`qa-request:${q.attempt}`,'AUTHORIZED_QA_REQUEST',q);
   });
   await handle.signal('submit_qa',q);return {state:'QA_SUBMITTED',reviewer_id:p.subject,attempt:q.attempt};
  }
  if(action==='reconcile'){await handle.signal('reconcile');return {state:'RECONCILE_REQUESTED',resubmitted:false};}
  if(action==='stop'){await handle.signal('safe_stop');return {state:'STOP_REQUESTED',remote_cancel:false,operation_retained:true};}
  throw new Error('UNKNOWN_GATEWAY_ACTION');
 }
}
