// Lane self-requeue (root QA 2026-11-06 round 4): a helper
// child whose provider submission failed RETRYABLE must be
// claimable again by its parent worker WITHOUT any operator
// clearing the allocator's failed_workers exclusion by hand.
// The lane reconciles on its health cycle (the dispatcher
// calls health before every tick) and clears THIS worker's
// exclusion only under the full fence: durable
// FAILED_RETRYABLE receipt for the child's current (terminal)
// attempt, child back in RETRY with no live lease, and the
// persisted binding verifying against the job idempotency
// key. IN_FLIGHT (uncertain) and FAILED_TERMINAL children
// are never requeued, and a tampered binding is skipped.
// Real local PostgreSQL, scripted fake adapters - no
// provider contact. Time passing (lease expiry, the 30s
// LEASE_EXPIRED health backoff lapsing) is simulated by
// moving timestamps, exactly as the platform suites do; the
// requeue action itself is performed ONLY by the lane.
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
import { createDelegatedChild, loadRecordedHelperResult } from "../src/platform/helper-queue.js";
import { requeueRetryableHelperChildren, withHelperDelegation } from "../src/platform/helper-lane.js";
import { ProviderCallError } from "../src/platform/helper-providers.js";
import { childKey, type HelperAdapter, type HelperAssignment } from "../src/platform/helper-delegation.js";
import { digestOf } from "../src/platform/digest.js";
import type { ClaimedTask, WorkerAdapter } from "../src/types.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const EQ = { pinnedSource: { ref: 'doc:fixture-input', digest: 'a'.repeat(64) },
  surface: { kind: 'api', model: 'manus-api-v2', authBinding: 'manus:x-manus-api-key' },
  skillRef: 'skill:fixture', criteria: ['output addresses the pinned source'], rework: { maxAttempts: 1 } };
const WORKER = 'GEMINI-SEO-WORKER';

const coded = (kind: 'INVALID' | 'RATE_LIMITED' | 'SUBMISSION_UNCERTAIN') =>
  new ProviderCallError(kind, kind === 'SUBMISSION_UNCERTAIN'
    ? 'manus /v2/task.create: network failure on a mutating call - reconcile, never resubmit'
    : 'provider answered with an error envelope');

function fakeAdapter(submitImpl: (a: HelperAssignment) => Promise<{ externalRef: string }>) {
  const state = { submitCalls: 0, lastAssignment: null as HelperAssignment | null };
  const adapter: HelperAdapter = {
    helperId: 'manus', surface: 'api', bound: true,
    descriptor: { model: 'manus-api-v2', authBinding: 'manus:x-manus-api-key' },
    submit: async (a) => { state.submitCalls++; state.lastAssignment = a; return submitImpl(a); },
    readResult: async (ref) => {
      const a = state.lastAssignment!;
      const payload = { text: 'requeue answer' };
      return { childKey: childKey(a), helperId: 'manus' as const, externalRef: ref,
        digest: digestOf(payload), payload, costUnits: 15 };
    },
  };
  return { adapter, state };
}

test("helper lane requeue: retryable child retries automatically after restart + lease expiry; uncertain/terminal/tampered never requeued",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 300000 }, async () => {
  const schema = `agy_hrq_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_hrq_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
    await scopedSetup.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read'],resource_policy='{"maxConcurrentTasks":8,"quotaCap":100,"spendCap":0,"reservation":1}'`);
    const resources = new ResourceStore(owner);
    const profile = { ...discoverResource(WORKER, ['text'], Date.now()),
      status: 'READY' as const, ready: true, quotaRemaining: 10, quotaReserve: 0, maxConcurrency: 8,
      passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0, costPerTask: 0, spendCap: 0, quotaCap: 10,
      permissions: ['read'] };
    await resources.register(profile as any, 'gemini');
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id=$2`,
      [JSON.stringify({ bindings: { missions: ['GEMINI_UI_STAGING'], task_types: ['hello', 'helper_delegation'], reply_targets: [RT] } }), WORKER]);
    const service = new ProjectService(runtime, scope, op);
    await service.execute('/jobs', 'POST', { idempotency_key: 'job-parent', objective: 'parent',
      tasks: [{ name: 'parent', idempotencyKey: 'job-parent-t', taskType: 'hello', requiredCapabilities: ['text'], requiredPermissions: ['read'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 10,
        payload: { mission_id: 'GEMINI_UI_STAGING', target_worker_id: WORKER, callback_target: RT } }] });
    const surface = createWorkerSurface(runtime);
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

    const assignmentFor = (subtaskKey: string): HelperAssignment => ({
      parentWorkerId: WORKER, parentTaskId: parentId, parentAttempt: 1,
      subtaskKey, helperId: 'manus', scope: { ...scope },
      sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
      budget: { unit: 'provider_credits', cap: 100, spent: 0, enforcement: 'prompt_only', hard: false },
      expiresAtMs: Date.now() + 600_000, replyTarget: RT, equipment: EQ });

    const inner: WorkerAdapter = {
      name: 'gemini-x', capabilities: ['text'],
      execute: async () => { throw new Error('connector must not see helper tasks'); },
      check_status: async () => ({ state: 'SUCCEEDED' }),
      collect_result: async () => ({ state: 'SUCCEEDED', output: { inner: true } }),
      cancel: async () => {},
      health: async () => ({ ready: true }),
    };
    const newLane = (adapter: HelperAdapter) =>
      withHelperDelegation(inner, { pool: rt, scope, parent: gemini, adapterFor: () => adapter });

    const mkClaimedChild = async (subtaskKey: string) => {
      const a = assignmentFor(subtaskKey);
      const child = await createDelegatedChild(rt, scope, gemini, op, a,
        { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'], parentLeaseToken: parentLease,
          input: { text: 'extract from the pinned source' } });
      const c = await surface(gemini, scope, 'claim', {});
      assert.equal(c.status, 'LEASED');
      assert.equal(c.task.taskId, child.childTaskId);
      return { childTaskId: child.childTaskId,
        claimed: { ...c.task, status: 'CLAIMED', leaseExpiresAt: new Date(Date.now() + 600_000) } as unknown as ClaimedTask };
    };
    const rowOf = async (childTaskId: string) =>
      (await qu(`SELECT status, attempt, claimed_by, failed_workers, payload FROM agy_tasks WHERE task_id=$1`, [childTaskId]))[0];
    // Lease expiry + the queue's reclaim, then the 30s
    // LEASE_EXPIRED health backoff lapsing (time passage
    // only). NOTE: reclaim runs exactly ONCE, while the
    // worker is still inside its cooldown - the window in
    // which the allocator's own substitution logic preserves
    // the exclusion. Nothing after this point touches
    // failed_workers except the lane.
    const expireAndReclaim = async (childTaskId: string) => {
      await qu(`UPDATE agy_tasks SET lease_expires_at=now()-interval '1 minute' WHERE task_id=$1`, [childTaskId]);
      await service.store.reclaimExpired();
      await qu(`UPDATE agy_project_worker_health SET blocked_until=now()-interval '1 second' WHERE worker_id=$1`, [WORKER]);
    };
    const claimAttempt = async () => surface(gemini, scope, 'claim', {});
    const assertNotLeased = async (childTaskId: string) => {
      const c: any = await claimAttempt();
      assert.ok(!(c.status === 'LEASED' && c.task?.taskId === childTaskId),
        'the excluded worker must not re-claim this child');
    };

    // ---- A. RETRYABLE: rate-limited once, then the worker
    // "dies" (lease expiry + reclaim) and a RESTARTED lane
    // requeues the child on its health cycle - no operator
    // action anywhere - and the retry completes.
    {
      let calls = 0;
      const { adapter, state } = fakeAdapter(async () => {
        calls++;
        if (calls === 1) throw coded('RATE_LIMITED');
        return { externalRef: 'rq-ref-2' };
      });
      const { childTaskId, claimed } = await mkClaimedChild('rq-retry');
      const lane1 = newLane(adapter);
      const begun = await lane1.execute(claimed, new AbortController().signal);
      assert.equal((await lane1.check_status(begun.externalId)).state, 'FAILED');
      assert.equal(state.submitCalls, 1);
      assert.equal((await rowOf(childTaskId)).payload.submission_state, 'FAILED_RETRYABLE');

      await expireAndReclaim(childTaskId);
      const afterReclaim = await rowOf(childTaskId);
      assert.equal(afterReclaim.status, 'RETRY');
      assert.equal(Number(afterReclaim.attempt), 1, 'the failed attempt is terminal and unreplaced');
      assert.ok(afterReclaim.failed_workers.includes(WORKER), 'the allocator exclusion is in place');
      await assertNotLeased(childTaskId);

      // Restart: a brand-new lane instance (empty outcome
      // map). Its health cycle performs the requeue.
      const lane2 = newLane(adapter);
      assert.equal((await lane2.health()).ready, true);
      const afterHealth = await rowOf(childTaskId);
      assert.ok(!afterHealth.failed_workers.includes(WORKER), 'the LANE cleared the exclusion');
      assert.equal(afterHealth.payload.last_requeue?.by, WORKER);
      assert.equal(afterHealth.payload.last_requeue?.from_attempt, 1);
      const dispatch = (await qu(`SELECT failed_workers FROM agy_dispatch_tasks WHERE task_id=$1`, [childTaskId]))[0];
      assert.ok(!dispatch || !dispatch.failed_workers.includes(WORKER), 'the dispatch projection follows');

      const c2: any = await claimAttempt();
      assert.equal(c2.status, 'LEASED');
      assert.equal(c2.task.taskId, childTaskId);
      assert.equal(c2.task.attempt, 2, 'the retry runs under a NEW lease and attempt');
      const claimed2 = { ...c2.task, status: 'CLAIMED', leaseExpiresAt: new Date(Date.now() + 600_000) } as unknown as ClaimedTask;
      const begun2 = await lane2.execute(claimed2, new AbortController().signal);
      assert.equal((await lane2.check_status(begun2.externalId)).state, 'SUCCEEDED');
      const collected: any = await lane2.collect_result(begun2.externalId);
      assert.equal(collected.output.delegation_outcome, 'RECORDED');
      assert.equal(collected.output.payload.text, 'requeue answer');
      assert.equal(state.submitCalls, 2, 'exactly one retry submission');
      const finalRow = await rowOf(childTaskId);
      assert.equal(finalRow.payload.submission_state, 'SUBMITTED');
      assert.equal(finalRow.payload.submission_attempt, 2);
      assert.equal(finalRow.payload.submission_failure, undefined, 'the live receipt is cleared on re-arm');
      assert.equal(finalRow.payload.submission_failures.length, 1, 'failure history is preserved');
      assert.equal(finalRow.payload.submission_failures[0].code, 'RATE_LIMITED');
      const durable = await loadRecordedHelperResult(rt, scope, assignmentFor('rq-retry'));
      assert.equal(durable?.externalRef, 'rq-ref-2');
    }

    // ---- B. UNCERTAIN: the submission outcome is unknown;
    // the child stays IN_FLIGHT with no receipt and the lane
    // NEVER clears its exclusion.
    {
      const { adapter, state } = fakeAdapter(async () => { throw coded('SUBMISSION_UNCERTAIN'); });
      const { childTaskId, claimed } = await mkClaimedChild('rq-uncertain');
      const lane = newLane(adapter);
      const begun = await lane.execute(claimed, new AbortController().signal);
      assert.equal((await lane.check_status(begun.externalId)).state, 'FAILED');
      assert.equal((await rowOf(childTaskId)).payload.submission_state, 'IN_FLIGHT');
      await expireAndReclaim(childTaskId);
      assert.ok((await rowOf(childTaskId)).failed_workers.includes(WORKER));
      assert.equal((await newLane(adapter).health()).ready, true);
      assert.deepEqual(await requeueRetryableHelperChildren(rt, scope, WORKER), [],
        'an uncertain child is never requeued');
      assert.ok((await rowOf(childTaskId)).failed_workers.includes(WORKER),
        'the exclusion survives the reconcile for IN_FLIGHT');
      await assertNotLeased(childTaskId);
      assert.equal(state.submitCalls, 1, 'an uncertain submission is never replayed');
    }

    // ---- C. TERMINAL: a definitive rejection is never
    // requeued even though the queue status allows a retry.
    {
      const { adapter, state } = fakeAdapter(async () => { throw coded('INVALID'); });
      const { childTaskId, claimed } = await mkClaimedChild('rq-terminal');
      const lane = newLane(adapter);
      const begun = await lane.execute(claimed, new AbortController().signal);
      assert.equal((await lane.check_status(begun.externalId)).state, 'FAILED');
      assert.equal((await rowOf(childTaskId)).payload.submission_state, 'FAILED_TERMINAL');
      await expireAndReclaim(childTaskId);
      assert.ok((await rowOf(childTaskId)).failed_workers.includes(WORKER));
      assert.equal((await newLane(adapter).health()).ready, true);
      assert.deepEqual(await requeueRetryableHelperChildren(rt, scope, WORKER), [],
        'a terminally failed child is never requeued');
      assert.ok((await rowOf(childTaskId)).failed_workers.includes(WORKER));
      await assertNotLeased(childTaskId);
      assert.equal(state.submitCalls, 1);
    }

    // ---- D. BINDING FENCE: a retryable receipt whose
    // persisted binding no longer verifies (equipment
    // tampered after the failure) is skipped - health stays
    // fail-soft and the exclusion stays.
    {
      const { adapter } = fakeAdapter(async () => { throw coded('RATE_LIMITED'); });
      const { childTaskId, claimed } = await mkClaimedChild('rq-tampered');
      const lane = newLane(adapter);
      const begun = await lane.execute(claimed, new AbortController().signal);
      assert.equal((await lane.check_status(begun.externalId)).state, 'FAILED');
      assert.equal((await rowOf(childTaskId)).payload.submission_state, 'FAILED_RETRYABLE');
      await expireAndReclaim(childTaskId);
      await qu(`UPDATE agy_tasks SET payload=jsonb_set(payload,'{equipment,criteria}','["tampered"]'::jsonb) WHERE task_id=$1`, [childTaskId]);
      assert.equal((await newLane(adapter).health()).ready, true, 'health is fail-soft on a bad binding');
      assert.deepEqual(await requeueRetryableHelperChildren(rt, scope, WORKER), [],
        'a tampered binding is never requeued');
      assert.ok((await rowOf(childTaskId)).failed_workers.includes(WORKER));
      await assertNotLeased(childTaskId);
    }
  } finally {
    await runtime?.end().catch(() => {}); await owner.end().catch(() => {}); await admin.end().catch(() => {});
  }
});
