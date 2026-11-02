// Integration tests for the 2026-11-02 qualification lifecycle fix:
// a settled previous run is archived (append-only history) instead
// of blocking the next grant, and the grant path repairs the two
// stale leftovers that broke run-20261102-restore3 live (connector
// left disabled by cleanup; worker quotaUsed counter left stale).
// Evidence class: LOCAL integration — real PostgreSQL, repo
// migrations, controller + worker surface under the role-switched
// RUNTIME pool, mirroring test/qualification-controller.integration
// .test.ts. Skipped without AGY_TEST_DATABASE_URL. NOT run in the
// authoring environment (no local PostgreSQL); typechecked there.
// The pure gate logic is unit-tested in
// test/callback-lifecycle-fix.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createWorkerSurface } from "../src/platform/worker-surface.js";
import { createQualificationController, QUALIFICATION_SCOPE } from "../src/platform/qualification-controller.js";
import { createCallbackReceiver } from "../src/platform/worker-callback-receiver.js";
import { dispatchWorkerCallbacks } from "../src/platform/worker-callbacks.js";
import type { Principal } from "../src/platform/auth.js";

const scopeQ = QUALIFICATION_SCOPE;
const qualP: Principal = { subject: 'qual-worker', role: 'worker', workerId: 'MUSE-QUAL-WORKER', scopes: [scopeQ] };
const opP: any = { subject: 'control-plane', role: 'operator', scopes: [scopeQ] };
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
  const waitState = async (ctl: any, states: string[], ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const s = ctl.state(); if (states.includes(s)) return s; await sleep(50); }
    return ctl.state();
  };
  const grant = async (runId: string, ttlMs = 60_000, logs?: any[]) => {
    const cfg = { enabled: true, runId, expiresAtMs: Date.now() + ttlMs, intervalMs: 50 };
    const ctl = createQualificationController(runtime, { config: cfg,
      log: logs ? (event: string, detail?: Record<string, unknown>) => { logs.push({ event, ...(detail ?? {}) }); } : () => {} });
    ctl.start();
    assert.equal(await waitState(ctl, ['ACTIVE', 'BLOCKED']), 'ACTIVE', `grant ${runId} reaches ACTIVE`);
    return { ctl, cfg };
  };
  const rollback = async (cfg: any) => {
    const ctl = createQualificationController(runtime, { config: { ...cfg, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    ctl.start();
    assert.equal(await waitState(ctl, ['ROLLED_BACK', 'BLOCKED']), 'ROLLED_BACK', 'cleanup rolls the window back');
    ctl.stop();
  };
  const lifecycle = async (opId: string) => {
    const surf = createWorkerSurface(runtime);
    const arrived = await surf(qualP, scopeQ, 'arrive', {});
    assert.equal(arrived.status, 'READY');
    const job = (await q(`SELECT job_id FROM agy_jobs ORDER BY created_at DESC LIMIT 1`))[0];
    const task = (await q(`SELECT task_id FROM agy_tasks WHERE job_id=$1`, [job.job_id]))[0];
    const claim: any = await surf(qualP, scopeQ, 'claim', {});
    assert.equal(claim.status, 'LEASED');
    assert.equal(claim.task.taskId, task.task_id);
    const lease = { task_id: task.task_id, lease_token: claim.task.leaseToken, attempt: claim.task.attempt };
    await surf(qualP, scopeQ, 'ack', { ...lease });
    const result: any = await surf(qualP, scopeQ, 'result', { ...lease,
      result: { summary: 'lifecycle synthetic result' }, evidence: { external_operation_id: opId } });
    assert.equal(result.status, 'RESULT_SUBMITTED');
    return { task_id: task.task_id, job_id: job.job_id };
  };
  const deliverCallbacks = async () => {
    const receiver = createCallbackReceiver(runtime);
    const disp = await dispatchWorkerCallbacks(runtime, scopeQ,
      async (intent: any) => receiver.receive(opP, scopeQ, intent), { missionId: 'GL_QUALIFICATION', actor: 'control-plane' });
    return disp.delivered;
  };
  const markerRow = async () => (await q(`SELECT policies FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0];
  const sleepPastMarker = async () => {
    const m = (await markerRow())?.policies?.qualificationRun;
    if (m?.expires_at) { const wait = Date.parse(m.expires_at) - Date.now() + 250; if (wait > 0) await sleep(wait); }
  };
  const teardown = async () => {
    await runtime.end(); await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  };
  return { q, runtime, waitState, grant, rollback, lifecycle, deliverCallbacks, markerRow, sleepPastMarker, teardown };
}

test("L1: settled prior run is archived, not deleted — next grant proceeds and repairs grant-time leftovers",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q } = env;
  try {
    const a = await env.grant('run-l1a', 4000);
    a.ctl.stop();
    const runA = await env.lifecycle('op-l1a-1');
    assert.equal(await env.deliverCallbacks(), 1, 'run A callback delivered via the canonical dispatcher');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE task_id=$1`, [runA.task_id]))[0].status, 'DELIVERED');
    assert.equal(Number((await q(`SELECT effect_count FROM agy_callback_receipts WHERE callback_id IN (SELECT callback_id FROM agy_worker_callbacks WHERE task_id=$1)`, [runA.task_id]))[0].effect_count), 1);
    await env.rollback(a.cfg);
    assert.equal((await q(`SELECT enabled FROM agy_connectors WHERE connector_id='muse-qual-x'`))[0].enabled, false, 'cleanup leaves the connector disabled (the restore3 leftover)');
    // Fixture: the stale quota counter G2 left behind, reproduced.
    await q(`UPDATE agy_workers SET resource_profile = jsonb_set(resource_profile,'{quotaUsed}','1') WHERE worker_id='MUSE-QUAL-WORKER'`);
    await env.sleepPastMarker();

    const b = await env.grant('run-l1b', 60_000);
    b.ctl.stop();
    const proj = await env.markerRow();
    assert.equal(proj.policies.qualificationRun.run_id, 'run-l1b');
    const history = proj.policies.qualificationRunHistory;
    assert.ok(Array.isArray(history) && history.length === 1, 'exactly one archived history entry');
    assert.equal(history[0].run_id, 'run-l1a');
    assert.equal(history[0].job_id, runA.job_id);
    assert.equal(history[0].marker.run_id, 'run-l1a', 'the archived marker is preserved verbatim');
    // Evidence preserved: nothing from run A was deleted.
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_jobs`))[0].n, 2, 'both run jobs remain');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_tasks`))[0].n, 2, 'both run tasks remain');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_worker_callbacks`))[0].n, 1, 'run A callback row remains');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_task_events WHERE task_id=$1`, [runA.task_id]))[0].n > 0, true, 'run A events remain');
    // Grant-time leftover repairs:
    assert.equal((await q(`SELECT enabled FROM agy_connectors WHERE connector_id='muse-qual-x'`))[0].enabled, true, 'grant re-enables the connector cleanup disabled');
    assert.equal(Number((await q(`SELECT resource_profile->>'quotaUsed' AS u FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].u), 0,
      'grant recomputes the stale quotaUsed from live HELD reservations (none held)');
    // And the window actually works end to end:
    const runB = await env.lifecycle('op-l1b-1');
    assert.ok(runB.task_id, 'run B lifecycle completes in the same scope that used to require manual DB surgery');
  } finally { await env.teardown(); }
});

test("L2: prior run with an undelivered callback is NOT archived — the next grant stays BLOCKED",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const env = await setup();
  const { q } = env;
  try {
    const a = await env.grant('run-l2a', 4000);
    a.ctl.stop();
    const runA = await env.lifecycle('op-l2a-1');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE task_id=$1`, [runA.task_id]))[0].status, 'PENDING',
      'callback deliberately left undelivered');
    await env.rollback(a.cfg);
    await env.sleepPastMarker();

    const logs: any[] = [];
    const cfgB = { enabled: true, runId: 'run-l2b', expiresAtMs: Date.now() + 60_000, intervalMs: 50 };
    const ctlB = createQualificationController(env.runtime, { config: cfgB,
      log: (event: string, detail?: Record<string, unknown>) => { logs.push({ event, ...(detail ?? {}) }); } });
    ctlB.start();
    assert.equal(await env.waitState(ctlB, ['BLOCKED', 'ACTIVE']), 'BLOCKED', 'unsettled prior run still blocks');
    ctlB.stop();
    const blocked = logs.find((l) => l.event === 'QUALIFICATION_CONTROLLER_BLOCKED');
    assert.equal(blocked?.reason, 'PREVIOUS_RUN_NOT_SETTLED');
    const proj = await env.markerRow();
    assert.equal(proj.policies.qualificationRun.run_id, 'run-l2a', 'the unsettled marker is untouched');
    assert.ok(!proj.policies.qualificationRunHistory, 'nothing was archived');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_jobs WHERE idempotency_key='run-l2b'`))[0].n, 0, 'no job was created for the blocked run');
  } finally { await env.teardown(); }
});
