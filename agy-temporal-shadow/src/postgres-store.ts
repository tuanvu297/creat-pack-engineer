import { Pool } from "pg";
import type { ClaimRequest, ClaimedTask, EngineStore, TaskSpec, TaskStatus } from "./types.js";
import { queuePriority } from "./scheduler.js";
import { allocateDemand,sharedPoolProfiles } from "./resources/allocation.js";
import { resourceFromRow, ResourceStore } from "./resource-store.js";
import { createHash } from "node:crypto";
import type { ProjectScope } from './platform/scope.js';
import { selectProjectDemand } from './platform/allocation.js';

export class PostgresStore implements EngineStore {
  constructor(readonly pool: Pool, readonly scope?:ProjectScope) {}
  async createJob(input: { tenantId: string; idempotencyKey: string; objective: string; mode: any; passThreshold: number; tasks: TaskSpec[] }) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if(this.scope && input.tenantId!==this.scope.tenantId)throw new Error('PROJECT_SCOPE_DENIED');
      const conflict=this.scope?'tenant_id,workspace_id,project_id,idempotency_key':'tenant_id,idempotency_key';
      const job = await client.query(`INSERT INTO agy_jobs(tenant_id,idempotency_key,objective,mode,pass_threshold) VALUES($1,$2,$3,$4,$5) ON CONFLICT(${conflict}) DO NOTHING RETURNING job_id`, [input.tenantId,input.idempotencyKey,input.objective,input.mode,input.passThreshold]);
      if (!job.rowCount) {
        const existing = await client.query(`SELECT job_id FROM agy_jobs WHERE tenant_id=$1 AND idempotency_key=$2`, [input.tenantId,input.idempotencyKey]);
        await client.query("COMMIT"); return { jobId: existing.rows[0].job_id, duplicate: true };
      }
      const jobId = job.rows[0].job_id;
      const ids = new Map<string,string>();
      for (const task of input.tasks) { const row = await client.query(`INSERT INTO agy_tasks(job_id,idempotency_key,name,task_type,payload,required_capabilities,priority,max_retry,timeout_seconds,policy,importance,expected_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING task_id`, [jobId,task.idempotencyKey,task.name,task.taskType,task.payload??{},task.requiredCapabilities??[],queuePriority(task),task.maxRetry??2,task.timeoutSeconds??300,task,task.importance??.5,task.expectedValue??.5]); ids.set(task.idempotencyKey,row.rows[0].task_id); }
      for (const task of input.tasks) if (task.dependsOn?.length) await client.query(`UPDATE agy_tasks SET depends_on=$1 WHERE job_id=$2 AND idempotency_key=$3`, [task.dependsOn.map((key) => { const id=ids.get(key); if(!id) throw new Error(`Unknown dependency: ${key}`); return id; }),jobId,task.idempotencyKey]);
      await client.query("COMMIT"); return { jobId, duplicate: false };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async claim(request: ClaimRequest) {
    const client = await this.pool.connect();
    let selectedTaskId:string|undefined;
    try {
      await client.query("BEGIN");
      // Registry serializes resource reservations; task locks isolate concurrent execution.
      const registry = await client.query(`SELECT * FROM agy_workers ORDER BY worker_id FOR UPDATE`);
      const profiles = sharedPoolProfiles(registry.rows.map(resourceFromRow));
      if(this.scope) {
        // Registry locks are held through selection+claim+reservation, so another project cannot steal capacity.
        const dispatch=(await client.query(`SELECT d.*,p.name,p.status AS project_status,p.priority AS project_priority,p.resource_policy,p.permissions,p.active,p.quota_used,p.spend_used,p.adapter_kinds,p.health
          FROM agy_dispatch_tasks d JOIN agy_dispatch_projects p USING(tenant_id,workspace_id,project_id) WHERE d.available_at<=now()`)).rows;
        const selected=selectProjectDemand(dispatch.map(d=>({project:{tenantId:d.tenant_id,workspaceId:d.workspace_id,projectId:d.project_id,name:d.name,status:d.project_status,priority:d.project_priority,resourcePolicy:d.resource_policy,permissions:d.permissions,sourceOfTruthRef:'not-loaded',policyRef:'not-loaded',defaultSkillPack:'',policies:{},createdAt:0,updatedAt:0},
          jobId:d.job_id,taskId:d.task_id,task:d.policy,active:Number(d.active),quotaUsed:Number(d.quota_used),spendUsed:Number(d.spend_used),passThreshold:Number(d.pass_threshold),excluded:[...d.failed_workers,...d.health.filter((h:any)=>new Date(h.until).getTime()>Date.now()).map((h:any)=>h.workerId)],
          allowedWorkers:registry.rows.filter(w=>d.adapter_kinds.includes(w.adapter)&&(!d.policy.checkpointAdapter||w.adapter===d.policy.checkpointAdapter)).map(w=>w.worker_id)})),profiles);
        if(!selected||selected.allocation.workerId!==request.workerId||selected.scope!==JSON.stringify([this.scope.tenantId,this.scope.workspaceId,this.scope.projectId])){await client.query('COMMIT');return null;}
        // Only the globally selected task is eligible in this transaction.
        selectedTaskId=selected.taskId;
        const project=(await client.query(`SELECT * FROM agy_projects`)).rows[0];
        if(!project||project.status!=='ACTIVE') {await client.query('COMMIT');return null;}
        const blocked=(await client.query(`SELECT worker_id FROM agy_project_worker_health WHERE blocked_until>now()`)).rows;
        for(const profile of profiles)if(blocked.some(r=>r.worker_id===profile.workerId)){profile.ready=false;profile.status='DEGRADED';}
        const usage=(await client.query(`SELECT (SELECT count(*) FROM agy_tasks WHERE status IN ('CLAIMED','RUNNING')) AS active,
          coalesce(sum(coalesce(actual_quota,expected_quota)),0) AS quota,coalesce(sum(coalesce(actual_cost,expected_cost)),0) AS cost FROM agy_resource_reservations`)).rows[0];
        if(Number(usage.active)>=Number(project.resource_policy.maxConcurrentTasks??0)) {await client.query('COMMIT');return null;}
        // Project budgets are enforced alongside the global provider balance/reserve.
        for(const profile of profiles) {
          profile.quotaCap=profile.quotaCap===null?null:Math.min(profile.quotaCap-profile.quotaUsed,Number(project.resource_policy.quotaCap??0)-Number(usage.quota));
          profile.spendCap=profile.spendCap===null?null:Math.min(profile.spendCap-profile.spendUsed,Number(project.resource_policy.spendCap??0)-Number(usage.cost));
          profile.quotaUsed=0;profile.spendUsed=0;
          profile.permissions=profile.permissions.filter(p=>project.permissions.includes(p));
        }
      }
      const candidates = await client.query(`SELECT t.*,j.mode,j.pass_threshold FROM agy_tasks t JOIN agy_jobs j USING(job_id)
        WHERE t.status IN ('QUEUED','RETRY') AND t.available_at<=now()
        AND NOT EXISTS(SELECT 1 FROM unnest(t.depends_on) dep LEFT JOIN agy_tasks d ON d.task_id=dep WHERE d.status IS DISTINCT FROM 'PASS')
        ORDER BY t.priority DESC,t.available_at,t.created_at LIMIT 50 FOR UPDATE OF t SKIP LOCKED`);
      for (const row of candidates.rows) {
        if(this.scope && row.task_id!==selectedTaskId)continue;
        const spec = mapClaim(row);
        if(spec.checkpoint&&registry.rows.find(w=>w.worker_id===request.workerId)?.adapter!==spec.checkpoint.adapter)continue;
        // Scoped dispatch already selected an enabled project connector's worker. Do not reroute
        // locally to a globally registered provider that is not bound to this project.
        const excluded=spec.checkpoint?row.failed_workers.filter((id:string)=>registry.rows.find(w=>w.worker_id===id)?.adapter!==spec.checkpoint!.adapter):row.failed_workers;
        const allocation = allocateDemand({...spec,jobId:row.job_id}, this.scope?profiles.filter(p=>p.workerId===request.workerId):profiles, Date.now(),Number(row.pass_threshold), excluded);
        if (allocation.workerId !== request.workerId) continue;
        const active = await client.query(`SELECT policy FROM agy_tasks WHERE status IN ('CLAIMED','RUNNING','QA') AND task_id<>$1 AND (job_id=$2 OR policy->>'sharedStateKey'=$3)`,[row.task_id,row.job_id,spec.sharedStateKey??null]);
        if ((row.mode==='SINGLE_WORKFLOW' && active.rowCount) || (spec.sharedStateKey && active.rows.some(a=>a.policy.sharedStateKey===spec.sharedStateKey))) continue;
        const updated = await client.query(`UPDATE agy_tasks SET status='CLAIMED',claimed_by=$2,lease_token=gen_random_uuid(),lease_expires_at=now()+make_interval(secs=>$3),heartbeat_at=now(),attempt=attempt+1,updated_at=now() WHERE task_id=$1 RETURNING *`,[row.task_id,request.workerId,request.leaseSeconds]);
        const claimed=updated.rows[0];
        await client.query(`UPDATE agy_workers SET active_count=active_count+1,quota_remaining=quota_remaining-$2,
          resource_profile=jsonb_set(jsonb_set(resource_profile,'{spendUsed}',to_jsonb(coalesce((resource_profile->>'spendUsed')::numeric,0)+$3)),
          '{quotaUsed}',to_jsonb(coalesce((resource_profile->>'quotaUsed')::numeric,0)+$2)),updated_at=now() WHERE worker_id=$1`,[request.workerId,spec.estimatedQuota??0,spec.estimatedCost??0]);
        await client.query(`INSERT INTO agy_resource_reservations(reservation_id,task_id,job_id,worker_id,attempt,expected_quota,expected_cost) VALUES($1,$2,$3,$4,$5,$6,$7)`,[claimed.lease_token,row.task_id,row.job_id,request.workerId,claimed.attempt,spec.estimatedQuota??0,spec.estimatedCost??0]);
        await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'RESOURCE_ALLOCATION','CLAIMED',$3,$4)`,[row.job_id,row.task_id,request.workerId,allocation]);
        await client.query(`UPDATE agy_jobs SET status='RUNNING',updated_at=now() WHERE job_id=$1`,[row.job_id]);
        await client.query("COMMIT"); return {...mapClaim(updated.rows[0]),passThreshold:Number(row.pass_threshold)};
      }
      await client.query("COMMIT"); return null;
    } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
  }
  async heartbeat(taskId:string,workerId:string,leaseToken:string,leaseSeconds:number) { const result=await this.pool.query(`UPDATE agy_tasks SET heartbeat_at=now(),lease_expires_at=now()+make_interval(secs=>$4),updated_at=now() WHERE task_id=$1 AND claimed_by=$2 AND lease_token=$3 AND status IN ('CLAIMED','RUNNING') AND lease_expires_at>now()`,[taskId,workerId,leaseToken,leaseSeconds]); return result.rowCount===1; }
  async transition(taskId:string,leaseToken:string,from:TaskStatus[],to:TaskStatus,patch:Record<string,unknown>={}) {
    const update=`UPDATE agy_tasks SET status=$3::text::agy_task_status,result=COALESCE($4,result),error=COALESCE($5,error),policy=CASE WHEN $7 AND checkpoint->>'externalId' IS NOT NULL THEN jsonb_set(policy,'{submissionGeneration}',to_jsonb(coalesce((policy->>'submissionGeneration')::integer,0)+1)) ELSE policy END,checkpoint=CASE WHEN $7 THEN NULL ELSE checkpoint END,available_at=CASE WHEN $3::text='RETRY' THEN now()+make_interval(secs=>least(60,power(2,least(attempt,6))::integer)) ELSE available_at END,finished_at=CASE WHEN $3::text IN ('PASS','FAIL','BLOCKED','CANCELLED') THEN now() ELSE finished_at END,updated_at=now() WHERE task_id=$1 AND lease_token=$2 AND status=ANY($6::agy_task_status[]) AND (status='QA' OR lease_expires_at>now())`;
    const values:unknown[]=[taskId,leaseToken,to,patch.result??null,patch.error??null,from,patch.clearCheckpoint===true];
    const client=await this.pool.connect();try{
      await client.query('BEGIN');await client.query('SELECT worker_id FROM agy_workers ORDER BY worker_id FOR UPDATE');const result=await client.query(update+' RETURNING task_id,job_id',values);
      if(!result.rowCount){await client.query('COMMIT');return false;}
      const jobId=result.rows[0].job_id;
      if(this.scope&&to==='QA')await client.query(`INSERT INTO agy_qa_results(task_id,job_id,verdict,evidence,reviewed_by) VALUES($1,$2,$3,$4,current_setting('agy.subject'))`,[taskId,jobId,patch.qaVerdict??'PENDING',patch.qaEvidence??{}]);
      await this.aggregateJob(client,jobId);
      await client.query('COMMIT');return true;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  private async aggregateJob(client:any,jobId:string){await client.query(`UPDATE agy_jobs SET status=(CASE
    WHEN NOT EXISTS(SELECT 1 FROM agy_tasks WHERE job_id=$1 AND status<>'PASS') THEN 'PASS'
    WHEN EXISTS(SELECT 1 FROM agy_tasks WHERE job_id=$1 AND status IN ('FAIL','BLOCKED','CANCELLED')) THEN 'BLOCKED'
    WHEN EXISTS(SELECT 1 FROM agy_tasks WHERE job_id=$1 AND status IN ('CLAIMED','RUNNING')) THEN 'RUNNING'
    WHEN EXISTS(SELECT 1 FROM agy_tasks WHERE job_id=$1 AND status='QA') THEN 'QA' ELSE 'QUEUED' END)::agy_job_status,updated_at=now() WHERE job_id=$1`,[jobId]);}
  async reclaimExpired(){
    const client=await this.pool.connect();try{await client.query("BEGIN");
      await client.query(`SELECT worker_id FROM agy_workers ORDER BY worker_id FOR UPDATE`);
      const expired=await client.query(`SELECT task_id,job_id,lease_token,claimed_by FROM agy_tasks WHERE status IN ('CLAIMED','RUNNING') AND lease_expires_at<now() FOR UPDATE SKIP LOCKED`);
      for(const row of expired.rows){
        await client.query(`UPDATE agy_resource_reservations SET state='EXPIRED' WHERE reservation_id=$1 AND state='HELD'`,[row.lease_token]);
        if(this.scope)await client.query(`INSERT INTO agy_project_worker_health(worker_id,blocked_until,error_code) VALUES($1,now()+interval '30 seconds','LEASE_EXPIRED') ON CONFLICT(tenant_id,workspace_id,project_id,worker_id) DO UPDATE SET blocked_until=EXCLUDED.blocked_until,error_code=EXCLUDED.error_code`,[row.claimed_by]);
        else await client.query(`UPDATE agy_workers SET status='DEGRADED' WHERE worker_id=$1`,[row.claimed_by]);
        await client.query(`UPDATE agy_tasks SET status=CASE WHEN attempt<=max_retry THEN 'RETRY'::agy_task_status ELSE 'BLOCKED'::agy_task_status END,claimed_by=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL,available_at=now(),error='{"code":"LEASE_EXPIRED"}',updated_at=now() WHERE task_id=$1`,[row.task_id]);
        await this.aggregateJob(client,row.job_id);
      }
      if(this.scope) {
        // Failure exclusions expire with task-local backoff/cooldown; permanent/uncertain
        // BLOCKED tasks are never reopened. A sole eligible worker can retry safely.
        const retryRows=(await client.query(`SELECT t.*,j.pass_threshold FROM agy_tasks t JOIN agy_jobs j USING(job_id)
         WHERE t.status='RETRY' AND t.available_at<=now() AND cardinality(t.failed_workers)>0 FOR UPDATE OF t SKIP LOCKED`)).rows;
        const profiles=sharedPoolProfiles((await client.query('SELECT * FROM agy_workers')).rows.map(resourceFromRow));
        const kinds=(await client.query('SELECT kind FROM agy_connectors WHERE enabled')).rows.map(r=>r.kind);
        const cooldown=(await client.query('SELECT worker_id FROM agy_project_worker_health WHERE blocked_until>now()')).rows.map(r=>r.worker_id);
        // Resource does not carry adapter; derive the binding from registry separately.
        const registry=(await client.query('SELECT worker_id,adapter FROM agy_workers')).rows;
        for(const row of retryRows) {
          const candidates=profiles.filter(p=>{const adapter=registry.find(w=>w.worker_id===p.workerId)?.adapter;return kinds.includes(adapter)&&(!row.checkpoint||adapter===row.checkpoint.adapter);});
          const alternative=allocateDemand(mapClaim(row),candidates,Date.now(),Number(row.pass_threshold),[...row.failed_workers,...cooldown]);
          if(!alternative.workerId)await client.query('UPDATE agy_tasks SET failed_workers=$2,updated_at=now() WHERE task_id=$1',
            [row.task_id,row.failed_workers.filter((id:string)=>cooldown.includes(id))]);
        }
      }
      await client.query("COMMIT");return expired.rows.length;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async recordWorkerFailure(workerId:string,code:string,attempt:number,maxRetry:number){
    if(this.scope) {
      await this.pool.query(`INSERT INTO agy_project_worker_health(worker_id,blocked_until,error_code) VALUES($1,now()+make_interval(secs=>$3),$2)
        ON CONFLICT(tenant_id,workspace_id,project_id,worker_id) DO UPDATE SET blocked_until=EXCLUDED.blocked_until,error_code=EXCLUDED.error_code`,[workerId,code,Math.min(30,2**Math.min(attempt,5))]);
      return;
    }
    const kind=code==='RATE_LIMIT'||code==='429'?'RATE_LIMIT':code==='PERMISSION_DENIED'?'PERMISSION':code==='INVALID_INPUT'?'INVALID_INPUT':code.includes('TIMEOUT')?'TIMEOUT':'TRANSIENT';
    const recovery=await new ResourceStore(this.pool).fail(workerId,kind,attempt,maxRetry);
    await this.pool.query(`UPDATE agy_tasks SET available_at=to_timestamp($2/1000.0) WHERE claimed_by=$1 AND status='RUNNING'`,[workerId,recovery.availableAt]);
  }
  async saveCheckpoint(task:ClaimedTask,externalId:string,adapter:string) {
    const digest=createHash('sha256').update(JSON.stringify(task.payload??{})).digest('hex');
    const client=await this.pool.connect();try {await client.query("BEGIN");
      const result=await client.query(`UPDATE agy_tasks SET checkpoint_version=checkpoint_version+1,checkpoint=coalesce(checkpoint,'{}'::jsonb)||$3::jsonb WHERE task_id=$1 AND lease_token=$2 AND lease_expires_at>now() AND status='RUNNING' RETURNING checkpoint_version`,[task.taskId,task.leaseToken,{externalId,digest,adapter,submissionState:'ACCEPTED'}]);
      if(!result.rowCount)throw new Error("STALE_CHECKPOINT_WRITER");
      await client.query(`INSERT INTO agy_checkpoints(task_id,version,attempt_id,external_id,context_digest,data) VALUES($1,$2,$3,$4,$5,$6)`,[task.taskId,result.rows[0].checkpoint_version,task.leaseToken,externalId,digest,{externalId,digest,adapter}]);await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  async saveSubmissionIntent(task:ClaimedTask,adapter:string,idempotencyKey:string){
    const digest=createHash('sha256').update(JSON.stringify(task.payload??{})).digest('hex');
    const result=await this.pool.query(`UPDATE agy_tasks SET checkpoint=$3,updated_at=now() WHERE task_id=$1 AND lease_token=$2 AND lease_expires_at>now() AND status='RUNNING' AND checkpoint IS NULL`,[task.taskId,task.leaseToken,{submissionState:'INTENT',adapter,digest,idempotencyKey}]);
    if(result.rowCount!==1)throw new Error('STALE_SUBMISSION_INTENT');
  }
  async deferTask(task:ClaimedTask,workerId:string,retryAfterMs:number,code:string){
    if(!Number.isFinite(retryAfterMs)||retryAfterMs<0)throw new Error('INVALID_RETRY_AFTER');
    const client=await this.pool.connect();try{await client.query('BEGIN');
      await client.query('SELECT worker_id FROM agy_workers ORDER BY worker_id FOR UPDATE');
      const result=await client.query(`UPDATE agy_tasks SET status=CASE WHEN attempt<=max_retry THEN 'RETRY'::agy_task_status ELSE 'BLOCKED'::agy_task_status END,
       available_at=now()+($3::double precision*interval '1 millisecond'),error=$4,updated_at=now()
       WHERE task_id=$1 AND lease_token=$2 AND lease_expires_at>now() AND status='RUNNING' RETURNING job_id`,[task.taskId,task.leaseToken,retryAfterMs,{code,retry_after_ms:retryAfterMs}]);
      if(!result.rowCount){await client.query('COMMIT');return false;}
      // A throttled, not-submitted request consumes no usage. Retain provider context if already submitted.
      if(!task.checkpoint?.externalId){
       await client.query(`UPDATE agy_tasks SET checkpoint=NULL WHERE task_id=$1`,[task.taskId]);
       const held=await client.query(`SELECT * FROM agy_resource_reservations WHERE reservation_id=$1 AND state='HELD' FOR UPDATE`,[task.leaseToken]);
       if(held.rowCount){const h=held.rows[0];await client.query(`UPDATE agy_workers SET quota_remaining=quota_remaining+$2,
        resource_profile=jsonb_set(jsonb_set(resource_profile,'{quotaUsed}',to_jsonb(coalesce((resource_profile->>'quotaUsed')::numeric,0)-$2)),
        '{spendUsed}',to_jsonb(coalesce((resource_profile->>'spendUsed')::numeric,0)-$3)) WHERE worker_id=$1`,[workerId,Number(h.expected_quota),Number(h.expected_cost)]);
        await client.query(`UPDATE agy_resource_reservations SET state='SETTLED',actual_quota=0,actual_cost=0 WHERE reservation_id=$1`,[task.leaseToken]);}
      }
      await this.aggregateJob(client,result.rows[0].job_id);await client.query('COMMIT');return true;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async recordTelemetry(input:Record<string,unknown>){
    const client=await this.pool.connect();try {await client.query("BEGIN");
      await client.query('SELECT worker_id FROM agy_workers ORDER BY worker_id FOR UPDATE');
      await client.query(`INSERT INTO agy_telemetry(job_id,task_id,worker_id,adapter,model,tool,outcome,latency_ms,retry_count,cost_amount,cost_currency,quota_units,metadata,attempt_id,usage_tokens,context_loss)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(task_id,attempt_id,outcome) WHERE attempt_id IS NOT NULL DO NOTHING`,[input.jobId,input.taskId??null,input.workerId??null,input.adapter??null,input.model??null,input.tool??null,input.outcome,input.latencyMs??null,input.retryCount??0,input.costAmount??null,input.costCurrency??null,input.quotaUnits??null,input.metadata??{},input.attemptId??null,input.tokens??null,input.contextLoss??null]);
      if(input.attemptId) {
        const externalId=(input.metadata as Record<string,unknown>|undefined)?.externalOperationId;
        const operationReservations=this.scope&&externalId&&input.taskId?await client.query(`SELECT * FROM agy_resource_reservations WHERE task_id=$1 AND
          (reservation_id=$2 OR reservation_id IN(SELECT attempt_id FROM agy_checkpoints WHERE task_id=$1 AND external_id=$3)) ORDER BY attempt,created_at FOR UPDATE`,[input.taskId,input.attemptId,externalId]):undefined;
        if(operationReservations?.rowCount){
          const rows=operationReservations.rows;
          const knownQuota=typeof input.quotaUnits==='number'&&Number.isFinite(input.quotaUnits)&&input.quotaUnits>=0;
          const knownCost=typeof input.costAmount==='number'&&Number.isFinite(input.costAmount)&&input.costAmount>=0;
          const quota=knownQuota?Number(input.quotaUnits):Math.max(...rows.map(r=>Number(r.actual_quota??r.expected_quota)));
          const cost=knownCost?Number(input.costAmount):Math.max(...rows.map(r=>Number(r.actual_cost??r.expected_cost)));
          for(let index=0;index<rows.length;index++){
            const r=rows[index],previousQuota=Number(r.actual_quota??r.expected_quota),previousCost=Number(r.actual_cost??r.expected_cost),assignedQuota=index===0?quota:0,assignedCost=index===0?cost:0;
            await client.query(`UPDATE agy_workers SET quota_remaining=quota_remaining+$2-$3,
              resource_profile=jsonb_set(jsonb_set(resource_profile,'{spendUsed}',to_jsonb(coalesce((resource_profile->>'spendUsed')::numeric,0)-$4+$5)),
              '{quotaUsed}',to_jsonb(coalesce((resource_profile->>'quotaUsed')::numeric,0)-$2+$3)),updated_at=now() WHERE worker_id=$1`,[r.worker_id,previousQuota,assignedQuota,previousCost,assignedCost]);
            await client.query(`UPDATE agy_resource_reservations SET state='SETTLED',actual_quota=$2,actual_cost=$3 WHERE reservation_id=$1`,[r.reservation_id,knownQuota||index>0?assignedQuota:null,knownCost||index>0?assignedCost:null]);
          }
        }else{
        const held=await client.query(`SELECT * FROM agy_resource_reservations WHERE reservation_id=$1 AND state IN ('HELD','EXPIRED') FOR UPDATE`,[input.attemptId]);
        if(held.rowCount){const h=held.rows[0];const actualQuota=input.quotaUnits??Number(h.expected_quota);const actualCost=input.costAmount??Number(h.expected_cost);
          await client.query(`UPDATE agy_workers SET quota_remaining=quota_remaining+$2-$3,resource_profile=jsonb_set(jsonb_set(resource_profile,'{spendUsed}',to_jsonb(coalesce((resource_profile->>'spendUsed')::numeric,0)-$4+$5)),'{quotaUsed}',to_jsonb(coalesce((resource_profile->>'quotaUsed')::numeric,0)-$2+$3)),updated_at=now() WHERE worker_id=$1`,[h.worker_id,Number(h.expected_quota),actualQuota,Number(h.expected_cost),actualCost]);
          await client.query(`UPDATE agy_resource_reservations SET state='SETTLED',actual_quota=$2,actual_cost=$3 WHERE reservation_id=$1`,[input.attemptId,input.quotaUnits??null,input.costAmount??null]);
        }
        }
      }
      if(this.scope&&input.jobId)await this.aggregateJob(client,String(input.jobId));
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
}
function mapClaim(row:any):ClaimedTask { return { ...row.policy,taskId:row.task_id,jobId:row.job_id,idempotencyKey:row.idempotency_key,name:row.name,taskType:row.task_type,payload:row.payload,requiredCapabilities:row.required_capabilities,dependsOn:row.depends_on,priority:row.priority,maxRetry:row.max_retry,timeoutSeconds:row.timeout_seconds,status:row.status,attempt:row.attempt,leaseToken:row.lease_token,leaseExpiresAt:new Date(row.lease_expires_at),checkpoint:row.checkpoint }; }
