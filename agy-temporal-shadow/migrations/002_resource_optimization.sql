-- Apply after 001. Execute enum addition outside an explicit transaction.
ALTER TYPE agy_schedule_mode ADD VALUE IF NOT EXISTS 'MULTI_JOB_CONCURRENT';
ALTER TABLE agy_tasks ADD COLUMN policy jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agy_tasks ADD COLUMN importance numeric NOT NULL DEFAULT .5 CHECK (importance BETWEEN 0 AND 1);
ALTER TABLE agy_tasks ADD COLUMN expected_value numeric NOT NULL DEFAULT .5 CHECK (expected_value BETWEEN 0 AND 1);
ALTER TABLE agy_tasks ADD COLUMN failed_workers text[] NOT NULL DEFAULT '{}';
ALTER TABLE agy_workers ADD COLUMN resource_profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agy_workers ADD COLUMN quota_remaining numeric;
ALTER TABLE agy_workers ADD COLUMN quota_reserve numeric NOT NULL DEFAULT 0 CHECK (quota_reserve >= 0);
ALTER TABLE agy_workers ADD COLUMN central_brain boolean NOT NULL DEFAULT false;
ALTER TABLE agy_telemetry ADD COLUMN task_type text;
ALTER TABLE agy_telemetry ADD COLUMN prompt_version text;
ALTER TABLE agy_telemetry ADD COLUMN error_type text;
ALTER TABLE agy_telemetry ADD COLUMN qa_feedback jsonb NOT NULL DEFAULT '[]';
ALTER TABLE agy_telemetry ADD COLUMN human_correction text;
ALTER TABLE agy_telemetry ADD COLUMN final_outcome text;
ALTER TABLE agy_telemetry ADD COLUMN resource_snapshot jsonb NOT NULL DEFAULT '{}';

CREATE TABLE agy_learning_samples (
  sample_id bigserial PRIMARY KEY,
  telemetry_id bigint UNIQUE NOT NULL REFERENCES agy_telemetry(telemetry_id),
  observed_at timestamptz NOT NULL DEFAULT now(),
  evidence jsonb NOT NULL,
  eligible_for_promotion boolean NOT NULL DEFAULT false
);
CREATE TABLE agy_optimization_candidates (
  candidate_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage text NOT NULL DEFAULT 'CANDIDATE' CHECK (stage IN ('CANDIDATE','TEST','COMPARE_WITH_BASELINE','COLLECT_EVIDENCE','REPORT','USER_APPROVAL','PROMOTED','REJECTED')),
  baseline jsonb NOT NULL,
  candidate jsonb NOT NULL,
  evidence_report jsonb,
  approved_by text,
  approved_at timestamptz,
  CHECK (stage <> 'PROMOTED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
-- Every task telemetry event also supplies the learning dataset; approval is never automatic.
CREATE FUNCTION agy_capture_learning_sample() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agy_learning_samples(telemetry_id,evidence)
  VALUES(NEW.telemetry_id,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER agy_learning_capture AFTER INSERT ON agy_telemetry
FOR EACH ROW EXECUTE FUNCTION agy_capture_learning_sample();

-- Registry capacity is released when execution leaves its active states.
CREATE FUNCTION agy_release_worker_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('CLAIMED','RUNNING') AND NEW.status NOT IN ('CLAIMED','RUNNING') THEN
    UPDATE agy_workers SET active_count=greatest(0,active_count-1) WHERE worker_id=OLD.claimed_by;
    IF NEW.status IN ('RETRY','BLOCKED') AND OLD.claimed_by IS NOT NULL THEN
      NEW.failed_workers=array_append(OLD.failed_workers,OLD.claimed_by);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agy_capacity_release BEFORE UPDATE OF status ON agy_tasks
FOR EACH ROW EXECUTE FUNCTION agy_release_worker_capacity();

-- Populate typed fields from the versioned learning packet written by the engine.
CREATE FUNCTION agy_enrich_telemetry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.task_type=NEW.metadata->>'taskType';
  NEW.prompt_version=NEW.metadata->>'promptVersion';
  NEW.error_type=NEW.metadata->>'errorType';
  NEW.qa_feedback=coalesce(NEW.metadata->'qaFeedback','[]'::jsonb);
  NEW.human_correction=NEW.metadata->>'humanCorrection';
  NEW.final_outcome=NEW.metadata->>'finalOutcome';
  RETURN NEW;
END $$;
CREATE TRIGGER agy_telemetry_enrichment BEFORE INSERT ON agy_telemetry
FOR EACH ROW EXECUTE FUNCTION agy_enrich_telemetry();

-- Remove the legacy capability-only claim bypass; resource-aware claim uses service transactions.
DROP FUNCTION agy_claim_task(text,text[],integer);

CREATE VIEW agy_competency_observations AS
SELECT worker_id,adapter,model,task_type,prompt_version,
 count(*) FILTER (WHERE final_outcome IN ('PASS','FAIL','BLOCKED')) AS evaluated_samples,
 avg((final_outcome='PASS')::integer) FILTER (WHERE final_outcome IN ('PASS','FAIL','BLOCKED')) AS pass_rate,
 avg((retry_count>0)::integer) AS retry_rate,
 avg(latency_ms) AS latency_ms,
 sum(cost_amount) AS observed_cost, sum(quota_units) AS observed_quota
FROM agy_telemetry GROUP BY worker_id,adapter,model,task_type,prompt_version;
