-- Additive, scoped native Codex command lane. Never grants arbitrary commands.
BEGIN;
CREATE TABLE agy_temporal_native_operations (
 tenant_id text,workspace_id text,project_id text,
 workflow_id text NOT NULL REFERENCES agy_temporal_missions(workflow_id),attempt integer NOT NULL,
 operation_id text NOT NULL UNIQUE,request_id text NOT NULL,state text NOT NULL DEFAULT 'INTENT',
 ack jsonb,checkpoint jsonb,result jsonb,error jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,workspace_id,project_id,workflow_id,attempt)
);
ALTER TABLE agy_temporal_native_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agy_temporal_native_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY temporal_native_scope ON agy_temporal_native_operations USING(agy_scope_matches(tenant_id,workspace_id,project_id)) WITH CHECK(agy_scope_matches(tenant_id,workspace_id,project_id));
CREATE TRIGGER temporal_native_fill BEFORE INSERT OR UPDATE ON agy_temporal_native_operations FOR EACH ROW EXECUTE FUNCTION agy_fill_scope();
COMMIT;
