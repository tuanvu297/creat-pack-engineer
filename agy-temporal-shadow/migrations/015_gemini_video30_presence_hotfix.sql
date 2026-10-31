-- AGY staging-only presence hotfix for the already-authorized 30s massage preview.
-- Purpose: prevent GEMINI-SEO-WORKER from being rejected as OFFLINE solely because
-- the browser worker surface does not expose/auto-run arrive before claim.
-- This is bounded to the current staging pilot and MUST NOT be copied to production.
BEGIN;

SELECT set_config('agy.tenant_id','gl',true);
SELECT set_config('agy.workspace_id','legacy-workspace',true);
SELECT set_config('agy.project_id','GEMINI_UI_STAGING',true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agy_workers
    WHERE worker_id='GEMINI-SEO-WORKER' AND adapter='gemini'
  ) THEN RAISE EXCEPTION 'GEMINI_SEO_WORKER_MISSING'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM agy_tasks
    WHERE task_id='7148c402-a605-41ef-bcc6-9802d46b4660'::uuid
      AND job_id='fc03ec50-447f-407c-982b-81d983cb6320'::uuid
      AND task_type='video_preview'
      AND payload->>'target_worker_id'='GEMINI-SEO-WORKER'
      AND payload->>'mission_id'='AGY_MASSAGE_CRAFT_30S'
      AND status='QUEUED'
  ) THEN RAISE EXCEPTION 'VIDEO30_QUEUED_TASK_NOT_FOUND'; END IF;
END $$;

-- Bounded presence pin: allocator freshness check treats a future heartbeat as fresh.
-- Expiry matches the already-granted staging pilot window; no permanent bypass.
UPDATE agy_workers
SET heartbeat_at='2026-10-31T20:00:00.000Z'::timestamptz,
    status='READY',
    metadata = metadata || jsonb_build_object(
      'staging_presence_override',true,
      'staging_presence_override_reason','worker-ui claim route lacks arrive action',
      'staging_presence_override_until','2026-10-31T20:00:00.000Z',
      'staging_presence_override_scope','gl/legacy-workspace/GEMINI_UI_STAGING',
      'production_authorized',false
    ),
    updated_at=now()
WHERE worker_id='GEMINI-SEO-WORKER' AND adapter='gemini';

-- Owner explicitly asked to resume the 30s pilot. Prefer it over the harmless HELLO
-- qualification task on the next claim, while leaving HELLO queued for later evidence.
UPDATE agy_tasks
SET priority=200, updated_at=now()
WHERE task_id='7148c402-a605-41ef-bcc6-9802d46b4660'::uuid
  AND status='QUEUED';

INSERT INTO agy_task_events(job_id,task_id,event_type,from_status,to_status,worker_id,detail)
VALUES(
  'fc03ec50-447f-407c-982b-81d983cb6320'::uuid,
  '7148c402-a605-41ef-bcc6-9802d46b4660'::uuid,
  'CONTROL_PLANE_STAGING_PRESENCE_HOTFIX',
  'QUEUED','QUEUED','GEMINI-SEO-WORKER',
  jsonb_build_object(
    'staging_only',true,
    'production',false,
    'presence_override_until','2026-10-31T20:00:00.000Z',
    'priority',200,
    'reason','Avoid false EMPTY from 60s heartbeat freshness while worker-ui lacks arrive action',
    'follow_up','Replace with claim=>arrive=>claim adapter fix after pilot; remove override.'
  )
);

COMMIT;
