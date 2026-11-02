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
import { createWorkerCallbackDriver, parseCallbackDriverConfig } from "../src/platform/worker-callback-driver.js";
import { ResourceStore } from "../src/resource-store.js";
import { discoverResource } from "../src/resources/discovery.js";
import { createWorkerSurface } from "../src/platform/worker-surface.js";
import { dispatchWorkerCallbacks, reconcileWorkerCallbacks, releaseUnknownCallback, releaseBlockedCallback, recoverStaleCallbackIntents,
  createHttpCallbackTransport, createHttpCallbackLookup, CallbackDefiniteFailure, CallbackLookupBlocked, CallbackOutcomeUnknown, type CallbackTransport } from "../src/platform/worker-callbacks.js";
import { digestOf } from "../src/platform/digest.js";
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
    for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','012_worker_callbacks.sql','013_reservation_accounting_closure.sql'])
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
      return { accepted: true, idempotency_key: intent.callback_id, task_id: intent.task_id, attempt: intent.attempt, content_digest: intent.content_digest, received_at: new Date().toISOString() }; };
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

    // ---- V1: replay with a mutated payload is a conflict ------------
    const mutatedReplay = await postRcv(rcvBase, { ...realTuple, payload: { result: { summary: 'mutated' }, evidence: { external_operation_id: 'op-u1' } } });
    assert.equal(mutatedReplay.status, 409); assert.equal(mutatedReplay.body.error, 'CALLBACK_TUPLE_CONFLICT',
      'the replay path revalidates the payload against the outbox — a known id/digest does not rescue a mutated payload');
    const cbFRec = await q(`SELECT * FROM agy_callback_receipts WHERE callback_id=$1`, [cbF.callback_id]);
    assert.equal(cbFRec.length, 1); assert.equal(Number(cbFRec[0].effect_count), 1, 'the mutated replay added zero effect');

    // ---- V2: partial readback holds UNKNOWN; slow body is bounded ---
    const partialLookup = async (exp: any) => ({ found: true, content_digest: exp.content_digest });
    const recPartial = await reconcileWorkerCallbacks(runtime, scope, partialLookup as any, { actor: 'control-plane' });
    assert.ok(recPartial.unvalidated >= 1, 'a readback missing identity fields is unvalidated, never reconciled');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbD.callback_id]))[0].status, 'UNKNOWN',
      'partial receipt did not deliver the row');
    const slowBody = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"found":true'); });
    await new Promise<void>((r) => slowBody.listen(0, '127.0.0.1', r));
    const slowLookup = createHttpCallbackLookup({ baseUrl: `http://127.0.0.1:${(slowBody.address() as any).port}`, token: 'x',
      allowHosts: [`127.0.0.1:${(slowBody.address() as any).port}`], scope, timeoutMs: 200 });
    const tS = Date.now();
    const recSlow = await reconcileWorkerCallbacks(runtime, scope, slowLookup, { actor: 'control-plane' });
    assert.ok(Date.now() - tS < 8000, 'a never-ending body is bounded by the same abort timer');
    assert.ok(recSlow.lookup_failed >= 1, 'aborted body read is a lookup failure');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbI.callback_id]))[0].status, 'UNKNOWN');
    (slowBody as any).closeAllConnections?.(); slowBody.close();

    // ---- V3→B1: the ungated legacy route keeps PIN semantics --------
    // QA B1 supersedes the v6 blanket payload guard: addressing a task
    // does NOT remove it from ungated legacy demand (the pin allocated
    // it), and the ungated dispatch query/selection is pin-exact.
    // External-namespace isolation is a registry property instead —
    // metadata.external_namespace_only on the NEW worker, proven in
    // the B1 section below.
    await service.execute('/jobs', 'POST', { idempotency_key: 'job-v3', objective: 'addressed legacy task', tasks: [{ name: 'v3-task', idempotencyKey: 'v3-t',
      taskType: 'planning', requiredCapabilities: ['planning', 'qa'], requiredPermissions: ['read'], permissionGranted: true,
      safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 999,
      payload: { mission_id: 'M-SEO', target_worker_id: 'MUSE-SEO-WORKER', callback_target: RT } }] });
    const qt = (await q(`SELECT t.* FROM agy_tasks t JOIN agy_jobs j USING(job_id) WHERE j.idempotency_key='job-v3'`))[0];
    await owner.query(`UPDATE agy_workers SET max_concurrency=3 WHERE worker_id='MUSE-SEO-WORKER'`);
    const legacyStore = new PostgresStore(new ProjectPool(runtime, scope, 'legacy-daemon').asPool(), scope);
    const legacyClaim = await legacyStore.claim({ workerId: 'MUSE-SEO-WORKER', capabilities: ['planning', 'qa', 'creative', 'text'], leaseSeconds: 120 });
    assert.equal(legacyClaim?.taskId, qt.task_id,
      'pin semantics restored: an addressed LEGACY task is claimed by the ungated route exactly as at the pin — no blanket payload filter');
    const qtAfter = (await q(`SELECT status,attempt FROM agy_tasks WHERE task_id=$1`, [qt.task_id]))[0];
    assert.equal(qtAfter.status, 'CLAIMED'); assert.equal(qtAfter.attempt, 1);

    // ---- A1: the worker registry is GLOBAL (pin fact) — isolation uses
    // a DISTINCT qualification worker + adapter kind, never a shared row.
    const scopeQ = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_QUALIFICATION' };
    const opQ: Principal = { subject: 'control-op', role: 'operator', scopes: [scopeQ] };
    const seedQ = await owner.connect();
    try {
      await seedQ.query('BEGIN');
      await seedQ.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)",
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await seedQ.query("INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING",
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await seedQ.query("INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES($1,$2,$3,'muse-qual-x','muse-qual',ARRAY['planning'],'local','vault:test',true,ARRAY['read','analyze','planning','qa'])",
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await seedQ.query(`UPDATE agy_projects SET status='ACTIVE',priority=10,permissions=ARRAY['read','analyze','planning','qa'],resource_policy='{"maxConcurrentTasks":2,"quotaCap":1,"spendCap":0,"reservation":0}' WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_QUALIFICATION'`);
      await seedQ.query('COMMIT');
    } catch (e) { await seedQ.query('ROLLBACK'); throw e; } finally { seedQ.release(); }
    const kindsBiz = (await q(`SELECT adapter_kinds FROM agy_dispatch_projects WHERE project_id='GL_AUTOMATION'`))[0].adapter_kinds;
    const kindsQ = (await q(`SELECT adapter_kinds FROM agy_dispatch_projects WHERE project_id='GL_QUALIFICATION'`))[0].adapter_kinds;
    assert.ok(!kindsBiz.includes('muse-qual'), 'the qualification adapter kind does not exist in the business project');
    assert.ok(kindsQ.includes('muse-qual') && !kindsQ.includes('muse'), 'the qualification project binds only the qualification kind');

    // A business task (untargeted, Muse-capable) queued BEFORE the run.
    await service.execute('/jobs', 'POST', { idempotency_key: 'job-a1-biz', objective: 'business task', tasks: [{ name: 'biz', idempotencyKey: 'a1-biz-t',
      taskType: 'planning', requiredCapabilities: ['planning'], requiredPermissions: ['read'], permissionGranted: true,
      safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 50, payload: { note: 'business' } }] });
    const bizTask = (await q(`SELECT t.* FROM agy_tasks t JOIN agy_jobs j USING(job_id) WHERE j.idempotency_key='job-a1-biz'`))[0];

    // Distinct qualification worker; business row forced OFFLINE (plan state) and snapshotted.
    await resources.register(profile('MUSE-QUAL-WORKER', ['planning']), 'muse-qual');
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='MUSE-QUAL-WORKER'`,
      [JSON.stringify({ bindings: { missions: ['GL_QUALIFICATION'], task_types: ['planning'], reply_targets: [RT] }, qualification: 'UNVERIFIED', external_namespace_only: true })]);
    await owner.query(`UPDATE agy_workers SET status='OFFLINE' WHERE worker_id IN ('MUSE-SEO-WORKER','MUSE-QUAL-WORKER')`);
    const bizRowBefore = (await q(`SELECT status,metadata,quota_remaining,active_count FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0];

    // Transition (window): ONLY the qualification row goes READY, cap-only
    // quota. quota_reserve MUST be 0: the scheduler hard-gate requires
    // quotaRemaining - estimatedQuota >= quotaReserve, so a cap-only
    // profile carrying the default reserve could never allocate.
    await owner.query(`UPDATE agy_workers SET status='READY', quota_remaining=1, quota_reserve=0 WHERE worker_id='MUSE-QUAL-WORKER'`);
    // A raw pool for the qualification scope: the shared runtime pool is
    // bound to the business scope's session settings.
    const rawQ = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
    const surfQ = createWorkerSurface(rawQ);
    const surfaceQ = (principal: Principal, action: string, input: any) => surfQ(principal, scopeQ, action, input);
    const serviceQ = new ProjectService(rawQ, scopeQ, opQ);
    await serviceQ.execute('/jobs', 'POST', { idempotency_key: 'job-a1-qual', objective: 'synthetic qualification', pass_threshold: 0, tasks: [{ name: 'qual', idempotencyKey: 'a1-qual-t',
      taskType: 'planning', requiredCapabilities: ['planning'], requiredPermissions: ['read'], permissionGranted: true,
      safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 500,
      payload: { mission_id: 'GL_QUALIFICATION', target_worker_id: 'MUSE-QUAL-WORKER', callback_target: RT } }] });
    const qualTask = (await q(`SELECT t.* FROM agy_tasks t JOIN agy_jobs j USING(job_id) WHERE j.idempotency_key='job-a1-qual'`))[0];
    const qualP: Principal = { subject: 'qual-worker', role: 'worker', workerId: 'MUSE-QUAL-WORKER', scopes: [scopeQ] };
    await assert.rejects(() => surface(qualP, scope, 'claim', {}), /PROJECT_SCOPE_DENIED/,
      'the qualification identity has no business scope');
    await assert.rejects(() => surfaceQ(Muse, 'claim', {}), /PROJECT_SCOPE_DENIED/,
      'the business identity has no qualification scope');
    const qClaim = await surfaceQ(qualP, 'claim', {});
    assert.equal(qClaim.status, 'LEASED'); assert.equal(qClaim.task.taskId, qualTask.task_id);
    await surfaceQ(qualP, 'ack', { task_id: qClaim.task.taskId, lease_token: qClaim.task.leaseToken, attempt: 1 });
    const qRes = await surfaceQ(qualP, 'result', { task_id: qClaim.task.taskId, lease_token: qClaim.task.leaseToken, attempt: 1,
      result: { summary: 'qualification synthetic result' }, evidence: { external_operation_id: 'op-qual-1' } });
    assert.equal(qRes.status, 'RESULT_SUBMITTED');
    const qualCb = (await q(`SELECT * FROM agy_worker_callbacks WHERE task_id=$1`, [qualTask.task_id]))[0];
    assert.equal(qualCb.status, 'PENDING');

    // Business state after the qualification flow: task and global row untouched.
    const bizAfter = (await q(`SELECT status,attempt,claimed_by FROM agy_tasks WHERE task_id=$1`, [bizTask.task_id]))[0];
    assert.equal(bizAfter.status, 'QUEUED'); assert.equal(bizAfter.attempt, 0); assert.equal(bizAfter.claimed_by, null,
      'the queued business task was never claimed or mutated by the qualification flow');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_resource_reservations WHERE task_id=$1`, [bizTask.task_id]))[0].n, 0);
    assert.equal((await surface(Muse, scope, 'claim', {})).status, 'EMPTY', 'no alternate gated claim path into the business task');
    const bizRowAfter = (await q(`SELECT status,metadata,quota_remaining,active_count FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0];
    assert.equal(bizRowAfter.status, 'OFFLINE');
    assert.equal(JSON.stringify(bizRowAfter.metadata), JSON.stringify(bizRowBefore.metadata), 'global business row metadata (bindings) unchanged');
    assert.equal(String(bizRowAfter.quota_remaining), String(bizRowBefore.quota_remaining), 'global business row quota unchanged');
    assert.equal(bizRowAfter.active_count, bizRowBefore.active_count, 'global business row never allocated');

    // ---- A2: runtime driver — default disabled, allowlisted, bounded.
    assert.equal(parseCallbackDriverConfig({}).config.enabled, false, 'driver is disabled without explicit enablement');
    assert.equal(parseCallbackDriverConfig({ AGY_CALLBACK_DRIVER_ENABLED: 'true' }).reason, 'SCOPE_REQUIRED');
    assert.equal(parseCallbackDriverConfig({ AGY_CALLBACK_DRIVER_ENABLED: 'true', AGY_CALLBACK_DRIVER_SCOPE: 'gl:legacy-workspace:GL_QUALIFICATION', AGY_CALLBACK_DRIVER_MISSION: 'GL_QUALIFICATION' }).reason, 'EXPIRES_AT_REQUIRED',
      'an enabled driver without an absolute owner deadline is refused at config time (B2)');
    const miss = await dispatchWorkerCallbacks(rawQ, scopeQ, okTransport, { missionId: 'NOPE' });
    assert.equal(miss.seen, 0, 'a foreign mission allowlist touches nothing, even in the same project');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [qualCb.callback_id]))[0].status, 'PENDING');
    const drvOff = createWorkerCallbackDriver(rawQ, { config: { enabled: false }, operator: opQ, log: () => {} });
    assert.equal(drvOff.start(), 'DISABLED');
    const drvNoOp = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: Date.now() + 60_000, runId: 'test-noop' }, log: () => {} });
    assert.equal(drvNoOp.start(), 'NO_OPERATOR', 'no operator identity, no driver — credentials are never substituted');
    const drv = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: Date.now() + 60_000, runId: 'test-main', intervalMs: 100, timeboxMs: 60_000, limit: 1, timeoutMs: 5000 }, operator: opQ, log: () => {} });
    assert.equal(drv.start(), 'RUNNING');
    let drvRow: any;
    for (let i = 0; i < 60; i++) { drvRow = (await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [qualCb.callback_id]))[0];
      if (drvRow.status === 'DELIVERED') break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(drvRow.status, 'DELIVERED', 'the running driver delivered the allowlisted callback in-process');
    drv.stop();
    assert.equal(Number((await q(`SELECT effect_count FROM agy_callback_receipts WHERE callback_id=$1`, [qualCb.callback_id]))[0].effect_count), 1);
    const drvX = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: Date.now() + 60_000, runId: 'test-x', intervalMs: 50, timeboxMs: 0, limit: 1 }, operator: opQ, log: () => {} });
    // Contract change (2026-11-02 lifecycle fix): timeboxMs no
    // longer gates delivery — the owner expiry is the only deadline
    // (the startedAt+timebox cap stranded restore3's callback).
    // Unit coverage: test/callback-lifecycle-fix.test.ts.
    assert.equal(drvX.start(), 'RUNNING', 'timeboxMs no longer expires the driver; the owner expiry is the only deadline');
    drvX.stop();
    const drvY = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: Date.now() - 1000, runId: 'test-y', intervalMs: 50, limit: 1 }, operator: opQ, log: () => {} });
    assert.equal(drvY.start(), 'EXPIRED', 'an already-past owner expiry still expires the driver before any pass');

    // ---- B1: ungated fairness across projects + external exclusion --
    // A second 'muse' connector in the qualification project (fixture
    // only, added AFTER the A1 isolation assertions) lets one internal
    // worker be allocatable in both projects, so global priority
    // fairness is observable end to end.
    const seedB1 = await owner.connect();
    try {
      await seedB1.query('BEGIN');
      await seedB1.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)",
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await seedB1.query("INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES($1,$2,$3,'muse-b1-x','muse',ARRAY['planning'],'local','vault:test',true,ARRAY['read','analyze','planning','qa'])",
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await seedB1.query('COMMIT');
    } catch (e) { await seedB1.query('ROLLBACK'); throw e; } finally { seedB1.release(); }
    // B1's scenarios are about priority/addressing, not quota: its
    // qualification tasks carry estimatedQuota 0 because the
    // project's lifetime quotaCap is now exactly 1 (D3) and section
    // A1's task already consumed that unit — with an estimate of 1
    // this demand would be quota-ineligible and prove nothing.
    await serviceQ.execute('/jobs', 'POST', { idempotency_key: 'job-b1-high', objective: 'high priority', pass_threshold: 0, tasks: [{ name: 'high', idempotencyKey: 'b1-h-t',
      taskType: 'planning', requiredCapabilities: ['planning'], requiredPermissions: ['planning'], permissionGranted: true,
      safetyApproved: true, estimatedQuota: 0, estimatedCost: 0, maxRetry: 0, priority: 900,
      payload: { note: 'high' } }] });
    const highTask = (await q(`SELECT t.* FROM agy_tasks t JOIN agy_jobs j USING(job_id) WHERE j.idempotency_key='job-b1-high'`))[0];
    await service.execute('/jobs', 'POST', { idempotency_key: 'job-b1-addr', objective: 'addressed legacy', tasks: [{ name: 'addr', idempotencyKey: 'b1-a-t',
      taskType: 'planning', requiredCapabilities: ['planning'], requiredPermissions: ['read'], permissionGranted: true,
      safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 80,
      payload: { target_worker_id: 'OTHER-WORKER' } }] });
    const addrTask = (await q(`SELECT t.* FROM agy_tasks t JOIN agy_jobs j USING(job_id) WHERE j.idempotency_key='job-b1-addr'`))[0];
    // Fixture headroom: OTHER-WORKER holds several leases across the
    // B1 claims below; the shared profile cap of 2 is not the subject.
    await owner.query(`UPDATE agy_workers SET max_concurrency=5 WHERE worker_id='OTHER-WORKER'`);
    const legacyBiz = new PostgresStore(new ProjectPool(runtime, scope, 'legacy-daemon').asPool(), scope);
    const legacyQ = new PostgresStore(new ProjectPool(rawQ, scopeQ, 'legacy-daemon').asPool(), scopeQ);
    // (a) Fairness: business-scope ungated claim gets NOTHING while the
    // higher-priority demand lives in the other project (pin behaviour
    // — the pre-B1 join hid that demand and would have stolen bizTask).
    assert.equal(await legacyBiz.claim({ workerId: 'OTHER-WORKER', capabilities: ['text', 'planning'], leaseSeconds: 60 }), null,
      'global selection outranks the caller project: no low-priority steal');
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [bizTask.task_id]))[0].status, 'QUEUED');
    // (b) The high-priority task IS claimable ungated from its project.
    const highClaim = await legacyQ.claim({ workerId: 'OTHER-WORKER', capabilities: ['text', 'planning'], leaseSeconds: 60 });
    assert.equal(highClaim?.taskId, highTask.task_id);
    // (c) Addressed LEGACY tasks keep pin behaviour ungated, in normal
    // priority order: addressed (80) before untargeted bizTask (50).
    const addrClaim = await legacyBiz.claim({ workerId: 'OTHER-WORKER', capabilities: ['text', 'planning'], leaseSeconds: 60 });
    assert.equal(addrClaim?.taskId, addrTask.task_id, 'an addressed legacy task remains in ungated demand (no regression)');
    const bizClaim = await legacyBiz.claim({ workerId: 'OTHER-WORKER', capabilities: ['text', 'planning'], leaseSeconds: 60 });
    assert.equal(bizClaim?.taskId, bizTask.task_id, 'the low task is claimed only after higher global demand is served');
    // (d) External namespace: with the fairness fixture connector
    // disabled again, the qualification project binds ONLY 'muse-qual'
    // (the A1 end state). The external worker and its task are then
    // unreachable from the ungated route in every direction.
    const seedB1b = await owner.connect();
    try {
      await seedB1b.query('BEGIN');
      await seedB1b.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)",
        [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
      await seedB1b.query("UPDATE agy_connectors SET enabled=false WHERE connector_id='muse-b1-x'");
      await seedB1b.query('COMMIT');
    } catch (e) { await seedB1b.query('ROLLBACK'); throw e; } finally { seedB1b.release(); }
    const kindsQ2 = (await q(`SELECT adapter_kinds FROM agy_dispatch_projects WHERE project_id='GL_QUALIFICATION'`))[0].adapter_kinds;
    assert.ok(kindsQ2.includes('muse-qual') && !kindsQ2.includes('muse'), 'qualification project restored to the A1 adapter isolation');
    await serviceQ.execute('/jobs', 'POST', { idempotency_key: 'job-b1-qual', objective: 'external task', pass_threshold: 0, tasks: [{ name: 'qual2', idempotencyKey: 'b1-q-t',
      taskType: 'planning', requiredCapabilities: ['planning'], requiredPermissions: ['planning'], permissionGranted: true,
      safetyApproved: true, estimatedQuota: 0, estimatedCost: 0, maxRetry: 0, priority: 950,
      payload: { mission_id: 'GL_QUALIFICATION', target_worker_id: 'MUSE-QUAL-WORKER', callback_target: RT } }] });
    const qualTask2 = (await q(`SELECT t.* FROM agy_tasks t JOIN agy_jobs j USING(job_id) WHERE j.idempotency_key='job-b1-qual'`))[0];
    assert.equal(await legacyQ.claim({ workerId: 'MUSE-QUAL-WORKER', capabilities: ['planning'], leaseSeconds: 60 }), null,
      'external_namespace_only excludes the qualification worker from ungated allocation');
    assert.equal(await legacyQ.claim({ workerId: 'OTHER-WORKER', capabilities: ['text', 'planning'], leaseSeconds: 60 }), null,
      'no legacy worker can take the external task either (adapter isolation)');
    const qual2After = (await q(`SELECT status,attempt FROM agy_tasks WHERE task_id=$1`, [qualTask2.task_id]))[0];
    assert.equal(qual2After.status, 'QUEUED'); assert.equal(qual2After.attempt, 0, 'the external task was never legacy-selected');

    // ---- B2: absolute deadline — restart never renews the window ---
    const noopTransport = async (): Promise<any> => ({ accepted: true, idempotency_key: 'x', task_id: 'x', attempt: 0, content_digest: 'x' });
    const b2expires = Date.now() + 900;
    const drvB2a = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: b2expires, runId: 'run-b2', intervalMs: 60, timeboxMs: 3_600_000, limit: 1 }, operator: opQ, transport: noopTransport, lookup: async () => ({ found: false }), log: () => {} });
    assert.equal(drvB2a.start(), 'RUNNING');
    drvB2a.stop(); // simulated restart: process state lost, env deadline unchanged
    const drvB2b = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: b2expires, runId: 'run-b2', intervalMs: 60, timeboxMs: 3_600_000, limit: 1 }, operator: opQ, transport: noopTransport, lookup: async () => ({ found: false }), log: () => {} });
    assert.equal(drvB2b.start(), 'RUNNING', 'before the deadline a restart may resume — against the SAME deadline');
    let b2state = '';
    for (let i = 0; i < 40; i++) { b2state = drvB2b.state(); if (b2state === 'EXPIRED') break; await new Promise((r) => setTimeout(r, 100)); }
    assert.equal(b2state, 'EXPIRED', 'the restarted driver expires at the ORIGINAL deadline, not at restart+timebox');
    const drvB2c = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: b2expires, runId: 'run-b2', intervalMs: 60, timeboxMs: 3_600_000, limit: 1 }, operator: opQ, transport: noopTransport, lookup: async () => ({ found: false }), log: () => {} });
    assert.equal(drvB2c.start(), 'EXPIRED', 'a boot after the deadline never starts a pass');

    // ---- B3: definite-failure policy — stop fast, bounded retries ---
    const mkCallback = async (id: string, attemptNo: number) => {
      const payload = { kind: 'worker-result-callback', version: 1, callback_id: id, job_id: qualTask.job_id, task_id: qualTask.task_id,
        attempt: attemptNo, worker_id: 'MUSE-QUAL-WORKER', target: RT, status: 'QA', summary: 'b3', evidence: null, completed_at: new Date().toISOString() };
      const digest = digestOf(payload);
      const ins = await owner.connect();
      try {
        await ins.query('BEGIN');
        await ins.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)",
          [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
        await ins.query(`INSERT INTO agy_worker_callbacks(callback_id,tenant_id,workspace_id,project_id,job_id,task_id,attempt,worker_id,target,content_digest,payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,'MUSE-QUAL-WORKER',$8,$9,$10)`,
          [id, scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId, qualTask.job_id, qualTask.task_id, attemptNo, RT, digest, JSON.stringify(payload)]);
        await ins.query('COMMIT');
      } catch (e) { await ins.query('ROLLBACK'); throw e; } finally { ins.release(); }
    };
    const cbAuthId = randomUUID(); await mkCallback(cbAuthId, 11);
    let authCalls = 0;
    const authTransport: CallbackTransport = async () => { authCalls++; throw new CallbackDefiniteFailure('RECEIVER_AUTH_OR_ROUTE_401', true); };
    const b3a = await dispatchWorkerCallbacks(rawQ, scopeQ, authTransport, { actor: 'control-op', limit: 1, missionId: 'GL_QUALIFICATION' });
    assert.equal(authCalls, 1); assert.equal(b3a.blocked.length, 1, 'an auth block stops at the first occurrence');
    assert.equal((await q(`SELECT status,last_error FROM agy_worker_callbacks WHERE callback_id=$1`, [cbAuthId]))[0].status, 'BLOCKED');
    const drvB3 = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: Date.now() + 60_000, runId: 'run-b3', intervalMs: 60, limit: 1 }, operator: opQ, transport: authTransport, lookup: async () => ({ found: false }), log: () => {} });
    assert.equal(drvB3.start(), 'RUNNING');
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(authCalls, 1, 'a BLOCKED row is never re-sent — the driver does not poll it');
    drvB3.stop();
    const cbTrId = randomUUID(); await mkCallback(cbTrId, 12);
    let trCalls = 0;
    const trTransport: CallbackTransport = async () => { trCalls++; throw new CallbackDefiniteFailure('RECEIVER_REJECTED_400'); };
    for (let i = 0; i < 4; i++) await dispatchWorkerCallbacks(rawQ, scopeQ, trTransport, { actor: 'control-op', limit: 1, missionId: 'GL_QUALIFICATION' });
    assert.equal(trCalls, 3, 'transient definite failures: original + at most 2 retries, counter persisted across invocations');
    const trRow = (await q(`SELECT status,delivery_attempts FROM agy_worker_callbacks WHERE callback_id=$1`, [cbTrId]))[0];
    assert.equal(trRow.status, 'BLOCKED'); assert.equal(Number(trRow.delivery_attempts), 3);
    assert.equal(await releaseBlockedCallback(rawQ, scopeQ, cbTrId, { actor: 'control-op' }), true, 'owner release is the only way back from BLOCKED');
    assert.equal((await q(`SELECT status,delivery_attempts FROM agy_worker_callbacks WHERE callback_id=$1`, [cbTrId]))[0].delivery_attempts, 0);

    // ---- C1/C2 fixtures: isolated missions so the B3 rows (mission
    // GL_QUALIFICATION) cannot leak into these assertions.
    const mkTaskQ = async (jobKey: string, mission: string) => {
      await serviceQ.execute('/jobs', 'POST', { idempotency_key: jobKey, objective: 'c-fixture', pass_threshold: 0, tasks: [{ name: jobKey, idempotencyKey: `${jobKey}-t`,
        taskType: 'planning', requiredCapabilities: ['planning'], requiredPermissions: ['planning'], permissionGranted: true,
        safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 10,
        payload: { mission_id: mission, target_worker_id: 'MUSE-QUAL-WORKER', callback_target: RT } }] });
      return (await q(`SELECT t.* FROM agy_tasks t JOIN agy_jobs j USING(job_id) WHERE j.idempotency_key=$1`, [jobKey]))[0];
    };
    const mkCallbackFor = async (task: any, attemptNo: number, status = 'PENDING') => {
      const id = randomUUID();
      const payload = { kind: 'worker-result-callback', version: 1, callback_id: id, job_id: task.job_id, task_id: task.task_id,
        attempt: attemptNo, worker_id: 'MUSE-QUAL-WORKER', target: RT, status: 'QA', summary: 'c', evidence: null, completed_at: new Date().toISOString() };
      const ins = await owner.connect();
      try {
        await ins.query('BEGIN');
        await ins.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)",
          [scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId]);
        await ins.query(`INSERT INTO agy_worker_callbacks(callback_id,tenant_id,workspace_id,project_id,job_id,task_id,attempt,worker_id,target,content_digest,payload,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,'MUSE-QUAL-WORKER',$8,$9,$10,$11)`,
          [id, scopeQ.tenantId, scopeQ.workspaceId, scopeQ.projectId, task.job_id, task.task_id, attemptNo, RT, digestOf(payload), JSON.stringify(payload), status]);
        await ins.query('COMMIT');
      } catch (e) { await ins.query('ROLLBACK'); throw e; } finally { ins.release(); }
      return id;
    };
    const waitState = async (drv: { state: () => string }, want: string, ms = 4000) => {
      let st = '';
      for (let i = 0; i < ms / 50; i++) { st = drv.state(); if (st === want) break; await new Promise((r) => setTimeout(r, 50)); }
      return st;
    };

    // ---- C1a: a multi-row dispatch pass never STARTS an effect after
    // the cutoff. The first send is bounded by the REAL remaining
    // time (250 ms window vs a 350 ms transport), lands UNKNOWN, and
    // the second row is never even claimed.
    const taskC1 = await mkTaskQ('job-c1', 'GL_QUALIFICATION_C1');
    const cbC1a = await mkCallbackFor(taskC1, 21);
    const cbC1b = await mkCallbackFor(taskC1, 22);
    let c1Calls = 0;
    const slowTransport: CallbackTransport = async (intent: any) => {
      c1Calls++;
      await new Promise((r) => setTimeout(r, 350));
      return { accepted: true, idempotency_key: intent.callback_id, task_id: intent.task_id, attempt: intent.attempt, content_digest: intent.content_digest };
    };
    const c1res = await dispatchWorkerCallbacks(rawQ, scopeQ, slowTransport,
      { actor: 'control-op', limit: 2, timeoutMs: 10_000, missionId: 'GL_QUALIFICATION_C1', deadlineMs: Date.now() + 250 });
    assert.equal(c1Calls, 1, 'only the first send started; the second never began after the cutoff');
    assert.equal(c1res.expired, true);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbC1a]))[0].status, 'UNKNOWN',
      'the in-flight send was bounded by the real remaining time and classified, not delivered late');
    const cbC1bRow = (await q(`SELECT status,delivery_attempts FROM agy_worker_callbacks WHERE callback_id=$1`, [cbC1b]))[0];
    assert.equal(cbC1bRow.status, 'PENDING'); assert.equal(Number(cbC1bRow.delivery_attempts), 0, 'no intent was claimed for the second row');

    // ---- C1b: a reconcile phase that itself runs past the cutoff is
    // followed by ZERO sends and an EXPIRED driver. The slow lookup
    // returns a clean found:false — the UNKNOWN row stays UNKNOWN
    // (read-only proof recorded, never re-sent).
    let c1LookupCalls = 0, c1DriverSends = 0;
    const drvC1 = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION_C1', expiresAtMs: Date.now() + 200, runId: 'run-c1', intervalMs: 50, limit: 1, timeoutMs: 5000 }, operator: opQ,
      transport: async () => { c1DriverSends++; return { accepted: true }; },
      lookup: async () => { c1LookupCalls++; await new Promise((r) => setTimeout(r, 350)); return { found: false }; }, log: () => {} });
    assert.equal(drvC1.start(), 'RUNNING');
    assert.equal(await waitState(drvC1, 'EXPIRED'), 'EXPIRED', 'deadline re-checked after the reconcile phase: no dispatch follows');
    assert.equal(c1LookupCalls, 1);
    assert.equal(c1DriverSends, 0, 'no send effect started after the cutoff');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbC1a]))[0].status, 'UNKNOWN',
      'clean found:false leaves the row UNKNOWN — no resend, no release');
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbC1b]))[0].status, 'PENDING');

    // ---- C2a: restart with a PERSISTED blocked row (cbAuthId, mission
    // GL_QUALIFICATION, blocked in the B3 section by a previous
    // "process") — the new driver stops BLOCKED before any lookup or
    // send, instead of polling no-op passes.
    let c2RestartLookups = 0, c2RestartSends = 0;
    const drvC2 = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION', expiresAtMs: Date.now() + 60_000, runId: 'run-c2-restart', intervalMs: 50, limit: 1 }, operator: opQ,
      transport: async () => { c2RestartSends++; return { accepted: true }; },
      lookup: async () => { c2RestartLookups++; return { found: false }; }, log: () => {} });
    assert.equal(drvC2.start(), 'RUNNING');
    assert.equal(await waitState(drvC2, 'BLOCKED'), 'BLOCKED', 'persisted BLOCKED is read at tick start and stops the driver');
    assert.equal(c2RestartLookups, 0, 'no lookup call happened before the stop');
    assert.equal(c2RestartSends, 0, 'no send happened before the stop');

    // ---- C2b: a reconcile lookup auth block (401) is classified and
    // propagated: exactly ONE lookup call, the row lands BLOCKED with
    // needs_owner_repair, the driver stops BLOCKED, and the pending
    // row behind it is never sent.
    const taskC2 = await mkTaskQ('job-c2', 'GL_QUALIFICATION_C2');
    const cbC2Unknown = await mkCallbackFor(taskC2, 31, 'UNKNOWN');
    const cbC2Pending = await mkCallbackFor(taskC2, 32);
    let c2LookupCalls = 0, c2Sends = 0;
    const drvC2b = createWorkerCallbackDriver(rawQ, { config: { enabled: true, scope: scopeQ, missionId: 'GL_QUALIFICATION_C2', expiresAtMs: Date.now() + 60_000, runId: 'run-c2-lookup', intervalMs: 50, limit: 1 }, operator: opQ,
      transport: async () => { c2Sends++; return { accepted: true }; },
      lookup: async () => { c2LookupCalls++; throw new CallbackLookupBlocked('RECEIVER_LOOKUP_AUTH_401'); }, log: () => {} });
    assert.equal(drvC2b.start(), 'RUNNING');
    assert.equal(await waitState(drvC2b, 'BLOCKED'), 'BLOCKED', 'a lookup auth block stops the driver instead of looping every interval');
    assert.equal(c2LookupCalls, 1, 'the auth-blocked lookup was called exactly once in total');
    assert.equal(c2Sends, 0);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbC2Unknown]))[0].status, 'BLOCKED',
      'the UNKNOWN row left the reconcile loop into BLOCKED (needs_owner_repair)');
    const cbC2PendingRow = (await q(`SELECT status,delivery_attempts FROM agy_worker_callbacks WHERE callback_id=$1`, [cbC2Pending]))[0];
    assert.equal(cbC2PendingRow.status, 'PENDING'); assert.equal(Number(cbC2PendingRow.delivery_attempts), 0);
    // The in-process guard denial classifies the same way (direct
    // reconcile): ACTION_DENIED is a config block, not lookup_failed.
    const cbC2Denied = await mkCallbackFor(taskC2, 33, 'UNKNOWN');
    const recDenied = await reconcileWorkerCallbacks(rawQ, scopeQ, async () => { throw new Error('ACTION_DENIED'); },
      { actor: 'control-op', limit: 1, missionId: 'GL_QUALIFICATION_C2' });
    assert.equal(recDenied.blocked.length, 1, 'ACTION_DENIED propagates as blocked/needs_owner_repair');
    assert.equal(recDenied.lookup_failed, 0);
    assert.equal((await q(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1`, [cbC2Denied]))[0].status, 'BLOCKED');

  } finally {
    if (cbServer) await new Promise((r) => cbServer.close(r));
    if (runtime) await runtime.end();
    await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  }
});
