-- Additive, one-shot staging migration. Retains all historical records.
BEGIN;
CREATE TABLE agy_runtime_workers (
 tenant_id text, workspace_id text, project_id text,
 instance_id text, worker_id text NOT NULL, connector_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('STARTING','RUNNING','IDLE','BLOCKED','STOPPED')),
 heartbeat_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 last_outcome text, error_code text,
 PRIMARY KEY(tenant_id,workspace_id,project_id,instance_id,worker_id,connector_id)
);
ALTER TABLE agy_runtime_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agy_runtime_workers FORCE ROW LEVEL SECURITY;
CREATE POLICY agy_runtime_scope ON agy_runtime_workers
 USING(agy_scope_matches(tenant_id,workspace_id,project_id))
 WITH CHECK(agy_scope_matches(tenant_id,workspace_id,project_id));
CREATE TRIGGER agy_runtime_fill BEFORE INSERT OR UPDATE ON agy_runtime_workers
 FOR EACH ROW EXECUTE FUNCTION agy_fill_scope();

-- Transactional evidence: transitions and submission intents cannot outrun the ledger.
CREATE FUNCTION agy_runtime_task_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status OR NEW.checkpoint IS DISTINCT FROM OLD.checkpoint THEN
  INSERT INTO agy_task_events(job_id,task_id,event_type,from_status,to_status,worker_id,detail)
  VALUES(NEW.job_id,NEW.task_id,'DURABLE_RUNTIME',CASE WHEN TG_OP='INSERT' THEN NULL ELSE OLD.status::text END,
   NEW.status::text,NEW.claimed_by,jsonb_build_object('attempt',NEW.attempt,'checkpoint_version',NEW.checkpoint_version,
    'external_id',NEW.checkpoint->>'externalId','submission_state',NEW.checkpoint->>'submissionState',
    'lease_expires_at',NEW.lease_expires_at,'error_code',NEW.error->>'code'));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agy_runtime_evidence AFTER INSERT OR UPDATE ON agy_tasks
 FOR EACH ROW EXECUTE FUNCTION agy_runtime_task_evidence();

-- Route accepted operations only to their original adapter, even after worker loss.
DO $$ DECLARE definition text; needle text;
BEGIN
 definition=pg_get_functiondef('agy_sync_dispatch()'::regprocedure);
 needle=$fragment$'minimumConnectorClass',x.policy->'minimumConnectorClass')$fragment$;
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'EXPECTED_MIGRATION_007_REQUIRED'; END IF;
 EXECUTE replace(definition,needle,$fragment$'minimumConnectorClass',x.policy->'minimumConnectorClass','checkpointAdapter',x.checkpoint->>'adapter')$fragment$);
END $$;
COMMIT;
