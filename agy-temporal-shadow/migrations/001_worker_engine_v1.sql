-- PostgreSQL 17 includes gen_random_uuid(); no global extension installation is needed.

CREATE TYPE agy_job_status AS ENUM ('QUEUED','RUNNING','QA','PASS','FAIL','BLOCKED','CANCELLED');
CREATE TYPE agy_task_status AS ENUM ('QUEUED','CLAIMED','RUNNING','QA','PASS','FAIL','RETRY','BLOCKED','CANCELLED');
CREATE TYPE agy_schedule_mode AS ENUM ('SINGLE_WORKFLOW','PARALLEL_BATCH','DAG');

CREATE TABLE agy_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  objective text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}',
  mode agy_schedule_mode NOT NULL,
  status agy_job_status NOT NULL DEFAULT 'QUEUED',
  pass_threshold numeric(5,4) NOT NULL DEFAULT 0.8000 CHECK (pass_threshold BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE agy_tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES agy_jobs(job_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  name text NOT NULL,
  task_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  required_capabilities text[] NOT NULL DEFAULT '{}',
  depends_on uuid[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 0,
  status agy_task_status NOT NULL DEFAULT 'QUEUED',
  attempt integer NOT NULL DEFAULT 0,
  max_retry integer NOT NULL DEFAULT 2 CHECK (max_retry BETWEEN 0 AND 20),
  timeout_seconds integer NOT NULL DEFAULT 300 CHECK (timeout_seconds > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, idempotency_key)
);

CREATE TABLE agy_workers (
  worker_id text PRIMARY KEY,
  adapter text NOT NULL,
  capabilities text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','BUSY','DEGRADED','OFFLINE')),
  max_concurrency integer NOT NULL DEFAULT 1 CHECK (max_concurrency > 0),
  active_count integer NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  metadata jsonb NOT NULL DEFAULT '{}',
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agy_task_events (
  event_id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES agy_jobs(job_id) ON DELETE CASCADE,
  task_id uuid REFERENCES agy_tasks(task_id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  worker_id text,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agy_telemetry (
  telemetry_id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES agy_jobs(job_id) ON DELETE CASCADE,
  task_id uuid REFERENCES agy_tasks(task_id) ON DELETE CASCADE,
  worker_id text,
  adapter text,
  model text,
  tool text,
  outcome text NOT NULL,
  latency_ms integer,
  retry_count integer NOT NULL DEFAULT 0,
  cost_amount numeric(18,8),
  cost_currency text,
  quota_units numeric(18,4),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX agy_tasks_claim_idx ON agy_tasks (priority DESC, available_at, created_at)
  WHERE status IN ('QUEUED','RETRY');
CREATE INDEX agy_tasks_lease_idx ON agy_tasks (lease_expires_at)
  WHERE status IN ('CLAIMED','RUNNING');
CREATE INDEX agy_tasks_job_idx ON agy_tasks (job_id, status);

-- Atomic queue claim: SKIP LOCKED prevents duplicate claims without Redis.
CREATE OR REPLACE FUNCTION agy_claim_task(
  p_worker_id text,
  p_capabilities text[],
  p_lease_seconds integer DEFAULT 30
) RETURNS SETOF agy_tasks LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT t.task_id
    FROM agy_tasks t
    WHERE t.status IN ('QUEUED','RETRY')
      AND t.available_at <= now()
      AND t.required_capabilities <@ p_capabilities
      AND NOT EXISTS (
        SELECT 1 FROM unnest(t.depends_on) dep
        JOIN agy_tasks d ON d.task_id = dep
        WHERE d.status <> 'PASS'
      )
    ORDER BY t.priority DESC, t.available_at, t.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE agy_tasks t
  SET status='CLAIMED', claimed_by=p_worker_id, lease_token=gen_random_uuid(),
      lease_expires_at=now()+make_interval(secs=>p_lease_seconds), heartbeat_at=now(),
      attempt=t.attempt+1, updated_at=now()
  FROM candidate c WHERE t.task_id=c.task_id
  RETURNING t.*;
END $$;

CREATE OR REPLACE FUNCTION agy_reclaim_expired_tasks() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
  UPDATE agy_tasks
  SET status = CASE WHEN attempt <= max_retry THEN 'RETRY'::agy_task_status ELSE 'BLOCKED'::agy_task_status END,
      claimed_by=NULL, lease_token=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
      available_at=now(), error=jsonb_build_object('code','LEASE_EXPIRED'), updated_at=now()
  WHERE status IN ('CLAIMED','RUNNING') AND lease_expires_at < now();
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
