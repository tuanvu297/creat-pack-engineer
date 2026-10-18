import type { Pool } from "pg";
import { discoverResource } from "./resources/discovery.js";
import { failurePolicy, type FailureKind } from "./resources/recovery.js";
import type { Resource } from "./resources/types.js";

export function resourceFromRow(w:any):Resource {
  return {...discoverResource(w.worker_id,w.capabilities,new Date(w.heartbeat_at).getTime()),...w.resource_profile,
    workerId:w.worker_id,capabilities:w.capabilities,status:w.status,ready:w.status==='READY',centralBrain:w.central_brain,
    activeCount:w.active_count,maxConcurrency:w.max_concurrency,quotaRemaining:w.quota_remaining===null?null:Number(w.quota_remaining),quotaReserve:Number(w.quota_reserve),lastHealthAt:new Date(w.heartbeat_at).getTime()};
}
export class ResourceStore {
  constructor(private readonly pool:Pool){}
  async list():Promise<Resource[]> {return (await this.pool.query(`SELECT * FROM agy_workers ORDER BY worker_id`)).rows.map(resourceFromRow);}
  async register(resource:Resource,adapter:string) {
    const previous=await this.pool.query(`SELECT resource_profile FROM agy_workers WHERE worker_id=$1`,[resource.workerId]);
    const prior=previous.rows[0]?.resource_profile;
    await this.pool.query(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(worker_id) DO UPDATE SET
      adapter=EXCLUDED.adapter,capabilities=EXCLUDED.capabilities,status=EXCLUDED.status,max_concurrency=EXCLUDED.max_concurrency,
      resource_profile=agy_workers.resource_profile || EXCLUDED.resource_profile || jsonb_build_object('spendUsed',coalesce(agy_workers.resource_profile->'spendUsed','0'::jsonb),'quotaUsed',coalesce(agy_workers.resource_profile->'quotaUsed','0'::jsonb),
        'rateLimitedUntil',coalesce(agy_workers.resource_profile->'rateLimitedUntil','0'::jsonb),'circuitOpenUntil',coalesce(agy_workers.resource_profile->'circuitOpenUntil','0'::jsonb),'consecutiveFailures',coalesce(agy_workers.resource_profile->'consecutiveFailures','0'::jsonb)),
      quota_reserve=EXCLUDED.quota_reserve,central_brain=EXCLUDED.central_brain,heartbeat_at=now(),updated_at=now()`,
      [resource.workerId,adapter,resource.capabilities,resource.status,resource.maxConcurrency,resource,resource.quotaRemaining,resource.quotaReserve,resource.centralBrain]);
    if(prior && (prior.model!==resource.model || JSON.stringify(prior.capabilities)!==JSON.stringify(resource.capabilities)))await this.pool.query(`INSERT INTO agy_learning_events(trigger_type,context,payload,source_key) VALUES('MODEL_TOOL_CHANGE',$1,$2,$3)`,[resource.workerId,{before:prior,after:resource},`resource:${resource.workerId}:${crypto.randomUUID()}`]);
    return {registered:resource.workerId,quotaNote:"Existing quota/accounting is preserved; use reconciliation for provider quota shifts"};
  }
  async reconcileQuota(workerId:string,remaining:number) {if(!Number.isFinite(remaining)||remaining<0)throw new Error("INVALID_QUOTA");
    // Remaining is provider balance; subtract unresolved reservations whose billing is not observed yet.
    const result=await this.pool.query(`UPDATE agy_workers w SET quota_remaining=greatest(0,$2-(SELECT coalesce(sum(expected_quota),0) FROM agy_resource_reservations r WHERE r.worker_id=w.worker_id AND r.state='HELD')),updated_at=now() WHERE worker_id=$1 RETURNING worker_id,quota_remaining`,[workerId,remaining]);if(!result.rowCount)throw new Error("UNKNOWN_RESOURCE");return result.rows[0];}
  async fail(workerId:string,kind:FailureKind,attempt:number,maxRetry:number,retryAfterMs?:number) {
    const client=await this.pool.connect();try {await client.query("BEGIN");const row=await client.query(`SELECT * FROM agy_workers WHERE worker_id=$1 FOR UPDATE`,[workerId]);if(!row.rowCount)throw new Error("UNKNOWN_RESOURCE");
      const r=resourceFromRow(row.rows[0]);const result=failurePolicy(r,kind,attempt,maxRetry,Date.now(),retryAfterMs);
      await client.query(`UPDATE agy_workers SET status=$2,resource_profile=$3,updated_at=now() WHERE worker_id=$1`,[workerId,r.status,r]);await client.query("COMMIT");return result;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
}
