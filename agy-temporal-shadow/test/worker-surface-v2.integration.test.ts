// Integration tests for the CANDIDATE canonical worker surface v2
// (QA findings C1–C4). Evidence class: LOCAL integration against a real
// local PostgreSQL 18.4 with repo migrations 001-008 + candidate 012, an
// RLS-bound runtime role, and the real ProjectService/PostgresStore code.
// Fixture note (C6): the worker profiles registered here use convenient
// numbers (quota 100, passRate .95) as LOCAL TEST FIXTURES ONLY — they are
// not the registry candidate and assert nothing about real accounts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { Pool } from "pg";
import { ProjectPool } from "../src/platform/scoped-pool.js";
import { ProjectService } from "../src/platform/service.js";
import { PostgresStore } from "../src/postgres-store.js";
import { ResourceStore } from "../src/resource-store.js";
import { discoverResource } from "../src/resources/discovery.js";
import { createWorkerSurface } from "../src/platform/worker-surface.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const Muse: Principal = { subject: 'claude-worker', role: 'worker', scopes: [scope], workerId: 'MUSE-SEO-WORKER' };
const other: Principal = { subject: 'other-worker', role: 'worker', scopes: [scope], workerId: 'OTHER-WORKER' };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };

test("worker surface v2: bindings, claim gate, checkpoint/result integrity, outbox, settlement",
  { skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const schema = `agy_w2_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_w2_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const owner = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  let runtime: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','012_worker_callbacks.sql','013_reservation_accounting_closure.sql'])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    const seed = await owner.connect();
    try {
      await seed.query('BEGIN');
      await seed.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query("INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'Greenlife Spa','repo:gl','policy:gl') ON CONFLICT DO NOTHING", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query("INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES($1,$2,$3,'muse-x','muse',ARRAY['text'],'local','vault:test',true,ARRAY['read','analyze','planning','qa'])", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query("INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES($1,$2,$3,'gemini-x','gemini',ARRAY['text'],'local','vault:test',true,ARRAY['read','analyze','planning','qa'])", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query('COMMIT');
    } catch (e) { await seed.query('ROLLBACK'); throw e; } finally { seed.release(); }
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
    await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    runtime = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
    const scoped = new ProjectPool(runtime, scope, 'setup').asPool();
    await scoped.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read','analyze','planning','qa'],resource_policy='{"maxConcurrentTasks":4,"quotaCap":100,"spendCap":10,"reservation":1}'`);

    const resources = new ResourceStore(owner);
    const profile = (workerId: string, caps: string[]) => ({ ...discoverResource(workerId, caps, Date.now()),
      status: 'READY' as const, ready: true, quotaRemaining: 100, quotaReserve: 20, maxConcurrency: 2,
      passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0, costPerTask: 0, spendCap: 0, quotaCap: 200,
      permissions: ['read', 'analyze', 'planning', 'qa'] });
    await resources.register(profile('MUSE-SEO-WORKER', ['text', 'creative', 'planning', 'qa']), 'muse');
    await resources.register(profile('OTHER-WORKER', ['text', 'planning']), 'muse');
    await resources.register(profile('GEMINI-SEO-WORKER', ['text', 'qa']), 'gemini');
    // Control-plane-provisioned bindings (metadata) for Muse only.
    await owner.query(`UPDATE agy_workers SET metadata='{"bindings":{"missions":["M-SEO"],"task_types":["planning","research","qa","creative"],"reply_targets":["CHATGPT_ASSISTANT_CONTROL_PLANE"]}}' WHERE worker_id='MUSE-SEO-WORKER'`);

    const service = new ProjectService(runtime, scope, op);
    const mkJob = async (key: string, task: any) => (await service.execute('/jobs', 'POST', { idempotency_key: key, objective: key,
      tasks: [{ name: key, idempotencyKey: key + '-t', taskType: 'planning', requiredPermissions: ['read'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, ...task }] })).jobId;
    const jobA = await mkJob('job-a', { requiredCapabilities: ['text', 'planning'], priority: 100, payload: { mission_id: 'M-SEO' } });
    await mkJob('job-b', { requiredCapabilities: ['text', 'planning'], payload: { mission_id: 'M-SEO', auto_dispatch: false } });
    await mkJob('job-c', { requiredCapabilities: ['text', 'planning'], payload: { mission_id: 'M-SEO', target_worker_id: 'OTHER-WORKER' } });
    await mkJob('job-d', { requiredCapabilities: ['text', 'planning'], payload: { mission_id: 'M-OTHER' } });
    await mkJob('job-e', { requiredCapabilities: ['creative'], priority: 90, payload: { mission_id: 'M-SEO' } });

    const surface = createWorkerSurface(runtime);
    const q = async (sql: string, args: any[] = []) => (await owner.query(sql, args)).rows;

    // Claim gate: of A/B/C/D only A is claimable by Muse (B auto_dispatch,
    // C targeted elsewhere, D mission outside Muse's bindings).
    const claimA = await surface(Muse, scope, 'claim', {});
    assert.equal(claimA.status, 'LEASED');
    const A = claimA.task;
    assert.equal(A.jobId, jobA);
    const bRow = await q(`SELECT status,attempt FROM agy_tasks WHERE payload->>'auto_dispatch'='false'`);
    assert.equal(bRow[0].status, 'QUEUED'); assert.equal(bRow[0].attempt, 0, 'auto_dispatch=false produced zero attempts');

    // C1/C2: cross-worker denial even with the exact task id + lease token.
    await assert.rejects(() => surface(other, scope, 'ack', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt }), /WORKER_BINDING_DENIED/);
    await assert.rejects(() => surface(other, scope, 'heartbeat', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt }), /WORKER_BINDING_DENIED/);
    await assert.rejects(() => surface(other, scope, 'result', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt, result: { x: 1 }, evidence: { external_operation_id: 'op-x' } }), /WORKER_BINDING_DENIED/);
    await assert.rejects(() => surface(other, scope, 'readback', { task_id: A.taskId }), /READBACK_DENIED/);
    // Wrong attempt / wrong token for the rightful worker.
    await assert.rejects(() => surface(Muse, scope, 'ack', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt + 9 }), /ATTEMPT_DENIED/);
    await assert.rejects(() => surface(Muse, scope, 'ack', { task_id: A.taskId, lease_token: randomUUID(), attempt: A.attempt }), /LEASE_DENIED/);

    const ack = await surface(Muse, scope, 'ack', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt });
    assert.equal(ack.status, 'RUNNING');
    assert.equal(Number((await q(`SELECT active_count FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0].active_count), 1);

    // C3: checkpoint digest covers the real payload; replay is idempotent.
    const ck = await surface(Muse, scope, 'checkpoint', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt, external_id: 'op-1', state: { step: 'a' } });
    assert.equal(ck.version, 1);
    const expectedDigest = createHash('sha256').update(JSON.stringify({ step: 'a' })).digest('hex');
    const ckRows = await q(`SELECT context_digest FROM agy_checkpoints WHERE task_id=$1`, [A.taskId]);
    assert.equal(ckRows.length, 1); assert.equal(ckRows[0].context_digest, expectedDigest);
    const ckReplay = await surface(Muse, scope, 'checkpoint', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt, external_id: 'op-1', state: { step: 'a' } });
    assert.equal(ckReplay.version, 1, 'identical checkpoint replay returns the same version');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_checkpoints WHERE task_id=$1`, [A.taskId]))[0].n, 1, 'replay inserted no new checkpoint row');
    await assert.rejects(() => surface(Muse, scope, 'checkpoint', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt, external_id: 'op-1', state: { step: 'DIFFERENT' } }), /CHECKPOINT_CONFLICT/);

    // C4: result requires evidence; writes receipt + PENDING outbox; the
    // capacity trigger releases active_count on leaving RUNNING.
    await assert.rejects(() => surface(Muse, scope, 'result', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt, result: { summary: 'done' } }), /EVIDENCE_REQUIRED/);
    const res = await surface(Muse, scope, 'result', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt, result: { summary: 'done' }, evidence: { external_operation_id: 'op-1' } });
    assert.equal(res.status, 'RESULT_SUBMITTED'); assert.equal(res.task_status, 'QA');
    assert.equal(res.callback.status, 'PENDING');
    assert.equal(Number((await q(`SELECT active_count FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0].active_count), 0, 'capacity released by the existing trigger');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_task_events WHERE task_id=$1 AND event_type='RESULT_SUBMITTED'`, [A.taskId]))[0].n, 1, 'attempt receipt recorded in agy_task_events');
    // Replay: identical content idempotent; different content conflicts.
    const resReplay = await surface(Muse, scope, 'result', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt, result: { summary: 'done' }, evidence: { external_operation_id: 'op-1' } });
    assert.equal(resReplay.replay, true);
    assert.equal((await q(`SELECT count(*)::int n FROM agy_worker_callbacks WHERE task_id=$1`, [A.taskId]))[0].n, 1);
    await assert.rejects(() => surface(Muse, scope, 'result', { task_id: A.taskId, lease_token: A.leaseToken, attempt: A.attempt, result: { summary: 'CHANGED' }, evidence: { external_operation_id: 'op-1' } }), /RESULT_CONTENT_CONFLICT/);
    // Pending vs delivered readback.
    const rb1 = await surface(Muse, scope, 'readback', { task_id: A.taskId });
    assert.equal(rb1.callback.status, 'PENDING'); assert.equal(rb1.callback.delivered_at, null);
    // The control-plane delivery act runs with the project scope set
    // (agy_worker_callbacks is RLS-scoped by migration 012).
    const dc = await owner.connect();
    try { await dc.query('BEGIN');
      await dc.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await dc.query(`UPDATE agy_worker_callbacks SET status='DELIVERED', delivered_at=now() WHERE task_id=$1`, [A.taskId]);
      await dc.query('COMMIT');
    } catch (e) { await dc.query('ROLLBACK'); throw e; } finally { dc.release(); }
    const rb2 = await surface(Muse, scope, 'readback', { task_id: A.taskId });
    assert.equal(rb2.callback.status, 'DELIVERED'); assert.ok(rb2.callback.delivered_at, 'delivered_at set only by the control-plane act');

    // C4: canonical QA completion + telemetry settles the reservation once.
    const store = new PostgresStore(new ProjectPool(runtime, scope, 'qa').asPool(), scope);
    assert.equal(await store.transition(A.taskId, A.leaseToken, ['QA'], 'PASS'), true);
    const telemetry = { jobId: jobA, taskId: A.taskId, attemptId: A.leaseToken, workerId: 'MUSE-SEO-WORKER', outcome: 'PASS', quotaUnits: 1, costAmount: 0, metadata: { taskType: 'planning', externalOperationId: 'op-1' } };
    await store.recordTelemetry(telemetry);
    const quotaAfterFirst = (await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0].quota_remaining;
    await store.recordTelemetry(telemetry);
    const quotaAfterSecond = (await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0].quota_remaining;
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [A.leaseToken]))[0].state, 'SETTLED');
    assert.equal(String(quotaAfterFirst), String(quotaAfterSecond), 'second telemetry record does not settle twice');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_telemetry WHERE task_id=$1`, [A.taskId]))[0].n, 1, 'telemetry is idempotent per (task, attempt, outcome)');

    // Expiry: task E (creative — only Muse qualifies) leased, then expired.
    const claimE = await surface(Muse, scope, 'claim', {});
    assert.equal(claimE.status, 'LEASED');
    const ec = await owner.connect();
    try { await ec.query('BEGIN');
      await ec.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await ec.query(`UPDATE agy_tasks SET lease_expires_at=now()-interval '1 minute' WHERE task_id=$1`, [claimE.task.taskId]);
      await ec.query('COMMIT');
    } catch (e) { await ec.query('ROLLBACK'); throw e; } finally { ec.release(); }
    await assert.rejects(() => surface(Muse, scope, 'ack', { task_id: claimE.task.taskId, lease_token: claimE.task.leaseToken, attempt: claimE.task.attempt }), /LEASE_EXPIRED/);

    // The unbound worker can claim a task; Gemini (capability-short) gets
    // nothing; and the mission-gated task was never attempted BY MUSE —
    // Muse's bindings excluded it at the gate on every claim above.
    const claimC = await surface(other, scope, 'claim', {});
    assert.equal(claimC.status, 'LEASED');
    const g = await surface(gemini, scope, 'claim', {});
    assert.equal(g.status, 'EMPTY');
    const dByClaude = await q(`SELECT count(*)::int n FROM agy_tasks WHERE payload->>'mission_id'='M-OTHER' AND claimed_by='MUSE-SEO-WORKER'`);
    assert.equal(dByClaude[0].n, 0, 'mission-gated task never attempted by the bound worker');
    const bFinal = await q(`SELECT attempt FROM agy_tasks WHERE payload->>'auto_dispatch'='false'`);
    assert.equal(bFinal[0].attempt, 0, 'auto_dispatch=false still at zero attempts after every claim');
  } finally {
    if (runtime) await runtime.end();
    await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  }
});
