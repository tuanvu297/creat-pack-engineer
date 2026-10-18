BEGIN;
CREATE TABLE agy_global_learning_audit(sequence bigserial PRIMARY KEY,actor text NOT NULL,action text NOT NULL,candidate_id text NOT NULL,fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER agy_global_audit_no_edit BEFORE UPDATE OR DELETE ON agy_global_learning_audit FOR EACH ROW EXECUTE FUNCTION agy_immutable_audit();
COMMIT;
