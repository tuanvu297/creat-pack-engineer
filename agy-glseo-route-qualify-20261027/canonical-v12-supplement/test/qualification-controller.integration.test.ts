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
  return { q, scopedTx, runtime, owner, waitState, grant, assertBizUntouched, teardown };
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

    // E4: arrival after cleanup asserts presence but cannot reopen
    // the window (no quota, project PAUSED, connector disabled).
    await surf(qualP, scopeQ, 'arrive', {});
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
    // Hand-craft the durable state a crash mid-grant leaves:
    // marker PREPARING for run-crash + the worker shell inserted,
    // but NO transition, NO connector, NO job.
    const expMs = Date.now() + 60_000;
    const marker = { run_id: 'run-crash', expires_at: new Date(expMs).toISOString(), granted_at: new Date().toISOString(), phase: 'PREPARING' };
    await env.scopedTx(scopeQ, async (c) => {
      await c.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING`,
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await c.query(`UPDATE agy_projects SET status='PAUSED', priority=10, permissions=ARRAY['read','analyze','planning','qa'],
        resource_policy='{"maxConcurrentTasks":1,"quotaCap":1,"spendCap":0,"reservation":0}', policies=$1::jsonb
        WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`,
        [JSON.stringify({ qualificationRun: marker })]);
    });
    await q(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES('MUSE-QUAL-WORKER','muse-qual',ARRAY['planning'],'OFFLINE',1,'{"spendCap":0,"quotaCap":null}',null,0,false,$1)`,
      [JSON.stringify({ bindings: { missions: ['GL_QUALIFICATION'], task_types: ['planning'], reply_targets: ['CHATGPT_ASSISTANT_CONTROL_PLANE'] }, qualification: 'UNVERIFIED', evidence: 'none', external_namespace_only: true })]);

    // The same run's controller completes the interrupted grant —
    // exactly the missing pieces, nothing refilled or duplicated.
    const cfg = { enabled: true, runId: 'run-crash', expiresAtMs: expMs, intervalMs: 50 };
    const ctl = createQualificationController(runtime, { config: cfg, log: () => {} });
    ctl.start();
    assert.equal(await env.waitState(ctl, ['ACTIVE', 'BLOCKED']), 'ACTIVE', 'a PREPARING grant is completed by its own run');
    const proj = (await q(`SELECT status,policies FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0];
    assert.equal(proj.status, 'ACTIVE'); assert.equal(proj.policies.qualificationRun.phase, 'GRANTED');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_connectors WHERE connector_id='muse-qual-x' AND enabled`))[0].n, 1, 'the missing connector was completed');
    const w = (await q(`SELECT status,quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.equal(w.status, 'READY'); assert.equal(Number(w.quota_remaining), 1, 'the missing transition was completed (from NULL, exactly once)');
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
