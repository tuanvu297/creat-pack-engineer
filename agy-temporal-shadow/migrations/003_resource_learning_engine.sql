ALTER TABLE agy_workers DROP CONSTRAINT agy_workers_status_check;
ALTER TABLE agy_workers ADD CONSTRAINT agy_workers_status_check CHECK(status IN ('READY','BUSY','DEGRADED','RATE_LIMITED','OFFLINE'));
ALTER TABLE agy_tasks ADD COLUMN checkpoint jsonb;
ALTER TABLE agy_tasks ADD COLUMN checkpoint_version integer NOT NULL DEFAULT 0;
ALTER TABLE agy_telemetry ADD COLUMN attempt_id text;
ALTER TABLE agy_telemetry ADD COLUMN usage_tokens bigint;
ALTER TABLE agy_telemetry ADD COLUMN context_loss boolean;
CREATE UNIQUE INDEX agy_usage_event_dedupe ON agy_telemetry(task_id,attempt_id,outcome) WHERE attempt_id IS NOT NULL;

CREATE TABLE agy_resource_reservations (
  reservation_id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agy_tasks(task_id),
  job_id uuid NOT NULL REFERENCES agy_jobs(job_id),
  worker_id text NOT NULL REFERENCES agy_workers(worker_id),
  attempt integer NOT NULL,
  expected_quota numeric NOT NULL CHECK(expected_quota >= 0),
  expected_cost numeric NOT NULL CHECK(expected_cost >= 0),
  actual_quota numeric CHECK(actual_quota >= 0),
  actual_cost numeric CHECK(actual_cost >= 0),
  state text NOT NULL DEFAULT 'HELD' CHECK(state IN ('HELD','SETTLED','EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,attempt)
);
CREATE TABLE agy_checkpoints (
  task_id uuid NOT NULL REFERENCES agy_tasks(task_id),
  version integer NOT NULL,
  attempt_id uuid NOT NULL,
  external_id text,
  context_digest text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,version)
);
CREATE TABLE agy_learning_state (
  state_id text PRIMARY KEY CHECK(state_id='library'),
  revision bigint NOT NULL DEFAULT 0,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO agy_learning_state(state_id,state) VALUES('library',
  '{"skills":[],"candidates":[],"evidence":[],"experiments":[],"audit":[],"events":[],"activePointers":{}}');
CREATE TABLE agy_learning_audit (
  sequence bigint PRIMARY KEY,
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION agy_immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit entries are append-only'; END $$;
CREATE TRIGGER agy_audit_no_edit BEFORE UPDATE OR DELETE ON agy_learning_audit FOR EACH ROW EXECUTE FUNCTION agy_immutable_audit();
CREATE TABLE agy_learning_events (
  event_id bigserial PRIMARY KEY,
  trigger_type text NOT NULL,
  context text NOT NULL,
  payload jsonb NOT NULL,
  source_key text UNIQUE NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION agy_queue_learning_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agy_learning_events(trigger_type,context,payload,source_key)
  VALUES(CASE WHEN NEW.outcome='QA_PENDING' THEN 'SKILL_GAP' ELSE 'JOB_OUTCOME' END,
    coalesce(NEW.task_type,'unknown'),to_jsonb(NEW),'telemetry:'||NEW.telemetry_id);
  RETURN NEW;
END $$;
CREATE TRIGGER agy_learning_event_capture AFTER INSERT ON agy_telemetry FOR EACH ROW EXECUTE FUNCTION agy_queue_learning_event();

-- Service promotion requires a separate authenticated approval path. No automatic deployments.
-- Use separate PostgreSQL roles for workers/API and approval administrators in staging.
