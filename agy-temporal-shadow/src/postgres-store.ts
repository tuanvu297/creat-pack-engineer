import { Pool } from "pg";
import type { ClaimRequest, ClaimedTask, EngineStore, TaskSpec, TaskStatus } from "./types.js";
import { queuePriority } from "./scheduler.js";
import { allocateDemand,sharedPoolProfiles } from "./resources/allocation.js";
import { resourceFromRow, ResourceStore } from "./resource-store.js";
import { createHash } from "node:crypto";
import type { ProjectScope } from './platform/scope.js';
import { selectProjectDemand } from './platform/allocation.js';
import { workerGatePasses } from './platform/worker-gate.js';

export class PostgresStore implements EngineStore {
  constructor(readonly pool: Pool, readonly scope?:ProjectScope) {}
  // Transaction-wide owner deadline fence (qualification route
  // only, opt-in via a deadlineMs argument): reads the database
  // wall clock (clock_timestamp(), never the transaction-start
  // now()) in its OWN statement at the point of the call. The
  // deadline variants place it immediately before COMMIT, AFTER
  // every write of the transaction, so a wait that begins after
  // the method's post-lock clock read — a write trigger, an
  // event/outbox insert, a worker-counter, reservation or
  // job-aggregate lock — still rolls the WHOLE transaction back
  // instead of committing half of it late (H1, extending the F2
  // post-lock pattern). Returns false when no deadline applies,
  // so callers without one keep pin semantics exactly. Read-only
  // paths (result QA replay, checkpoint replay, readback,
  // recover) never call this: they mutate nothing and stay
  // answerable past the deadline. Cleanup never carries a
  // deadline either: it runs BECAUSE the deadline passed.
  private async deadlineCrossed(client:any, deadlineMs?:number): Promise<boolean> {
    if (!deadlineMs) return false;
    const now=(await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now;
    return new Date(now).getTime()>=deadlineMs;
  }
  async createJob(input: { tenantId: string; idempotencyKey: string; objective: string; mode: any; passThreshold: number; tasks: TaskSpec[]; deadlineMs?: number }) {
    const client = await this.pool.connect();
    // Absolute owner fence at the mutation transaction itself
    // (candidate, opt-in via deadlineMs): the database's real clock
    // (clock_timestamp(), never the transaction-start now()) is
    // checked when the transaction opens AND again after the
    // inserts, before COMMIT — a lock wait anywhere inside this
    // transaction that spans the deadline therefore rolls the whole
    // creation back instead of committing a late job. Callers
    // without a deadline are untouched.
    const fence = async () => {
      if (!input.deadlineMs) return;
      const now = (await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now;
      if (new Date(now).getTime() >= input.deadlineMs) throw new Error('JOB_CREATION_DEADLINE_EXCEEDED');
    };
    try {
      await client.query("BEGIN");
      await fence();
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
      await fence();
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
      // Absolute deadline (candidate, opt-in via the request): the
      // check runs AFTER the registry lock is held — the lock wait
      // itself may have crossed the deadline, and a claim that
      // starts late must not lease at all. Callers without a
      // deadline are untouched.
      if (request.deadlineMs && Date.now() > request.deadlineMs) { await client.query('COMMIT'); return null; }
      if(this.scope) {
        // Registry locks are held through selection+claim+reservation, so another project cannot steal capacity.
        // Demand selection stays GLOBAL and pin-exact for the ungated
        // route (B1): the dispatch query below is the pin's, with NO
        // agy_tasks join — joining the RLS-scoped task table would hide
        // other projects' demand from selectProjectDemand and break
        // cross-project priority fairness for legacy callers.
        const dispatchAll=(await client.query(`SELECT d.*,p.name,p.status AS project_status,p.priority AS project_priority,p.resource_policy,p.permissions,p.active,p.quota_used,p.spend_used,p.adapter_kinds,p.health
          FROM agy_dispatch_tasks d JOIN agy_dispatch_projects p USING(tenant_id,workspace_id,project_id) WHERE d.available_at<=now()`)).rows;
        // Worker gate (candidate): when the claim carries a gate (the
        // NEW gated namespace only), demand is filtered INSIDE this
        // transaction, before selection/allocation — a forbidden task
        // is never claimed, attempted, or reserved. The projection's
        // policy omits the task payload, so the gate reads payloads
        // from agy_tasks directly; that read is RLS-scoped to this
        // project, which is exactly the gated namespace's reach (a
        // gated claim can only ever lease in-scope tasks). The ungated
        // route applies NO payload filter: legacy semantics, including
        // for addressed tasks, are unchanged from the pin.
        // External-namespace isolation on the ungated route is done
        // through the registry, not payloads: a worker whose metadata
        // marks it external_namespace_only (the NEW external
        // qualification worker) is excluded from allowedWorkers below
        // whenever the claim carries no gate, so the legacy allocator
        // can never select it — in any project — while its own gated
        // claims are unaffected.
        let dispatch=dispatchAll;
        if(request.gate){
          const payloadRows=(await client.query(`SELECT task_id,payload FROM agy_tasks`)).rows;
          const payloadById=new Map(payloadRows.map((r:any)=>[r.task_id,r.payload]));
          dispatch=dispatchAll.filter((d:any)=>workerGatePasses(request.gate!,{...d.policy,payload:payloadById.get(d.task_id)}));
        }
        const selected=selectProjectDemand(dispatch.map(d=>({project:{tenantId:d.tenant_id,workspaceId:d.workspace_id,projectId:d.project_id,name:d.name,status:d.project_status,priority:d.project_priority,resourcePolicy:d.resource_policy,permissions:d.permissions,sourceOfTruthRef:'not-loaded',policyRef:'not-loaded',defaultSkillPack:'',policies:{},createdAt:0,updatedAt:0},
          jobId:d.job_id,taskId:d.task_id,task:d.policy,active:Number(d.active),quotaUsed:Number(d.quota_used),spendUsed:Number(d.spend_used),passThreshold:Number(d.pass_threshold),excluded:[...d.failed_workers,...d.health.filter((h:any)=>new Date(h.until).getTime()>Date.now()).map((h:any)=>h.workerId)],
          allowedWorkers:registry.rows.filter(w=>d.adapter_kinds.includes(w.adapter)&&(!d.policy.checkpointAdapter||w.adapter===d.policy.checkpointAdapter)&&(!!request.gate||w.metadata?.external_namespace_only!==true)).map(w=>w.worker_id)})),profiles);
        if(!selected||selected.allocation.workerId!==request.workerId||selected.scope!==JSON.stringify([this.scope.tenantId,this.scope.workspaceId,this.scope.projectId])){await client.query('COMMIT');return null;}
        // Only the globally selected task is eligible in this transaction.
        selectedTaskId=selected.taskId;
        const project=(await client.query(`SELECT * FROM agy_projects`)).rows[0];
        if(!project||project.status!=='ACTIVE') {await client.query('COMMIT');return null;}
        const blocked=(await client.query(`SELECT worker_id FROM agy_project_worker_health WHERE blocked_until>now()`)).rows;
        for(const profile of profiles)if(blocked.some(r=>r.worker_id===profile.workerId)){profile.ready=false;profile.status='DEGRADED';}
        const usage=(await client.query(`SELECT (SELECT count(*) FROM agy_tasks WHERE status IN ('CLAIMED','RUNNING')) AS active,
          coalesce(sum(coalesce(actual_quota,expected_quota)),0) AS quota,coalesce(sum(coalesce(actual_cost,expected_cost)),0) AS cost FROM agy_resource_reservations WHERE state IN ('HELD','SETTLED')`)).rows[0];
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
        if (request.deadlineMs && Date.now() > request.deadlineMs) break;
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
        const updated = await client.query(`UPDATE agy_tasks SET status='CLAIMED',claimed_by=$2,lease_token=gen_random_uuid(),lease_expires_at=LEAST(now()+make_interval(secs=>$3),COALESCE($4::timestamptz,'infinity'::timestamptz)),heartbeat_at=now(),attempt=attempt+1,updated_at=now() WHERE task_id=$1 RETURNING *`,[row.task_id,request.workerId,request.leaseSeconds,request.deadlineMs?new Date(request.deadlineMs).toISOString():null]);
        const claimed=updated.rows[0];
        await client.query(`UPDATE agy_workers SET active_count=active_count+1,quota_remaining=quota_remaining-$2,
          resource_profile=jsonb_set(jsonb_set(resource_profile,'{spendUsed}',to_jsonb(coalesce((resource_profile->>'spendUsed')::numeric,0)+$3)),
          '{quotaUsed}',to_jsonb(coalesce((resource_profile->>'quotaUsed')::numeric,0)+$2)),updated_at=now() WHERE worker_id=$1`,[request.workerId,spec.estimatedQuota??0,spec.estimatedCost??0]);
        await client.query(`INSERT INTO agy_resource_reservations(reservation_id,task_id,job_id,worker_id,attempt,expected_quota,expected_cost) VALUES($1,$2,$3,$4,$5,$6,$7)`,[claimed.lease_token,row.task_id,row.job_id,request.workerId,claimed.attempt,spec.estimatedQuota??0,spec.estimatedCost??0]);
        await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'RESOURCE_ALLOCATION','CLAIMED',$3,$4)`,[row.job_id,row.task_id,request.workerId,allocation]);
        await client.query(`UPDATE agy_jobs SET status='RUNNING',updated_at=now() WHERE job_id=$1`,[row.job_id]);
        // Transaction-wide deadline fence (opt-in, H1): every
        // write of this claim is staged, but any of them — the
        // task UPDATE, the counters, the reservation, the job
        // aggregate — may have waited on a database lock past the
        // cutoff. Read the wall clock in its own statement NOW
        // and roll the WHOLE claim back if it crossed: no lease,
        // attempt, counter, reservation, or event may commit
        // late. Callers without a deadline skip this entirely.
        if (await this.deadlineCrossed(client, request.deadlineMs)) { await client.query('ROLLBACK'); return null; }
        await client.query("COMMIT"); return {...mapClaim(updated.rows[0]),passThreshold:Number(row.pass_threshold)};
      }
      await client.query("COMMIT"); return null;
    } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
  }
  async heartbeat(taskId:string,workerId:string,leaseToken:string,leaseSeconds:number,deadlineMs?:number) {
    // Without a deadline the statement is the pin's, unchanged.
    if (!deadlineMs) {
      const result=await this.pool.query(`UPDATE agy_tasks SET heartbeat_at=now(),lease_expires_at=now()+make_interval(secs=>$4),updated_at=now() WHERE task_id=$1 AND claimed_by=$2 AND lease_token=$3 AND status IN ('CLAIMED','RUNNING') AND lease_expires_at>now()`,[taskId,workerId,leaseToken,leaseSeconds]);
      return result.rowCount===1;
    }
    // With a deadline (qualification route only) the fence must be
    // a real-clock read taken AFTER the task row lock is held, in
    // its own statement. Two tempting shortcuts do NOT work
    // (both proven against PostgreSQL 18): a single UPDATE with
    // clock_timestamp() in its WHERE still updates the row after
    // a lock wait spanning the deadline (rowCount 1, past
    // deadline); and clock_timestamp() in the locking SELECT's
    // target list is bound at the first tuple fetch — i.e. BEFORE
    // the wait — not when the lock is granted. So: lock the row
    // (statement 1), read clock_timestamp() (statement 2, starts
    // only once the lock is held), compare, and only then write —
    // one transaction, the write's timestamps derived from that
    // same post-lock read.
    const client=await this.pool.connect();try{
      await client.query('BEGIN');
      const locked=await client.query(`SELECT lease_expires_at FROM agy_tasks WHERE task_id=$1 AND claimed_by=$2 AND lease_token=$3 AND status IN ('CLAIMED','RUNNING') FOR UPDATE`,[taskId,workerId,leaseToken]);
      const row=locked.rows[0];
      if(!row){await client.query('ROLLBACK');return false;}
      const nowMs=new Date((await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now).getTime();
      if(nowMs>=deadlineMs||!row.lease_expires_at||new Date(row.lease_expires_at).getTime()<=nowMs){await client.query('ROLLBACK');return false;}
      const result=await client.query(`UPDATE agy_tasks SET heartbeat_at=$4::timestamptz,lease_expires_at=LEAST($4::timestamptz+make_interval(secs=>$5),$6::timestamptz),updated_at=$4::timestamptz WHERE task_id=$1 AND claimed_by=$2 AND lease_token=$3 AND status IN ('CLAIMED','RUNNING')`,
        [taskId,workerId,leaseToken,new Date(nowMs).toISOString(),leaseSeconds,new Date(deadlineMs).toISOString()]);
      // Final pre-COMMIT fence (H1, transaction-wide): the write
      // itself can still wait past the deadline after the
      // post-lock read above (e.g. on a trigger fired by the task
      // UPDATE); a crossed deadline rolls the heartbeat back.
      if(await this.deadlineCrossed(client,deadlineMs)){await client.query('ROLLBACK');return false;}
      await client.query('COMMIT');
      return result.rowCount===1;
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
  }
  async transition(taskId:string,leaseToken:string,from:TaskStatus[],to:TaskStatus,patch:Record<string,unknown>={},deadlineMs?:number) {
    // Optional worker binding (worker-surface v2): when patch.workerId is
    // present the transition additionally requires the task to be claimed
    // by exactly that worker. Existing callers omit it and are unchanged.
    // Optional absolute deadline (qualification route only): after the
    // registry lock is held, the database wall clock
    // (clock_timestamp(), not the transaction-start now()) is read —
    // if the lock wait itself crossed the deadline the transition
    // refuses (returns false) and nothing mutates; the lease
    // predicate in the deadline variant likewise uses
    // clock_timestamp(). Callers without a deadline keep pin text.
    const workerClause=typeof patch.workerId==='string'?' AND claimed_by=$8':'';
    const leasePredicate=deadlineMs?'(status=\'QA\' OR lease_expires_at>clock_timestamp())':'(status=\'QA\' OR lease_expires_at>now())';
    const update=`UPDATE agy_tasks SET status=$3::text::agy_task_status,result=COALESCE($4,result),error=COALESCE($5,error),policy=CASE WHEN $7 AND checkpoint->>'externalId' IS NOT NULL THEN jsonb_set(policy,'{submissionGeneration}',to_jsonb(coalesce((policy->>'submissionGeneration')::integer,0)+1)) ELSE policy END,checkpoint=CASE WHEN $7 THEN NULL ELSE checkpoint END,available_at=CASE WHEN $3::text='RETRY' THEN now()+make_interval(secs=>least(60,power(2,least(attempt,6))::integer)) ELSE available_at END,finished_at=CASE WHEN $3::text IN ('PASS','FAIL','BLOCKED','CANCELLED') THEN now() ELSE finished_at END,updated_at=now() WHERE task_id=$1 AND lease_token=$2 AND status=ANY($6::agy_task_status[]) AND ${leasePredicate}${workerClause}`;
    const values:unknown[]=[taskId,leaseToken,to,patch.result??null,patch.error??null,from,patch.clearCheckpoint===true,...(workerClause?[patch.workerId]:[])];
    const client=await this.pool.connect();try{
      await client.query('BEGIN');await client.query('SELECT worker_id FROM agy_workers ORDER BY worker_id FOR UPDATE');
      if(deadlineMs){
        // Lock the task row too, THEN read the wall clock: the
        // check is authoritative only when no lock the mutation
        // needs is still outstanding.
        await client.query('SELECT task_id FROM agy_tasks WHERE task_id=$1 FOR UPDATE',[taskId]);
        const now=(await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now;
        if(new Date(now).getTime()>=deadlineMs){await client.query('COMMIT');return false;}
      }
      const result=await client.query(update+' RETURNING task_id,job_id',values);
      if(!result.rowCount){await client.query('COMMIT');return false;}
      const jobId=result.rows[0].job_id;
      if(this.scope&&to==='QA')await client.query(`INSERT INTO agy_qa_results(task_id,job_id,verdict,evidence,reviewed_by) VALUES($1,$2,$3,$4,current_setting('agy.subject'))`,[taskId,jobId,patch.qaVerdict??'PENDING',patch.qaEvidence??{}]);
      await this.aggregateJob(client,jobId);
      // Final pre-COMMIT fence (H1, transaction-wide; deadline
      // variant only): the task UPDATE, the QA insert and the job
      // aggregate can each wait on locks past the deadline AFTER
      // the post-lock clock read above; a crossed deadline rolls
      // the whole transition back instead of committing it late.
      if(deadlineMs&&await this.deadlineCrossed(client,deadlineMs)){await client.query('ROLLBACK');return false;}
      await client.query('COMMIT');return true;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  // Atomic worker result submission (candidate, worker-surface v3).
  // ONE transaction under the task row lock: verifies the immutable
  // binding (claimed_by = workerId, lease token, attempt), requires the
  // RUNNING state (a result is never auto-acked from CLAIMED), then
  // writes task->QA + QA-receipt row + task-event receipt + callback
  // outbox row + reservation settlement + telemetry together. Any
  // failure rolls back ALL of it, so a retry is always safe. A replay
  // with identical content under the same attempt returns the recorded
  // callback exactly once; different content conflicts. Settlement uses
  // the caller-provided actuals when valid, else the reserved estimates
  // (mirroring recordTelemetry's held-branch adjustment), and the
  // reservation state guard (state='HELD') makes it exactly-once — a
  // later recordTelemetry finds nothing HELD and cannot settle twice.
  async workerResult(input:{taskId:string,workerId:string,leaseToken:string,attempt:number,result:Record<string,unknown>,evidence:Record<string,unknown>,contentDigest:string,target:string,quotaUnits?:unknown,costAmount?:unknown,deadlineMs?:number}) {
    const client=await this.pool.connect();try{
      await client.query('BEGIN');
      const locked=await client.query(`SELECT * FROM agy_tasks WHERE task_id=$1 FOR UPDATE`,[input.taskId]);
      const row=locked.rows[0];
      if(!row)throw new Error('TASK_NOT_FOUND');
      if(row.claimed_by!==input.workerId)throw new Error('WORKER_BINDING_DENIED');
      if(String(row.lease_token)!==input.leaseToken)throw new Error('LEASE_DENIED');
      if(Number(row.attempt)!==Number(input.attempt))throw new Error('ATTEMPT_DENIED');
      if(row.status==='QA'){
        const cb=(await client.query(`SELECT * FROM agy_worker_callbacks WHERE task_id=$1 AND attempt=$2`,[input.taskId,row.attempt])).rows[0];
        if(!cb)throw new Error('RESULT_STATE_CONFLICT');
        if(cb.content_digest!==input.contentDigest)throw new Error('RESULT_CONTENT_CONFLICT');
        await client.query('COMMIT');
        return {status:'RESULT_SUBMITTED',replay:true,task_id:input.taskId,attempt:Number(row.attempt),task_status:'QA',content_digest:input.contentDigest,callback:{callback_id:cb.callback_id,status:cb.status,target:cb.target}};
      }
      if(row.status==='CLAIMED')throw new Error('RESULT_REQUIRES_ACK');
      if(row.status!=='RUNNING')throw new Error('RESULT_DENIED');
      // Absolute owner deadline (qualification route only): the
      // task row lock is already held here, and the wall clock is
      // read from the database at this moment — a lock wait that
      // crossed the deadline is caught before any mutation. (The
      // QA-replay branch above is a pure read and stays available.)
      if(input.deadlineMs){const now=(await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now;if(new Date(now).getTime()>=input.deadlineMs)throw new Error('LEASE_EXPIRED');}
      if(!row.lease_expires_at||new Date(row.lease_expires_at).getTime()<=Date.now())throw new Error('LEASE_EXPIRED');
      const resultJson={...input.result,evidence:input.evidence,content_digest:input.contentDigest};
      await client.query(`UPDATE agy_tasks SET status='QA',result=$2,updated_at=now() WHERE task_id=$1`,[input.taskId,resultJson]);
      if(this.scope)await client.query(`INSERT INTO agy_qa_results(task_id,job_id,verdict,evidence,reviewed_by) VALUES($1,$2,'PENDING',$3,current_setting('agy.subject'))`,[input.taskId,row.job_id,input.evidence]);
      await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'RESULT_SUBMITTED','QA',$3,$4)`,
        [row.job_id,input.taskId,input.workerId,{attempt:Number(row.attempt),content_digest:input.contentDigest,external_operation_id:input.evidence.external_operation_id}]);
      const cb=(await client.query(`INSERT INTO agy_worker_callbacks(job_id,task_id,attempt,worker_id,target,status,payload,content_digest) VALUES($1,$2,$3,$4,$5,'PENDING',$6,$7) RETURNING callback_id`,
        [row.job_id,input.taskId,row.attempt,input.workerId,input.target,{result:input.result,evidence:input.evidence},input.contentDigest])).rows[0];
      // Reservation settlement, same transaction, exactly once.
      let settled=false;
      const held=(await client.query(`SELECT * FROM agy_resource_reservations WHERE reservation_id=$1 AND state='HELD' FOR UPDATE`,[input.leaseToken])).rows[0];
      if(held){
        const qValid=typeof input.quotaUnits==='number'&&Number.isFinite(input.quotaUnits)&&input.quotaUnits>=0;
        const cValid=typeof input.costAmount==='number'&&Number.isFinite(input.costAmount)&&input.costAmount>=0;
        const actualQuota=qValid?Number(input.quotaUnits):Number(held.expected_quota);
        const actualCost=cValid?Number(input.costAmount):Number(held.expected_cost);
        await client.query(`UPDATE agy_workers SET quota_remaining=quota_remaining+$2-$3,
          resource_profile=jsonb_set(jsonb_set(resource_profile,'{spendUsed}',to_jsonb(coalesce((resource_profile->>'spendUsed')::numeric,0)-$4+$5)),
          '{quotaUsed}',to_jsonb(coalesce((resource_profile->>'quotaUsed')::numeric,0)-$2+$3)),updated_at=now() WHERE worker_id=$1`,
          [input.workerId,Number(held.expected_quota),actualQuota,Number(held.expected_cost),actualCost]);
        await client.query(`UPDATE agy_resource_reservations SET state='SETTLED',actual_quota=$2,actual_cost=$3 WHERE reservation_id=$1`,[input.leaseToken,actualQuota,actualCost]);
        settled=true;
        await client.query(`INSERT INTO agy_telemetry(job_id,task_id,worker_id,outcome,quota_units,cost_amount,metadata,attempt_id) VALUES($1,$2,$3,'RESULT_SUBMITTED',$4,$5,$6,$7)
          ON CONFLICT(task_id,attempt_id,outcome) WHERE attempt_id IS NOT NULL DO NOTHING`,
          [row.job_id,input.taskId,input.workerId,actualQuota,actualCost,{externalOperationId:input.evidence.external_operation_id,contentDigest:input.contentDigest},input.leaseToken]);
      }
      await this.aggregateJob(client,row.job_id);
      // Final pre-COMMIT fence (H1, transaction-wide; deadline
      // variant only): any late write stage above — the
      // task-event or callback-outbox insert, the reservation /
      // worker-counter settlement, the telemetry insert, the job
      // aggregate — can wait on a lock past the deadline AFTER
      // the post-lock clock read; a crossed deadline throws and
      // the catch rolls back task->QA + QA receipt + event +
      // outbox + settlement + telemetry together, never a
      // half-committed result. The QA-replay branch near the top
      // is a pure read and deliberately stays unfenced.
      if(input.deadlineMs&&await this.deadlineCrossed(client,input.deadlineMs))throw new Error('LEASE_EXPIRED');
      await client.query('COMMIT');
      return {status:'RESULT_SUBMITTED',replay:false,task_id:input.taskId,attempt:Number(row.attempt),task_status:'QA',content_digest:input.contentDigest,settled,callback:{callback_id:cb.callback_id,status:'PENDING',target:input.target}};
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
  async saveCheckpoint(task:ClaimedTask,externalId:string,adapter:string,payload?:Record<string,unknown>,workerId?:string,attempt?:number,deadlineMs?:number) {
    // The content digest covers the explicit checkpoint payload when given,
    // else the claimed task's payload. (The worker surface previously
    // passed a stub task, which silently digested {}.)
    const effectivePayload=payload??task.payload??{};
    const digest=createHash('sha256').update(JSON.stringify(effectivePayload)).digest('hex');
    const client=await this.pool.connect();try {await client.query("BEGIN");
      // Lock and validate the task BEFORE any replay lookup: a stale,
      // completed, foreign, or expired lease must never be answered with
      // an existing version. The row lock also serializes concurrent
      // writers, so a duplicate insert cannot slip between check and write.
      const locked=await client.query(`SELECT status,claimed_by,lease_token,lease_expires_at,attempt FROM agy_tasks WHERE task_id=$1 FOR UPDATE`,[task.taskId]);
      const row=locked.rows[0];
      if(!row||row.status!=='RUNNING'||String(row.lease_token)!==task.leaseToken||(workerId&&row.claimed_by!==workerId)||!row.lease_expires_at||new Date(row.lease_expires_at).getTime()<=Date.now())throw new Error("STALE_CHECKPOINT_WRITER");
      if(attempt!==undefined&&Number(attempt)!==Number(row.attempt))throw new Error("ATTEMPT_DENIED");
      // Absolute owner deadline (qualification route only): the
      // wall clock is read from the database while the task row
      // lock is held, before any replay answer or write.
      if(deadlineMs){const now=(await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now;if(new Date(now).getTime()>=deadlineMs)throw new Error("LEASE_EXPIRED");}
      // Idempotent replay: the same external operation with the same
      // content returns the existing version without a new row; the same
      // external operation with different content is a conflict.
      const existing=await client.query(`SELECT version,context_digest FROM agy_checkpoints WHERE task_id=$1 AND external_id=$2 ORDER BY version DESC LIMIT 1`,[task.taskId,externalId]);
      if(existing.rowCount){
        if(existing.rows[0].context_digest!==digest)throw new Error("CHECKPOINT_CONFLICT");
        await client.query("COMMIT");return existing.rows[0].version as number;
      }
      const result=await client.query(`UPDATE agy_tasks SET checkpoint_version=checkpoint_version+1,checkpoint=coalesce(checkpoint,'{}'::jsonb)||$2::jsonb WHERE task_id=$1 RETURNING checkpoint_version`,[task.taskId,{externalId,digest,adapter,submissionState:'ACCEPTED',payload:effectivePayload}]);
      // Persist the real payload alongside the digest so a checkpoint is
      // auditable content, not just a hash of nothing.
      await client.query(`INSERT INTO agy_checkpoints(task_id,version,attempt_id,external_id,context_digest,data) VALUES($1,$2,$3,$4,$5,$6)`,[task.taskId,result.rows[0].checkpoint_version,task.leaseToken,externalId,digest,{externalId,digest,adapter,payload:effectivePayload}]);
      // Final pre-COMMIT fence (H1, transaction-wide; deadline
      // variant only): a wait at the task write or the checkpoint
      // insert spanning the deadline rolls back BOTH writes. The
      // replay return above is a pure read and stays unfenced.
      if(deadlineMs&&await this.deadlineCrossed(client,deadlineMs))throw new Error("LEASE_EXPIRED");
      await client.query("COMMIT");
      return result.rows[0].checkpoint_version as number;
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
