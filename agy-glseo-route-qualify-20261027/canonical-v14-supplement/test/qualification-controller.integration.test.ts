// Integration tests for the CANDIDATE qualification provisioning
// controller (findings D1–D3 as accepted; E1–E4 revisions).
// Evidence class: LOCAL integration — real local PostgreSQL 18.4,
// repo migrations 001-008 + candidate 012, the controller running
// under the role-switched RUNTIME pool (never the owner). Every
// test's qualification scope starts COMPLETELY EMPTY (no project,
// worker, or connector rows): the controller must build the window
// itself, exactly once. Worker presence comes ONLY from the
// exposed worker-surface 'arrive' action — no test calls
// ResourceStore.register, and no profile measurement is ever
// fabricated: arrival projects the project's own provisioned
// permissions + quotaCap, and passRate & friends stay at the
// engine's DEFAULT_NOT_MEASURED values.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createWorkerSurface } from "../src/platform/worker-surface.js";
import { createQualificationController, parseQualificationConfig, QUALIFICATION_SCOPE } from "../src/platform/qualification-controller.js";
import type { Principal } from "../src/platform/auth.js";

const scopeQ = QUALIFICATION_SCOPE;
const scopeBiz = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' };
const qualP: Principal = { subject: 'qual-worker', role: 'worker', workerId: 'MUSE-QUAL-WORKER', scopes: [scopeQ] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const schema = `agy_qual_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_qual_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const owner = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  await admin.query(`CREATE SCHEMA ${schema}`);
  for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','012_worker_callbacks.sql'])
    await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
  await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  const runtime: Pool = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
  const q = async (sql: string, params?: unknown[]) => (await owner.query(sql, params as any)).rows;
  const scopedTx = async (scope: typeof scopeQ, fn: (c: any) => Promise<void>) => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true),set_config('agy.subject','setup',true)",
        [scope.tenantId, scope.workspaceId, scope.projectId]);
      await fn(c);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  // Business scope seeded (owner) — the controller must never reach it.
  await scopedTx(scopeBiz, async (c) => {
    await c.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'Greenlife Spa','repo:gl','policy:gl') ON CONFLICT DO NOTHING`,
      [scopeBiz.tenantId, scopeBiz.workspaceId, scopeBiz.projectId]);
    await c.query(`UPDATE agy_projects SET status='ACTIVE',priority=5,permissions=ARRAY['read','analyze','planning','qa'],resource_policy='{"maxConcurrentTasks":2,"quotaCap":100,"spendCap":0,"reservation":0}' WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_AUTOMATION'`);
  });
  await owner.query(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
    VALUES('MUSE-SEO-WORKER','muse',ARRAY['planning'],'OFFLINE',1,'{"spendCap":0,"quotaCap":null}',null,0,false,'{"team":"business"}')`);
  const bizProjBefore = (await q(`SELECT status,priority,resource_policy FROM agy_projects WHERE project_id='GL_AUTOMATION'`))[0];
  const bizWorkerBefore = (await q(`SELECT status,metadata,quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0];
  const waitState = async (ctl: any, states: string[], ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const s = ctl.state(); if (states.includes(s)) return s; await sleep(50); }
    return ctl.state();
  };
  const grant = async (runId: string, ttlMs = 60_000) => {
    const cfg = { enabled: true, runId, expiresAtMs: Date.now() + ttlMs, intervalMs: 50 };
    const ctl = createQualificationController(runtime, { config: cfg, log: () => {} });
    ctl.start();
    assert.equal(await waitState(ctl, ['ACTIVE', 'BLOCKED']), 'ACTIVE', `grant ${runId} reaches ACTIVE`);
    return { ctl, cfg };
  };
  const assertBizUntouched = async () => {
    assert.equal(JSON.stringify((await q(`SELECT status,priority,resource_policy FROM agy_projects WHERE project_id='GL_AUTOMATION'`))[0]), JSON.stringify(bizProjBefore), 'business project untouched');
    assert.equal(JSON.stringify((await q(`SELECT status,metadata,quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0]), JSON.stringify(bizWorkerBefore), 'business worker untouched');
  };
  const teardown = async () => {
    await runtime.end(); await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  };
  return { q, scopedTx, runtime, owner, waitState, grant, assertBizUntouched, teardown, role };
}
const qualJobCount = async (env: any) => (await env.q(`SELECT count(*)::int AS n FROM agy_jobs`))[0].n;
const neutralEvents = async (env: any, taskId: string) =>
  (await env.q(`SELECT count(*)::int AS n FROM agy_task_events WHERE task_id=$1 AND event_type='QUALIFICATION_LEASE_NEUTRALIZED'`, [taskId]))[0].n;

test("T1 lifecycle: one-shot grant, arrival-only presence (E4), full cycle via exposed actions, monitor discipline, foreign block, cleanup",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime } = env;
  try {
    // Default-disabled gates.
    assert.equal(parseQualificationConfig({}).reason, 'NOT_ENABLED');
    assert.equal(parseQualificationConfig({ AGY_QUALIFICATION_ENABLED: 'true' }).reason, 'STAGE_ONLY_REQUIRED');
    assert.equal(parseQualificationConfig({ AGY_QUALIFICATION_ENABLED: 'true', AGY_STAGE_ONLY: 'true', AGY_QUALIFICATION_RUN_ID: 'run-x', AGY_QUALIFICATION_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() }).reason, 'CAP_ONLY_APPROVAL_REQUIRED');

    const { ctl, cfg } = await env.grant('run-t1');
    const proj = (await q(`SELECT status,priority,resource_policy,policies FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0];
    assert.equal(proj.status, 'ACTIVE'); assert.equal(proj.priority, 10);
    assert.equal(proj.resource_policy.quotaCap, 1, 'D3: qualification quotaCap is exactly 1');
    assert.equal(proj.policies.qualificationRun.run_id, 'run-t1');
    assert.equal(proj.policies.qualificationRun.phase, 'GRANTED', 'E1: the grant marker completed PREPARING -> GRANTED');
    const worker0 = (await q(`SELECT status,quota_remaining,resource_profile,metadata,heartbeat_at FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.equal(worker0.status, 'READY'); assert.equal(Number(worker0.quota_remaining), 1);
    assert.equal(worker0.resource_profile.quotaCap, null, 'E4: the controller grants a SHELL profile only (quotaCap null)');
    assert.equal(worker0.resource_profile.passRate, undefined, 'no fabricated measurement at grant time');
    const job = (await q(`SELECT job_id FROM agy_jobs WHERE idempotency_key='run-t1'`))[0];
    const task = (await q(`SELECT task_id,payload FROM agy_tasks WHERE job_id=$1`, [job.job_id]))[0];
    assert.equal(task.payload.mission_id, 'GL_QUALIFICATION'); assert.equal(task.payload.target_worker_id, 'MUSE-QUAL-WORKER');

    // E4: before arrival the window cannot run — the shell profile
    // has no presence, no permissions, quotaCap null.
    const surf = createWorkerSurface(runtime);
    const earlyClaim = await surf(qualP, scopeQ, 'claim', {});
    assert.equal(earlyClaim.status, 'EMPTY', 'no claim is possible before the worker actually arrives');

    // An unprovisioned identity cannot arrive (no self-provisioning).
    const ghostP: Principal = { subject: 'ghost', role: 'worker', workerId: 'GHOST-WORKER', scopes: [scopeQ] };
    await assert.rejects(() => surf(ghostP, scopeQ, 'arrive', {}), /WORKER_NOT_PROVISIONED/);

    // Arrival: ONLY the exposed surface action, nothing else.
    const arrived = await surf(qualP, scopeQ, 'arrive', {});
    assert.equal(arrived.status, 'READY');
    const worker1 = (await q(`SELECT resource_profile,quota_remaining,metadata FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.deepEqual(worker1.resource_profile.permissions, ['read', 'analyze', 'planning', 'qa'],
      'arrival projects the project\'s own provisioned permissions');
    assert.equal(worker1.resource_profile.quotaCap, 1, 'arrival projects the project\'s own approved cap (exactly 1)');
    assert.equal(worker1.resource_profile.passRate, undefined, 'DEFAULT_NOT_MEASURED preserved: arrival fabricates no passRate');
    assert.equal(Number(worker1.quota_remaining), 1, 'arrival never grants or refills quota');
    assert.deepEqual(worker1.metadata, worker0.metadata, 'arrival does not touch provisioning metadata/bindings');

    // Full cycle through exposed actions only, lease capped at an
    // owner deadline: lease_expires_at <= deadline EXACTLY (E2).
    const capD = Date.now() + 8_000;
    const surfCap = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => s.projectId === 'GL_QUALIFICATION' ? capD : undefined });
    const claim = await surfCap(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED'); assert.equal(claim.task.taskId, task.task_id);
    const leaseRow = (await q(`SELECT lease_expires_at FROM agy_tasks WHERE task_id=$1`, [task.task_id]))[0];
    assert.ok(new Date(leaseRow.lease_expires_at).getTime() <= capD, 'E2: lease_expires_at <= the exact deadline (no tolerance)');
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 0, 'the claim consumed the one cap unit');
    await surfCap(qualP, scopeQ, 'ack', { task_id: task.task_id, lease_token: claim.task.leaseToken, attempt: claim.task.attempt });
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [task.task_id]))[0].status, 'RUNNING');
    await surfCap(qualP, scopeQ, 'heartbeat', { task_id: task.task_id, lease_token: claim.task.leaseToken, attempt: claim.task.attempt });
    const result = await surfCap(qualP, scopeQ, 'result', { task_id: task.task_id, lease_token: claim.task.leaseToken, attempt: claim.task.attempt,
      result: { summary: 'qualification synthetic result' }, evidence: { external_operation_id: 'op-t1-1' } });
    assert.equal(result.status, 'RESULT_SUBMITTED');
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [task.task_id]))[0].status, 'QA');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claim.task.leaseToken]))[0].state, 'SETTLED');

    // D1: monitor ticks / a restarted controller never refill.
    await ctl.tick();
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 0);
    const ctlRestart = createQualificationController(runtime, { config: cfg, log: () => {} });
    ctlRestart.start();
    assert.equal(await env.waitState(ctlRestart, ['ACTIVE', 'BLOCKED']), 'ACTIVE');
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 0, 'restart does not refill');
    assert.equal(await qualJobCount(env), 1);
    ctlRestart.stop();

    // D1: an owner pause after the grant is NOT undone by monitoring.
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`UPDATE agy_projects SET status='PAUSED' WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`);
      await c.query(`UPDATE agy_workers SET status='OFFLINE' WHERE worker_id='MUSE-QUAL-WORKER'`);
    });
    await ctl.tick();
    assert.equal((await q(`SELECT status FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0].status, 'PAUSED', 'monitor does not re-activate an owner-paused project');
    assert.equal((await q(`SELECT status FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].status, 'OFFLINE', 'monitor does not re-ready an owner-offlined worker');
    ctl.stop();

    // D2: a foreign run id fails closed on this run's persisted grant.
    const ctlForeign = createQualificationController(runtime, { config: { enabled: true, runId: 'run-foreign', expiresAtMs: Date.now() + 60_000, intervalMs: 50 }, log: () => {} });
    ctlForeign.start();
    assert.equal(await env.waitState(ctlForeign, ['BLOCKED', 'ACTIVE']), 'BLOCKED');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_jobs WHERE idempotency_key='run-foreign'`))[0].n, 0);
    ctlForeign.stop();

    // Guarded cleanup with NO active lease: dormant state, zero
    // neutralization events, evidence preserved.
    const ctlRb = createQualificationController(runtime, { config: { ...cfg, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    ctlRb.start();
    assert.equal(await env.waitState(ctlRb, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK');
    assert.equal(await neutralEvents(env, task.task_id), 0, 'no active lease at cleanup -> no neutralization event');
    assert.equal((await q(`SELECT enabled FROM agy_connectors WHERE connector_id='muse-qual-x'`))[0].enabled, false);
    assert.equal((await q(`SELECT status FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0].status, 'PAUSED');
    assert.equal(await qualJobCount(env), 1, 'evidence preserved');
    ctlRb.stop();

    // F1: arrival after cleanup is REFUSED with zero mutation —
    // the window is closed (project PAUSED, connector disabled,
    // worker OFFLINE) and arrival must not revive any of it.
    const workerBeforeArrive = (await q(`SELECT status,heartbeat_at,resource_profile FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    await assert.rejects(() => surf(qualP, scopeQ, 'arrive', {}), /ARRIVAL_NOT_GRANTED/);
    const workerAfterArrive = (await q(`SELECT status,heartbeat_at,resource_profile FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.equal(JSON.stringify(workerAfterArrive), JSON.stringify(workerBeforeArrive), 'a refused arrival mutates nothing');
    const afterClaim = await surf(qualP, scopeQ, 'claim', {});
    assert.equal(afterClaim.status, 'EMPTY', 'arrival alone cannot reopen a cleaned-up window');
    assert.equal((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining, null);

    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T2 concurrency (E1): concurrent different runs yield exactly one owner; same-run concurrency converges",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime } = env;
  try {
    const expiresAtMs = Date.now() + 60_000;
    const mk = (runId: string) => createQualificationController(runtime,
      { config: { enabled: true, runId, expiresAtMs, intervalMs: 25 }, log: () => {} });
    const ctlA = mk('run-a'); const ctlB = mk('run-b');
    ctlA.start(); ctlB.start();
    const [sA, sB] = await Promise.all([env.waitState(ctlA, ['ACTIVE', 'BLOCKED'], 15000), env.waitState(ctlB, ['ACTIVE', 'BLOCKED'], 15000)]);
    assert.deepEqual([sA, sB].sort(), ['ACTIVE', 'BLOCKED'], 'exactly one of the two different runs owns the scope');
    const winner = sA === 'ACTIVE' ? 'run-a' : 'run-b';
    assert.equal(await qualJobCount(env), 1, 'exactly one job was created across both racing runs');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_tasks`))[0].n, 1, 'exactly one task exists');
    const marker = (await q(`SELECT policies FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0].policies.qualificationRun;
    assert.equal(marker.run_id, winner, 'the durable marker names the winning run');
    assert.equal(marker.phase, 'GRANTED');
    ctlA.stop(); ctlB.stop();

    // Same-run concurrency: two controllers of the winning run both
    // converge to monitor; nothing is created or refilled twice.
    const ctlW1 = mk(winner); const ctlW2 = mk(winner);
    ctlW1.start(); ctlW2.start();
    const [w1, w2] = await Promise.all([env.waitState(ctlW1, ['ACTIVE', 'BLOCKED']), env.waitState(ctlW2, ['ACTIVE', 'BLOCKED'])]);
    assert.equal(w1, 'ACTIVE'); assert.equal(w2, 'ACTIVE');
    assert.equal(await qualJobCount(env), 1);
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 1,
      'the one cap unit exists exactly once (not refilled by the second controller)');
    ctlW1.stop(); ctlW2.stop();
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T3a crash boundaries (E1) + partial-state cleanup resume (E3)",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime } = env;
  try {
    // Hand-craft the durable state a crash AFTER phase A leaves.
    // Phase A is atomic (E1), so this is its exact committed
    // shape: project ACTIVE with marker PREPARING, connector
    // enabled, worker READY with quota 1 — and NO job yet.
    // (The v10-style partial state — marker with an OFFLINE shell
    // worker and no connector — is unreachable from this
    // controller; F3 treats any such deviation as owner
    // intervention, proven in T3c.)
    const expMs = Date.now() + 60_000;
    const grantedAt = new Date().toISOString();
    const marker = { run_id: 'run-crash', expires_at: new Date(expMs).toISOString(), granted_at: grantedAt, phase: 'PREPARING' };
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING`,
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await c.query(`UPDATE agy_projects SET status='ACTIVE', priority=10, permissions=ARRAY['read','analyze','planning','qa'],
        resource_policy='{"maxConcurrentTasks":1,"quotaCap":1,"spendCap":0,"reservation":0}', policies=$1::jsonb
        WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`,
        [JSON.stringify({ qualificationRun: marker })]);
      await c.query(`INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
        VALUES('gl','legacy-workspace','GL_QUALIFICATION','muse-qual-x','muse-qual',ARRAY['planning'],'local','vault:custom.agy-worker',true,ARRAY['read','analyze','planning','qa']) ON CONFLICT DO NOTHING`);
    });
    await q(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES('MUSE-QUAL-WORKER','muse-qual',ARRAY['planning'],'READY',1,'{"spendCap":0,"quotaCap":null}',1,0,false,$1)`,
      [JSON.stringify({ bindings: { missions: ['GL_QUALIFICATION'], task_types: ['planning'], reply_targets: ['CHATGPT_ASSISTANT_CONTROL_PLANE'] }, qualification: 'UNVERIFIED', evidence: 'none', external_namespace_only: true })]);

    // The same run's controller completes the interrupted grant —
    // ONLY the missing job and the phase flip. It rewrites no
    // registry state: granted_at is preserved, the worker's cap
    // is not refilled (it was never NULL in this shape).
    const cfg = { enabled: true, runId: 'run-crash', expiresAtMs: expMs, intervalMs: 50 };
    const ctl = createQualificationController(runtime, { config: cfg, log: () => {} });
    ctl.start();
    assert.equal(await env.waitState(ctl, ['ACTIVE', 'BLOCKED']), 'ACTIVE', 'a PREPARING grant is completed by its own run');
    const proj = (await q(`SELECT status,policies FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0];
    assert.equal(proj.status, 'ACTIVE'); assert.equal(proj.policies.qualificationRun.phase, 'GRANTED');
    assert.equal(proj.policies.qualificationRun.granted_at, grantedAt, 'recovery preserves the original grant stamp (no registry rewrite)');
    const w = (await q(`SELECT status,quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.equal(w.status, 'READY'); assert.equal(Number(w.quota_remaining), 1, 'the granted cap stands exactly as phase A left it');
    assert.equal(await qualJobCount(env), 1);
    ctl.stop();

    // Partial-state resume (E3): claim, then simulate a crash that
    // settled the reservation but never transitioned the task.
    const surf = createWorkerSurface(runtime);
    await surf(qualP, scopeQ, 'arrive', {});
    const claim = await surf(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED');
    const taskId = claim.task.taskId;
    assert.equal(Number((await q(`SELECT active_count FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].active_count), 1);
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`UPDATE agy_resource_reservations SET state='EXPIRED' WHERE reservation_id=$1`, [claim.task.leaseToken]);
    });

    const ctlRb = createQualificationController(runtime, { config: { ...cfg, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    ctlRb.start();
    assert.equal(await env.waitState(ctlRb, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK');
    const task = (await q(`SELECT status,claimed_by,lease_token FROM agy_tasks WHERE task_id=$1`, [taskId]))[0];
    assert.equal(task.status, 'BLOCKED', 'cleanup transitions the orphaned task to a terminal, non-runnable state');
    assert.equal(task.claimed_by, null); assert.equal(task.lease_token, null);
    assert.equal(Number((await q(`SELECT active_count FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].active_count), 0,
      'capacity was released exactly once by the canonical accounting');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claim.task.leaseToken]))[0].state, 'EXPIRED');
    assert.equal(await neutralEvents(env, taskId), 1);
    const lateClaim = await surf(qualP, scopeQ, 'claim', {});
    assert.equal(lateClaim.status, 'EMPTY', 'no task is runnable after cleanup');
    ctlRb.stop();

    // Repeated cleanup after >1s: a pure no-op (E3).
    await sleep(1200);
    const ctlRb2 = createQualificationController(runtime, { config: { ...cfg, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    ctlRb2.start();
    assert.equal(await env.waitState(ctlRb2, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK');
    assert.equal(await neutralEvents(env, taskId), 1, 'the neutralization event is still exactly one after a repeated cleanup');
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [taskId]))[0].status, 'BLOCKED');
    assert.equal(Number((await q(`SELECT active_count FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].active_count), 0);
    ctlRb2.stop();
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T3b result-vs-cleanup race (E3): exactly one settles; counters, reservation and events stay consistent",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime } = env;
  try {
    const { ctl, cfg } = await env.grant('run-race');
    const surf = createWorkerSurface(runtime);
    await surf(qualP, scopeQ, 'arrive', {});
    const claim = await surf(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED');
    const taskId = claim.task.taskId;
    await surf(qualP, scopeQ, 'ack', { task_id: taskId, lease_token: claim.task.leaseToken, attempt: claim.task.attempt });
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [taskId]))[0].status, 'RUNNING');
    ctl.stop();

    // Fire the worker's result and the past-deadline cleanup at the
    // same time. Whichever transaction wins, the end state must be
    // one of exactly two consistent outcomes.
    const ctlRb = createQualificationController(runtime, { config: { ...cfg, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    const resultPromise = surf(qualP, scopeQ, 'result', { task_id: taskId, lease_token: claim.task.leaseToken, attempt: claim.task.attempt,
      result: { summary: 'race result' }, evidence: { external_operation_id: 'op-race-1' } })
      .then((v: any) => ({ ok: true, v })).catch((e: any) => ({ ok: false, e: String(e?.message ?? e) }));
    ctlRb.start();
    const [r, s] = await Promise.all([resultPromise, env.waitState(ctlRb, ['ROLLED_BACK', 'BLOCKED'])]);
    assert.equal(s, 'ROLLED_BACK');
    const task = (await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [taskId]))[0];
    const reservation = (await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claim.task.leaseToken]))[0];
    const events = await neutralEvents(env, taskId);
    const active = Number((await q(`SELECT active_count FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].active_count);
    assert.equal(active, 0, 'capacity released exactly once in either outcome');
    if (r.ok) {
      assert.equal(task.status, 'QA', 'result won: task settled to QA');
      assert.equal(reservation.state, 'SETTLED', 'result won: reservation settled by the result, NOT flipped to EXPIRED by cleanup');
      assert.equal(events, 0, 'result won: no neutralization event');
    } else {
      assert.equal(task.status, 'BLOCKED', 'cleanup won: task terminally blocked, never runnable again');
      assert.equal(reservation.state, 'EXPIRED', 'cleanup won: reservation expired by the canonical path');
      assert.equal(events, 1, 'cleanup won: exactly one neutralization event');
    }
    ctlRb.stop();

    // A repeated cleanup after >1s changes nothing in either outcome.
    const resBefore = reservation.state; const evBefore = events;
    await sleep(1200);
    const ctlRb2 = createQualificationController(runtime, { config: { ...cfg, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    ctlRb2.start();
    assert.equal(await env.waitState(ctlRb2, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claim.task.leaseToken]))[0].state, resBefore);
    assert.equal(await neutralEvents(env, taskId), evBefore);
    ctlRb2.stop();
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T4 absolute cutoff (E2): held locks crossing the deadline permit no late grant, claim, or lease extension",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime, owner } = env as any;
  try {
    // Part 1: the prepare transaction waits on the scope lock past
    // the deadline -> nothing is granted, no job exists.
    const lockClient = await owner.connect();
    await lockClient.query(`SELECT pg_advisory_lock(hashtext('agy:qualification:scope:gl/legacy-workspace/GL_QUALIFICATION'))`);
    const ctlLock = createQualificationController(runtime,
      { config: { enabled: true, runId: 'run-lock', expiresAtMs: Date.now() + 700, intervalMs: 25 }, log: () => {} });
    ctlLock.start();
    await sleep(1100); // the deadline passes while prepare is queued on the lock
    await lockClient.query(`SELECT pg_advisory_unlock(hashtext('agy:qualification:scope:gl/legacy-workspace/GL_QUALIFICATION'))`);
    lockClient.release();
    assert.equal(await env.waitState(ctlLock, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK',
      'a prepare that crosses the cutoff while waiting grants nothing and rolls back');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0].n, 0, 'no project/grant was written after the cutoff');
    assert.equal(await qualJobCount(env), 0, 'no job was created after the cutoff');
    ctlLock.stop();

    // Part 2: a claim whose transaction waits on the registry lock
    // past its deadline returns EMPTY and leases nothing.
    const { ctl, cfg } = await env.grant('run-t4');
    const surf = createWorkerSurface(runtime);
    await surf(qualP, scopeQ, 'arrive', {});
    let capT4 = Date.now() + 700;
    const surfCap = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => s.projectId === 'GL_QUALIFICATION' ? capT4 : undefined });
    const holdClient = await owner.connect();
    await holdClient.query('BEGIN');
    await holdClient.query(`SELECT * FROM agy_workers ORDER BY worker_id FOR UPDATE`);
    const claimPromise = surfCap(qualP, scopeQ, 'claim', {});
    await sleep(1100); // deadline passes while the claim waits on the lock
    await holdClient.query('COMMIT'); holdClient.release();
    const lateClaim = await claimPromise;
    assert.equal(lateClaim.status, 'EMPTY', 'a claim that crosses the cutoff while waiting leases nothing');
    const job = (await q(`SELECT job_id FROM agy_jobs WHERE idempotency_key='run-t4'`))[0];
    const task = (await q(`SELECT task_id,status FROM agy_tasks WHERE job_id=$1`, [job.job_id]))[0];
    assert.equal(task.status, 'QUEUED');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_resource_reservations`))[0].n, 0, 'no reservation was created by the late claim');
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 1);

    // Part 3: a live lease is capped EXACTLY at the deadline; a
    // last-fraction heartbeat may reach the deadline but never
    // cross it; after it, every mutation is denied.
    capT4 = Date.now() + 60_000;
    const claim = await surfCap(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED');
    const lease1 = (await q(`SELECT lease_expires_at FROM agy_tasks WHERE task_id=$1`, [task.task_id]))[0];
    assert.ok(new Date(lease1.lease_expires_at).getTime() <= capT4, 'lease_expires_at <= deadline exactly (no tolerance)');
    const capFrac = Date.now() + 300;
    capT4 = capFrac;
    await surfCap(qualP, scopeQ, 'heartbeat', { task_id: task.task_id, lease_token: claim.task.leaseToken, attempt: claim.task.attempt });
    const lease2 = (await q(`SELECT lease_expires_at FROM agy_tasks WHERE task_id=$1`, [task.task_id]))[0];
    assert.ok(new Date(lease2.lease_expires_at).getTime() <= capFrac, 'E2: a last-fraction heartbeat never pushes the lease past the deadline');
    await sleep(500); // past capFrac
    await assert.rejects(() => surfCap(qualP, scopeQ, 'heartbeat', { task_id: task.task_id, lease_token: claim.task.leaseToken, attempt: claim.task.attempt }), /LEASE_EXPIRED/);
    await assert.rejects(() => surfCap(qualP, scopeQ, 'ack', { task_id: task.task_id, lease_token: claim.task.leaseToken, attempt: claim.task.attempt }), /LEASE_EXPIRED/);
    await assert.rejects(() => surfCap(qualP, scopeQ, 'result', { task_id: task.task_id, lease_token: claim.task.leaseToken, attempt: claim.task.attempt, result: { summary: 'late' }, evidence: { external_operation_id: 'op-t4-late' } }), /LEASE_EXPIRED/);
    ctl.stop();

    const ctlRb = createQualificationController(runtime, { config: { ...cfg, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    ctlRb.start();
    assert.equal(await env.waitState(ctlRb, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK');
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [task.task_id]))[0].status, 'BLOCKED');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claim.task.leaseToken]))[0].state, 'EXPIRED');
    assert.equal(await neutralEvents(env, task.task_id), 1);
    ctlRb.stop();
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T3c PREPARING recovery with owner intervention (F3): restart BLOCKS and revives nothing",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime } = env;
  try {
    // The exact post-phase-A shape (as in T3a), then the OWNER
    // pauses the project and offlines the worker before any
    // restart. A recovering controller must read that as an owner
    // decision, not as a crash to repair.
    const expMs = Date.now() + 60_000;
    const marker = { run_id: 'run-crash', expires_at: new Date(expMs).toISOString(), granted_at: new Date().toISOString(), phase: 'PREPARING' };
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING`,
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await c.query(`UPDATE agy_projects SET status='ACTIVE', priority=10, permissions=ARRAY['read','analyze','planning','qa'],
        resource_policy='{"maxConcurrentTasks":1,"quotaCap":1,"spendCap":0,"reservation":0}', policies=$1::jsonb
        WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`,
        [JSON.stringify({ qualificationRun: marker })]);
      await c.query(`INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
        VALUES('gl','legacy-workspace','GL_QUALIFICATION','muse-qual-x','muse-qual',ARRAY['planning'],'local','vault:custom.agy-worker',true,ARRAY['read','analyze','planning','qa']) ON CONFLICT DO NOTHING`);
    });
    await q(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES('MUSE-QUAL-WORKER','muse-qual',ARRAY['planning'],'READY',1,'{"spendCap":0,"quotaCap":null}',1,0,false,$1)`,
      [JSON.stringify({ bindings: { missions: ['GL_QUALIFICATION'], task_types: ['planning'], reply_targets: ['CHATGPT_ASSISTANT_CONTROL_PLANE'] }, qualification: 'UNVERIFIED', evidence: 'none', external_namespace_only: true })]);
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`UPDATE agy_projects SET status='PAUSED' WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`);
    });
    await q(`UPDATE agy_workers SET status='OFFLINE' WHERE worker_id='MUSE-QUAL-WORKER'`);

    const ctl = createQualificationController(runtime, { config: { enabled: true, runId: 'run-crash', expiresAtMs: expMs, intervalMs: 50 }, log: () => {} });
    ctl.start();
    assert.equal(await env.waitState(ctl, ['BLOCKED', 'ACTIVE']), 'BLOCKED',
      'a PREPARING grant whose owner state changed is not silently completed');
    ctl.stop();
    const proj = (await q(`SELECT status,policies FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0];
    assert.equal(proj.status, 'PAUSED', 'the owner pause stands');
    assert.equal(proj.policies.qualificationRun.phase, 'PREPARING', 'the marker was not flipped by recovery');
    const w = (await q(`SELECT status,quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.equal(w.status, 'OFFLINE', 'the owner offline stands');
    assert.equal(Number(w.quota_remaining), 1, 'recovery did not touch the cap in either direction');
    assert.equal(await qualJobCount(env), 0, 'no job was created for the interrupted run');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T5 arrival is a qualification opt-in (F1): owner OFFLINE/PAUSED, wrong scope and wrong worker refuse with zero mutation",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime } = env;
  try {
    const { ctl } = await env.grant('run-f1');
    ctl.stop();
    const surf = createWorkerSurface(runtime);
    const bizP: Principal = { subject: 'biz-worker', role: 'worker', workerId: 'MUSE-SEO-WORKER', scopes: [scopeBiz] };
    const workerRow = async () => (await q(`SELECT status,heartbeat_at,resource_profile,quota_remaining,metadata FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    const bizRow = async () => (await q(`SELECT status,heartbeat_at,resource_profile,quota_remaining,metadata FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0];

    // Happy path inside the granted window, with a body that tries
    // to override everything: only the project's own provisioned
    // values are projected.
    const arrived = await surf(qualP, scopeQ, 'arrive', { permissions: ['admin'], quotaCap: 999, status: 'OFFLINE' });
    assert.equal(arrived.status, 'READY');
    const afterArrive = await workerRow();
    assert.deepEqual(afterArrive.resource_profile.permissions, ['read', 'analyze', 'planning', 'qa'], 'body permissions are never honored');
    assert.equal(afterArrive.resource_profile.quotaCap, 1, 'body quotaCap is never honored');
    assert.equal(afterArrive.status, 'READY');

    // Owner offlines the worker: arrival refuses and mutates
    // nothing (heartbeat NOT re-stamped, profile untouched).
    await q(`UPDATE agy_workers SET status='OFFLINE' WHERE worker_id='MUSE-QUAL-WORKER'`);
    const offlineRow = await workerRow();
    await assert.rejects(() => surf(qualP, scopeQ, 'arrive', {}), /ARRIVAL_REFUSED/);
    assert.equal(JSON.stringify(await workerRow()), JSON.stringify(offlineRow), 'arrival cannot revive an owner-offlined worker');

    // Owner pauses the project (worker restored to READY by the
    // owner): arrival refuses with zero mutation.
    await q(`UPDATE agy_workers SET status='READY' WHERE worker_id='MUSE-QUAL-WORKER'`);
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`UPDATE agy_projects SET status='PAUSED' WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`);
    });
    const pausedRow = await workerRow();
    await assert.rejects(() => surf(qualP, scopeQ, 'arrive', {}), /ARRIVAL_NOT_GRANTED/);
    assert.equal(JSON.stringify(await workerRow()), JSON.stringify(pausedRow), 'arrival cannot act in an owner-paused project');

    // Wrong scope: the business worker arriving in the BUSINESS
    // scope (which has no grant marker) is refused and its row is
    // byte-identical — arrival can never rewrite business profiles.
    const bizBefore = await bizRow();
    await assert.rejects(() => surf(bizP, scopeBiz, 'arrive', {}), /ARRIVAL_NOT_GRANTED/);
    assert.equal(JSON.stringify(await bizRow()), JSON.stringify(bizBefore), 'business worker row byte-identical after a refused arrival');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T6 real-clock fences (F2): held locks spanning the cutoff block heartbeat, ack, and job creation",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime, owner } = env;
  try {
    // (a) Job creation: createJob with a deadline, its INSERT held
    // by an ACCESS EXCLUSIVE table lock across the deadline. The
    // in-transaction pre-commit clock fence must roll it back.
    const { PostgresStore } = await import("../src/postgres-store.js");
    const { ProjectPool } = await import("../src/platform/scoped-pool.js");
    const store = new PostgresStore(new ProjectPool(runtime, scopeQ, 'test').asPool(), scopeQ);
    // The jobs table FK-references the project row; in the real
    // flow phase A creates it before any job creation.
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING`,
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
    });
    const locker = await owner.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`LOCK TABLE agy_jobs IN ACCESS EXCLUSIVE MODE`);
      const attempt = store.createJob({ tenantId: 'gl', idempotencyKey: 'run-fenced', objective: 'fenced', mode: 'SINGLE_WORKFLOW' as any,
        passThreshold: 0, deadlineMs: Date.now() + 700,
        tasks: [{ name: 't', idempotencyKey: 'run-fenced-task', taskType: 'planning' } as any] });
      const settled = attempt.then(() => 'CREATED', (e: any) => String(e?.message));
      await sleep(1100);
      await locker.query('COMMIT');
      assert.equal(await settled, 'JOB_CREATION_DEADLINE_EXCEEDED', 'a job creation that waited past the deadline commits nothing');
    } finally { locker.release(); }
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_jobs`))[0].n, 0, 'no job row exists after the fenced creation');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_tasks`))[0].n, 0, 'no task row exists after the fenced creation');

    // (b) Heartbeat + ack under held locks, qualification surface
    // capped at a 900ms deadline.
    const capMs = Date.now() + 900;
    const { ctl } = await env.grant('run-f2', 60_000);
    ctl.stop();
    const surf = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => (s.projectId === 'GL_QUALIFICATION' ? capMs : undefined) });
    await surf(qualP, scopeQ, 'arrive', {});
    const claim = await surf(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED');
    const lease = { task_id: claim.task.taskId, lease_token: claim.task.leaseToken, attempt: 1 };
    assert.ok(new Date(claim.task.leaseExpiresAt).getTime() <= capMs, 'the lease is capped at the deadline exactly');

    // Heartbeat: hold the TASK row lock across the deadline; the
    // UPDATE waits, then its clock_timestamp predicate refuses.
    const hbLocker = await owner.connect();
    try {
      await hbLocker.query('BEGIN');
      await hbLocker.query(`SELECT task_id FROM agy_tasks WHERE task_id=$1 FOR UPDATE`, [lease.task_id]);
      const hb = surf(qualP, scopeQ, 'heartbeat', lease).then(() => 'OK', (e: any) => String(e?.message));
      await sleep(1200);
      await hbLocker.query('COMMIT');
      assert.match(await hb, /LEASE_EXPIRED/, 'heartbeat that waited past the deadline does not extend the lease');
    } finally { hbLocker.release(); }
    const afterHb = (await q(`SELECT lease_expires_at FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0];
    assert.ok(new Date(afterHb.lease_expires_at).getTime() <= capMs, 'lease expiry never moved past the deadline');

    // Ack: hold the REGISTRY lock (all worker rows) across a fresh
    // deadline; the transition's post-lock clock check refuses.
    const cap2 = Date.now() + 900;
    const surf2 = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => (s.projectId === 'GL_QUALIFICATION' ? cap2 : undefined) });
    const ackLocker = await owner.connect();
    try {
      await ackLocker.query('BEGIN');
      await ackLocker.query(`SELECT worker_id FROM agy_workers ORDER BY worker_id FOR UPDATE`);
      const ack = surf2(qualP, scopeQ, 'ack', lease).then(() => 'OK', (e: any) => String(e?.message));
      await sleep(1200);
      await ackLocker.query('COMMIT');
      assert.match(await ack, /LEASE_EXPIRED/, 'ack that waited past the deadline does not transition the task');
    } finally { ackLocker.release(); }
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0].status, 'CLAIMED', 'the task was not acked late');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T7 concurrent cleanup (F4): two past-deadline controllers settle canonically with exactly one event",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime } = env;
  try {
    const { ctl, cfg } = await env.grant('run-f4');
    ctl.stop();
    const surf = createWorkerSurface(runtime);
    await surf(qualP, scopeQ, 'arrive', {});
    const claim = await surf(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED');
    const taskId = claim.task.taskId;

    // Two controllers of the SAME run, both past the deadline,
    // started back to back: their cleanup phases race.
    const past = { ...cfg, expiresAtMs: Date.now() - 1000 };
    const rb1 = createQualificationController(runtime, { config: past, log: () => {} });
    const rb2 = createQualificationController(runtime, { config: past, log: () => {} });
    rb1.start(); rb2.start();
    assert.equal(await env.waitState(rb1, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK');
    assert.equal(await env.waitState(rb2, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK');
    rb1.stop(); rb2.stop();
    assert.equal(await neutralEvents(env, taskId), 1, 'concurrent cleanups emit exactly one neutralization event');
    const task = (await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [taskId]))[0];
    assert.equal(task.status, 'BLOCKED');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claim.task.leaseToken]))[0].state, 'EXPIRED');
    assert.equal(Number((await q(`SELECT active_count FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].active_count), 0);

    // A delayed third cleanup is still exactly one event.
    const rb3 = createQualificationController(runtime, { config: past, log: () => {} });
    rb3.start();
    assert.equal(await env.waitState(rb3, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK');
    rb3.stop();
    assert.equal(await neutralEvents(env, taskId), 1, 'a delayed repeat cleanup adds no event');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T8 transaction-wide cutoff for claim (H1): a late-stage lock held across the deadline rolls the whole claim back",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime, owner } = env;
  try {
    const { ctl } = await env.grant('run-h1-claim');
    ctl.stop();
    const capMs = Date.now() + 900;
    const surf = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => (s.projectId === 'GL_QUALIFICATION' ? capMs : undefined) });
    await surf(qualP, scopeQ, 'arrive', {});
    // Hold the JOB row: the claim's own selection + lease UPDATE
    // pass their early checks, then the claim transaction waits
    // at its final job aggregate UPDATE — a late stage, after the
    // initial guards. Only the pre-COMMIT clock fence can stop
    // this claim from committing a late lease.
    const job = (await q(`SELECT job_id FROM agy_jobs WHERE idempotency_key='run-h1-claim'`))[0];
    const taskBefore = (await q(`SELECT status,attempt,lease_token FROM agy_tasks WHERE job_id=$1`, [job.job_id]))[0];
    const locker = await owner.connect();
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT job_id FROM agy_jobs WHERE job_id=$1 FOR UPDATE`, [job.job_id]);
      const claimP = surf(qualP, scopeQ, 'claim', {}).then((r: any) => r.status as string, (e: any) => 'ERR:' + String(e?.message));
      await sleep(1400);
      await locker.query('COMMIT');
      assert.equal(await claimP, 'EMPTY', 'the fenced claim issues no lease');
    } finally { locker.release(); }
    const taskAfter = (await q(`SELECT status,attempt,lease_token FROM agy_tasks WHERE job_id=$1`, [job.job_id]))[0];
    assert.equal(JSON.stringify(taskAfter), JSON.stringify(taskBefore), 'no late attempt, lease, or status committed');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_resource_reservations`))[0].n, 0, 'no reservation committed');
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 1, 'the cap was not debited');
    assert.equal(Number((await q(`SELECT active_count FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].active_count), 0, 'no capacity was committed');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_task_events WHERE event_type='RESOURCE_ALLOCATION'`))[0].n, 0, 'no allocation event committed');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T9 transaction-wide cutoff for prepare (H1): late waits in phase A and phase C commit no grant and no flip",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime, owner } = env;
  try {
    // (a) Phase A: the dormant worker shell pre-exists (owner
    // seed) with its row lock held. Phase A's reads pass, its
    // grant writes wait on that lock across the deadline, and the
    // final fence must roll the whole grant back.
    await q(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES('MUSE-QUAL-WORKER','muse-qual',ARRAY['planning'],'OFFLINE',1,'{"spendCap":0,"quotaCap":null}',null,0,false,$1)`,
      [JSON.stringify({ bindings: { missions: ['GL_QUALIFICATION'], task_types: ['planning'], reply_targets: ['CHATGPT_ASSISTANT_CONTROL_PLANE'] }, qualification: 'UNVERIFIED', evidence: 'none', external_namespace_only: true })]);
    const lockerA = await owner.connect();
    try {
      await lockerA.query('BEGIN');
      await lockerA.query(`SELECT worker_id FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER' FOR UPDATE`);
      const ctl = createQualificationController(runtime, { config: { enabled: true, runId: 'run-h1-a', expiresAtMs: Date.now() + 900, intervalMs: 50 }, log: () => {} });
      ctl.start();
      await sleep(1400);
      await lockerA.query('COMMIT');
      assert.equal(await env.waitState(ctl, ['ROLLED_BACK', 'BLOCKED', 'ACTIVE']), 'ROLLED_BACK',
        'the fenced phase A expires into cleanup instead of committing a late grant');
      ctl.stop();
    } finally { lockerA.release(); }
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0].n, 0, 'no project/grant committed late');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_connectors WHERE connector_id='muse-qual-x'`))[0].n, 0, 'no connector committed late');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_jobs`))[0].n, 0, 'no job exists');
    const wA = (await q(`SELECT status,quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.equal(wA.status, 'OFFLINE'); assert.equal(wA.quota_remaining, null, 'the transition never landed');

    // (b) Phase C: a complete post-phase-A state (as T3a) whose
    // project row lock is held. Recovery validates, the job
    // already exists, and the marker flip UPDATE waits across
    // the deadline; the final fence must roll the flip back.
    const expMs = Date.now() + 900;
    const marker = { run_id: 'run-h1-c', expires_at: new Date(expMs).toISOString(), granted_at: new Date().toISOString(), phase: 'PREPARING' };
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING`,
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await c.query(`UPDATE agy_projects SET status='ACTIVE', priority=10, permissions=ARRAY['read','analyze','planning','qa'],
        resource_policy='{"maxConcurrentTasks":1,"quotaCap":1,"spendCap":0,"reservation":0}', policies=$1::jsonb
        WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`,
        [JSON.stringify({ qualificationRun: marker })]);
      await c.query(`INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
        VALUES('gl','legacy-workspace','GL_QUALIFICATION','muse-qual-x','muse-qual',ARRAY['planning'],'local','vault:custom.agy-worker',true,ARRAY['read','analyze','planning','qa']) ON CONFLICT DO NOTHING`);
    });
    await q(`UPDATE agy_workers SET status='READY', quota_remaining=1 WHERE worker_id='MUSE-QUAL-WORKER'`);
    // The run's job must already exist for phase C to reach the flip.
    const { ProjectService } = await import("../src/platform/service.js");
    const svc = new ProjectService(runtime, scopeQ, { subject: 'setup', role: 'operator', scopes: [scopeQ] } as any);
    await svc.execute('/jobs', 'POST', { idempotency_key: 'run-h1-c', objective: 'h1 phase C', pass_threshold: 0,
      tasks: [{ name: 'qualification', idempotencyKey: 'run-h1-c-task', taskType: 'planning', requiredCapabilities: ['planning'],
        requiredPermissions: ['planning'], permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0,
        maxRetry: 0, priority: 10, payload: { mission_id: 'GL_QUALIFICATION', target_worker_id: 'MUSE-QUAL-WORKER', callback_target: 'CHATGPT_ASSISTANT_CONTROL_PLANE' } }] });
    const lockerC = await owner.connect();
    try {
      await lockerC.query('BEGIN');
      await lockerC.query(`SELECT project_id FROM agy_projects WHERE project_id='GL_QUALIFICATION' FOR UPDATE`);
      const ctlC = createQualificationController(runtime, { config: { enabled: true, runId: 'run-h1-c', expiresAtMs: expMs, intervalMs: 50 }, log: () => {} });
      ctlC.start();
      await sleep(1400);
      await lockerC.query('COMMIT');
      await env.waitState(ctlC, ['ROLLED_BACK', 'BLOCKED', 'ACTIVE']);
      ctlC.stop();
    } finally { lockerC.release(); }
    const projC = (await q(`SELECT policies FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0];
    assert.equal(projC.policies.qualificationRun.phase, 'PREPARING', 'the GRANTED flip never committed late');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T10 arrival atomicity (H2): owner offline injected during the lock wait, and expiry during the wait, both refuse with zero writes",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime, owner } = env;
  try {
    const { ctl } = await env.grant('run-h2');
    ctl.stop();
    const surf = createWorkerSurface(runtime);
    const okArrive = await surf(qualP, scopeQ, 'arrive', {});
    assert.equal(okArrive.status, 'READY');
    const rowOf = async () => (await q(`SELECT status,heartbeat_at,resource_profile FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];

    // (a) The owner holds the worker row, flips it OFFLINE in the
    // same transaction, and commits only after arrival has queued
    // on the lock. Arrival validates on the LOCKED row: it must
    // see OFFLINE and refuse, writing nothing.
    const before1 = await rowOf();
    const locker = await owner.connect();
    let arriveRes: string;
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT worker_id FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER' FOR UPDATE`);
      await locker.query(`UPDATE agy_workers SET status='OFFLINE' WHERE worker_id='MUSE-QUAL-WORKER'`);
      const p = surf(qualP, scopeQ, 'arrive', {}).then(() => 'ARRIVED', (e: any) => String(e?.message));
      await sleep(400);
      await locker.query('COMMIT');
      arriveRes = await p;
    } finally { locker.release(); }
    assert.equal(arriveRes!, 'ARRIVAL_REFUSED', 'arrival saw the owner offline that landed during its wait');
    const after1 = await rowOf();
    assert.equal(after1.status, 'OFFLINE', 'the owner state stands');
    assert.equal(String(after1.heartbeat_at), String(before1.heartbeat_at), 'no heartbeat was stamped by the refused arrival');
    assert.equal(JSON.stringify(after1.resource_profile), JSON.stringify(before1.resource_profile), 'no profile write by the refused arrival');

    // (b) Expiry during the wait: restore READY under a fresh
    // short marker deadline (owner rewrites the marker — fixture
    // time control), hold the worker row past it, then arrive.
    await q(`UPDATE agy_workers SET status='READY' WHERE worker_id='MUSE-QUAL-WORKER'`);
    const shortExp = Date.now() + 900;
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`UPDATE agy_projects SET policies = jsonb_set(policies, '{qualificationRun,expires_at}', $1::jsonb)
        WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`,
        [JSON.stringify(new Date(shortExp).toISOString())]);
    });
    const before2 = await rowOf();
    const locker2 = await owner.connect();
    let arriveRes2: string;
    try {
      await locker2.query('BEGIN');
      await locker2.query(`SELECT worker_id FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER' FOR UPDATE`);
      const p2 = surf(qualP, scopeQ, 'arrive', {}).then(() => 'ARRIVED', (e: any) => String(e?.message));
      await sleep(1400);
      await locker2.query('COMMIT');
      arriveRes2 = await p2;
    } finally { locker2.release(); }
    assert.equal(arriveRes2!, 'ARRIVAL_NOT_GRANTED', 'arrival whose window expired during its lock wait refuses');
    const after2 = await rowOf();
    assert.equal(String(after2.heartbeat_at), String(before2.heartbeat_at), 'no heartbeat was stamped after expiry');
    assert.equal(JSON.stringify(after2.resource_profile), JSON.stringify(before2.resource_profile), 'no profile write after expiry');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

// H1 (extended, same deadline contract): the final pre-COMMIT
// rollback fence covers EVERY deadline-carrying mutation
// transaction, not only claim/prepare. The remaining variants —
// result, heartbeat, ack, checkpoint — each pass their post-lock
// clock read first and can still wait at a LATE write stage
// (trigger, event/outbox insert, worker-counter or aggregate
// lock). T11/T12 stage exactly those waits: a gated pg_sleep
// trigger stands in for a slow/blocked late write, and a held
// job-row lock blocks the ack's aggregate. Invariants: on a
// crossed deadline the WHOLE transaction rolls back (no
// half-commit), while read-only paths (readback) stay answerable.
const installHoldTriggers = async (env: any) => {
  const { q, role } = env;
  await q(`CREATE TABLE test_hold(id int PRIMARY KEY, enabled boolean NOT NULL DEFAULT false)`);
  await q(`INSERT INTO test_hold(id, enabled) VALUES (1,false),(2,false),(3,false)`);
  await q(`GRANT SELECT ON test_hold TO ${role}`);
  await q(`CREATE OR REPLACE FUNCTION test_hold_sleep() RETURNS trigger LANGUAGE plpgsql AS $fn$
    DECLARE flag boolean;
    BEGIN
      SELECT enabled INTO flag FROM test_hold WHERE id = TG_ARGV[0]::int;
      IF flag THEN PERFORM pg_sleep(2); END IF;
      RETURN NEW;
    END $fn$`);
  await q(`CREATE TRIGGER test_hold_callbacks BEFORE INSERT ON agy_worker_callbacks FOR EACH ROW EXECUTE FUNCTION test_hold_sleep(1)`);
  await q(`CREATE TRIGGER test_hold_tasks BEFORE UPDATE ON agy_tasks FOR EACH ROW EXECUTE FUNCTION test_hold_sleep(2)`);
  await q(`CREATE TRIGGER test_hold_checkpoints BEFORE INSERT ON agy_checkpoints FOR EACH ROW EXECUTE FUNCTION test_hold_sleep(3)`);
};
const setHold = async (env: any, id: number, on: boolean) =>
  env.q(`UPDATE test_hold SET enabled=$2 WHERE id=$1`, [id, on]);

test("T11 transaction-wide cutoff for result (H1 ext): a wait at the callback-outbox insert rolls back the whole result",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime } = env;
  try {
    const { ctl } = await env.grant('run-h1-result');
    ctl.stop();
    const plain = createWorkerSurface(runtime);
    await plain(qualP, scopeQ, 'arrive', {});
    const claim = await plain(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED');
    const lease = { task_id: claim.task.taskId, lease_token: claim.task.leaseToken, attempt: claim.task.attempt };
    await plain(qualP, scopeQ, 'ack', lease);
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0].status, 'RUNNING');
    const jobBefore = (await q(`SELECT status FROM agy_jobs WHERE job_id=$1`, [claim.task.jobId]))[0].status;

    // The result's post-lock clock read passes (the call starts
    // before the cap); its late stages then run — task->QA, QA
    // receipt, task event — until the OUTBOX insert hits the
    // gated 2s hold, well past the 900ms cap. Settlement with
    // quota_units 0 WOULD refund the cap unit if it committed,
    // which makes a half-commit directly observable.
    await installHoldTriggers(env);
    const capMs = Date.now() + 900;
    const surfCap = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => (s.projectId === 'GL_QUALIFICATION' ? capMs : undefined) });
    await setHold(env, 1, true);
    const res = await surfCap(qualP, scopeQ, 'result', { ...lease,
      result: { summary: 'late result' }, evidence: { external_operation_id: 'op-t11-1' }, quota_units: 0, cost_amount: 0 })
      .then(() => 'SUBMITTED', (e: any) => String(e?.message));
    await setHold(env, 1, false);
    assert.equal(res, 'LEASE_EXPIRED', 'the result that waited past the deadline at the outbox insert is refused');

    const task = (await q(`SELECT status,result FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0];
    assert.equal(task.status, 'RUNNING', 'task->QA rolled back');
    assert.equal(task.result, null, 'no result payload committed');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_qa_results WHERE task_id=$1`, [lease.task_id]))[0].n, 0, 'no QA receipt committed');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_task_events WHERE task_id=$1 AND event_type='RESULT_SUBMITTED'`, [lease.task_id]))[0].n, 0, 'no task event committed');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_worker_callbacks WHERE task_id=$1`, [lease.task_id]))[0].n, 0, 'no outbox row committed');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_telemetry WHERE task_id=$1`, [lease.task_id]))[0].n, 0, 'no telemetry committed');
    const reservation = (await q(`SELECT state,actual_quota FROM agy_resource_reservations WHERE reservation_id=$1`, [lease.lease_token]))[0];
    assert.equal(reservation.state, 'HELD', 'the reservation was not settled by the late result');
    assert.equal(reservation.actual_quota, null, 'no settlement actuals committed');
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 0, 'no settlement refund committed');
    assert.equal((await q(`SELECT status FROM agy_jobs WHERE job_id=$1`, [claim.task.jobId]))[0].status, jobBefore, 'the job aggregate was not advanced');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});

test("T12 transaction-wide cutoff for ack, heartbeat, checkpoint (H1 ext): late write-stage waits commit nothing; readback stays open",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q, runtime, owner } = env;
  try {
    const { ctl } = await env.grant('run-h1-late');
    ctl.stop();
    const plain = createWorkerSurface(runtime);
    await plain(qualP, scopeQ, 'arrive', {});
    const claim = await plain(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED');
    const lease = { task_id: claim.task.taskId, lease_token: claim.task.leaseToken, attempt: claim.task.attempt };
    const job = (await q(`SELECT job_id FROM agy_jobs WHERE idempotency_key='run-h1-late'`))[0];
    await installHoldTriggers(env);

    // (a) ACK: the transition passes its post-lock clock read,
    // writes the task UPDATE, then its job aggregate waits on
    // the owner's held job-row lock across the cap. The final
    // fence must roll the status change back too.
    const capA = Date.now() + 900;
    const surfA = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => (s.projectId === 'GL_QUALIFICATION' ? capA : undefined) });
    const ackLocker = await owner.connect();
    let ackRes: string;
    try {
      await ackLocker.query('BEGIN');
      await ackLocker.query(`SELECT job_id FROM agy_jobs WHERE job_id=$1 FOR UPDATE`, [job.job_id]);
      const p = surfA(qualP, scopeQ, 'ack', lease).then(() => 'ACKED', (e: any) => String(e?.message));
      await sleep(1400);
      await ackLocker.query('COMMIT');
      ackRes = await p;
    } finally { ackLocker.release(); }
    assert.equal(ackRes!, 'LEASE_EXPIRED', 'the ack that waited past the deadline at its aggregate is refused');
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0].status, 'CLAIMED', 'the late ack transition rolled back');

    // The lease is undamaged: an in-window ack still succeeds.
    await plain(qualP, scopeQ, 'ack', lease);
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0].status, 'RUNNING');

    // (b) HEARTBEAT: the post-lock clock read passes, then the
    // write itself is held by the gated task-UPDATE trigger past
    // the cap; the final fence rolls it back.
    const hbBefore = (await q(`SELECT heartbeat_at,lease_expires_at FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0];
    const capH = Date.now() + 900;
    const surfH = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => (s.projectId === 'GL_QUALIFICATION' ? capH : undefined) });
    await setHold(env, 2, true);
    const hbRes = await surfH(qualP, scopeQ, 'heartbeat', lease).then(() => 'BEAT', (e: any) => String(e?.message));
    await setHold(env, 2, false);
    assert.equal(hbRes, 'LEASE_EXPIRED', 'the heartbeat held at its write past the deadline is refused');
    const hbAfter = (await q(`SELECT heartbeat_at,lease_expires_at FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0];
    assert.equal(String(hbAfter.heartbeat_at), String(hbBefore.heartbeat_at), 'no late heartbeat was stamped');
    assert.equal(String(hbAfter.lease_expires_at), String(hbBefore.lease_expires_at), 'the lease was not extended late');

    // (c) CHECKPOINT: the post-lock clock read passes, the task
    // checkpoint write lands in-transaction, then the checkpoint
    // INSERT is held by the gated trigger past the cap; the
    // final fence rolls back BOTH writes.
    const cpBefore = (await q(`SELECT checkpoint_version,checkpoint FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0];
    const capC = Date.now() + 900;
    const surfC = createWorkerSurface(runtime, { leaseDeadlineMs: (s) => (s.projectId === 'GL_QUALIFICATION' ? capC : undefined) });
    await setHold(env, 3, true);
    const cpRes = await surfC(qualP, scopeQ, 'checkpoint', { ...lease, external_id: 'op-t12-1', state: { progress: 1 } })
      .then(() => 'CHECKPOINTED', (e: any) => String(e?.message));
    await setHold(env, 3, false);
    assert.equal(cpRes, 'LEASE_EXPIRED', 'the checkpoint held at its insert past the deadline is refused');
    const cpAfter = (await q(`SELECT checkpoint_version,checkpoint FROM agy_tasks WHERE task_id=$1`, [lease.task_id]))[0];
    assert.equal(Number(cpAfter.checkpoint_version), Number(cpBefore.checkpoint_version), 'the task checkpoint write rolled back');
    assert.equal(JSON.stringify(cpAfter.checkpoint), JSON.stringify(cpBefore.checkpoint), 'the task checkpoint payload is unchanged');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_checkpoints WHERE task_id=$1`, [lease.task_id]))[0].n, 0, 'no checkpoint row committed');

    // (d) Read-only paths are NOT fenced: past the same cap,
    // readback still answers and reports the true state.
    const rb = await surfC(qualP, scopeQ, 'readback', { task_id: lease.task_id });
    assert.equal(rb.task.status, 'RUNNING', 'readback stays answerable past the deadline');
    assert.equal(rb.task.result, null, 'readback reports no phantom result');
    await env.assertBizUntouched();
  } finally { await env.teardown(); }
});
