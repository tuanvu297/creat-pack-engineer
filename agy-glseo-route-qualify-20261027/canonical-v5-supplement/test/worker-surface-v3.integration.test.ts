// Integration tests for the CANDIDATE canonical worker surface v3
// (QA findings S1–S3 + S6). Evidence class: LOCAL integration against a
// real local PostgreSQL 18.4 with repo migrations 001-008 + candidate
// 012, an RLS-bound runtime role, and the real ProjectService /
// PostgresStore / worker-surface / callback-dispatcher code.
// Fixture note (C6): worker profiles below use convenient numbers as
// LOCAL TEST FIXTURES ONLY — not the registry candidate.
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
import { dispatchWorkerCallbacks, reconcileWorkerCallbacks, releaseUnknownCallback, recoverStaleCallbackIntents,
  createHttpCallbackTransport, createHttpCallbackLookup, CallbackDefiniteFailure, CallbackOutcomeUnknown } from "../src/platform/worker-callbacks.js";
import { createServer } from "node:http";
import { createCallbackReceiver } from "../src/platform/worker-callback-receiver.js";
import { createGatewayHttpServer } from "../src/temporal/http-server.js";
import type { IdentityConfig } from "../src/platform/auth.js";
import { createHash as _sha } from "node:crypto";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const Muse: Principal = { subject: 'claude-worker', role: 'worker', scopes: [scope], workerId: 'MUSE-SEO-WORKER' };
const other: Principal = { subject: 'other-worker', role: 'worker', scopes: [scope], workerId: 'OTHER-WORKER' };
const nobind: Principal = { subject: 'nobind-worker', role: 'worker', scopes: [scope], workerId: 'NOBIND-WORKER' };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const malform: Principal = { subject: 'malform-worker', role: 'worker', scopes: [scope], workerId: 'MALFORM-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';

test("worker surface v3: in-transaction claim gate, atomic result, checkpoint locking, dispatcher",
  { skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 180000 }, async () => {
  const schema = `agy_w3_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_w3_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const owner = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  let runtime: Pool | undefined; let cbServer: any;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','012_worker_callbacks.sql'])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    const seed = await owner.connect();
    try { await seed.query('BEGIN');
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
    const scopedSetup = new ProjectPool(runtime, scope, 'setup').asPool();
    await scopedSetup.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read','analyze','planning','qa'],resource_policy='{"maxConcurrentTasks":4,"quotaCap":100,"spendCap":10,"reservation":1}'`);

    const resources = new ResourceStore(owner);
    const profile = (workerId: string, caps: string[]) => ({ ...discoverResource(workerId, caps, Date.now()),
      status: 'READY' as const, ready: true, quotaRemaining: 100, quotaReserve: 20, maxConcurrency: 2,
      passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0, costPerTask: 0, spendCap: 0, quotaCap: 200,
      permissions: ['read', 'analyze', 'planning', 'qa'] });
    await resources.register(profile('MUSE-SEO-WORKER', ['text', 'creative', 'planning', 'qa']), 'muse');
    await resources.register(profile('OTHER-WORKER', ['text', 'planning']), 'muse');
    await resources.register(profile('NOBIND-WORKER', ['text']), 'muse');
    await resources.register(profile('GEMINI-SEO-WORKER', ['text', 'qa']), 'gemini');
    await resources.register(profile('MALFORM-WORKER', ['text']), 'muse');
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='MALFORM-WORKER'`,
      [JSON.stringify({ bindings: { missions: 'M-SEO', task_types: ['creative'], reply_targets: [RT] } })]);
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='MUSE-SEO-WORKER'`,
      [JSON.stringify({ bindings: { missions: ['M-SEO'], task_types: ['planning', 'research', 'qa', 'creative'], reply_targets: [RT] } })]);
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='OTHER-WORKER'`,
      [JSON.stringify({ bindings: { task_types: ['planning'], reply_targets: [RT] } })]);
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='GEMINI-SEO-WORKER'`,
      [JSON.stringify({ bindings: { task_types: ['qa'], reply_targets: [RT] } })]);
    // NOBIND-WORKER deliberately keeps metadata without bindings.

    const service = new ProjectService(runtime, scope, op);
    const mkJob = async (key: string, task: any) => (await service.execute('/jobs', 'POST', { idempotency_key: key, objective: key,
      tasks: [{ name: key, idempotencyKey: key + '-t', taskType: 'planning', requiredPermissions: ['read'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, ...task }] })).jobId;
    const surface = createWorkerSurface(runtime);
    const q = async (sql: string, args: any[] = []) => (await owner.query(sql, args)).rows;
    // Owner-side row surgery (crash simulation) must still satisfy the
    // scope fill trigger: run inside a tx with the project's GUCs set.
    const ownerScoped = async (sql: string, params: unknown[]) => {
      const c = await owner.connect();
      try { await c.query('BEGIN');
        await c.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
        const r = await c.query(sql, params as any); await c.query('COMMIT'); return r;
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };

    // ---- S1: mixed queue — forbidden heads, valid tail ----------------
    await mkJob('job-h1', { requiredCapabilities: ['creative'], priority: 200, payload: { mission_id: 'M-SEO', auto_dispatch: false } });
    await mkJob('job-h2', { requiredCapabilities: ['creative'], priority: 190, payload: { mission_id: 'M-SEO', target_worker_id: 'OTHER-WORKER' } });
    await mkJob('job-tail', { requiredCapabilities: ['creative'], priority: 10, payload: { mission_id: 'M-SEO', target_worker_id: 'MUSE-SEO-WORKER', callback_target: RT } });
    const claimT = await surface(Muse, scope, 'claim', {});
    assert.equal(claimT.status, 'LEASED', 'the valid tail is leased, not a forbidden head');
    const tailId = claimT.task.taskId;
    for (const marker of ['auto_dispatch', 'target_worker_id']) {
      const rows = await q(`SELECT status,attempt FROM agy_tasks WHERE payload->>$1 IS NOT NULL`, [marker]);
      assert.equal(rows[0].status, 'QUEUED', `${marker} task was never claimed`);
      assert.equal(rows[0].attempt, 0, `${marker} task attempt stayed 0 — gate ran before mutation`);
    }
    assert.equal((await q(`SELECT count(*)::int n FROM agy_resource_reservations r JOIN agy_tasks t ON t.task_id=r.task_id WHERE t.payload->>'auto_dispatch'='false' OR t.payload->>'target_worker_id'='OTHER-WORKER'`))[0].n, 0,
      'no reservation was ever created for a forbidden task');
    const denied = await surface(nobind, scope, 'claim', {});
    assert.equal(denied.status, 'DENIED'); assert.equal(denied.reason, 'WORKER_BINDINGS_MISSING',
      'a worker with no provisioned bindings is denied, not unrestricted');
    assert.equal((await q(`SELECT coalesce(sum(attempt),0)::int s FROM agy_tasks WHERE payload->>'auto_dispatch'='false'`))[0].s, 0);
    const gEmpty = await surface(gemini, scope, 'claim', {});
    assert.equal(gEmpty.status, 'DENIED'); assert.equal(gEmpty.reason, 'WORKER_BINDINGS_INVALID',
      'an incompletely provisioned worker (no missions/reply_targets bindings) is denied outright under T3, not merely empty');

    // ---- T3: unattributed tasks are invisible to this namespace ------
    await mkJob('job-na1', { requiredCapabilities: ['creative'], priority: 300, payload: { target_worker_id: 'MUSE-SEO-WORKER', callback_target: RT } });
    await mkJob('job-na2', { requiredCapabilities: ['creative'], priority: 290, payload: { mission_id: 'M-SEO', callback_target: RT } });
    await mkJob('job-na3', { requiredCapabilities: ['creative'], priority: 280, payload: { mission_id: 'M-SEO', target_worker_id: 'MUSE-SEO-WORKER' } });
    const naClaim = await surface(Muse, scope, 'claim', {});
    assert.equal(naClaim.status, 'EMPTY', 'tasks missing mission_id, target_worker_id, or callback_target are all gated out');
    assert.equal((await q(`SELECT coalesce(sum(attempt),0)::int s FROM agy_tasks WHERE payload->>'auto_dispatch' IS NULL AND attempt>0 AND task_id <> ALL($1)`, [[tailId]]))[0].s, 0,
      'no unattributed task was attempted');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_resource_reservations r JOIN agy_tasks t ON t.task_id=r.task_id WHERE t.task_id <> $1`, [tailId]))[0].n, 0,
      'no reservation exists for any gated-out task');
    const malformed = await surface(malform, scope, 'claim', {});
    assert.equal(malformed.status, 'DENIED'); assert.equal(malformed.reason, 'WORKER_BINDINGS_INVALID',
      'malformed bindings (missions as a string) are denied, never widened');

    // ---- Main flow -----------------------------------------------------
    const jobM = await mkJob('job-main', { requiredCapabilities: ['creative', 'planning'], priority: 100, payload: { mission_id: 'M-SEO', target_worker_id: 'MUSE-SEO-WORKER', callback_target: RT } });
    const claimM = await surface(Muse, scope, 'claim', {});
    assert.equal(claimM.status, 'LEASED');
    const M = claimM.task; assert.equal(M.jobId, jobM);
    await assert.rejects(() => surface(other, scope, 'ack', { task_id: M.taskId, lease_token: M.leaseToken, attempt: M.attempt }), /WORKER_BINDING_DENIED/);
    // S2: a result is never auto-acked from CLAIMED.
    await assert.rejects(() => surface(Muse, scope, 'result', { task_id: M.taskId, lease_token: M.leaseToken, attempt: M.attempt, result: { summary: 'early' }, evidence: { external_operation_id: 'op-early' } }), /RESULT_REQUIRES_ACK/);
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [M.taskId]))[0].status, 'CLAIMED');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_worker_callbacks WHERE task_id=$1`, [M.taskId]))[0].n, 0);
    // Attempt is required (S3).
    await assert.rejects(() => surface(Muse, scope, 'ack', { task_id: M.taskId, lease_token: M.leaseToken }), /ATTEMPT_REQUIRED/);
    const ack = await surface(Muse, scope, 'ack', { task_id: M.taskId, lease_token: M.leaseToken, attempt: M.attempt });
    assert.equal(ack.status, 'RUNNING');

    // S3: concurrent duplicate checkpoints collapse to one version/row,
    // and the persisted data carries the real payload + digest.
    const ckArgs = { task_id: M.taskId, lease_token: M.leaseToken, attempt: M.attempt, external_id: 'op-1', state: { step: 'a' } };
    const [ck1, ck2] = await Promise.all([surface(Muse, scope, 'checkpoint', ckArgs), surface(Muse, scope, 'checkpoint', ckArgs)]);
    assert.equal(ck1.version, 1); assert.equal(ck2.version, 1, 'concurrent duplicate returns the same version');
    const ckRows = await q(`SELECT context_digest, data FROM agy_checkpoints WHERE task_id=$1`, [M.taskId]);
    assert.equal(ckRows.length, 1, 'exactly one checkpoint row under contention');
    assert.equal(ckRows[0].context_digest, createHash('sha256').update(JSON.stringify({ step: 'a' })).digest('hex'));
    assert.deepEqual(ckRows[0].data.payload, { step: 'a' }, 'checkpoint persists the real payload');
    await assert.rejects(() => surface(Muse, scope, 'checkpoint', { ...ckArgs, attempt: M.attempt + 5 }), /ATTEMPT_DENIED/);
    await assert.rejects(() => surface(Muse, scope, 'checkpoint', { ...ckArgs, state: { step: 'DIFFERENT' } }), /CHECKPOINT_CONFLICT/);

    // S2 atomicity: inject a failure at the event insert — EVERYTHING
    // must roll back (task, QA row, outbox, settlement, telemetry).
    await owner.query(`CREATE OR REPLACE FUNCTION ${schema}.fail_result_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`);
    await owner.query(`CREATE TRIGGER fail_event BEFORE INSERT ON agy_task_events FOR EACH ROW WHEN (NEW.event_type='RESULT_SUBMITTED') EXECUTE FUNCTION ${schema}.fail_result_event()`);
    const resArgs = { task_id: M.taskId, lease_token: M.leaseToken, attempt: M.attempt, result: { summary: 'done' }, evidence: { external_operation_id: 'op-1' } };
    await assert.rejects(() => surface(Muse, scope, 'result', resArgs), /injected failure/);
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [M.taskId]))[0].status, 'RUNNING', 'task update rolled back');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_worker_callbacks WHERE task_id=$1`, [M.taskId]))[0].n, 0, 'no orphan outbox row');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_qa_results WHERE task_id=$1`, [M.taskId]))[0].n, 0, 'no orphan QA row');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [M.leaseToken]))[0].state, 'HELD', 'reservation not settled by a failed result');
    await owner.query(`DROP TRIGGER fail_event ON agy_task_events`);

    // S2 race: two concurrent identical results — exactly one wins, the
    // other is the replay; every artefact exists exactly once.
    const [r1, r2] = await Promise.all([surface(Muse, scope, 'result', resArgs), surface(Muse, scope, 'result', resArgs)]);
    assert.deepEqual([r1.replay, r2.replay].sort(), [false, true], 'one submission + one replay');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_worker_callbacks WHERE task_id=$1`, [M.taskId]))[0].n, 1);
    assert.equal((await q(`SELECT count(*)::int n FROM agy_task_events WHERE task_id=$1 AND event_type='RESULT_SUBMITTED'`, [M.taskId]))[0].n, 1);
    assert.equal((await q(`SELECT count(*)::int n FROM agy_qa_results WHERE task_id=$1`, [M.taskId]))[0].n, 1);
    assert.equal((await q(`SELECT count(*)::int n FROM agy_telemetry WHERE task_id=$1 AND outcome='RESULT_SUBMITTED'`, [M.taskId]))[0].n, 1);
    // S6/S2 settlement: HELD -> SETTLED exactly once; a later canonical
    // recordTelemetry cannot settle again or move quota.
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [M.leaseToken]))[0].state, 'SETTLED');
    const store = new PostgresStore(new ProjectPool(runtime, scope, 'qa').asPool(), scope);
    const quotaBefore = (await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0].quota_remaining;
    await store.recordTelemetry({ jobId: jobM, taskId: M.taskId, attemptId: M.leaseToken, workerId: 'MUSE-SEO-WORKER', outcome: 'PASS', quotaUnits: 99, costAmount: 0, metadata: { taskType: 'planning' } });
    const quotaAfter = (await q(`SELECT quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0].quota_remaining;
    assert.equal(String(quotaBefore), String(quotaAfter), 'recordTelemetry after settlement does not settle twice');
    assert.equal(Number((await q(`SELECT actual_quota FROM agy_resource_reservations WHERE reservation_id=$1`, [M.leaseToken]))[0].actual_quota), 1, 'settled at the reserved estimate, not rewritten by later telemetry');
    await assert.rejects(() => surface(Muse, scope, 'result', { ...resArgs, result: { summary: 'CHANGED' } }), /RESULT_CONTENT_CONFLICT/);
    // S3 stale replay: the task is in QA — a checkpoint replay must be
    // denied by the locked-row validation, never answered with a version.
    await assert.rejects(() => surface(Muse, scope, 'checkpoint', ckArgs), /CHECKPOINT_DENIED/);
    assert.equal((await q(`SELECT count(*)::int n FROM agy_checkpoints WHERE task_id=$1`, [M.taskId]))[0].n, 1);

    // ---- S6: dispatcher delivers with a receipt, exactly once ---------
    const rb1 = await surface(Muse, scope, 'readback', { task_id: M.taskId });
    assert.equal(rb1.callback.status, 'PENDING');
    let deliveries: any[] = [];
    const okTransport = async (intent: any) => { deliveries.push(intent.callback_id);
      return { accepted: true, idempotency_key: intent.callback_id, content_digest: intent.content_digest, received_at: new Date().toISOString() }; };
    const d1 = await dispatchWorkerCallbacks(runtime, scope, okTransport, { actor: 'control-plane' });
    assert.equal(d1.delivered, 1);
    const rb2 = await surface(Muse, scope, 'readback', { task_id: M.taskId });
    assert.equal(rb2.callback.status, 'DELIVERED'); assert.ok(rb2.callback.delivered_at);
    const devEvents = await q(`SELECT detail FROM agy_task_events WHERE task_id=$1 AND event_type='CALLBACK_DELIVERED'`, [M.taskId]);
    assert.equal(devEvents.length, 1); assert.equal(devEvents[0].detail.receipt.idempotency_key, rb1.callback.callback_id, 'validated delivery receipt recorded');
    const d2 = await dispatchWorkerCallbacks(runtime, scope, okTransport, { actor: 'control-plane' });
    assert.equal(d2.delivered, 0); assert.equal(deliveries.length, 1, 'DELIVERED rows are never delivered twice');

    // Dispatcher failure keeps PENDING + records the failure; retry works.
    const T = claimT.task;
    await surface(Muse, scope, 'ack', { task_id: T.taskId, lease_token: T.leaseToken, attempt: T.attempt });
    await surface(Muse, scope, 'result', { task_id: T.taskId, lease_token: T.leaseToken, attempt: T.attempt, result: { summary: 'tail done' }, evidence: { external_operation_id: 'op-tail' } });
    const failTransport = async () => { throw new CallbackDefiniteFailure('target rejected'); };
    const d3 = await dispatchWorkerCallbacks(runtime, scope, failTransport, { actor: 'control-plane' });
    assert.equal(d3.failed, 1);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE task_id=$1`, [T.taskId]))[0].status, 'PENDING', 'failed delivery stays PENDING');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_task_events WHERE task_id=$1 AND event_type='CALLBACK_DELIVERY_FAILED'`, [T.taskId]))[0].n, 1);
    const d4 = await dispatchWorkerCallbacks(runtime, scope, okTransport, { actor: 'control-plane' });
    assert.equal(d4.delivered, 1, 'a later pass delivers the retained PENDING row');

    // ---- T1: real receiver route + HTTP transport (local full route) --
    // A stub transport is a harness, not a connection; this section wires
    // the REAL adapter to the REAL receiver route on the canonical host
    // shape. Live hosted route status stays BLOCKED_TRANSPORT (nothing
    // deployed) — this test proves the local route only.
    assert.throws(() => createHttpCallbackTransport({ baseUrl: 'https://evil.example', token: 'x' }), /CALLBACK_HOST_NOT_ALLOWLISTED/);
    const cbIdentities: IdentityConfig[] = [
      { subject: 'control-op', token: 'operator-token', role: 'operator', scopes: [scope] },
      { subject: 'claude-worker', token: 'claude-token', role: 'worker', workerId: 'MUSE-SEO-WORKER', scopes: [scope] },
    ];
    cbServer = createGatewayHttpServer({ identities: cbIdentities, callbacks: createCallbackReceiver(runtime), worker: surface,
      status: async () => ({}), start: async () => ({ status: 'ACCEPTED', run_id: 'x', replayed: false }),
      signal: async () => ({ status: 'ACCEPTED' }), query: async () => ({}) } as any);
    await new Promise<void>((r) => cbServer.listen(0, '127.0.0.1', r));
    const cbBase = `http://127.0.0.1:${cbServer.address().port}`;
    const allow = [`127.0.0.1:${cbServer.address().port}`];
    const httpTransport = createHttpCallbackTransport({ baseUrl: cbBase, token: 'operator-token', allowHosts: allow });
    const httpLookup = createHttpCallbackLookup({ baseUrl: cbBase, token: 'operator-token', allowHosts: allow, scope });
    const doTask = async (key: string, opId: string) => {
      await service.execute('/jobs', 'POST', { idempotency_key: key, objective: key, tasks: [{ name: key, idempotencyKey: key,
        taskType: 'planning', requiredCapabilities: ['creative', 'planning'], requiredPermissions: ['read'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0,
        payload: { mission_id: 'M-SEO', target_worker_id: 'MUSE-SEO-WORKER', callback_target: RT }, priority: 100 }] });
      const c = await surface(Muse, scope, 'claim', {});
      assert.equal(c.status, 'LEASED');
      await surface(Muse, scope, 'ack', { task_id: c.task.taskId, lease_token: c.task.leaseToken, attempt: c.task.attempt });
      await surface(Muse, scope, 'result', { task_id: c.task.taskId, lease_token: c.task.leaseToken, attempt: c.task.attempt,
        result: { summary: key }, evidence: { external_operation_id: opId } });
      return (await q(`SELECT * FROM agy_worker_callbacks WHERE task_id=$1`, [c.task.taskId]))[0];
    };

    // Happy path over real HTTP: receiver records the effect once.
    const cbA = await doTask('job-t1a', 'op-t1a');
    const dA = await dispatchWorkerCallbacks(runtime, scope, httpTransport, { actor: 'control-plane' });
    assert.equal(dA.delivered, 1);
    const recA = await q(`SELECT * FROM agy_callback_receipts WHERE callback_id=$1`, [cbA.callback_id]);
    assert.equal(recA.length, 1); assert.equal(Number(recA[0].effect_count), 1, 'receiver effect happened exactly once');

    // Lost response after the receiver committed: outcome UNKNOWN, no
    // auto-resend, reconcile from readback settles it, effect stays 1.
    const cbB = await doTask('job-t1b', 'op-t1b');
    let sendsB = 0;
    const lostTransport = async (intent: any) => { sendsB++; await httpTransport(intent); throw new CallbackOutcomeUnknown('response lost after send'); };
    const dB = await dispatchWorkerCallbacks(runtime, scope, lostTransport, { actor: 'control-plane' });
    assert.equal(dB.unknown, 1); assert.equal(sendsB, 1);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbB.callback_id]))[0].status, 'UNKNOWN');
    const dB2 = await dispatchWorkerCallbacks(runtime, scope, httpTransport, { actor: 'control-plane' });
    assert.equal(dB2.seen, 0, 'UNKNOWN rows are never auto-resent');
    const rec1 = await reconcileWorkerCallbacks(runtime, scope, httpLookup, { actor: 'control-plane' });
    assert.equal(rec1.reconciled, 1);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbB.callback_id]))[0].status, 'DELIVERED');
    assert.equal(Number((await q(`SELECT effect_count FROM agy_callback_receipts WHERE callback_id=$1`, [cbB.callback_id]))[0].effect_count), 1,
      'after restart/reconcile the receiver effect count is still exactly 1');

    // Void receipt never delivers; explicit release is the only way back.
    const cbC = await doTask('job-t1c', 'op-t1c');
    const dC = await dispatchWorkerCallbacks(runtime, scope, async () => undefined, { actor: 'control-plane' });
    assert.equal(dC.unknown, 1);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbC.callback_id]))[0].status, 'UNKNOWN');
    assert.equal(await releaseUnknownCallback(runtime, scope, cbC.callback_id, { actor: 'control-plane' }), true);
    const dC2 = await dispatchWorkerCallbacks(runtime, scope, httpTransport, { actor: 'control-plane' });
    assert.equal(dC2.delivered, 1, 'released row delivers on a later pass');

    // Mismatched receipt never delivers.
    const cbD = await doTask('job-t1d', 'op-t1d');
    const dD = await dispatchWorkerCallbacks(runtime, scope, async (intent: any) =>
      ({ accepted: true, idempotency_key: intent.callback_id, content_digest: 'deadbeef' }), { actor: 'control-plane' });
    assert.equal(dD.unknown, 1);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbD.callback_id]))[0].status, 'UNKNOWN');

    // Bounded timeout: a transport that never answers is classified
    // UNKNOWN within the configured bound, not waited on forever.
    const cbE = await doTask('job-t1e', 'op-t1e');
    const t0 = Date.now();
    const dE = await dispatchWorkerCallbacks(runtime, scope, () => new Promise(() => {}), { actor: 'control-plane', timeoutMs: 150 });
    assert.equal(dE.unknown, 1); assert.ok(Date.now() - t0 < 4000, 'timeout is bounded');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbE.callback_id]))[0].status, 'UNKNOWN');

    // ---- U1: receiver scope authorization + tuple validation ---------
    const cbF = await doTask('job-u1', 'op-u1');
    const rcvBase = `${cbBase}/v1/callbacks/tenants/gl/workspaces/legacy-workspace/projects/GL_AUTOMATION/receive`;
    const rcvOther = `${cbBase}/v1/callbacks/tenants/gl/workspaces/legacy-workspace/projects/OTHER_PROJECT/receive`;
    const postRcv = async (url: string, body: any, token = 'operator-token') => {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const realTuple = { callback_id: cbF.callback_id, task_id: cbF.task_id, attempt: Number(cbF.attempt),
      worker_id: cbF.worker_id, target: cbF.target, content_digest: cbF.content_digest, payload: cbF.payload };
    const receiptsBefore = (await q(`SELECT count(*)::int n FROM agy_callback_receipts`))[0].n;
    // Same operator role, wrong project scope: 403 and zero rows written.
    const crossPost = await postRcv(rcvOther, realTuple);
    assert.equal(crossPost.status, 403, 'cross-scope receive is denied');
    const crossGet = await fetch(`${rcvOther}/${cbF.callback_id}`, { headers: { authorization: 'Bearer operator-token' } });
    assert.equal(crossGet.status, 403, 'cross-scope lookup is denied');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_callback_receipts`))[0].n, receiptsBefore, 'cross-scope attempts wrote zero rows');
    // Fabricated inputs get no receipt.
    const badDigest = await postRcv(rcvBase, { ...realTuple, content_digest: 'xyz' });
    assert.equal(badDigest.status, 400); assert.equal(badDigest.body.error, 'CALLBACK_DIGEST_INVALID');
    const ghost = await postRcv(rcvBase, { ...realTuple, callback_id: '123e4567-e89b-12d3-a456-426614174000', content_digest: 'a'.repeat(64) });
    assert.equal(ghost.status, 404, 'a callback_id with no outbox row is not found, never receipted');
    const wrongAttempt = await postRcv(rcvBase, { ...realTuple, attempt: Number(cbF.attempt) + 1 });
    assert.equal(wrongAttempt.status, 409); assert.equal(wrongAttempt.body.error, 'CALLBACK_TUPLE_CONFLICT');
    const forgedPayload = await postRcv(rcvBase, { ...realTuple, payload: { result: { summary: 'forged' }, evidence: { external_operation_id: 'op-u1' } } });
    assert.equal(forgedPayload.status, 409, 'payload that differs from the immutable outbox payload conflicts');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_callback_receipts WHERE callback_id=$1`, [cbF.callback_id]))[0].n, 0, 'no receipt for any fabricated tuple');
    // The genuine tuple receipts once; replays dedup; tuple drift conflicts.
    const legit = await postRcv(rcvBase, realTuple);
    assert.equal(legit.status, 200); assert.equal(legit.body.effect_count, 1);
    const replay = await postRcv(rcvBase, realTuple);
    assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true); assert.equal(replay.body.effect_count, 1);
    const drift = await postRcv(rcvBase, { ...realTuple, target: 'SOMEWHERE_ELSE' });
    assert.equal(drift.status, 409, 'replay with a different target conflicts even under the same key');
    await assert.rejects(() => createCallbackReceiver(runtime!).receive(Muse, scope, realTuple), /ACTION_DENIED/,
      'a worker-role principal can never use the receiver');
    const dF = await dispatchWorkerCallbacks(runtime, scope, httpTransport, { actor: 'control-plane' });
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbF.callback_id]))[0].status, 'DELIVERED',
      'dispatcher confirms against the already-recorded receipt');

    // ---- U2: crash after intent + send, before confirm ---------------
    const cbG = await doTask('job-u2', 'op-u2');
    // The crashed dispatcher had claimed the intent and completed the
    // send; it died before the confirm transaction.
    await ownerScoped(`UPDATE agy_worker_callbacks SET status='SENDING', delivery_intent_at=now() - interval '120 seconds', delivery_attempts=1 WHERE callback_id=$1`, [cbG.callback_id]);
    const crashedSend = await postRcv(rcvBase, { callback_id: cbG.callback_id, task_id: cbG.task_id, attempt: Number(cbG.attempt),
      worker_id: cbG.worker_id, target: cbG.target, content_digest: cbG.content_digest, payload: cbG.payload });
    assert.equal(crashedSend.status, 200);
    let restartSends = 0;
    const countingTransport = async (intent: any, signal?: AbortSignal) => { restartSends++; return httpTransport(intent, signal); };
    const dG = await dispatchWorkerCallbacks(runtime, scope, countingTransport, { actor: 'control-plane' });
    assert.ok(dG.swept >= 1, 'restart pass sweeps the stale intent instead of resending');
    assert.equal(restartSends, 0, 'the restarted dispatcher sent nothing for the crashed row');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbG.callback_id]))[0].status, 'UNKNOWN');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_task_events WHERE task_id=$1 AND event_type='CALLBACK_INTENT_STALE'`, [cbG.task_id]))[0].n, 1);
    const recG = await reconcileWorkerCallbacks(runtime, scope, httpLookup, { actor: 'control-plane' });
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbG.callback_id]))[0].status, 'DELIVERED',
      'reconcile settles the crashed delivery from the receiver readback');
    assert.equal(Number((await q(`SELECT effect_count FROM agy_callback_receipts WHERE callback_id=$1`, [cbG.callback_id]))[0].effect_count), 1,
      'receiver effect count is still exactly 1 after crash + restart + reconcile');
    // A FRESH intent is another dispatcher's fence: not swept, not sent.
    const cbH = await doTask('job-u2b', 'op-u2b');
    await ownerScoped(`UPDATE agy_worker_callbacks SET status='SENDING', delivery_intent_at=now(), delivery_attempts=1 WHERE callback_id=$1`, [cbH.callback_id]);
    const dH = await dispatchWorkerCallbacks(runtime, scope, countingTransport, { actor: 'control-plane' });
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbH.callback_id]))[0].status, 'SENDING',
      'a fresh intent is owned elsewhere and left alone');
    await ownerScoped(`UPDATE agy_worker_callbacks SET delivery_intent_at=now() - interval '120 seconds' WHERE callback_id=$1`, [cbH.callback_id]);
    const sweptH = await recoverStaleCallbackIntents(runtime, scope, { actor: 'control-plane' });
    assert.ok(sweptH.swept >= 1);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbH.callback_id]))[0].status, 'UNKNOWN');

    // ---- U3: redirect refusal + lookup timeout ------------------------
    let elsewhereHits = 0; let redirHits = 0;
    const redir = createServer((req, res) => { redirHits++; if ((req.url ?? '').includes('/elsewhere')) elsewhereHits++; res.writeHead(302, { location: '/elsewhere' }); res.end(); });
    await new Promise<void>((r) => redir.listen(0, '127.0.0.1', r));
    const redirBase = `http://127.0.0.1:${(redir.address() as any).port}`;
    const cbI = await doTask('job-u3', 'op-u3');
    const redirTransport = createHttpCallbackTransport({ baseUrl: redirBase, token: 'x', allowHosts: [`127.0.0.1:${(redir.address() as any).port}`] });
    await dispatchWorkerCallbacks(runtime, scope, redirTransport, { actor: 'control-plane' });
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbI.callback_id]))[0].status, 'UNKNOWN',
      'a redirecting endpoint never confirms delivery');
    assert.equal(elsewhereHits, 0, 'the payload was never carried to the redirect target');
    redir.close();
    const hang = createServer(() => { /* never responds */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r));
    const hangLookup = createHttpCallbackLookup({ baseUrl: `http://127.0.0.1:${(hang.address() as any).port}`, token: 'x',
      allowHosts: [`127.0.0.1:${(hang.address() as any).port}`], scope, timeoutMs: 200 });
    const tL = Date.now();
    const recHang = await reconcileWorkerCallbacks(runtime, scope, hangLookup, { actor: 'control-plane' });
    assert.ok(Date.now() - tL < 8000, 'lookup timeout is bounded');
    assert.ok(recHang.lookup_failed >= 1, 'a hung readback is a lookup failure, not a not-found');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbI.callback_id]))[0].status, 'UNKNOWN',
      'an unanswerable readback holds the row UNKNOWN');
    (hang as any).closeAllConnections?.(); hang.close();
  } finally {
    if (cbServer) await new Promise((r) => cbServer.close(r));
    if (runtime) await runtime.end();
    await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  }
});
