-- Portable PostgreSQL 17+ staging reservation ledger. Apply only after A0
-- schema/backup readback and the mission-specific grant review.
CREATE SCHEMA IF NOT EXISTS agy_dispatch;
REVOKE ALL ON SCHEMA agy_dispatch FROM PUBLIC;

CREATE TABLE IF NOT EXISTS agy_dispatch.reservations (
  operation_id uuid PRIMARY KEY,
  identity_id text NOT NULL,
  run_id text NOT NULL,
  task_id text NOT NULL,
  attempt_id text NOT NULL,
  idempotency_key text NOT NULL,
  binding_digest text NOT NULL CHECK (binding_digest ~ '^[a-f0-9]{64}$'),
  nonce text NOT NULL CHECK (nonce ~ '^[a-f0-9]{32,128}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (identity_id, run_id, idempotency_key),
  UNIQUE (identity_id, run_id, nonce)
);

REVOKE ALL ON agy_dispatch.reservations FROM PUBLIC;
CREATE INDEX IF NOT EXISTS dispatch_reservations_rate_idx
  ON agy_dispatch.reservations (identity_id, run_id, created_at DESC);

