-- Qualification registry — CANDIDATE (AGY-GLSEO-ROUTE-QUALIFY-20261027)
-- Provisions the DEDICATED qualification worker for the G2 window.
-- Nothing here is applied anywhere; all rows start dormant.
--
-- PIN FACTS this file is built on (verified by reading the source):
--   * agy_workers is GLOBAL. Migration 001: worker_id is the PRIMARY
--     KEY and the table has NO tenant/workspace/project columns.
--     Migration 004's RLS/scope loops enumerate 21 tables;
--     agy_workers is NOT among them. ResourceStore.list() selects all
--     rows unscoped and register() upserts ON CONFLICT(worker_id).
--     metadata.bindings therefore live on the global row.
--   * Consequence: the SAME worker_id cannot be OFFLINE for business
--     and READY for qualification, and bindings cannot differ per
--     project for one worker_id. Any plan claiming "project-scoped
--     worker registration" is wrong.
--   * What IS project-scoped: agy_connectors (in the 004 RLS list),
--     hence the dispatch projection's adapter_kinds per project.
--
-- The metadata flag external_namespace_only=true is the ungated-route
-- half of the isolation: the legacy allocator (whose dispatch query
-- and selection stay pin-exact) excludes such workers from
-- allowedWorkers whenever a claim carries no gate, so the legacy
-- route can never select this worker in any project. Gated claims
-- (the new namespace) are unaffected by the flag.
--
-- Isolation therefore uses a DISTINCT worker_id + DISTINCT adapter
-- kind that exists only in the qualification project:
--   * MUSE-SEO-WORKER (business row, registry candidate v3) stays
--     OFFLINE with incomplete bindings for the whole G2 window;
--     nothing in this file touches it.
--   * MUSE-QUAL-WORKER is single-purpose: its global bindings are
--     safe precisely because the row serves nothing else.
--   * Adapter kind 'muse-qual' is inserted ONLY in GL_QUALIFICATION,
--     so allocation in GL_AUTOMATION can never select this worker
--     (allowedWorkers is adapter-filtered per project), and
--     GL_QUALIFICATION binds no other kind.
--
-- Run inside a transaction with the scope GUCs set to the
-- qualification project (agy.tenant_id / agy.workspace_id /
-- agy.project_id). Every UPDATE below carries an explicit scope
-- WHERE: migration 004 backfills a GL_AUTOMATION project row for
-- tenant 'gl', and an unscoped UPDATE on agy_projects is denied by
-- the scope guard when it touches other projects' rows.

-- 1) Qualification project (create once; policy shape is exact —
--    selectProjectDemand SKIPS a project whose resource_policy lacks
--    any of maxConcurrentTasks/quotaCap/spendCap/reservation as
--    finite numbers). Priority is raised above business only for the
--    window (cross-project selection is global and sorts by project
--    priority first); the rollback restores priority 0 / PAUSED.
insert into agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref)
values ('gl','legacy-workspace','GL_QUALIFICATION','GL Qualification','owner-registry','owner-registry')
on conflict do nothing;
update agy_projects
   set status='ACTIVE', priority=10,
       permissions=ARRAY['read','analyze','planning','qa'],
       resource_policy='{"maxConcurrentTasks":1,"quotaCap":100,"spendCap":0,"reservation":0}'
 where tenant_id='gl' and workspace_id='legacy-workspace' and project_id='GL_QUALIFICATION';

-- 2) The qualification adapter kind, ONLY in this project.
insert into agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
values ('gl','legacy-workspace','GL_QUALIFICATION','muse-qual-x','muse-qual',ARRAY['planning'],'local','vault:custom.agy-worker',true,ARRAY['read','analyze','planning','qa'])
on conflict do nothing;

-- 3) The dedicated qualification worker — dormant as provisioned:
--    OFFLINE, quota NULL (UNKNOWN), no reliability numbers anywhere
--    (the synthetic job carries pass_threshold 0, so allocation never
--    needs a passRate claim), complete bindings for its one mission.
insert into agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
values ('MUSE-QUAL-WORKER','muse-qual',ARRAY['planning'],'OFFLINE',1,
        '{"spendCap":0,"quotaCap":null,"qualificationNote":"cap-only transition happens only inside the approved G2 window"}',
        null,0,false,
        '{"bindings":{"missions":["GL_QUALIFICATION"],"task_types":["planning"],"reply_targets":["CHATGPT_ASSISTANT_CONTROL_PLANE"]},"qualification":"UNVERIFIED","evidence":"none","external_namespace_only":true}')
on conflict (worker_id) do nothing;

-- 4) WINDOW TRANSITION (execute only inside the approved 60-minute
--    window, after preflight): cap-only profile. quota_reserve MUST
--    be 0 — the scheduler hard-gate requires
--    quotaRemaining - estimatedQuota >= quotaReserve, so a cap of 1
--    with any positive reserve can never allocate the one task.
-- update agy_workers set status='READY', quota_remaining=1, quota_reserve=0
--  where worker_id='MUSE-QUAL-WORKER';

-- 5) ROLLBACK (window end or abort): dormant again, evidence kept.
-- update agy_workers set status='OFFLINE', quota_remaining=null
--  where worker_id='MUSE-QUAL-WORKER';
-- update agy_projects set status='PAUSED', priority=0
--  where tenant_id='gl' and workspace_id='legacy-workspace' and project_id='GL_QUALIFICATION';
