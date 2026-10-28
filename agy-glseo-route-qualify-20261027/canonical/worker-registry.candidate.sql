-- Canonical worker registry — CANDIDATE (AGY-GLSEO-ROUTE-QUALIFY-20261027)
-- Run by the control plane against EXISTING_POSTGRES_D049 (staging schema
-- of the hosted staging service) inside one transaction with the project
-- scope set, exactly as the repo's own provisioning/tests do. Idempotent:
-- ON CONFLICT DO NOTHING — re-running never widens an existing binding;
-- changes go through an explicit reviewed UPDATE, not this file.
-- NOT RUN anywhere by Muse.
begin;
select set_config('agy.tenant_id','gl',true),
       set_config('agy.workspace_id','legacy-workspace',true),
       set_config('agy.project_id','GL_AUTOMATION',true);

-- Worker registry rows (allocation reads these via resourceFromRow).
insert into agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain)
values ('MUSE-SEO-WORKER','muse',ARRAY['text','creative','planning','qa'],'READY',1,
        '{"permissions":["read","analyze","planning","qa"],"passRate":0.95,"retryRate":0,"errorRate":0,"contextLossRisk":0,"costPerTask":0,"spendCap":0,"quotaCap":200,"quotaUsed":0,"spendUsed":0}'::jsonb,
        100,20,false)
on conflict (worker_id) do nothing;

insert into agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain)
values ('GEMINI-SEO-WORKER','gemini',ARRAY['text','qa'],'READY',1,
        '{"permissions":["read","analyze","planning","qa"],"passRate":0.95,"retryRate":0,"errorRate":0,"contextLossRisk":0,"costPerTask":0,"spendCap":0,"quotaCap":200,"quotaUsed":0,"spendUsed":0}'::jsonb,
        100,20,false)
on conflict (worker_id) do nothing;

-- Project connector bindings: the dispatch projection derives
-- adapter_kinds from ENABLED connector kinds; a worker is allocatable in
-- this project only when its adapter matches one of these kinds.
insert into agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
values ('gl','legacy-workspace','GL_AUTOMATION','muse-seo','muse',ARRAY['text','creative','planning','qa'],
        'https://agy-temporal-staging-staging.up.railway.app/v1/worker','vault:agy-worker-claude-token',true,
        ARRAY['read','analyze','planning','qa'])
on conflict do nothing;

insert into agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
values ('gl','legacy-workspace','GL_AUTOMATION','gemini-seo','gemini',ARRAY['text','qa'],
        'browser-adapter:gemini (contract prepared Gemini-side; no native MCP)','vault:agy-worker-gemini-token',true,
        ARRAY['read','analyze','planning','qa'])
on conflict do nothing;

-- Verification readback expected after commit:
--   select worker_id, adapter, capabilities from agy_workers
--     where worker_id in ('MUSE-SEO-WORKER','GEMINI-SEO-WORKER');
--   select project_id, adapter_kinds from agy_dispatch_projects
--     where tenant_id='gl' and project_id='GL_AUTOMATION';
-- adapter_kinds must include both 'muse' and 'gemini'.
commit;
