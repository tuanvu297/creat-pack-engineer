// Security/negative integration proofs for the hardened
// helper-queue boundary (peer-QA round, 2026-11-03). Real local
// PostgreSQL. Covers what the first queue test did not: spec
// money fences, lease-expiry and current-parent fences on
// begin/record/verify, exact-ref and submission-state checks at
// result verification, explicit result-type rejection, and
// binding durability across a fresh pool ("restart").
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
import { createDelegatedChild, beginHelperSubmission, recordHelperSubmission, verifyHelperResult, loadSubmissionBinding, readVerifiedHelperResult } from "../src/platform/helper-queue.js";
import { childKey, type HelperAssignment } from "../src/platform/helper-delegation.js";
import { digestOf } from "../src/platform/digest.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const other: Principal = { subject: 'other-worker', role: 'worker', scopes: [scope], workerId: 'OTHER-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const SPEC = { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'] };

test("helper queue security: spec fences, lease/parent fences, exact-ref result verification, restart durability",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 180000 }, async () => {
  const schema = `agy_hqs_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_hqs_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
    const parentClaim = await surface(gemini, scope, 'claim', {});
    assert.equal(parentClaim.status, 'LEASED');
    const parentId = parentClaim.task.taskId;
    const assignment = (over: Partial<HelperAssignment> = {}): HelperAssignment => ({
      parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: parentId, parentAttempt: 1,
      subtaskKey: 'sec-1', helperId: 'grok', scope: { ...scope },
      sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
      budget: { unit: 'provider_credits', cap: 5, spent: 0, enforcement: 'runtime', hard: true }, actualCostBounded: true,
      expiresAtMs: Date.now() + 600_000, replyTarget: RT, ...over });

    // --- SPEC money fences: nothing is written on rejection.
    const aSpec = assignment({ subtaskKey: 'sec-spec' });
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, aSpec, { ...SPEC, estimatedQuota: -1 }), /SPEC_INVALID/);
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, aSpec, { ...SPEC, estimatedCost: Number.NaN }), /SPEC_INVALID/);
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, aSpec, { ...SPEC, estimatedCost: Infinity }), /SPEC_INVALID/);
    await assert.rejects(() => loadSubmissionBinding(rt, scope, aSpec), /CHILD_NOT_FOUND/, 'rejected specs created no child');

    // --- Happy child, claimed.
    const a1 = assignment();
    const c1 = await createDelegatedChild(rt, scope, gemini, op, a1, SPEC);
    const childClaim = await surface(gemini, scope, 'claim', {});
    assert.equal(childClaim.task.taskId, c1.childTaskId);
    const lt = childClaim.task.leaseToken; const att = childClaim.task.attempt;

    // --- Record before begin is denied; begin twice fences.
    await assert.rejects(() => recordHelperSubmission(rt, scope, gemini, c1.childTaskId, lt, att, 'ref-x'), /SUBMISSION_RECORD_DENIED/);
    assert.equal((await beginHelperSubmission(rt, scope, gemini, c1.childTaskId, lt, att)).state, 'NEW');

    // --- Verify while IN_FLIGHT (not yet SUBMITTED) is denied.
    const payload = { findings: ['x'] };
    const envFor = (ref: string) => ({ childKey: childKey(a1), helperId: 'grok' as const, externalRef: ref,
      digest: digestOf(payload), payload, costUnits: 1 });
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, envFor('grok-ref-1') as any), /SUBMISSION_STATE_MISMATCH/);
    await recordHelperSubmission(rt, scope, gemini, c1.childTaskId, lt, att, 'grok-ref-1');

    // --- Exact-ref + type + cost fences at verification.
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, envFor('grok-ref-OTHER') as any), /RESULT_REF_MISMATCH/);
    await assert.rejects(() => verifyHelperResult(rt, scope, other, a1, envFor('grok-ref-1') as any), /PARENT_MISMATCH/);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, { ...envFor('grok-ref-1'), costUnits: -1 } as any), /RESULT_COST_INVALID/);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, { ...envFor('grok-ref-1'), costUnits: 'one' } as any), /RESULT_COST_INVALID/);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, { ...envFor('grok-ref-1'), costUnits: Infinity } as any), /RESULT_COST_INVALID/);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, { ...envFor('grok-ref-1'), payload: undefined } as any), /RESULT_PAYLOAD_INVALID/);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, { ...envFor('grok-ref-1'), digest: 42 } as any), /RESULT_TYPE_INVALID/);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, { ...envFor('grok-ref-1'), helperId: 'evil' } as any), /RESULT_TYPE_INVALID/);
    // NaN cost (unknown actuals) is the sanctioned pass-through.
    assert.deepEqual(await verifyHelperResult(rt, scope, gemini, a1, { ...envFor('grok-ref-1'), costUnits: Number.NaN } as any), { verified: true });

    // --- The composed boundary: binding from the queue, reader sees only the persisted ref.
    let seenRef = '';
    const reader = { async readResultFor(_a: HelperAssignment, ref: string) { seenRef = ref; return envFor(ref); } };
    const env = await readVerifiedHelperResult(rt, scope, gemini, a1, reader as any);
    assert.equal(seenRef, 'grok-ref-1');
    assert.equal(env.externalRef, 'grok-ref-1');

    // --- F1: a finite actual over the budget's remaining room is denied.
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, { ...envFor('grok-ref-1'), costUnits: 99 } as any), /RESULT_COST_EXCEEDS_BUDGET/);
    // --- F4: a spec priced above the assignment cap is denied up front.
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, assignment({ subtaskKey: 'sec-spec2' }), { ...SPEC, estimatedCost: 99 }), /SPEC_EXCEEDS_BUDGET/);
    // --- F3: same childKey, drifted reply target -> the pre-existing child is NOT silently returned.
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, assignment({ replyTarget: 'SOMEWHERE_ELSE' }), SPEC), /CHILD_BINDING_MISMATCH/);
    // --- F2: role check + empty-ref wedge, on a second child.
    const a2 = assignment({ subtaskKey: 'sec-2' });
    const c2 = await createDelegatedChild(rt, scope, gemini, op, a2, SPEC);
    const claim2 = await surface(gemini, scope, 'claim', {});
    assert.equal(claim2.task.taskId, c2.childTaskId);
    await assert.rejects(() => beginHelperSubmission(rt, scope, op, c2.childTaskId, claim2.task.leaseToken, claim2.task.attempt), /PARENT_REQUIRED/);
    assert.equal((await beginHelperSubmission(rt, scope, gemini, c2.childTaskId, claim2.task.leaseToken, claim2.task.attempt)).state, 'NEW');
    await assert.rejects(() => recordHelperSubmission(rt, scope, gemini, c2.childTaskId, claim2.task.leaseToken, claim2.task.attempt, ''), /SUBMISSION_REF_INVALID/);
    await recordHelperSubmission(rt, scope, gemini, c2.childTaskId, claim2.task.leaseToken, claim2.task.attempt, 'grok-ref-2');

    // --- Restart durability: a fresh pool loads the same binding.
    const runtime2 = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
    const binding = await loadSubmissionBinding(runtime2, scope, a1);
    assert.equal(binding.submissionRef, 'grok-ref-1');
    await runtime2.end();

    // --- Parent superseded: attempt bump denies verify AND begin.
    await ownerScoped(`UPDATE agy_tasks SET attempt=2 WHERE task_id=$1`, [parentId]);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, envFor('grok-ref-1') as any), /PARENT_ATTEMPT_MISMATCH/);
    await assert.rejects(() => beginHelperSubmission(rt, scope, gemini, c1.childTaskId, lt, att), /PARENT_ATTEMPT_MISMATCH/);
    await ownerScoped(`UPDATE agy_tasks SET attempt=1 WHERE task_id=$1`, [parentId]);

    // --- Lease-expiry fences.
    await ownerScoped(`UPDATE agy_tasks SET lease_expires_at=now()-interval '1 minute' WHERE task_id=$1`, [parentId]);
    await assert.rejects(() => verifyHelperResult(rt, scope, gemini, a1, envFor('grok-ref-1') as any), /PARENT_LEASE_EXPIRED/);
    await ownerScoped(`UPDATE agy_tasks SET lease_expires_at=now()+interval '30 minutes' WHERE task_id=$1`, [parentId]);
    await ownerScoped(`UPDATE agy_tasks SET lease_expires_at=now()-interval '1 minute' WHERE task_id=$1`, [c1.childTaskId]);
    await assert.rejects(() => beginHelperSubmission(rt, scope, gemini, c1.childTaskId, lt, att), /LEASE_EXPIRED/);
    await ownerScoped(`UPDATE agy_tasks SET lease_expires_at=now()+interval '30 minutes' WHERE task_id=$1`, [c1.childTaskId]);
    assert.deepEqual(await verifyHelperResult(rt, scope, gemini, a1, envFor('grok-ref-1') as any), { verified: true }, 'state restored: verification passes again');
  } finally {
    if (runtime) await runtime.end().catch(() => {});
    await owner.end().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
