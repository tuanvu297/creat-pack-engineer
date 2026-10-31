-- AGY 30s massage-craft preview resume — staging only, one business-preview task.
-- Reuses the already-authorized worker UI scope to avoid any identity/scope credential expansion.
-- Parent Agency job: gl_eb881251-3a93-46fa-8fd9-4fa90243fa2d
-- Continuation child: gl_b919842b-45b4-4cf3-84ed-c17b94030941
-- Runtime run: run-agy-massage30-resume-20261031-a1
-- Runtime job: fc03ec50-447f-407c-982b-81d983cb6320
-- Runtime task: 7148c402-a605-41ef-bcc6-9802d46b4660
-- PREVIEW only. No publish/schedule/top-up. No replay of deprecated Veo probes.
BEGIN;

SELECT set_config('agy.tenant_id','gl',true);
SELECT set_config('agy.workspace_id','legacy-workspace',true);
SELECT set_config('agy.project_id','GEMINI_UI_STAGING',true);

-- Fail closed before any mutation if the already-provisioned staging route is not exactly present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agy_projects
    WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GEMINI_UI_STAGING'
  ) THEN RAISE EXCEPTION 'GEMINI_UI_STAGING_PROJECT_MISSING'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agy_connectors
    WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GEMINI_UI_STAGING'
      AND connector_id='gemini-ui-staging-worker-ui' AND kind='gemini'
  ) THEN RAISE EXCEPTION 'GEMINI_UI_STAGING_CONNECTOR_MISSING'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agy_workers WHERE worker_id='GEMINI-SEO-WORKER' AND adapter='gemini'
  ) THEN RAISE EXCEPTION 'GEMINI_SEO_WORKER_MISSING_OR_ADAPTER_CONFLICT'; END IF;
END $$;

-- Keep the scope staging-only, but owner has now explicitly authorized this bounded preview pilot.
-- Extend only the arrival/grant window needed for the current run; no production enablement.
UPDATE agy_projects
SET status='ACTIVE',
    resource_policy='{"maxConcurrentTasks":1,"quotaCap":0,"spendCap":0,"reservation":0}'::jsonb,
    priority=100,
    permissions=ARRAY['read','analyze','planning','qa']::text[],
    policies = policies || jsonb_build_object(
      'stagingOnly',true,
      'businessTasksAllowed',true,
      'previewOnly',true,
      'publishAllowed',false,
      'topUpAllowed',false,
      'qualificationRun',jsonb_build_object(
        'run_id','run-agy-massage30-resume-20261031-a1',
        'phase','GRANTED',
        'granted_at',clock_timestamp(),
        'expires_at','2026-10-31T20:00:00.000Z'
      )
    ),
    updated_at=now()
WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GEMINI_UI_STAGING';

UPDATE agy_connectors
SET capabilities=ARRAY['hello','video_preview']::text[],
    enabled=true,
    permissions=ARRAY['read','analyze','planning','qa']::text[]
WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GEMINI_UI_STAGING'
  AND connector_id='gemini-ui-staging-worker-ui' AND kind='gemini';

-- Expand only task/mission bindings inside the same already-authorized scope.
UPDATE agy_workers
SET capabilities=(SELECT ARRAY(SELECT DISTINCT x FROM unnest(capabilities || ARRAY['hello','video_preview']::text[]) x ORDER BY x)),
    status='READY',
    heartbeat_at=now(),
    metadata = metadata || jsonb_build_object(
      'bindings',jsonb_build_object(
        'missions',jsonb_build_array('GEMINI_UI_STAGING','AGY_MASSAGE_CRAFT_30S'),
        'task_types',jsonb_build_array('hello','video_preview'),
        'reply_targets',jsonb_build_array('CHATGPT_ASSISTANT_CONTROL_PLANE')
      ),
      'active_preview_run','run-agy-massage30-resume-20261031-a1',
      'preview_only',true,
      'production_authorized',false
    ),
    resource_profile = resource_profile || '{"spendCap":0,"quotaCap":0}'::jsonb,
    quota_remaining=0,
    quota_reserve=0,
    updated_at=now()
WHERE worker_id='GEMINI-SEO-WORKER' AND adapter='gemini';

INSERT INTO agy_jobs(
  job_id,tenant_id,workspace_id,project_id,idempotency_key,
  objective,context,mode,status,pass_threshold
) VALUES (
  'fc03ec50-447f-407c-982b-81d983cb6320'::uuid,
  'gl','legacy-workspace','GEMINI_UI_STAGING',
  'run-agy-massage30-resume-20261031-a1',
  'Resume the existing Green Life Spa 30-second massage-craft PREVIEW using the currently callable authorized worker/toolchain. Do not replay deprecated Veo API probes. No production publish.',
  jsonb_build_object(
    'staging_only',true,
    'preview_only',true,
    'business_task',true,
    'parent_agency_job_id','gl_eb881251-3a93-46fa-8fd9-4fa90243fa2d',
    'continuation_child_job_id','gl_b919842b-45b4-4cf3-84ed-c17b94030941',
    'owner_flow_credit_ceiling',200,
    'no_gemini_api_usd_spend',true,
    'no_publish',true,
    'no_top_up',true,
    'prior_provider_operation_created',false
  ),
  'SINGLE_WORKFLOW','QUEUED',0
)
ON CONFLICT(tenant_id,workspace_id,project_id,idempotency_key) DO NOTHING;

DO $$
DECLARE existing uuid;
BEGIN
  SELECT job_id INTO existing FROM agy_jobs
  WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GEMINI_UI_STAGING'
    AND idempotency_key='run-agy-massage30-resume-20261031-a1';
  IF existing IS DISTINCT FROM 'fc03ec50-447f-407c-982b-81d983cb6320'::uuid THEN
    RAISE EXCEPTION 'VIDEO30_RUNTIME_RUN_ID_CONFLICT';
  END IF;
END $$;

INSERT INTO agy_tasks(
  task_id,job_id,idempotency_key,name,task_type,payload,
  required_capabilities,depends_on,priority,status,attempt,max_retry,
  timeout_seconds,available_at,policy,importance,expected_value
) VALUES (
  '7148c402-a605-41ef-bcc6-9802d46b4660'::uuid,
  'fc03ec50-447f-407c-982b-81d983cb6320'::uuid,
  'AGY-MASSAGE-30S-RESUME-GEMINI-A1',
  'Green Life Spa — Massage Craft 30s PREVIEW — resume A1',
  'video_preview',
  jsonb_build_object(
    'auto_dispatch',true,
    'mission_id','AGY_MASSAGE_CRAFT_30S',
    'target_worker_id','GEMINI-SEO-WORKER',
    'callback_target','CHATGPT_ASSISTANT_CONTROL_PLANE',
    'parent_agency_job_id','gl_eb881251-3a93-46fa-8fd9-4fa90243fa2d',
    'continuation_child_job_id','gl_b919842b-45b4-4cf3-84ed-c17b94030941',
    'deliverable','30-second vertical 9:16 PREVIEW video',
    'duration_seconds',30,
    'aspect_ratio','9:16',
    'creative_structure','Prefer 8s+8s+8s+6s, or another continuity-efficient bounded structure supported by the actual callable route.',
    'creative_direction','Authentic massage craft/process; tactile first frame; professional modest draping; neutral non-sexualized framing; realistic five-finger hand anatomy/contact; grounded skin/fabric physics; natural pressure/repositioning; calm retention-aware pacing; one physical action per shot; warm towel/grounding closing beat.',
    'forbidden','No unsafe neck manipulation; no fake testimonial; no diagnosis/cure/detox/treatment-effectiveness claim; no invented price/offer; no invented Green Life facade/logo/room; no generated text/logo unless source-verified and explicitly composited.',
    'source_policy','Use current AGY/Green Life source-of-truth and verified reference assets when actually accessible. Tight-frame/logo-free if source assets are unavailable.',
    'execution_policy','Use an actually callable authorized route. Flow/browser route is allowed if available. Do not use the deprecated LUME veo-3.1-generate-preview route. Do not retry an uncertain provider submission; reconcile by idempotency first.',
    'do_not_replay',jsonb_build_array('SH01-A1-veo31-preview','gemini-omni-1.1-flash via v1beta predictLongRunning'),
    'budget',jsonb_build_object('flow_credit_ceiling',200,'gemini_api_usd_spend_allowed',false,'top_up_allowed',false),
    'qa_required',jsonb_build_array('anatomy/contact','temporal continuity','motion/camera','fabric/physics/light','audio','pacing/retention','edit seams','claims/brand/source truth','accepted-output efficiency'),
    'result_contract','Return execution/operation identity, actual tool/model/route, artifact IDs/links, duration/aspect, credits if observable, provenance, self-QA, retries/failures, and evidence.external_operation_id. Do not self-promote final PASS.'
  ),
  ARRAY['video_preview']::text[],
  '{}'::uuid[],
  90,
  'QUEUED',
  0,
  0,
  1800,
  now(),
  '{"risk":"LOW","permissionGranted":true,"safetyApproved":true,"requiredPermissions":[],"estimatedQuota":0,"estimatedCost":0,"deterministic":false}'::jsonb,
  1,
  1
)
ON CONFLICT(task_id) DO NOTHING;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM agy_tasks WHERE job_id='fc03ec50-447f-407c-982b-81d983cb6320'::uuid;
  IF n <> 1 THEN RAISE EXCEPTION 'VIDEO30_RUNTIME_TASK_COUNT_INVALID:%', n; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agy_tasks
    WHERE task_id='7148c402-a605-41ef-bcc6-9802d46b4660'::uuid
      AND status='QUEUED'
      AND task_type='video_preview'
      AND payload->>'target_worker_id'='GEMINI-SEO-WORKER'
      AND payload->>'mission_id'='AGY_MASSAGE_CRAFT_30S'
      AND payload->>'callback_target'='CHATGPT_ASSISTANT_CONTROL_PLANE'
  ) THEN RAISE EXCEPTION 'VIDEO30_RUNTIME_TASK_IDENTITY_INVALID'; END IF;
END $$;

INSERT INTO agy_task_events(job_id,task_id,event_type,from_status,to_status,worker_id,detail)
VALUES(
  'fc03ec50-447f-407c-982b-81d983cb6320'::uuid,
  '7148c402-a605-41ef-bcc6-9802d46b4660'::uuid,
  'CONTROL_PLANE_PREVIEW_QUEUED',NULL,'QUEUED','GEMINI-SEO-WORKER',
  jsonb_build_object(
    'run_id','run-agy-massage30-resume-20261031-a1',
    'parent_agency_job_id','gl_eb881251-3a93-46fa-8fd9-4fa90243fa2d',
    'continuation_child_job_id','gl_b919842b-45b4-4cf3-84ed-c17b94030941',
    'staging_only',true,'preview_only',true,'flow_credit_ceiling',200,
    'do_not_replay_deprecated_probe',true
  )
);

COMMIT;
