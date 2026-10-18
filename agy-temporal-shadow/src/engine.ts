import type { EngineStore, WorkerAdapter } from "./types.js";
import { evaluateQa, qaPolicy } from "./qa.js";
import { createHash } from "node:crypto";
import { connectorIdempotencyKey,ConnectorError } from './adapters.js';
import { runtimeCapabilityAllows } from './resources/allocation.js';

export class WorkerEngine {
  constructor(private readonly store: EngineStore, private readonly adapter: WorkerAdapter, private readonly workerId: string, private readonly leaseSeconds = 30) {}
  async tick(): Promise<"IDLE"|"PASS"|"FAIL"|"BLOCKED"|"QA"> {
    const task = await this.store.claim({ workerId:this.workerId, capabilities:this.adapter.capabilities, leaseSeconds:this.leaseSeconds });
    if (!task) return "IDLE";
    const start=Date.now(); const abort=new AbortController(); const timeout=setTimeout(()=>abort.abort(),(task.timeoutSeconds??300)*1000);
    const heartbeat=setInterval(()=>{void this.store.heartbeat(task.taskId,this.workerId,task.leaseToken,this.leaseSeconds).then(ok=>{if(!ok)abort.abort();}).catch(()=>abort.abort());},Math.max(100,this.leaseSeconds*1000/3));
    let externalId: string | undefined;
    const hadCheckpointAtStart=!!task.checkpoint;
    let providerBoundaryStarted=0,providerBoundaryElapsed=0;
    try {
      if (!await this.store.transition(task.taskId,task.leaseToken,["CLAIMED"],"RUNNING")) return "FAIL";
      if(!runtimeCapabilityAllows(this.adapter.runtimeProfile,task))throw new ConnectorError('RUNTIME_CAPABILITY_DENIED',false);
      const result=await Promise.race([
        (async()=>{
          providerBoundaryStarted=Date.now();
          if(task.checkpoint) {
            const digest=createHash('sha256').update(JSON.stringify(task.payload??{})).digest('hex');
            if(task.checkpoint.adapter!==this.adapter.name || task.checkpoint.digest!==digest)throw new Error('CHECKPOINT_CONTEXT_MISMATCH');
            if(!task.checkpoint.externalId)throw new ConnectorError('SUBMISSION_UNCERTAIN',false);
            externalId=task.checkpoint.externalId;
          } else {
            if(this.store.saveSubmissionIntent)await this.store.saveSubmissionIntent(task,this.adapter.name,connectorIdempotencyKey(this.adapter.name,task));
            const submitted=await this.adapter.execute(task,abort.signal);externalId=submitted.externalId;
          }
          if(this.store.saveCheckpoint)await this.store.saveCheckpoint(task,externalId,this.adapter.name);
          task.checkpoint={externalId,adapter:this.adapter.name,digest:createHash('sha256').update(JSON.stringify(task.payload??{})).digest('hex'),idempotencyKey:connectorIdempotencyKey(this.adapter.name,task),submissionState:'ACCEPTED'};
          let status=await this.adapter.check_status(externalId);
          while(status.state==='RUNNING' && !abort.signal.aborted){await new Promise(resolve=>setTimeout(resolve,250));status=await this.adapter.check_status(externalId);}
          const collected=await this.adapter.collect_result(externalId);
          const usage=this.adapter.usage?await this.adapter.usage(externalId):{};
          providerBoundaryElapsed=Date.now()-providerBoundaryStarted;
          return {...collected,...usage,externalOperationId:externalId};})(),
        new Promise<never>((_,reject)=>abort.signal.addEventListener('abort',()=>reject(new Error('TIMEOUT_OR_LEASE_LOST')),{once:true}))
      ]);
      if (result.state === "SUCCEEDED") {
        if(task.risk==='LOW'&&task.deterministic&&task.payload?.verification==='AGY_MISSION5'&&task.payload.expected!==undefined){
          const passed=JSON.stringify(result.output)===JSON.stringify(task.payload.expected);
          result.qa={deterministicPassed:passed,score:passed?1:0,confidence:1,evidenceSufficient:true};
        }
        const qa = evaluateQa(task, result.qa, task.passThreshold ?? .8);
        if (!await this.store.transition(task.taskId,task.leaseToken,["RUNNING"],"QA",{result:result.output??{},qaEvidence:result.qa??{},qaVerdict:qa})) return "BLOCKED";
        if (qa === "PENDING") { await this.telemetry(task,"QA_PENDING",start,result); return "QA"; }
        const destination = qa === "PASS" ? "PASS" : task.attempt <= (task.maxRetry??0) ? "RETRY" : "BLOCKED";
        if (!await this.store.transition(task.taskId,task.leaseToken,["QA"],destination,{result:result.output??{},error:qa === "FAIL" ? {code:"QA_FAILED", feedback:result.qa?.feedback} : undefined})) return "BLOCKED";
        await this.telemetry(task,qa,start,{...result,providerBoundaryElapsed}); return qa;
      }
      const retryable=result.error?.retryable===true && task.attempt <= (task.maxRetry??0);
      if(this.store.recordWorkerFailure)await this.store.recordWorkerFailure(this.workerId,result.error?.code??"UNKNOWN_FAILURE",task.attempt,task.maxRetry??0);
      await this.store.transition(task.taskId,task.leaseToken,["RUNNING"],retryable?"RETRY":"BLOCKED",{error:result.error,clearCheckpoint:true});
      await this.telemetry(task,retryable?"FAIL":"BLOCKED",start,result); return retryable?"FAIL":"BLOCKED";
    } catch(error) {
      const classified=error as {code?:string;retryable?:boolean;retryAfterMs?:number};
      if(classified.code==='RATE_LIMIT'&&classified.retryAfterMs!==undefined&&classified.retryAfterMs>5000&&this.store.deferTask){
        const deferred=await this.store.deferTask(task,this.workerId,classified.retryAfterMs,classified.code);
        // No FAIL telemetry settlement: throttled unsent attempt already refunded; an existing operation retains its reservation.
        return deferred?(task.attempt<=(task.maxRetry??0)?'FAIL':'BLOCKED'):'BLOCKED';
      }
      // A fenced-out worker must not cancel a provider operation now owned by its successor.
      if(!await this.store.heartbeat(task.taskId,this.workerId,task.leaseToken,this.leaseSeconds))return 'BLOCKED';
      let cancellationConfirmed=true;
      if(externalId) {try{await this.adapter.cancel(externalId);}catch{cancellationConfirmed=false;}}
      if(this.store.recordWorkerFailure)await this.store.recordWorkerFailure(this.workerId,classified.code??(String(error).includes('TIMEOUT')?'TIMEOUT':'EXECUTION_ERROR'),task.attempt,task.maxRetry??0);
      const uncertain=classified.code==='SUBMISSION_UNCERTAIN';
      const retryable=!uncertain && cancellationConfirmed && classified.retryable!==false && !String(error).includes('CHECKPOINT_CONTEXT_MISMATCH') && task.attempt <= (task.maxRetry??0);
      await this.store.transition(task.taskId,task.leaseToken,["CLAIMED","RUNNING"],retryable?"RETRY":"BLOCKED",{error:{code:classified.code??"EXECUTION_ERROR",message:classified.code??'EXECUTION_FAILED'},clearCheckpoint:!uncertain&&cancellationConfirmed&&!String(error).includes('CHECKPOINT_CONTEXT_MISMATCH')});
      await this.telemetry(task,retryable?"FAIL":"BLOCKED",start,uncertain&&hadCheckpointAtStart&&!task.checkpoint?.externalId?{quotaUnits:0,costAmount:0}:{}); return retryable?"FAIL":"BLOCKED";
    } finally { clearTimeout(timeout); clearInterval(heartbeat); }
  }
  private telemetry(task:any,outcome:string,start:number,result:any){ return this.store.recordTelemetry({jobId:task.jobId,taskId:task.taskId,attemptId:task.leaseToken,workerId:this.workerId,adapter:this.adapter.name,model:result.model,tool:result.tool,outcome,latencyMs:Date.now()-start,retryCount:Math.max(0,task.attempt-1),costAmount:result.costAmount,costCurrency:result.costCurrency,quotaUnits:result.quotaUnits,tokens:result.tokens,contextLoss:result.contextLoss,metadata:{taskType:task.taskType,promptVersion:task.promptVersion??"UNVERSIONED",risk:task.risk??"MEDIUM",qaPolicy:qaPolicy(task,result.qa),qaFeedback:result.qa?.feedback??[],qaConflict:result.qa?.conflict,humanCorrection:result.qa?.humanCorrection,errorType:result.error?.code,finalOutcome:outcome,externalOperationId:result.externalOperationId??task.checkpoint?.externalId,sharedResourcePoolId:result.sharedResourcePoolId,providerUsage:result.providerUsage,
   trace_id:task.taskId,job_id:task.jobId,task_id:task.taskId,attempt_id:task.leaseToken,provider:this.adapter.runtimeProfile?.provider??null,connector_id:this.adapter.runtimeProfile?.connector_id??this.adapter.name,
   provider_request_id:result.providerRequestId??null,external_operation_id:result.externalOperationId??task.checkpoint?.externalId??null,
   shared_resource_pool_id:result.sharedResourcePoolId??this.adapter.runtimeProfile?.shared_resource_pool_id??null,idempotency_key:connectorIdempotencyKey(this.adapter.name,task),
   credential_scope_class:this.adapter.runtimeProfile?.credential_scope_class??'UNKNOWN',capability_snapshot_version:this.adapter.runtimeProfile?.capability_snapshot_version??null,
   provider_execution_latency_ms:result.providerExecutionLatencyMs??null,local_processing_latency_ms:result.providerBoundaryElapsed===undefined?null:Math.max(0,Date.now()-start-result.providerBoundaryElapsed),
   provider_boundary_elapsed_ms:result.providerBoundaryElapsed??null,usage_actual:result.providerUsage??null,cost_actual:result.costAmount??null,quota_remaining:result.providerQuotaRemaining??null}}); }
}
