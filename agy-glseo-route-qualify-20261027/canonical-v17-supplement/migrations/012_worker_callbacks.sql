-- CANDIDATE migration 012 — worker callback outbox + receiver receipts
-- (AGY-GLSEO-ROUTE-QUALIFY-20261027; revised in v4 per QA finding T1).
-- NOT APPLIED anywhere. Review-only. Apply order: after 011.
--
-- Why new tables: platform tasks have no callback delivery ledger.
-- agy_temporal_receipts is mission-scoped (FK to agy_temporal_missions)
-- and must not be repurposed for platform tasks; agy_task_events is an
-- append-only event log without delivery state.
--
-- agy_worker_callbacks: one immutable result callback per (task,
-- attempt), inserted as PENDING by the worker's atomic result
-- transaction. Delivery is an external-boundary operation and is NOT
-- assumed exactly-once: before any network call the dispatcher moves
-- the row PENDING -> SENDING, stamping a fenced intent
-- (delivery_intent_at, delivery_attempts), then sends with the
-- deterministic callback_id as the idempotency key; only a receipt
-- validated against (callback_id, attempt, content_digest) may confirm
-- DELIVERED, and only under the same intent fence. A crash after the
-- intent therefore leaves a SENDING row, never a PENDING one: stale
-- intents are swept to UNKNOWN, never resent. An outcome that cannot
-- be validated (send succeeded but the response or the confirm commit
-- was lost, a void/mismatched receipt, a timeout) also lands in
-- UNKNOWN: it is reconciled against the receiver's readback, or
-- released back to PENDING only by an explicit, audited control-plane
-- act. QA acceptance stays in agy_qa_results / task status and is
-- never implied here.
--
-- agy_callback_receipts: the receiver-side ledger on the canonical
-- host. The receiver route records each callback_id at most once
-- (PRIMARY KEY + ON CONFLICT DO NOTHING): a duplicate send with the
-- same digest returns the original receipt with effect_count still 1;
-- a duplicate with a different digest is a conflict. Reconciliation
-- reads this table.
BEGIN;
CREATE TABLE agy_worker_callbacks (
  tenant_id text, workspace_id text, project_id text,
  callback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES agy_jobs,
  task_id uuid NOT NULL REFERENCES agy_tasks,
  attempt integer NOT NULL,
  worker_id text NOT NULL,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','DELIVERED','UNKNOWN','BLOCKED')),
  payload jsonb NOT NULL,
  content_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivery_intent_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_error text,
  UNIQUE (tenant_id, workspace_id, project_id, task_id, attempt)
);
ALTER TABLE agy_worker_callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agy_worker_callbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_callbacks_scope ON agy_worker_callbacks
  USING (agy_scope_matches(tenant_id, workspace_id, project_id))
  WITH CHECK (agy_scope_matches(tenant_id, workspace_id, project_id));
CREATE TRIGGER worker_callbacks_fill BEFORE INSERT OR UPDATE ON agy_worker_callbacks
  FOR EACH ROW EXECUTE FUNCTION agy_fill_scope();

CREATE TABLE agy_callback_receipts (
  tenant_id text, workspace_id text, project_id text,
  callback_id uuid PRIMARY KEY,
  task_id uuid NOT NULL,
  attempt integer NOT NULL,
  worker_id text,
  target text,
  content_digest text NOT NULL,
  effect_count integer NOT NULL DEFAULT 1,
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agy_callback_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agy_callback_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY callback_receipts_scope ON agy_callback_receipts
  USING (agy_scope_matches(tenant_id, workspace_id, project_id))
  WITH CHECK (agy_scope_matches(tenant_id, workspace_id, project_id));
CREATE TRIGGER callback_receipts_fill BEFORE INSERT OR UPDATE ON agy_callback_receipts
  FOR EACH ROW EXECUTE FUNCTION agy_fill_scope();
COMMIT;
