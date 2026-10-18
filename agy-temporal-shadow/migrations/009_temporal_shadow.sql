-- Additive, one-shot local/staging migration. Existing history and dispatch unchanged.
BEGIN;
CREATE TABLE agy_temporal_missions (
 tenant_id text,workspace_id text,project_id text,
 mission_id text NOT NULL,task_key text NOT NULL,idempotency_key text NOT NULL,payload_hash text NOT NULL,
 workflow_id text NOT NULL UNIQUE,run_id text,job_id uuid REFERENCES agy_jobs,task_id uuid REFERENCES agy_tasks,
 contract jsonb NOT NULL,state text NOT NULL DEFAULT 'START_INTENT',qa_state text NOT NULL DEFAULT 'QA_NOT_STARTED',
 attempt integer NOT NULL DEFAULT 1,lease_attempt integer NOT NULL DEFAULT 1,executor_worker_id text NOT NULL,reviewer_id text,
 lease_token uuid,operation_id text,ack jsonb,result jsonb,qa jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,workspace_id,project_id,idempotency_key),
 UNIQUE(tenant_id,workspace_id,project_id,mission_id,task_key),
 CHECK(reviewer_id IS NULL OR reviewer_id<>executor_worker_id)
);
CREATE TABLE agy_temporal_receipts (
 tenant_id text,workspace_id text,project_id text,job_id uuid NOT NULL REFERENCES agy_jobs,
 task_id uuid NOT NULL REFERENCES agy_tasks,workflow_id text NOT NULL REFERENCES agy_temporal_missions(workflow_id),
 receipt_key text NOT NULL,kind text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,workspace_id,project_id,workflow_id,receipt_key)
);
-- Synthetic fixture operations are separate from provider evidence. No network dispatcher here.
CREATE TABLE agy_temporal_synthetic_operations (
 tenant_id text,workspace_id text,project_id text,workflow_id text NOT NULL REFERENCES agy_temporal_missions(workflow_id),
 attempt integer NOT NULL,idempotency_key text NOT NULL,payload_hash text NOT NULL,
 operation_id text NOT NULL,ready_at timestamptz NOT NULL,output jsonb NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id,project_id,workflow_id,attempt),
 UNIQUE(tenant_id,workspace_id,project_id,idempotency_key)
);
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['agy_temporal_missions','agy_temporal_receipts','agy_temporal_synthetic_operations'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
  EXECUTE format('CREATE POLICY temporal_scope ON %I USING(agy_scope_matches(tenant_id,workspace_id,project_id)) WITH CHECK(agy_scope_matches(tenant_id,workspace_id,project_id))',n);
  EXECUTE format('CREATE TRIGGER temporal_fill BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION agy_fill_scope()',n);
 END LOOP;
END $$;
CREATE TRIGGER temporal_receipt_immutable BEFORE UPDATE OR DELETE ON agy_temporal_receipts FOR EACH ROW EXECUTE FUNCTION agy_immutable_audit();
COMMIT;
