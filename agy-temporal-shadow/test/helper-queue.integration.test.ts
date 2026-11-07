// Integration regressions for the delegation QUEUE binding
// (D-057, 2026-11-03). Real local PostgreSQL, real
// ProjectService / PostgresStore / worker-surface / helper-queue
// code. Proves what the pure contract cannot: authenticated
// parent verification against the persisted row, unique child
// identity under retry and concurrency, the queue's own
// transactional reservation on child claim, the submission
// fence, and result verification (identity + digest + immutable
// persisted binding).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ProjectPool } from "../src/platform/scoped-pool.js";
import { ProjectService } from "../src/platform/service.js";
import { ResourceStore } from "../src/resource-store.js";
import { discoverResource } from "../src/resources/discovery.js";
import { createWorkerSurface } from "../src/platform/worker-surface.js";
import { createDelegatedChild, beginHelperSubmission, recordHelperSubmission, verifyHelperResult } from "../src/platform/helper-queue.js";
import { childKey, type HelperAssignment } from "../src/platform/helper-delegation.js";
import { digestOf } from "../src/platform/digest.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const other: Principal = { subject: 'other-worker', role: 'worker', scopes: [scope], workerId: 'OTHER-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const SPEC = { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'] };

test("helper queue: parent verification, unique child, reservation, submission fence, result verification",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 180000 }, async () => {
  const schema = `agy_hq_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_hq_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const owner = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  let runtime: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','012_worker_callbacks.sql','013_reservation_accounting_closure.sql'])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    const seed = await owner.connect();
    try { await seed.query('BEGIN');
      await seed.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query("INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'Gemini staging','repo:gl','policy:gl') ON CONFLICT DO NOTHING", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query("INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES($1,$2,$3,'gemini-x','gemini',ARRAY['text'],'local','vault:test',true,ARRAY['read'])", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query('COMMIT');
    } catch (e) { await seed.query('ROLLBACK'); throw e; } finally { seed.release(); }
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
    await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    runtime = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
    const rt: Pool = runtime;
    const scopedSetup = new ProjectPool(runtime, scope, 'setup').asPool();
    await scopedSetup.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read'],resource_policy='{"maxConcurrentTasks":4,"quotaCap":100,"spendCap":0,"reservation":1}'`);
    const resources = new ResourceStore(owner);
    const profile = { ...discoverResource('GEMINI-SEO-WORKER', ['text'], Date.now()),
      status: 'READY' as const, ready: true, quotaRemaining: 10, quotaReserve: 0, maxConcurrency: 4,
      passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0, costPerTask: 0, spendCap: 0, quotaCap: 10,
      permissions: ['read'] };
    await resources.register(profile as any, 'gemini');
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='GEMINI-SEO-WORKER'`,
      [JSON.stringify({ bindings: { missions: ['GEMINI_UI_STAGING'], task_types: ['hello', 'helper_delegation'], reply_targets: [RT] } })]);

    const service = new ProjectService(runtime, scope, op);
    await service.execute('/jobs', 'POST', { idempotency_key: 'job-parent', objective: 'parent',
      tasks: [{ name: 'parent', idempotencyKey: 'job-parent-t', taskType: 'hello', requiredCapabilities: ['text'], requiredPermissions: ['read'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 10,
        payload: { mission_id: 'GEMINI_UI_STAGING', target_worker_id: 'GEMINI-SEO-WORKER', callback_target: RT } }] });
    const surface = createWorkerSurface(runtime);
    const ownerScoped = async (sql: string, params: unknown[]) => {
      const c = await owner.connect();
      try { await c.query('BEGIN');
        await c.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
        const r = await c.query(sql, params as any); await c.query('COMMIT'); return r;
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };
    const q = async (sql: string, args: any[] = []) => (await owner.query(sql, args)).rows;
    const parentClaim = await surface(gemini, scope, 'claim', {});
    assert.equal(parentClaim.status, 'LEASED', 'parent task leased');
    const parentId = parentClaim.task.taskId;

    const assignment = (over: Partial<HelperAssignment> = {}): HelperAssignment => ({
      parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: parentId, parentAttempt: 1,
      subtaskKey: 'extract-1', helperId: 'grok', scope: { ...scope },
      sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
      budget: { unit: 'provider_credits', cap: 5, spent: 0, enforcement: 'runtime', hard: true }, actualCostBounded: true,
      expiresAtMs: Date.now() + 600_000, replyTarget: RT,
      equipment: { pinnedSource: { ref: 'doc:fixture-input', digest: 'a'.repeat(64) },
    surface: { kind: 'api', model: 'fixture-model', authBinding: 'fixture:binding' },
    skillRef: 'skill:fixture', criteria: ['output addresses the pinned source'], rework: { maxAttempts: 1 } }, ...over });

    // Happy path + idempotent re-create.
    const a1 = assignment();
    const c1 = await createDelegatedChild(rt, scope, gemini, op, a1, SPEC);
    assert.equal(c1.created, true);
    const c2 = await createDelegatedChild(rt, scope, gemini, op, a1, SPEC);
    assert.equal(c2.created, false, 're-create reconciles to the same child');
    assert.equal(c2.childTaskId, c1.childTaskId);
    assert.equal((await q(`SELECT count(*)::int n FROM agy_jobs WHERE idempotency_key=$1`, [childKey(a1)]))[0].n, 1, 'exactly one child job');

    // Concurrency: two simultaneous creates of a fresh subtask.
    const aConc = assignment({ subtaskKey: 'extract-concurrent' });
    const [r1, r2] = await Promise.all([
      createDelegatedChild(rt, scope, gemini, op, aConc, SPEC),
      createDelegatedChild(rt, scope, gemini, op, aConc, SPEC)]);
    assert.equal(r1.childTaskId, r2.childTaskId, 'concurrent creates converge on one child');
    assert.equal((await q(`SELECT count(*)::int n FROM agy_jobs WHERE idempotency_key=$1`, [childKey(aConc)]))[0].n, 1);

    // Negative: wrong authenticated parent.
    await assert.rejects(() => createDelegatedChild(rt, scope, other, op, a1, SPEC), /PARENT_MISMATCH/);
    // Negative: assignment naming a parent the caller does not own.
    await assert.rejects(() => createDelegatedChild(rt, scope, other, op, assignment({ parentWorkerId: 'OTHER-WORKER' }), SPEC), /PARENT_NOT_OWNER/);
    // Negative: stale attempt.
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, assignment({ parentAttempt: 2, subtaskKey: 'extract-2' }), SPEC), /PARENT_ATTEMPT_MISMATCH/);
    // Negative: cross-scope.
    await assert.rejects(() => createDelegatedChild(rt, { ...scope, projectId: 'OTHER' }, gemini, op, a1, SPEC), /CROSS_SCOPE/);
    // Negative: expired assignment.
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, assignment({ subtaskKey: 'extract-3', expiresAtMs: Date.now() - 1 }), SPEC), /ASSIGNMENT_DENIED/);

    // The child claims through the normal path: transactional reservation.
    const childClaim = await surface(gemini, scope, 'claim', {});
    assert.equal(childClaim.status, 'LEASED');
    const childId = childClaim.task.taskId;
    const held = await q(`SELECT state FROM agy_resource_reservations WHERE task_id=$1`, [childId]);
    assert.equal(held.length, 1, 'one reservation for the child');
    assert.equal(held[0].state, 'HELD', 'reservation held transactionally by the claim');

    // Submission fence.
    const lt = childClaim.task.leaseToken; const att = childClaim.task.attempt;
    assert.equal((await beginHelperSubmission(rt, scope, gemini, childId, lt, att)).state, 'NEW');
    assert.equal((await beginHelperSubmission(rt, scope, gemini, childId, lt, att)).state, 'IN_FLIGHT');
    await recordHelperSubmission(rt, scope, gemini, childId, lt, att, 'grok-ref-1');
    const after = await beginHelperSubmission(rt, scope, gemini, childId, lt, att);
    assert.equal(after.state, 'SUBMITTED'); assert.equal(after.externalRef, 'grok-ref-1');
    await assert.rejects(() => recordHelperSubmission(rt, scope, gemini, childId, lt, att, 'grok-ref-2'), /SUBMISSION_RECORD_DENIED/);
    // Durability across a "restart": a fresh pool sees the same state.
    const runtime2 = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
    const afterRestart = await beginHelperSubmission(runtime2, scope, gemini, childId, lt, att);
    assert.equal(afterRestart.state, 'SUBMITTED', 'submission state survives restart (durable in the queue)');
    await runtime2.end();

    // Result verification: identity + digest + persisted binding.
    const payload = { findings: ['a', 'b'] };
    const aChild = childId === c1.childTaskId ? a1 : aConc;
    const env = { childKey: childKey(aChild), helperId: aChild.helperId, externalRef: 'grok-ref-1', digest: digestOf(payload), payload, costUnits: 1 };
    assert.deepEqual(await verifyHelperResult(rt, scope, gemini, aChild, env as any), { verified: true });
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, aChild, { ...env, digest: 'deadbeef' } as any), /RESULT_DIGEST_MISMATCH/);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, aChild, { ...env, childKey: 'helper:grok:nope:1:x' } as any), /RESULT_CHILD_MISMATCH/);

    // Negative: expired parent lease (age the second parent claim's lease).
    await service.execute('/jobs', 'POST', { idempotency_key: 'job-parent2', objective: 'parent2',
      tasks: [{ name: 'parent2', idempotencyKey: 'job-parent2-t', taskType: 'hello', requiredCapabilities: ['text'], requiredPermissions: ['read'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 5,
        payload: { mission_id: 'GEMINI_UI_STAGING', target_worker_id: 'GEMINI-SEO-WORKER', callback_target: RT } }] });
    const p2 = await surface(gemini, scope, 'claim', {});
    assert.equal(p2.status, 'LEASED');
    await ownerScoped(`UPDATE agy_tasks SET lease_expires_at=now()-interval '1 minute' WHERE task_id=$1`, [p2.task.taskId]);
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op,
      assignment({ parentTaskId: p2.task.taskId, subtaskKey: 'extract-late' }), SPEC), /PARENT_LEASE_EXPIRED/);
  } finally {
    if (runtime) await runtime.end().catch(() => {});
    await owner.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await owner.end().catch(() => {}); await admin.end().catch(() => {});
  }
});
