-- AGY Gemini worker UI staging qualification provision — one-shot, data only.
-- Scope: gl/legacy-workspace/GEMINI_UI_STAGING
-- Worker: GEMINI-SEO-WORKER
-- Run: run-gemini-ui-staging-20261031-2242-a1
-- Exactly one harmless HELLO task: 59a8e025-5779-4dc5-8f25-4d07c941471c
-- No production rows, no business task, no schema changes.
BEGIN;

SELECT set_config('agy.tenant_id','gl',true);
SELECT set_config('agy.workspace_id','legacy-workspace',true);
SELECT set_config('agy.project_id','GEMINI_UI_STAGING',true);

-- Fail closed if the globally-named worker already belongs to another adapter
-- or already has different bindings. The observed precondition is missing bindings.
DO $$
DECLARE
  a text;
  b jsonb;
  desired jsonb := '{"missions":["GEMINI_UI_STAGING"],"task_types":["hello"],"reply_targets":["CHATGPT_ASSISTANT_CONTROL_PLANE"]}'::jsonb;
BEGIN
  SELECT adapter, metadata->'bindings' INTO a,b
    FROM agy_workers WHERE worker_id='GEMINI-SEO-WORKER';
  IF FOUND AND a <> 'gemini' THEN
    RAISE EXCEPTION 'GEMINI_UI_WORKER_ADAPTER_CONFLICT';
  END IF;
  IF b IS NOT NULL AND b <> desired THEN
    RAISE EXCEPTION 'GEMINI_UI_WORKER_BINDINGS_CONFLICT';
  END IF;
END $$;

INSERT INTO agy_projects(
  tenant_id,workspace_id,project_id,name,status,
  source_of_truth_ref,policy_ref,default_skill_pack,
  resource_policy,priority,permissions,policies
) VALUES (
  'gl','legacy-workspace','GEMINI_UI_STAGING','Gemini UI Staging Qualification','ACTIVE',
  'runtime://agy-temporal-staging/43f6cd3a9145ccfc44af7fb87301486d428fcecb',
  'AGY-STAGING-GEMINI-UI-HELLO-20261031',
  'GEMINI_UI_STAGING',
  '{"maxConcurrentTasks":1,"quotaCap":0,"spendCap":0,"reservation":0}'::jsonb,
  100,
  ARRAY['read','analyze','planning','qa']::text[],
  jsonb_build_object(
    'stagingOnly',true,
    'businessTasksAllowed',false,
    'qualificationRun',jsonb_build_object(
      'run_id','run-gemini-ui-staging-20261031-2242-a1',
      'phase','GRANTED',
      'granted_at',clock_timestamp(),
      'expires_at','2026-10-31T18:00:00.000Z'
    )
  )
)
ON CONFLICT(tenant_id,workspace_id,project_id) DO UPDATE SET
  name=EXCLUDED.name,
  status='ACTIVE',
  source_of_truth_ref=EXCLUDED.source_of_truth_ref,
  policy_ref=EXCLUDED.policy_ref,
  default_skill_pack=EXCLUDED.default_skill_pack,
  resource_policy=EXCLUDED.resource_policy,
  priority=EXCLUDED.priority,
  permissions=EXCLUDED.permissions,
  policies=agy_projects.policies || EXCLUDED.policies,
  updated_at=now();

INSERT INTO agy_connectors(
  tenant_id,workspace_id,project_id,connector_id,kind,capabilities,
  endpoint,secret_ref,enabled,permissions
) VALUES (
  'gl','legacy-workspace','GEMINI_UI_STAGING','gemini-ui-staging-worker-ui',
  'gemini',ARRAY['hello']::text[],
  'browser-adapter:/worker/ui','AGY_SECRET_GEMINI_UI_STAGING_NONE',
  true,ARRAY['read','analyze','planning','qa']::text[]
)
ON CONFLICT(tenant_id,workspace_id,project_id,connector_id) DO UPDATE SET
  kind=EXCLUDED.kind,
  capabilities=EXCLUDED.capabilities,
  endpoint=EXCLUDED.endpoint,
  secret_ref=EXCLUDED.secret_ref,
  enabled=true,
  permissions=EXCLUDED.permissions;

INSERT INTO agy_workers(
  worker_id,adapter,capabilities,status,max_concurrency,active_count,metadata,
  heartbeat_at,resource_profile,quota_remaining,quota_reserve,central_brain
) VALUES (
  'GEMINI-SEO-WORKER','gemini',ARRAY['hello']::text[],'READY',1,0,
  jsonb_build_object(
    'bindings',jsonb_build_object(
      'missions',jsonb_build_array('GEMINI_UI_STAGING'),
      'task_types',jsonb_build_array('hello'),
      'reply_targets',jsonb_build_array('CHATGPT_ASSISTANT_CONTROL_PLANE')
    ),
    'qualification','UNVERIFIED',
    'evidence','HELLO_PENDING',
    'external_namespace_only',true,
    'provisioned_scope','gl/legacy-workspace/GEMINI_UI_STAGING',
    'provision_run_id','run-gemini-ui-staging-20261031-2242-a1'
  ),
  now(),
  '{"spendCap":0,"quotaCap":0,"permissions":[]}'::jsonb,
  0,0,false
)
ON CONFLICT(worker_id) DO UPDATE SET
  adapter='gemini',
  capabilities=CASE
    WHEN 'hello'=ANY(agy_workers.capabilities) THEN agy_workers.capabilities
    ELSE array_append(agy_workers.capabilities,'hello')
  END,
  status='READY',
  max_concurrency=GREATEST(agy_workers.max_concurrency,1),
  metadata=agy_workers.metadata || EXCLUDED.metadata,
  heartbeat_at=now(),
  resource_profile=agy_workers.resource_profile || EXCLUDED.resource_profile,
  quota_remaining=COALESCE(agy_workers.quota_remaining,0),
  quota_reserve=0,
  central_brain=false,
  updated_at=now();

INSERT INTO agy_jobs(
  job_id,tenant_id,workspace_id,project_id,idempotency_key,
  objective,context,mode,status,pass_threshold
) VALUES (
  '04bfc3eb-831b-4f09-8145-194eaab270aa'::uuid,'gl','legacy-workspace','GEMINI_UI_STAGING',
  'run-gemini-ui-staging-20261031-2242-a1',
  'Harmless HELLO route qualification for GEMINI-SEO-WORKER; no business execution.',
  jsonb_build_object(
    'staging_only',true,
    'business_task',false,
    'requested_by','AGY Control Plane',
    'worker_id','GEMINI-SEO-WORKER'
  ),
  'SINGLE_WORKFLOW','QUEUED',0
)
ON CONFLICT(tenant_id,workspace_id,project_id,idempotency_key) DO NOTHING;

-- Fail closed if the run id already exists under a different job identity.
DO $$
DECLARE existing uuid;
BEGIN
  SELECT job_id INTO existing FROM agy_jobs WHERE idempotency_key='run-gemini-ui-staging-20261031-2242-a1';
  IF existing IS DISTINCT FROM '04bfc3eb-831b-4f09-8145-194eaab270aa'::uuid THEN
    RAISE EXCEPTION 'GEMINI_UI_RUN_ID_CONFLICT';
  END IF;
END $$;

INSERT INTO agy_tasks(
  task_id,job_id,idempotency_key,name,task_type,payload,
  required_capabilities,depends_on,priority,status,attempt,max_retry,
  timeout_seconds,available_at,policy,importance,expected_value
) VALUES (
  '59a8e025-5779-4dc5-8f25-4d07c941471c'::uuid,
  '04bfc3eb-831b-4f09-8145-194eaab270aa'::uuid,
  'HELLO-GEMINI-SEO-WORKER-A1',
  'HELLO — Gemini UI staging route qualification',
  'hello',
  jsonb_build_object(
    'message','HELLO',
    'harmless',true,
    'business_task',false,
    'auto_dispatch',true,
    'mission_id','GEMINI_UI_STAGING',
    'target_worker_id','GEMINI-SEO-WORKER',
    'callback_target','CHATGPT_ASSISTANT_CONTROL_PLANE'
  ),
  ARRAY['hello']::text[],
  '{}'::uuid[],
  100,
  'QUEUED',
  0,
  0,
  300,
  now(),
  '{"risk":"LOW","permissionGranted":true,"safetyApproved":true,"requiredPermissions":[],"estimatedQuota":0,"estimatedCost":0,"deterministic":true}'::jsonb,
  1,
  1
)
ON CONFLICT(task_id) DO NOTHING;

-- Exactly one task is allowed for this run.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM agy_tasks WHERE job_id='04bfc3eb-831b-4f09-8145-194eaab270aa'::uuid;
  IF n <> 1 THEN
    RAISE EXCEPTION 'GEMINI_UI_HELLO_TASK_COUNT_INVALID:%', n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agy_tasks
    WHERE job_id='04bfc3eb-831b-4f09-8145-194eaab270aa'::uuid
      AND task_id='59a8e025-5779-4dc5-8f25-4d07c941471c'::uuid
      AND task_type='hello'
      AND payload->>'target_worker_id'='GEMINI-SEO-WORKER'
      AND payload->>'mission_id'='GEMINI_UI_STAGING'
      AND payload->>'callback_target'='CHATGPT_ASSISTANT_CONTROL_PLANE'
  ) THEN
    RAISE EXCEPTION 'GEMINI_UI_HELLO_TASK_IDENTITY_INVALID';
  END IF;
END $$;

INSERT INTO agy_task_events(
  job_id,task_id,event_type,from_status,to_status,worker_id,detail
) VALUES (
  '04bfc3eb-831b-4f09-8145-194eaab270aa'::uuid,'59a8e025-5779-4dc5-8f25-4d07c941471c'::uuid,
  'CONTROL_PLANE_PROVISIONED',NULL,'QUEUED','GEMINI-SEO-WORKER',
  jsonb_build_object(
    'run_id','run-gemini-ui-staging-20261031-2242-a1',
    'staging_only',true,
    'business_task',false,
    'grant_expires_at','2026-10-31T18:00:00.000Z'
  )
);

COMMIT;
