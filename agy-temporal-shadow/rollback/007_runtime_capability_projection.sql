-- Restore Sprint 4 function ONLY. No table/row deletion.
-- Freeze Mission 5 writers and switch code coherently; preserve pending/uncertain checkpoints.
BEGIN;
CREATE OR REPLACE FUNCTION agy_sync_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t text;w text;p text;
BEGIN
 t=NEW.tenant_id;w=NEW.workspace_id;p=NEW.project_id;
 INSERT INTO agy_dispatch_projects(tenant_id,workspace_id,project_id,name,status,priority,resource_policy,permissions,active,quota_used,spend_used,adapter_kinds,health)
 SELECT tenant_id,workspace_id,project_id,name,status,priority,resource_policy,permissions,
 (SELECT count(*) FROM agy_tasks WHERE tenant_id=t AND workspace_id=w AND project_id=p AND status IN ('CLAIMED','RUNNING')),
 (SELECT coalesce(sum(coalesce(actual_quota,expected_quota)),0) FROM agy_resource_reservations WHERE tenant_id=t AND workspace_id=w AND project_id=p),
 (SELECT coalesce(sum(coalesce(actual_cost,expected_cost)),0) FROM agy_resource_reservations WHERE tenant_id=t AND workspace_id=w AND project_id=p),
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
 'importance',x.importance,'expectedValue',x.expected_value,'deterministic',x.policy->'deterministic'),
 -- A durable checkpoint resumes the same external provider operation, not a new submission.
 ARRAY(SELECT failed_worker FROM unnest(x.failed_workers) failed_worker WHERE NOT EXISTS(
   SELECT 1 FROM agy_workers resumed WHERE resumed.worker_id=failed_worker AND resumed.adapter=x.checkpoint->>'adapter'))
 FROM agy_tasks x JOIN agy_jobs j USING(job_id)
 WHERE x.tenant_id=t AND x.workspace_id=w AND x.project_id=p AND x.status IN ('QUEUED','RETRY')
 AND NOT EXISTS(SELECT 1 FROM unnest(x.depends_on) dep LEFT JOIN agy_tasks parent ON parent.task_id=dep WHERE parent.status IS DISTINCT FROM 'PASS')
 AND NOT EXISTS(SELECT 1 FROM agy_tasks active WHERE active.tenant_id=t AND active.workspace_id=w AND active.project_id=p AND active.status IN ('CLAIMED','RUNNING','QA')
  AND ((j.mode='SINGLE_WORKFLOW' AND active.job_id=x.job_id) OR (x.policy->>'sharedStateKey' IS NOT NULL AND active.policy->>'sharedStateKey'=x.policy->>'sharedStateKey')));
 RETURN NEW;
END $$;
COMMIT;

