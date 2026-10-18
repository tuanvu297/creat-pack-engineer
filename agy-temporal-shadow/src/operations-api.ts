import type { Pool } from "pg";
import { LearningStore } from "./learning-store.js";
import { ResourceStore } from "./resource-store.js";
import { ResourceManager } from "./resources/manager.js";
import { allocateDemand } from "./resources/allocation.js";
import { competencyByTask } from "./competency.js";
import { LearningEngine } from "./learning-engine.js";

export async function operationsApi(path:string,method:string,body:any,pool:Pool,approvalActor?:string,projectScoped=false):Promise<unknown|undefined> {
  const learning=new LearningStore(pool,projectScoped);const resources=new ResourceStore(pool);
  if(path==="/v1/resources"&&method==="GET")return resources.list();
  if(path==="/v1/resources/register"&&method==="POST") {const manager=new ResourceManager();manager.register(body.resource);if(!body.adapter)throw new Error("ADAPTER_REQUIRED");return resources.register(body.resource,body.adapter);}
  if(path==="/v1/resources/allocate"&&method==="POST")return allocateDemand(body.demand,await resources.list(),Date.now(),body.pass_threshold??.8,body.excluded??[]);
  if(path==="/v1/resources/quota"&&method==="POST")return resources.reconcileQuota(body.worker_id,body.remaining);
  if(path==="/v1/resources/failure"&&method==="POST")return resources.fail(body.worker_id,body.kind,body.attempt,body.max_retry,body.retry_after_ms);
  if(path==="/v1/learning"&&method==="GET")return learning.read();
  if(path==="/v1/learning/packs"&&method==="GET")return new LearningEngine(()=>Date.now(),await learning.read()).skillPacks();
  if(path==="/v1/learning/competency"&&method==="GET") {
    const rows=(await pool.query(`SELECT * FROM agy_telemetry WHERE final_outcome IN ('PASS','FAIL','BLOCKED') ORDER BY created_at DESC LIMIT 10000`)).rows;
    return competencyByTask(rows.map(r=>({workerId:r.worker_id,model:r.model,tool:r.tool,taskType:r.task_type??"unknown",promptVersion:r.prompt_version??"UNVERSIONED",finalOutcome:r.final_outcome,retry:r.retry_count,errorType:r.error_type,latencyMs:r.latency_ms??0,costAmount:r.cost_amount===null?undefined:Number(r.cost_amount),qaFeedback:r.qa_feedback,humanCorrection:r.human_correction})));
  }
  if(path==="/v1/learning/process-events"&&method==="POST")return learning.processEvents(body.limit);
  if(path==="/v1/learning/raw-skill"&&method==="POST")return learning.transact(e=>{e.ingestSkill(body.skill);return {ingested:true};});
  if(path==="/v1/learning/candidate"&&method==="POST")return learning.transact(e=>{e.explore(body);return {candidateId:body.candidateId};});
  if(path==="/v1/learning/start-test"&&method==="POST")return learning.transact(e=>{e.startTest(body.candidate_id);return {stage:"TEST"};});
  if(path==="/v1/learning/evidence"&&method==="POST")return learning.transact(e=>{e.addEvidence(body.candidate_id,body.evidence);return {recorded:true};});
  if(path==="/v1/learning/report"&&method==="POST")return learning.transact(e=>e.report(body.candidate_id,body.pass_threshold??.8));
  if(path==="/v1/learning/reject"&&method==="POST")return learning.transact(e=>{e.reject(body.candidate_id,body.reason);return {rejected:true};});
  if(path==="/v1/learning/revalidate"&&method==="POST")return learning.transact(e=>{e.revalidate(body.tool,body.version);return {revalidationRequested:true};});
  if(path==="/v1/learning/regression"&&method==="POST")return learning.transact(e=>e.observeRegression(body.candidate_id,body.reason));
  if(path==="/v1/learning/rollback-proposal"&&method==="POST")return learning.transact(e=>e.proposeRollback(body.candidate_id,body.reason));
  if(path==="/v1/approvals/promote"&&method==="POST") {
    if(!approvalActor)throw new Error("APPROVAL_AUTHORITY_REQUIRED");
    return learning.transact(e=>{e.approve(body.candidate_id,approvalActor,body.report_fingerprint);e.promote(body.candidate_id,approvalActor);return {libraryPromoted:true,productionDeployed:false};});
  }
  if(path==="/v1/approvals/rollback"&&method==="POST") {
    if(!approvalActor)throw new Error("APPROVAL_AUTHORITY_REQUIRED");
    return learning.transact(e=>{e.rollback(body.candidate_id,approvalActor,true);return {libraryRolledBack:true,productionDeployed:false};});
  }
  return undefined;
}
