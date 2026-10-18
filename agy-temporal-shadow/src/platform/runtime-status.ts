import type { Pool } from 'pg';
export async function runtimeStatus(pool:Pool) {
 const [workers,tasks]=await Promise.all([
  pool.query(`SELECT instance_id,worker_id,connector_id,state,heartbeat_at,expires_at,last_outcome,error_code,
   CASE WHEN expires_at<=now() AND state<>'STOPPED' THEN 'STALE' ELSE state END AS health
   FROM agy_runtime_workers ORDER BY instance_id,worker_id,connector_id`),
  pool.query(`SELECT t.task_id,t.job_id,t.name,t.status AS raw_status,t.claimed_by AS worker_id,t.attempt,t.max_retry,
   t.heartbeat_at,t.lease_expires_at,t.available_at,t.checkpoint_version,t.checkpoint->>'externalId' AS external_id,
   t.error->>'code' AS error_code,t.updated_at,
   CASE WHEN t.status IN ('CLAIMED','RUNNING') AND t.lease_expires_at<=now() THEN 'QUEUED'
    WHEN t.status IN ('CLAIMED','RUNNING') THEN 'RUNNING'
    WHEN t.status IN ('FAIL','BLOCKED','CANCELLED','QA') THEN 'BLOCKED'
    WHEN EXISTS(SELECT 1 FROM unnest(t.depends_on) dep JOIN agy_tasks d ON d.task_id=dep
     WHERE d.status IN ('FAIL','BLOCKED','CANCELLED','QA')) THEN 'BLOCKED'
    WHEN t.status='PASS' THEN 'PASS' ELSE 'QUEUED' END AS status,
   ARRAY(SELECT dep FROM unnest(t.depends_on) dep JOIN agy_tasks d ON d.task_id=dep WHERE d.status<>'PASS') AS waiting_for
   FROM agy_tasks t ORDER BY t.created_at,t.task_id`)
 ]);
 return {observedAt:new Date().toISOString(),stageOnly:true,
  dispatcherHealthy:workers.rows.some(w=>w.health==='RUNNING'||w.health==='IDLE'),
  workers:workers.rows,tasks:tasks.rows};
}
