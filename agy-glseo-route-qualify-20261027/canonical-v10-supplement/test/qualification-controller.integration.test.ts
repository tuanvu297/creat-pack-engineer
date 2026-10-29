// Integration tests for the CANDIDATE qualification provisioning
// controller (findings D1–D3). Evidence class: LOCAL integration —
// real local PostgreSQL 18.4, repo migrations 001-008 + candidate
// 012, the controller running under the role-switched RUNTIME pool
// (never the owner). The qualification scope starts COMPLETELY
// EMPTY (no project, worker, or connector rows): the controller
// must build the window itself, exactly once. Worker presence is
// the worker's own arrival act (a ResourceStore registration in
// this local fixture) — the controller deliberately does not fake
// presence or a measured profile.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ProjectPool } from "../src/platform/scoped-pool.js";
import { createWorkerSurface } from "../src/platform/worker-surface.js";
import { ResourceStore } from "../src/resource-store.js";
import { discoverResource } from "../src/resources/discovery.js";
import { createQualificationController, parseQualificationConfig, QUALIFICATION_SCOPE } from "../src/platform/qualification-controller.js";
import type { Principal } from "../src/platform/auth.js";

const scopeQ = QUALIFICATION_SCOPE;
const scopeBiz = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' };
const qualP: Principal = { subject: 'qual-worker', role: 'worker', workerId: 'MUSE-QUAL-WORKER', scopes: [scopeQ] };

test("qualification controller: one-shot grant, monitor-only ticks, fail-closed ownership, guarded cleanup",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const schema = `agy_qual_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_qual_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const owner = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  let runtime: Pool | undefined;
  const q = async (sql: string, params?: unknown[]) => (await owner.query(sql, params as any)).rows;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','012_worker_callbacks.sql'])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
    await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    runtime = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
    const rawQ: Pool = runtime;
    // Business scope seeded (owner) — the controller must never reach it.
    const seedB = await owner.connect();
    try {
      await seedB.query('BEGIN');
      await seedB.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true),set_config('agy.subject','setup',true)",
        [scopeBiz.tenantId, scopeBiz.workspaceId, scopeBiz.projectId]);
      await seedB.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'Greenlife Spa','repo:gl','policy:gl') ON CONFLICT DO NOTHING`,
        [scopeBiz.tenantId, scopeBiz.workspaceId, scopeBiz.projectId]);
      await seedB.query(`UPDATE agy_projects SET status='ACTIVE',priority=5,permissions=ARRAY['read','analyze','planning','qa'],resource_policy='{"maxConcurrentTasks":2,"quotaCap":100,"spendCap":0,"reservation":0}' WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_AUTOMATION'`);
      await seedB.query('COMMIT');
    } catch (e) { await seedB.query('ROLLBACK'); throw e; } finally { seedB.release(); }
    await owner.query(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES('MUSE-SEO-WORKER','muse',ARRAY['planning'],'OFFLINE',1,'{"spendCap":0,"quotaCap":null}',null,0,false,'{"team":"business"}')`);
    const bizProjBefore = (await q(`SELECT status,priority,resource_policy FROM agy_projects WHERE project_id='GL_AUTOMATION'`))[0];
    const bizWorkerBefore = (await q(`SELECT status,metadata,quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0];

    // Default-disabled gates.
    assert.equal(parseQualificationConfig({}).reason, 'NOT_ENABLED');
    assert.equal(parseQualificationConfig({ AGY_QUALIFICATION_ENABLED: 'true' }).reason, 'STAGE_ONLY_REQUIRED');
    assert.equal(parseQualificationConfig({ AGY_QUALIFICATION_ENABLED: 'true', AGY_STAGE_ONLY: 'true', AGY_QUALIFICATION_RUN_ID: 'run-d', AGY_QUALIFICATION_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() }).reason, 'CAP_ONLY_APPROVAL_REQUIRED',
      'without the owner cap-only approval flag the controller refuses to start');

    // One-shot grant from an EMPTY qualification scope, under the
    // runtime role.
    const qualCfgD = { enabled: true, runId: 'run-d-test', expiresAtMs: Date.now() + 60_000, intervalMs: 50 };
    const ctl1 = createQualificationController(rawQ, { config: qualCfgD, log: () => {} });
    assert.equal(ctl1.start(), 'RUNNING');
    for (let i = 0; i < 80; i++) { if (ctl1.state() === 'ACTIVE' || ctl1.state() === 'BLOCKED') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(ctl1.state(), 'ACTIVE', 'controller provisions registry + transition + job under the runtime role');
    const projD = (await q(`SELECT status,priority,resource_policy,policies FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0];
    assert.equal(projD.status, 'ACTIVE'); assert.equal(projD.priority, 10);
    assert.equal(projD.resource_policy.quotaCap, 1, 'D3: qualification quotaCap is exactly 1 (the owner cap), not 100');
    assert.equal(projD.policies.qualificationRun.run_id, 'run-d-test', 'the durable grant marker was written with the window');
    const connD = (await q(`SELECT enabled FROM agy_connectors WHERE connector_id='muse-qual-x' AND project_id='GL_QUALIFICATION'`))[0];
    assert.equal(connD.enabled, true, 'the controller applied the qualification connector itself');
    const workerD = (await q(`SELECT status,quota_remaining,quota_reserve,metadata FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.equal(workerD.status, 'READY'); assert.equal(Number(workerD.quota_remaining), 1); assert.equal(Number(workerD.quota_reserve), 0);
    assert.deepEqual(workerD.metadata.bindings.missions, ['GL_QUALIFICATION']);
    assert.equal(workerD.metadata.external_namespace_only, true);
    const jobsD = await q(`SELECT job_id FROM agy_jobs WHERE idempotency_key='run-d-test'`);
    assert.equal(jobsD.length, 1, 'exactly one job exists for the run');
    const tasksD = await q(`SELECT task_id,payload FROM agy_tasks WHERE job_id=$1`, [jobsD[0].job_id]);
    assert.equal(tasksD.length, 1, 'exactly one task exists in the run job');
    assert.equal(tasksD[0].payload.mission_id, 'GL_QUALIFICATION'); assert.equal(tasksD[0].payload.target_worker_id, 'MUSE-QUAL-WORKER');

    // The worker arrives — its OWN act: registering stamps its
    // presence (heartbeat_at) and its self-reported profile, and
    // (register semantics) preserves the controller-written
    // metadata and the granted quota. The controller deliberately
    // never fabricates presence or a measured profile. Fixture
    // profile values are labelled local test values, as elsewhere.
    const resources = new ResourceStore(new ProjectPool(rawQ, scopeQ, 'qual-worker').asPool());
    await resources.register({ ...discoverResource('MUSE-QUAL-WORKER', ['planning'], Date.now()), status: 'READY', ready: true,
      quotaRemaining: 1, quotaReserve: 0, maxConcurrency: 1, passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0,
      costPerTask: 0, spendCap: 0, quotaCap: 1, permissions: ['read', 'analyze', 'planning', 'qa'] }, 'muse-qual');
    // Claims go through a surface whose qualification leases are
    // capped at an owner deadline ~8s out: no lease can outlive it.
    const capD = Date.now() + 8_000;
    const surfCap = createWorkerSurface(rawQ, { leaseDeadlineMs: (s) => s.projectId === 'GL_QUALIFICATION' ? capD : undefined });
    const claimD = await surfCap(qualP, scopeQ, 'claim', {});
    assert.equal(claimD.status, 'LEASED');
    assert.equal(claimD.task.taskId, tasksD[0].task_id);
    const leaseRowD = (await q(`SELECT lease_expires_at FROM agy_tasks WHERE task_id=$1`, [tasksD[0].task_id]))[0];
    assert.ok(new Date(leaseRowD.lease_expires_at).getTime() <= capD + 1000, 'the issued lease is capped by the owner deadline');
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 0,
      'the claim consumed the one cap unit');

    // D1: after the grant, ticks and restarts are MONITOR-ONLY.
    await ctl1.tick();
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 0,
      'a monitor tick does not refill quota');
    const ctl2 = createQualificationController(rawQ, { config: qualCfgD, log: () => {} });
    ctl2.start();
    for (let i = 0; i < 80; i++) { if (ctl2.state() === 'ACTIVE' || ctl2.state() === 'BLOCKED') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(ctl2.state(), 'ACTIVE');
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 0,
      'a restarted controller does not refill quota');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_jobs WHERE idempotency_key='run-d-test'`))[0].n, 1);
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_tasks t JOIN agy_jobs j USING(job_id) WHERE j.idempotency_key='run-d-test'`))[0].n, 1);
    ctl2.stop();
    await new Promise((r) => setTimeout(r, 300));

    // D1: an owner pause/offline after the grant is NOT undone.
    const seedD2 = await owner.connect();
    try {
      await seedD2.query('BEGIN');
      await seedD2.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true),set_config('agy.subject','owner',true)",
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await seedD2.query(`UPDATE agy_projects SET status='PAUSED' WHERE project_id='GL_QUALIFICATION'`);
      await seedD2.query(`UPDATE agy_workers SET status='OFFLINE' WHERE worker_id='MUSE-QUAL-WORKER'`);
      await seedD2.query('COMMIT');
    } catch (e) { await seedD2.query('ROLLBACK'); throw e; } finally { seedD2.release(); }
    await ctl1.tick();
    assert.equal((await q(`SELECT status FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0].status, 'PAUSED',
      'monitor does not re-activate an owner-paused project');
    assert.equal((await q(`SELECT status FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].status, 'OFFLINE',
      'monitor does not re-ready an owner-offlined worker');
    assert.equal(Number((await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].quota_remaining), 0);
    ctl1.stop();

    // D2: a foreign run id fails closed on this run's persisted grant.
    const ctlForeign = createQualificationController(rawQ, { config: { enabled: true, runId: 'run-foreign', expiresAtMs: Date.now() + 60_000, intervalMs: 50 }, log: () => {} });
    ctlForeign.start();
    for (let i = 0; i < 80; i++) { if (ctlForeign.state() === 'BLOCKED' || ctlForeign.state() === 'ACTIVE') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(ctlForeign.state(), 'BLOCKED', 'foreign run is blocked by the persisted grant of run-d-test');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_jobs WHERE idempotency_key='run-foreign'`))[0].n, 0, 'the foreign run created no job');
    assert.equal((await q(`SELECT status FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0].status, 'OFFLINE');
    ctlForeign.stop();

    // Business rows byte-identical throughout.
    const bizProjAfter = (await q(`SELECT status,priority,resource_policy FROM agy_projects WHERE project_id='GL_AUTOMATION'`))[0];
    const bizWorkerAfter = (await q(`SELECT status,metadata,quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0];
    assert.equal(JSON.stringify(bizProjAfter), JSON.stringify(bizProjBefore), 'business project untouched by the controller');
    assert.equal(JSON.stringify(bizWorkerAfter), JSON.stringify(bizWorkerBefore), 'business worker untouched by the controller');

    // D2: past the owner deadline, lease mutations are denied
    // server-side even though the task row still exists.
    const surfQ = createWorkerSurface(rawQ);
    const surfaceQ = (principal: Principal, action: string, input: any) => surfQ(principal, scopeQ, action, input);
    while (Date.now() < capD + 100) await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(() => surfCap(qualP, scopeQ, 'heartbeat', { task_id: claimD.task.taskId, lease_token: claimD.task.leaseToken, attempt: claimD.task.attempt }), /LEASE_EXPIRED/);
    await assert.rejects(() => surfaceQ(qualP, 'result', { task_id: claimD.task.taskId, lease_token: claimD.task.leaseToken, attempt: claimD.task.attempt, result: { summary: 'late' }, evidence: { external_operation_id: 'op-d-late' } }), /LEASE_EXPIRED/);
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claimD.task.leaseToken]))[0].state, 'HELD',
      'the reservation is still HELD before cleanup (nothing settled it silently)');

    // Guarded cleanup: same run id past its deadline neutralizes
    // the active lease, settles the reservation exactly once, and
    // disables the connector — automatically.
    const ctl3 = createQualificationController(rawQ, { config: { ...qualCfgD, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    ctl3.start();
    for (let i = 0; i < 80; i++) { if (ctl3.state() === 'ROLLED_BACK' || ctl3.state() === 'BLOCKED') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(ctl3.state(), 'ROLLED_BACK', 'rollback after the deadline is automatic');
    const workerRb = (await q(`SELECT status,quota_remaining FROM agy_workers WHERE worker_id='MUSE-QUAL-WORKER'`))[0];
    assert.equal(workerRb.status, 'OFFLINE'); assert.equal(workerRb.quota_remaining, null);
    const projRb = (await q(`SELECT status,priority FROM agy_projects WHERE project_id='GL_QUALIFICATION'`))[0];
    assert.equal(projRb.status, 'PAUSED'); assert.equal(projRb.priority, 0);
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_jobs WHERE idempotency_key='run-d-test'`))[0].n, 1, 'evidence preserved; no second job');
    assert.equal((await q(`SELECT enabled FROM agy_connectors WHERE connector_id='muse-qual-x'`))[0].enabled, false,
      'cleanup disabled the qualification connector');
    const taskRb = (await q(`SELECT lease_expires_at FROM agy_tasks WHERE task_id=$1`, [tasksD[0].task_id]))[0];
    assert.ok(new Date(taskRb.lease_expires_at).getTime() <= Date.now(), 'cleanup forced the active lease into the past');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claimD.task.leaseToken]))[0].state, 'EXPIRED',
      'cleanup settled the HELD reservation to EXPIRED');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_task_events WHERE task_id=$1 AND event_type='QUALIFICATION_LEASE_NEUTRALIZED'`, [tasksD[0].task_id]))[0].n, 1);
    // Exactly-once: a second past-deadline instance changes nothing.
    const ctl4 = createQualificationController(rawQ, { config: { ...qualCfgD, expiresAtMs: Date.now() - 1000 }, log: () => {} });
    ctl4.start();
    for (let i = 0; i < 80; i++) { if (ctl4.state() === 'ROLLED_BACK' || ctl4.state() === 'BLOCKED') break; await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(ctl4.state(), 'ROLLED_BACK');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_task_events WHERE task_id=$1 AND event_type='QUALIFICATION_LEASE_NEUTRALIZED'`, [tasksD[0].task_id]))[0].n, 1,
      'lease neutralization happened exactly once');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [claimD.task.leaseToken]))[0].state, 'EXPIRED');
    // Post-cleanup mutations stay denied; attempts never duplicated.
    await assert.rejects(() => surfaceQ(qualP, 'result', { task_id: claimD.task.taskId, lease_token: claimD.task.leaseToken, attempt: claimD.task.attempt, result: { summary: 'late2' }, evidence: { external_operation_id: 'op-d-late2' } }), /LEASE_EXPIRED/);
    const taskFinal = (await q(`SELECT status,attempt FROM agy_tasks WHERE task_id=$1`, [tasksD[0].task_id]))[0];
    assert.equal(taskFinal.status, 'CLAIMED'); assert.equal(Number(taskFinal.attempt), 1, 'no duplicate attempt was created');
  } finally {
    if (runtime) await runtime.end();
    await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  }
});
