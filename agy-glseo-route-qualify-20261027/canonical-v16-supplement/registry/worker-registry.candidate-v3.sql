-- Canonical worker registry — CANDIDATE v3 (AGY-GLSEO-ROUTE-QUALIFY-20261027)
-- Supersedes worker-registry.candidate.sql in PR #15 (which stays frozen
-- as the review snapshot) after independent QA finding C6.
--
-- C6 correction: the v1 seed asserted READY status, quota_remaining=100,
-- quota_reserve=20, quotaCap=200, passRate=0.95, errorRate=0. Those were
-- simulated numbers with NO real account quota/resource evidence behind
-- them. They must never activate live allocation or imply budget. This v2
-- therefore provisions every worker UNQUALIFIED and fail-closed:
--   * status = 'OFFLINE' (resourceFromRow: ready = status='READY', so an
--     OFFLINE worker is never allocated),
--   * quota_remaining = NULL (UNKNOWN — the column and resourceFromRow
--     both support null),
--   * resource_profile carries NO reliability claims (no pass/error
--     rates); spendCap = 0 (a restriction: no spend authorized),
--     quotaCap = null (unknown, not a grant),
--   * connectors enabled = false (the dispatch projection derives
--     adapter_kinds from ENABLED kinds; disabled = not bound),
--   * metadata.qualification = 'UNVERIFIED' with the evidence state.
-- v3 (T3): the bindings shape is now COMPLETE for the qualification
-- namespace — missions, task_types AND reply_targets must all be
-- provisioned, non-empty, or the worker is denied at claim time. The
-- mission id below ('GL_SEO_DAILY') is the control plane's to confirm
-- at provisioning; tasks must carry it explicitly together with
-- target_worker_id and callback_target.
--
-- Activation is a separate, evidenced control-plane act: measure/verify
-- the real account quota and rates, write THOSE values, set status to
-- 'READY', and enable the connector rows. Nothing in this file does it.
--
-- Capabilities are DECLARED, not self-claimed rights:
--   * Muse: text/creative/planning/qa were exercised in this
--     qualification's document and QA work; no AGY runtime execution
--     probe has passed yet, hence OFFLINE/UNVERIFIED.
--   * Gemini: the user's assignment is research/planning, but Gemini's
--     verified probes so far are browser reads only (ledger/docs,
--     /health) with no runtime ACK. Its capabilities column stays EMPTY
--     and the declared set is recorded in metadata only; capabilities
--     activate per Gemini-side probe + acceptance, never by this file.
--
-- Credential references name the connector identity, not a person-token:
-- Muse's is 'vault:custom.agy-worker' (the connector id). No secret is
-- created by this file; Gemini's reference is Gemini-side and not created
-- here either.
--
-- Run by the control plane inside one transaction with the project scope
-- set. Idempotent (ON CONFLICT DO NOTHING). NOT RUN anywhere by Muse.
begin;
select set_config('agy.tenant_id','gl',true),
       set_config('agy.workspace_id','legacy-workspace',true),
       set_config('agy.project_id','GL_AUTOMATION',true);

insert into agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
values ('MUSE-SEO-WORKER','muse',ARRAY['text','creative','planning','qa'],'OFFLINE',1,
        '{"permissions":["read","analyze","planning","qa"],"spendCap":0,"quotaCap":null,"quotaUsed":0,"spendUsed":0}'::jsonb,
        null,0,false,
        '{"qualification":"UNVERIFIED","evidence":null,
          "bindings":{"missions":["GL_SEO_DAILY"],"task_types":["planning","research","qa","creative"],"reply_targets":["CHATGPT_ASSISTANT_CONTROL_PLANE"]}}'::jsonb)
on conflict (worker_id) do nothing;

insert into agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
values ('GEMINI-SEO-WORKER','gemini',ARRAY[]::text[],'OFFLINE',1,
        '{"permissions":["read","analyze","planning","qa"],"spendCap":0,"quotaCap":null,"quotaUsed":0,"spendUsed":0}'::jsonb,
        null,0,false,
        '{"qualification":"UNVERIFIED","evidence":"browser reads only (ledger/docs/health); no runtime ACK",
          "declared_capabilities":["research","planning"],
          "bindings":{"reply_targets":["CHATGPT_ASSISTANT_CONTROL_PLANE"]}}'::jsonb)
on conflict (worker_id) do nothing;

insert into agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
values ('gl','legacy-workspace','GL_AUTOMATION','muse-seo','muse',ARRAY['text','creative','planning','qa'],
        'https://agy-temporal-staging-staging.up.railway.app/v1/worker','vault:custom.agy-worker',false,
        ARRAY['read','analyze','planning','qa'])
on conflict do nothing;

insert into agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
values ('gl','legacy-workspace','GL_AUTOMATION','gemini-seo','gemini',ARRAY[]::text[],
        'browser-adapter:/worker/ui (contract in QA; no native MCP)','vault:gemini-side-not-created',false,
        ARRAY['read','analyze','planning','qa'])
on conflict do nothing;

-- Verification readback expected after commit:
--   select worker_id, status, quota_remaining, metadata->>'qualification'
--     from agy_workers where worker_id in ('MUSE-SEO-WORKER','GEMINI-SEO-WORKER');
--   -- both rows: status OFFLINE, quota_remaining NULL, UNVERIFIED.
--   select project_id, adapter_kinds from agy_dispatch_projects
--     where tenant_id='gl' and project_id='GL_AUTOMATION';
--   -- adapter_kinds must NOT yet include muse/gemini (connectors disabled).
commit;
