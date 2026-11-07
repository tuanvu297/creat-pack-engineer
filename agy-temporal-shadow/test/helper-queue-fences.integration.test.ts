// Fence-atomicity + durability regressions for the 2026-11-04
// helper-contract completion (W1/W2/W3/W5): the parent fence
// inside the creation transaction, begin/record as locked
// transactions, the equipment binding, durable recorded
// results, and one held-out end-to-end transfer through a
// MOCK Manus adapter (injected fetch - no provider contact).
// Real local PostgreSQL, real queue/service/surface code.
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
import { createDelegatedChild, beginHelperSubmission, recordHelperSubmission, verifyHelperResult,
  readVerifiedHelperResult, recordHelperResult, loadRecordedHelperResult } from "../src/platform/helper-queue.js";
import { childKey, type HelperAssignment } from "../src/platform/helper-delegation.js";
import { manusAdapter, assertAdapterMatchesAssignment, type FetchLike } from "../src/platform/helper-providers.js";
import { digestOf } from "../src/platform/digest.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const SPEC = { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'] };
const EQ = { pinnedSource: { ref: 'doc:fixture-input', digest: 'a'.repeat(64) },
  surface: { kind: 'api', model: 'manus-api-v2', authBinding: 'manus:x-manus-api-key' },
  skillRef: 'skill:fixture', criteria: ['output addresses the pinned source'], rework: { maxAttempts: 1 } };

test("helper fences: creation fence, locked begin/record, equipment binding, durable result, held-out transfer",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 180000 }, async () => {
  const schema = `agy_hf_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_hf_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
    const q = async (sql: string, args: any[] = []) => (await owner.query(sql, args)).rows;
    const ownerScoped = async (sql: string, params: unknown[]) => {
      const c = await owner.connect();
      try { await c.query('BEGIN');
        await c.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
        const r = await c.query(sql, params as any); await c.query('COMMIT'); return r;
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    };
    const qu = async (sql: string, args: any[] = []) => (await ownerScoped(sql, args)).rows;
    const parentClaim = await surface(gemini, scope, 'claim', {});
    assert.equal(parentClaim.status, 'LEASED');
    const parentId = parentClaim.task.taskId;
    const parentLease = parentClaim.task.leaseToken;

    const assignment = (over: Partial<HelperAssignment> = {}): HelperAssignment => ({
      parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: parentId, parentAttempt: 1,
      subtaskKey: 'xfer-1', helperId: 'manus', scope: { ...scope },
      sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
      budget: { unit: 'provider_credits', cap: 100, spent: 0, enforcement: 'prompt_only', hard: false },
      expiresAtMs: Date.now() + 600_000, replyTarget: RT, equipment: EQ, ...over });
    const specL = { ...SPEC, parentLeaseToken: parentLease };

    // ---- W3: equipment is binding identity.
    const a1 = assignment();
    const c1 = await createDelegatedChild(rt, scope, gemini, op, a1, specL);
    assert.equal(c1.created, true);
    const drifted = assignment({ equipment: { ...EQ, criteria: ['a different promise'] } });
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, drifted, specL), /CHILD_BINDING_MISMATCH/,
      'same key, different equipment = a different child, denied');

    // ---- W2: begin race - exactly one NEW under concurrency.
    const claim1 = await surface(gemini, scope, 'claim', {});
    assert.equal(claim1.status, 'LEASED');
    const childId = claim1.task.taskId; const lt = claim1.task.leaseToken; const att = claim1.task.attempt;
    assert.equal(childId, c1.childTaskId);
    const [b1, b2] = await Promise.all([
      beginHelperSubmission(rt, scope, gemini, childId, lt, att),
      beginHelperSubmission(rt, scope, gemini, childId, lt, att)]);
    assert.deepEqual([b1.state, b2.state].sort(), ['IN_FLIGHT', 'NEW'], 'exactly one begin wins');

    // ---- Held-out transfer: mock Manus adapter end to end.
    const fetchMock: FetchLike = async (url) => {
      if (url.includes('/v2/task.create')) return { status: 200, json: async () => ({ ok: true, task_id: 'heldout1' }) };
      if (url.includes('task.detail')) return { status: 200, json: async () => ({ ok: true, task: { id: 'heldout1', status: 'stopped', credit_usage: 15 } }) };
      return { status: 200, json: async () => ({ ok: true, task_id: 'heldout1', messages: [{ type: 'assistant_message', content: [{ type: 'text', text: 'held-out answer' }] }], has_more: false }) };
    };
    const adapter = manusAdapter({ apiKey: 'mock-key', fetch: fetchMock });
    assert.doesNotThrow(() => assertAdapterMatchesAssignment(a1, adapter), 'pinned surface matches the adapter descriptor');
    const sub = await adapter.submit(a1, { text: 'extract from the pinned source' });
    assert.equal(sub.externalRef, 'heldout1');
    await recordHelperSubmission(rt, scope, gemini, childId, lt, att, sub.externalRef);
    await assert.rejects(() => recordHelperSubmission(rt, scope, gemini, childId, lt, att, 'heldout2'), /SUBMISSION_RECORD_DENIED/,
      'a second, different submission under the same begin is denied');
    const env = await readVerifiedHelperResult(rt, scope, gemini, a1, adapter);
    assert.equal(env.costUnits, 15);
    assert.equal((env.payload as any).text, 'held-out answer');

    // ---- W5: the verified result is durable in the queue.
    assert.deepEqual(await recordHelperResult(rt, scope, gemini, a1, env, lt, att), { recorded: true, alreadyRecorded: false });
    assert.deepEqual(await recordHelperResult(rt, scope, gemini, a1, env, lt, att), { recorded: false, alreadyRecorded: true },
      're-recording the same result reconciles, never duplicates');
    const runtime2 = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
    const back = await loadRecordedHelperResult(runtime2, scope, a1);
    assert.ok(back, 'recorded result read back from a fresh pool');
    assert.equal(back!.digest, env.digest); assert.equal(back!.externalRef, 'heldout1'); assert.equal(back!.costUnits, 15);
    assert.equal((back!.payload as any).text, 'held-out answer', 'result survives the verifying process - it lives in the queue');
    const stored = (await qu(`SELECT payload FROM agy_tasks WHERE task_id=$1`, [childId]))[0].payload.submission_result;
    assert.equal(stored.childAttempt, att);
    assert.equal(stored.costKnown, true);
    assert.equal(stored.costUnits, 15);
    await runtime2.end();
    const otherPayload = { text: 'a different answer' };
    const otherEnv = { ...env, payload: otherPayload, digest: digestOf(otherPayload) };
    await assert.rejects(() => recordHelperResult(rt, scope, gemini, a1, otherEnv as any, lt, att), /RESULT_ALREADY_RECORDED/,
      'a different result for the recorded submission is denied, never overwritten');

    // A result that cannot meter its actual cost remains UNKNOWN after
    // JSONB persistence. A stale child lease cannot write it.
    const unknownAssignment = assignment({ subtaskKey: 'unknown-cost' });
    const unknownChild = await createDelegatedChild(rt, scope, gemini, op, unknownAssignment, specL);
    const unknownClaim = await surface(gemini, scope, 'claim', {});
    assert.equal(unknownClaim.task.taskId, unknownChild.childTaskId);
    await beginHelperSubmission(rt, scope, gemini, unknownChild.childTaskId,
      unknownClaim.task.leaseToken, unknownClaim.task.attempt);
    await recordHelperSubmission(rt, scope, gemini, unknownChild.childTaskId,
      unknownClaim.task.leaseToken, unknownClaim.task.attempt, 'unknown-ref');
    const unknownPayload = { text: 'unmetered answer' };
    const unknownEnv = { childKey: childKey(unknownAssignment), helperId: 'manus' as const,
      externalRef: 'unknown-ref', payload: unknownPayload, digest: digestOf(unknownPayload),
      costUnits: Number.NaN };
    await assert.rejects(() => recordHelperResult(rt, scope, gemini, unknownAssignment,
      unknownEnv, 'wrong-child-lease', unknownClaim.task.attempt), /CHILD_LEASE_DENIED/);
    assert.deepEqual(await recordHelperResult(rt, scope, gemini, unknownAssignment, unknownEnv,
      unknownClaim.task.leaseToken, unknownClaim.task.attempt), { recorded: true, alreadyRecorded: false });
    const unknownStored = (await qu(`SELECT payload FROM agy_tasks WHERE task_id=$1`,
      [unknownChild.childTaskId]))[0].payload.submission_result;
    assert.equal(unknownStored.costKnown, false); assert.equal(unknownStored.costUnits, null);
    const unknownBack = await loadRecordedHelperResult(rt, scope, unknownAssignment);
    assert.ok(unknownBack && Number.isNaN(unknownBack.costUnits), 'UNKNOWN remains UNKNOWN after JSONB round trip');

    // ---- W2: a parent attempt roll kills begin/record under the dead attempt.
    const a2 = assignment({ subtaskKey: 'xfer-2' });
    const c2 = await createDelegatedChild(rt, scope, gemini, op, a2, specL);
    const claim2 = await surface(gemini, scope, 'claim', {});
    assert.equal(claim2.task.taskId, c2.childTaskId);
    await qu(`UPDATE agy_tasks SET attempt=attempt+1 WHERE task_id=$1`, [parentId]);
    await assert.rejects(() => beginHelperSubmission(rt, scope, gemini, c2.childTaskId, claim2.task.leaseToken, claim2.task.attempt),
      /PARENT_ATTEMPT_MISMATCH/, 'begin under a superseded parent attempt is denied inside the locked tx');
    await qu(`UPDATE agy_tasks SET attempt=attempt-1 WHERE task_id=$1`, [parentId]);

    // ---- W1: expired parent lease -> creation denied AND no child written.
    await qu(`UPDATE agy_tasks SET lease_expires_at=now()-interval '1 minute' WHERE task_id=$1`, [parentId]);
    const a3 = assignment({ subtaskKey: 'xfer-3' });
    await assert.rejects(() => createDelegatedChild(rt, scope, gemini, op, a3, specL), /PARENT_LEASE_EXPIRED/);
    assert.equal((await q(`SELECT count(*)::int n FROM agy_jobs WHERE idempotency_key=$1`, [childKey(a3)]))[0].n, 0,
      'no child exists for the denied creation - fence and create are one atomic unit');
    // verifyHelperResult still honest on the happy-path child under the restored lease.
    await qu(`UPDATE agy_tasks SET lease_expires_at=now()+interval '10 minutes' WHERE task_id=$1`, [parentId]);
    assert.deepEqual(await verifyHelperResult(rt, scope, gemini, a1, env as any), { verified: true });
  } finally {
    await runtime?.end().catch(() => {}); await owner.end().catch(() => {}); await admin.end().catch(() => {});
  }
});


