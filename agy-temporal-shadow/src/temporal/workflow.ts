import {proxyActivities,defineSignal,defineQuery,setHandler,condition,workflowInfo} from '@temporalio/workflow';
import type {Activities,Mission,QaVerdict,Snapshot} from './contracts.js';
const a=proxyActivities<Activities>({startToCloseTimeout:'30 seconds',retry:{maximumAttempts:5,initialInterval:'100 milliseconds',maximumInterval:'2 seconds',nonRetryableErrorTypes:['CONTRACT_DENIED','IDEMPOTENCY_CONFLICT']}});
// Dispatch never retries automatically after a possibly accepted submission.
export const qaSignal=defineSignal<[QaVerdict]>('submit_qa');
export const stopSignal=defineSignal('safe_stop');
export const reconcileSignal=defineSignal('reconcile');
export const stateQuery=defineQuery<Snapshot>('progress');
export async function agyMission(m:Mission):Promise<Snapshot> {
 const dispatch=proxyActivities<Pick<Activities,'dispatch_worker'>>({startToCloseTimeout:m.ack_timeout_ms,retry:{maximumAttempts:1}});
 let snapshot:Snapshot={state:'START',qa_state:'QA_NOT_STARTED',attempt:1};
 let qa:QaVerdict|undefined,stop=false,reconcile=false;
 setHandler(stateQuery,()=>snapshot);
 setHandler(qaSignal,q=>{if(q.attempt===snapshot.attempt)qa=q;});
 setHandler(stopSignal,()=>{stop=true;});setHandler(reconcileSignal,()=>{reconcile=true;});
 let b=await a.load_project_state(m,workflowInfo().workflowId,workflowInfo().runId);
 const close=async(state:string,reason?:string)=>{await a.write_callback_receipt(m,b,state,reason);snapshot={...snapshot,state,...(reason?{reason}:{})};return snapshot;};
 for(let correction=0;correction<=m.max_corrections;correction++) {
  snapshot={state:'DISPATCH',qa_state:'QA_NOT_STARTED',attempt:b.attempt};qa=undefined;
  if(stop)return close('BLOCKED','SAFE_STOP_BEFORE_DISPATCH');
  let d:Awaited<ReturnType<Activities['dispatch_worker']>>;
  try{d=await dispatch.dispatch_worker(m,b);}catch{d={state:'UNCERTAIN'};}
  if(d.state==='BLOCKED_ROUTE')return close('BLOCKED_ROUTE','EXECUTOR_UNAVAILABLE_NO_WORK_FALLBACK');
  if(d.state==='UNCERTAIN'){
   snapshot.state='RECONCILING';const r=await a.reconcile_uncertain_operation(m,b);
   if(r.state!=='ACKED')return close('BLOCKED','SUBMISSION_UNCERTAIN_RECONCILE_REQUIRED');
   d={state:'ACKED',receipt:r.receipt};
  }
  if(!d.receipt)return close('BLOCKED','MISSING_EXECUTOR_ACK');
  await a.record_executor_ack(m,b,d.receipt);
  snapshot={...snapshot,state:'WAIT_RESULT',operation_id:d.receipt.operation_id};
  // Timers and Activities only: no process/DB/provider/file APIs in Workflow code.
  const deadline=Date.now()+m.result_timeout_ms;
  let result:Awaited<ReturnType<Activities['submit_result_evidence']>>={state:'RUNNING'};
  while(Date.now()<deadline&&!stop){
   if(reconcile){await a.reconcile_uncertain_operation(m,b);reconcile=false;}
   b=await a.heartbeat_checkpoint(m,b);result=await a.submit_result_evidence(m,b);
   if(result.state!=='RUNNING')break;
   await condition(()=>stop||reconcile,500);
  }
  if(stop)return close('BLOCKED','STOP_REQUESTED_OPERATION_RETAINED');
  if(result.state!=='RESULT'){
   await a.reconcile_uncertain_operation(m,b);return close('BLOCKED','RESULT_UNVERIFIED_RECONCILE_REQUIRED');
  }
  snapshot={...snapshot,state:'WAIT_QA',qa_state:'PENDING',evidence_refs:result.evidence_refs};
  const qaDeadline=Date.now()+m.qa_timeout_ms;
  while(!qa&&!stop&&Date.now()<qaDeadline){b=await a.heartbeat_checkpoint(m,b);await condition(()=>!!qa||stop,500);}
  if(stop)return close('BLOCKED','STOP_REQUESTED_OPERATION_RETAINED');
  if(!qa)return close('BLOCKED','QA_TIMEOUT');
  const verdict=await a.submit_qa_verdict(m,b,qa);
  if(verdict.state==='COMPLETE'){snapshot.qa_state='PASS';return close('COMPLETE');}
  snapshot.qa_state='FAIL';
  if(verdict.state!=='CORRECT'||correction===m.max_corrections)return close('BLOCKED','QA_FAILED');
  b=await a.prepare_correction(m,b,qa);
 }
 return close('BLOCKED','CORRECTION_LIMIT');
}
