-- Mission-scoped R11 transport ledger; existing PostgreSQL remains domain authority.
BEGIN;
CREATE TABLE agy_hosted_r11 (
 tenant_id text,workspace_id text,project_id text,
 workflow_id text NOT NULL REFERENCES agy_temporal_missions(workflow_id),
 document jsonb NOT NULL,
 PRIMARY KEY(tenant_id,workspace_id,project_id,workflow_id)
);
ALTER TABLE agy_hosted_r11 ENABLE ROW LEVEL SECURITY;
ALTER TABLE agy_hosted_r11 FORCE ROW LEVEL SECURITY;
CREATE POLICY hosted_r11_scope ON agy_hosted_r11 USING(agy_scope_matches(tenant_id,workspace_id,project_id)) WITH CHECK(agy_scope_matches(tenant_id,workspace_id,project_id));
CREATE TRIGGER hosted_r11_fill BEFORE INSERT OR UPDATE ON agy_hosted_r11 FOR EACH ROW EXECUTE FUNCTION agy_fill_scope();
COMMIT;
