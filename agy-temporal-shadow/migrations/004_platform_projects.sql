-- ONE-SHOT transactional migration. Do not rerun; see PLATFORM-RUNBOOK.md.
-- Run with migration owner, not runtime role. No rows are deleted.
BEGIN;
CREATE TABLE agy_tenants(tenant_id text PRIMARY KEY,name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE agy_workspaces(tenant_id text REFERENCES agy_tenants,workspace_id text,name text NOT NULL,PRIMARY KEY(tenant_id,workspace_id));
CREATE TABLE agy_projects(
 tenant_id text,workspace_id text,project_id text,name text NOT NULL,
 status text NOT NULL DEFAULT 'PAUSED' CHECK(status IN ('ACTIVE','PAUSED','ARCHIVED')),
 source_of_truth_ref text NOT NULL,policy_ref text NOT NULL,default_skill_pack text NOT NULL DEFAULT '',
 resource_policy jsonb NOT NULL DEFAULT '{"maxConcurrentTasks":1,"quotaCap":0,"spendCap":0,"reservation":0}',
 priority integer NOT NULL DEFAULT 0,permissions text[] NOT NULL DEFAULT '{}',policies jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,workspace_id,project_id),FOREIGN KEY(tenant_id,workspace_id) REFERENCES agy_workspaces);
INSERT INTO agy_tenants SELECT DISTINCT tenant_id,tenant_id,now() FROM agy_jobs;
INSERT INTO agy_tenants VALUES('gl','Legacy GL',now()) ON CONFLICT DO NOTHING;
INSERT INTO agy_tenants VALUES('migration-quarantine','Unattributed legacy records',now());
INSERT INTO agy_workspaces SELECT tenant_id,'legacy-workspace','Imported legacy workspace' FROM agy_tenants;
INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref)
 SELECT tenant_id,'legacy-workspace',CASE WHEN tenant_id='gl' THEN 'GL_AUTOMATION' ELSE 'LEGACY_IMPORTED' END,
 'Imported project','legacy-backup:pre-004','migration-review-required' FROM agy_tenants;
ALTER TABLE agy_jobs ADD COLUMN workspace_id text NOT NULL DEFAULT 'legacy-workspace';
ALTER TABLE agy_jobs ADD COLUMN project_id text;
UPDATE agy_jobs SET project_id=CASE WHEN tenant_id='gl' THEN 'GL_AUTOMATION' ELSE 'LEGACY_IMPORTED' END;
ALTER TABLE agy_jobs ALTER COLUMN project_id SET NOT NULL;
ALTER TABLE agy_jobs ALTER COLUMN workspace_id DROP DEFAULT;
ALTER TABLE agy_jobs DROP CONSTRAINT agy_jobs_tenant_id_idempotency_key_key;
ALTER TABLE agy_jobs ADD UNIQUE(tenant_id,workspace_id,project_id,idempotency_key);
ALTER TABLE agy_jobs ADD FOREIGN KEY(tenant_id,workspace_id,project_id) REFERENCES agy_projects;

-- Legacy records without proven attribution remain quarantined, NOT universal knowledge.
CREATE TABLE agy_project_learning_state(
 tenant_id text,workspace_id text,project_id text,state_id text NOT NULL DEFAULT 'library' CHECK(state_id='library'),
 revision bigint NOT NULL DEFAULT 0,state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,workspace_id,project_id,state_id));
INSERT INTO agy_project_learning_state SELECT tenant_id,workspace_id,project_id,'library',0,
 '{"skills":[],"candidates":[],"evidence":[],"experiments":[],"audit":[],"events":[],"activePointers":{}}',now() FROM agy_projects;
CREATE TABLE agy_project_learning_audit(
 tenant_id text,workspace_id text,project_id text,sequence bigint,actor text NOT NULL,action text NOT NULL,target text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,workspace_id,project_id,sequence));
CREATE TRIGGER agy_project_audit_no_edit BEFORE UPDATE OR DELETE ON agy_project_learning_audit FOR EACH ROW EXECUTE FUNCTION agy_immutable_audit();
CREATE TABLE agy_connectors(
 tenant_id text,workspace_id text,project_id text,connector_id text,kind text NOT NULL,capabilities text[] NOT NULL,
 endpoint text NOT NULL,secret_ref text NOT NULL,enabled boolean NOT NULL DEFAULT false,permissions text[] NOT NULL DEFAULT '{}',
 PRIMARY KEY(tenant_id,workspace_id,project_id,connector_id));
CREATE TABLE agy_artifacts(artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid NOT NULL REFERENCES agy_jobs,task_id uuid REFERENCES agy_tasks,uri text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE agy_task_attempts(task_id uuid REFERENCES agy_tasks,job_id uuid NOT NULL REFERENCES agy_jobs,attempt integer,lease_token uuid NOT NULL,status text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(task_id,attempt));
CREATE TABLE agy_qa_results(qa_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL REFERENCES agy_tasks,job_id uuid NOT NULL REFERENCES agy_jobs,verdict text NOT NULL CHECK(verdict IN ('PASS','FAIL','PENDING')),evidence jsonb NOT NULL,reviewed_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE agy_project_worker_health(worker_id text REFERENCES agy_workers,blocked_until timestamptz NOT NULL,error_code text NOT NULL,tenant_id text,workspace_id text,project_id text,PRIMARY KEY(tenant_id,workspace_id,project_id,worker_id));
CREATE TABLE agy_lessons(lesson_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid REFERENCES agy_jobs,content jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE agy_experiments(experiment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid REFERENCES agy_jobs,candidate_id text NOT NULL,state jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());

CREATE FUNCTION agy_scope_matches(t text,w text,p text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT t=nullif(current_setting('agy.tenant_id',true),'') AND w=nullif(current_setting('agy.workspace_id',true),'') AND p=nullif(current_setting('agy.project_id',true),'') $$;
CREATE FUNCTION agy_fill_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE data jsonb;parent_scope record;requested record;
BEGIN
 data=to_jsonb(NEW);
 SELECT nullif(current_setting('agy.tenant_id',true),'') t,nullif(current_setting('agy.workspace_id',true),'') w,nullif(current_setting('agy.project_id',true),'') p INTO requested;
 IF requested.t IS NULL OR requested.w IS NULL OR requested.p IS NULL THEN RAISE EXCEPTION 'PROJECT_SCOPE_REQUIRED'; END IF;
 NEW.tenant_id=coalesce(NEW.tenant_id,requested.t);NEW.workspace_id=coalesce(NEW.workspace_id,requested.w);NEW.project_id=coalesce(NEW.project_id,requested.p);
 IF NOT agy_scope_matches(NEW.tenant_id,NEW.workspace_id,NEW.project_id) THEN RAISE EXCEPTION 'PROJECT_SCOPE_DENIED'; END IF;
 IF data->>'job_id' IS NOT NULL AND TG_TABLE_NAME<>'agy_jobs' THEN
  SELECT tenant_id,workspace_id,project_id INTO parent_scope FROM agy_jobs WHERE job_id=(data->>'job_id')::uuid;
  IF NOT FOUND OR (parent_scope.tenant_id,parent_scope.workspace_id,parent_scope.project_id) IS DISTINCT FROM (NEW.tenant_id,NEW.workspace_id,NEW.project_id) THEN RAISE EXCEPTION 'PARENT_SCOPE_DENIED';END IF;
 END IF;
 IF data->>'task_id' IS NOT NULL AND TG_TABLE_NAME<>'agy_tasks' THEN
  SELECT tenant_id,workspace_id,project_id,job_id INTO parent_scope FROM agy_tasks WHERE task_id=(data->>'task_id')::uuid;
  IF NOT FOUND OR (parent_scope.tenant_id,parent_scope.workspace_id,parent_scope.project_id) IS DISTINCT FROM (NEW.tenant_id,NEW.workspace_id,NEW.project_id)
   OR (data->>'job_id' IS NOT NULL AND parent_scope.job_id IS DISTINCT FROM (data->>'job_id')::uuid) THEN RAISE EXCEPTION 'TASK_SCOPE_DENIED';END IF;
 END IF;
 IF data->>'telemetry_id' IS NOT NULL AND TG_TABLE_NAME<>'agy_telemetry' THEN
  SELECT tenant_id,workspace_id,project_id INTO parent_scope FROM agy_telemetry WHERE telemetry_id=(data->>'telemetry_id')::bigint;
  IF NOT FOUND OR (parent_scope.tenant_id,parent_scope.workspace_id,parent_scope.project_id) IS DISTINCT FROM (NEW.tenant_id,NEW.workspace_id,NEW.project_id) THEN RAISE EXCEPTION 'TELEMETRY_SCOPE_DENIED';END IF;
 END IF;
 IF TG_TABLE_NAME='agy_tasks' THEN
  IF EXISTS(SELECT 1 FROM unnest(NEW.depends_on) d LEFT JOIN agy_tasks t ON t.task_id=d WHERE t.job_id IS DISTINCT FROM NEW.job_id) THEN RAISE EXCEPTION 'DEPENDENCY_SCOPE_DENIED';END IF;
 END IF;
 RETURN NEW;
END $$;

-- Scope every existing operational table, preserving counts and identifiers.
DO $$ DECLARE n text; BEGIN
 FOREACH n IN ARRAY ARRAY['agy_tasks','agy_task_events','agy_telemetry','agy_resource_reservations','agy_checkpoints','agy_learning_samples','agy_learning_events','agy_optimization_candidates','agy_learning_state','agy_learning_audit','agy_artifacts','agy_task_attempts','agy_qa_results','agy_lessons','agy_experiments'] LOOP
  EXECUTE format('ALTER TABLE %I ADD COLUMN tenant_id text, ADD COLUMN workspace_id text, ADD COLUMN project_id text',n);
  IF n IN ('agy_tasks','agy_task_events','agy_telemetry','agy_resource_reservations') THEN
   EXECUTE format('UPDATE %I x SET tenant_id=j.tenant_id,workspace_id=j.workspace_id,project_id=j.project_id FROM agy_jobs j WHERE x.job_id=j.job_id',n);
  ELSIF n='agy_checkpoints' THEN
   EXECUTE format('UPDATE %I x SET tenant_id=t.tenant_id,workspace_id=t.workspace_id,project_id=t.project_id FROM agy_tasks t WHERE x.task_id=t.task_id',n);
  ELSIF n='agy_learning_samples' THEN
   EXECUTE format('UPDATE %I x SET tenant_id=t.tenant_id,workspace_id=t.workspace_id,project_id=t.project_id FROM agy_telemetry t WHERE x.telemetry_id=t.telemetry_id',n);
  ELSIF n='agy_learning_events' THEN
   EXECUTE format('UPDATE %I x SET tenant_id=t.tenant_id,workspace_id=t.workspace_id,project_id=t.project_id FROM agy_telemetry t WHERE x.source_key=''telemetry:''||t.telemetry_id',n);
  END IF;
  -- No fabricated attribution for old singleton skills/audit/optimization records.
  -- Audit trigger is disabled only for adding scope during this transaction; contents untouched.
  IF n='agy_learning_audit' THEN ALTER TABLE agy_learning_audit DISABLE TRIGGER agy_audit_no_edit; END IF;
  EXECUTE format('UPDATE %I SET tenant_id=''migration-quarantine'',workspace_id=''legacy-workspace'',project_id=''LEGACY_IMPORTED'' WHERE tenant_id IS NULL',n);
  IF n='agy_learning_audit' THEN ALTER TABLE agy_learning_audit ENABLE TRIGGER agy_audit_no_edit; END IF;
 END LOOP;
 FOREACH n IN ARRAY ARRAY['agy_projects','agy_jobs','agy_tasks','agy_task_events','agy_telemetry','agy_resource_reservations','agy_checkpoints','agy_learning_samples','agy_learning_events','agy_optimization_candidates','agy_learning_state','agy_learning_audit','agy_project_learning_state','agy_project_learning_audit','agy_connectors','agy_artifacts','agy_task_attempts','agy_qa_results','agy_lessons','agy_experiments','agy_project_worker_health'] LOOP
  EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL, ALTER COLUMN workspace_id SET NOT NULL, ALTER COLUMN project_id SET NOT NULL',n);
  IF n NOT IN ('agy_projects','agy_jobs') THEN EXECUTE format('ALTER TABLE %I ADD FOREIGN KEY(tenant_id,workspace_id,project_id) REFERENCES agy_projects',n);END IF;
  EXECUTE format('CREATE POLICY project_isolation ON %I USING(agy_scope_matches(tenant_id,workspace_id,project_id)) WITH CHECK(agy_scope_matches(tenant_id,workspace_id,project_id))',n);
  EXECUTE format('CREATE TRIGGER agy_scope_guard BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION agy_fill_scope()',n);
  EXECUTE format('CREATE INDEX ON %I(tenant_id,workspace_id,project_id)',n);
 END LOOP;
 -- Validate every backfilled FK before FORCE RLS hides parent rows from a non-bypass migration owner.
 FOREACH n IN ARRAY ARRAY['agy_projects','agy_jobs','agy_tasks','agy_task_events','agy_telemetry','agy_resource_reservations','agy_checkpoints','agy_learning_samples','agy_learning_events','agy_optimization_candidates','agy_learning_state','agy_learning_audit','agy_project_learning_state','agy_project_learning_audit','agy_connectors','agy_artifacts','agy_task_attempts','agy_qa_results','agy_lessons','agy_experiments','agy_project_worker_health'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',n);EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',n);
 END LOOP;
END $$;
ALTER VIEW agy_competency_observations SET(security_invoker=true);
ALTER TABLE agy_learning_events DROP CONSTRAINT agy_learning_events_source_key_key;
ALTER TABLE agy_learning_events ADD UNIQUE(tenant_id,workspace_id,project_id,source_key);
CREATE FUNCTION agy_initialize_project_library() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO agy_project_learning_state(tenant_id,workspace_id,project_id,state)
 VALUES(NEW.tenant_id,NEW.workspace_id,NEW.project_id,'{"skills":[],"candidates":[],"evidence":[],"experiments":[],"audit":[],"events":[],"activePointers":{}}');
 RETURN NEW;END $$;
CREATE TRIGGER agy_project_library_init AFTER INSERT ON agy_projects FOR EACH ROW EXECUTE FUNCTION agy_initialize_project_library();
CREATE FUNCTION agy_capture_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.status='CLAIMED' AND NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
  INSERT INTO agy_task_attempts(task_id,job_id,attempt,lease_token,status) VALUES(NEW.task_id,NEW.job_id,NEW.attempt,NEW.lease_token,'CLAIMED');
 END IF;
 IF NEW.attempt>0 THEN UPDATE agy_task_attempts SET status=NEW.status WHERE task_id=NEW.task_id AND attempt=NEW.attempt;END IF;
 RETURN NEW;END $$;
CREATE TRIGGER agy_attempt_capture AFTER UPDATE ON agy_tasks FOR EACH ROW EXECUTE FUNCTION agy_capture_attempt();

-- Global publication is separate from all private evidence. Runtime projects only get approved releases.
CREATE TABLE agy_global_skill_candidates(candidate_id text PRIMARY KEY,content jsonb NOT NULL,evidence jsonb NOT NULL,report_fingerprint text NOT NULL,created_by text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE agy_global_skills(skill_id text PRIMARY KEY,content jsonb NOT NULL,report_fingerprint text NOT NULL,approved_by text NOT NULL,approved_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE agy_platform_config(config_id text PRIMARY KEY,source_of_truth_ref text NOT NULL,policies jsonb NOT NULL);
INSERT INTO agy_platform_config VALUES('platform','local:PLATFORM-RUNBOOK.md','{"productionEnabled":false}');
COMMIT;
