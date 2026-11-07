-- QA correction R2 (2026-11-02): per-run reservation accounting.
-- Reservation accounting sums (dispatch projection + claim-time
-- usage) previously counted EVERY reservation ever recorded in a
-- project, including reservations of long-settled prior runs. A
-- qualification cap is granted PER RUN, so a settled prior run left
-- the project permanently at quota and the next run's claim stayed
-- EMPTY. This migration adds the terminal accounting state CLOSED:
-- the qualification controller transitions a run's SETTLED
-- reservations to CLOSED when the run is archived or cleaned up
-- (rows and actual_quota are retained as evidence; only the
-- accounting state advances), and both accounting sums count only
-- live states (HELD, SETTLED). Non-qualification projects are
-- unaffected unless their own lifecycle closes reservations.
-- Apply on disposable/staging only.
BEGIN;
ALTER TABLE agy_resource_reservations DROP CONSTRAINT IF EXISTS agy_resource_reservations_state_check;
ALTER TABLE agy_resource_reservations ADD CONSTRAINT agy_resource_reservations_state_check
  CHECK(state IN ('HELD','SETTLED','EXPIRED','CLOSED'));
CREATE OR REPLACE FUNCTION agy_sync_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t text;w text;p text;
BEGIN
 t=NEW.tenant_id;w=NEW.workspace_id;p=NEW.project_id;
 INSERT INTO agy_dispatch_projects(tenant_id,workspace_id,project_id,name,status,priority,resource_policy,permissions,active,quota_used,spend_used,adapter_kinds,health)
 SELECT tenant_id,workspace_id,project_id,name,status,priority,resource_policy,permissions,
 (SELECT count(*) FROM agy_tasks WHERE tenant_id=t AND workspace_id=w AND project_id=p AND status IN ('CLAIMED','RUNNING')),
 (SELECT coalesce(sum(coalesce(actual_quota,expected_quota)),0) FROM agy_resource_reservations WHERE tenant_id=t AND workspace_id=w AND project_id=p AND state IN ('HELD','SETTLED')),
 (SELECT coalesce(sum(coalesce(actual_cost,expected_cost)),0) FROM agy_resource_reservations WHERE tenant_id=t AND workspace_id=w AND project_id=p AND state IN ('HELD','SETTLED')),
 ARRAY(SELECT kind FROM agy_connectors WHERE tenant_id=t AND workspace_id=w AND project_id=p AND enabled),
 (SELECT coalesce(jsonb_agg(jsonb_build_object('workerId',worker_id,'until',blocked_until)),'[]'::jsonb) FROM agy_project_worker_health WHERE tenant_id=t AND workspace_id=w AND project_id=p)
 FROM agy_projects WHERE tenant_id=t AND workspace_id=w AND project_id=p
 ON CONFLICT(tenant_id,workspace_id,project_id) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,priority=EXCLUDED.priority,resource_policy=EXCLUDED.resource_policy,permissions=EXCLUDED.permissions,active=EXCLUDED.active,quota_used=EXCLUDED.quota_used,spend_used=EXCLUDED.spend_used,adapter_kinds=EXCLUDED.adapter_kinds,health=EXCLUDED.health;
 DELETE FROM agy_dispatch_tasks WHERE tenant_id=t AND workspace_id=w AND project_id=p;
 INSERT INTO agy_dispatch_tasks
 SELECT x.task_id,x.job_id,t,w,p,j.pass_threshold,x.available_at,
 jsonb_build_object('name','routing-metadata','idempotencyKey',x.task_id,'taskType',x.task_type,'requiredCapabilities',x.required_capabilities,
 'priority',x.priority,'risk',coalesce(x.policy->>'risk','MEDIUM'),'permissionGranted',x.policy->'permissionGranted','safetyApproved',x.policy->'safetyApproved',
 'requiredPermissions',coalesce(x.policy->'requiredPermissions','[]'::jsonb),'estimatedQuota',x.policy->'estimatedQuota','estimatedCost',x.policy->'estimatedCost',
 'importance',x.importance,'expectedValue',x.expected_value,'deterministic',x.policy->'deterministic','requiredRuntimeCapabilities',coalesce(x.policy->'requiredRuntimeCapabilities','[]'::jsonb),'minimumConnectorClass',x.policy->'minimumConnectorClass'),
 ARRAY(SELECT failed_worker FROM unnest(x.failed_workers) failed_worker WHERE NOT EXISTS(
   SELECT 1 FROM agy_workers resumed WHERE resumed.worker_id=failed_worker AND resumed.adapter=x.checkpoint->>'adapter'))
 FROM agy_tasks x JOIN agy_jobs j USING(job_id)
 WHERE x.tenant_id=t AND x.workspace_id=w AND x.project_id=p AND x.status IN ('QUEUED','RETRY')
 AND NOT EXISTS(SELECT 1 FROM unnest(x.depends_on) dep LEFT JOIN agy_tasks parent ON parent.task_id=dep WHERE parent.status IS DISTINCT FROM 'PASS')
 AND NOT EXISTS(SELECT 1 FROM agy_tasks active WHERE active.tenant_id=t AND active.workspace_id=w AND active.project_id=p AND active.status IN ('CLAIMED','RUNNING','QA')
  AND ((j.mode='SINGLE_WORKFLOW' AND active.job_id=x.job_id) OR (x.policy->>'sharedStateKey' IS NOT NULL AND active.policy->>'sharedStateKey'=x.policy->>'sharedStateKey')));
 RETURN NEW;
END $$;
-- One-time recompute of existing projections under the new rule.
UPDATE agy_dispatch_projects dp SET
  quota_used=(SELECT coalesce(sum(coalesce(actual_quota,expected_quota)),0) FROM agy_resource_reservations r
    WHERE r.tenant_id=dp.tenant_id AND r.workspace_id=dp.workspace_id AND r.project_id=dp.project_id AND r.state IN ('HELD','SETTLED')),
  spend_used=(SELECT coalesce(sum(coalesce(actual_cost,expected_cost)),0) FROM agy_resource_reservations r
    WHERE r.tenant_id=dp.tenant_id AND r.workspace_id=dp.workspace_id AND r.project_id=dp.project_id AND r.state IN ('HELD','SETTLED'));
COMMIT;
