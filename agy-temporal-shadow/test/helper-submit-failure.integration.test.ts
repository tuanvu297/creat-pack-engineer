// Submit-failure classification (root QA 2026-11-06): a
// deterministic provider rejection must NOT wedge the child
// IN_FLIGHT forever. The executor records a durable failure
// receipt on the child (terminal, or retryable for a strictly
// later claim attempt) and reports SUBMIT_FAILED; uncertain
// errors keep the child IN_FLIGHT with NO receipt; the
// pre-submit fence (validateBeforeSubmit) runs immediately
// before the provider call and its denial takes the terminal
// receipt without any provider call. Real local PostgreSQL,
// scripted fake adapters - no provider contact.
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
import { createDelegatedChild, beginHelperSubmission } from "../src/platform/helper-queue.js";
import { executeClaimedHelperChild } from "../src/platform/helper-executor.js";
import { ProviderCallError } from "../src/platform/helper-providers.js";
import { childKey, type HelperAdapter, type HelperAssignment } from "../src/platform/helper-delegation.js";
import { digestOf } from "../src/platform/digest.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const EQ = { pinnedSource: { ref: 'doc:fixture-input', digest: 'a'.repeat(64) },
  surface: { kind: 'api', model: 'manus-api-v2', authBinding: 'manus:x-manus-api-key' },
  skillRef: 'skill:fixture', criteria: ['output addresses the pinned source'], rework: { maxAttempts: 1 } };

// Real adapter errors: ProviderCallError carries the
// classification in .kind ONLY (no .code), and the message
// does not contain the kind string - the exact shape the
// pre-fix executor misread (root QA P1 2026-11-06).
const coded = (kind: 'INVALID' | 'RATE_LIMITED' | 'SUBMISSION_UNCERTAIN') =>
  new ProviderCallError(kind, kind === 'SUBMISSION_UNCERTAIN'
    ? 'manus /v2/task.create: network failure on a mutating call - reconcile, never resubmit'
    : 'provider answered with an error envelope');

// A scripted HelperAdapter: submit behaviour is replaceable
// per case; readResult returns a well-formed envelope bound
// to the assignment captured at submit time.
function fakeAdapter(submitImpl: (a: HelperAssignment) => Promise<{ externalRef: string }>) {
  const state = { submitCalls: 0, lastAssignment: null as HelperAssignment | null };
  const adapter: HelperAdapter = {
    helperId: 'manus', surface: 'api', bound: true,
    descriptor: { model: 'manus-api-v2', authBinding: 'manus:x-manus-api-key' },
    submit: async (a) => { state.submitCalls++; state.lastAssignment = a; return submitImpl(a); },
    readResult: async (ref) => {
      const a = state.lastAssignment!;
      const payload = { text: 'retry answer' };
      return { childKey: childKey(a), helperId: 'manus' as const, externalRef: ref,
        digest: digestOf(payload), payload, costUnits: 15 };
    },
  };
  return { adapter, state };
}

test("helper submit failure: terminal receipt, retryable re-arm on later attempt, uncertain stays IN_FLIGHT, pre-submit fence",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 300000 }, async () => {
  const schema = `agy_hsf_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_hsf_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
    const profile = { ...discoverResource('GEMINI-SEO-WORKER', ['text'], Date.now()),
      status: 'READY' as const, ready: true, quotaRemaining: 10, quotaReserve: 0, maxConcurrency: 8,
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
    const qu = async (sql: string, args: any[] = []) => (await ownerScoped(sql, args)).rows;
    const parentClaim = await surface(gemini, scope, 'claim', {});
    assert.equal(parentClaim.status, 'LEASED');
    const parentId = parentClaim.task.taskId;
    const parentLease = parentClaim.task.leaseToken;

    const assignmentFor = (subtaskKey: string): HelperAssignment => ({
      parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: parentId, parentAttempt: 1,
      subtaskKey, helperId: 'manus', scope: { ...scope },
      sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
      budget: { unit: 'provider_credits', cap: 100, spent: 0, enforcement: 'prompt_only', hard: false },
      expiresAtMs: Date.now() + 600_000, replyTarget: RT, equipment: EQ });
    const claimChild = async (childTaskId: string) => {
      const rows = await qu(`SELECT claimed_by, lease_token, attempt, status, lease_expires_at FROM agy_tasks WHERE task_id=$1`, [childTaskId]);
      const r = rows[0];
      if (r?.claimed_by === 'GEMINI-SEO-WORKER' && ['CLAIMED', 'RUNNING'].includes(r.status)
        && r.lease_expires_at && new Date(r.lease_expires_at).getTime() > Date.now())
        return { leaseToken: String(r.lease_token), attempt: Number(r.attempt) };
      const c = await surface(gemini, scope, 'claim', {});
      assert.equal(c.status, 'LEASED');
      assert.equal(c.task.taskId, childTaskId);
      return { leaseToken: c.task.leaseToken, attempt: c.task.attempt };
    };
    const mkChild = async (subtaskKey: string) => {
      const a = assignmentFor(subtaskKey);
      const child = await createDelegatedChild(rt, scope, gemini, op, a,
        { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'], parentLeaseToken: parentLease,
          input: { text: 'extract from the pinned source' } });
      const claim = await claimChild(child.childTaskId);
      return { a, childTaskId: child.childTaskId, claim };
    };
    const payloadOf = async (childTaskId: string) =>
      (await qu(`SELECT payload FROM agy_tasks WHERE task_id=$1`, [childTaskId]))[0].payload;
    const runTail = (a: HelperAssignment, childTaskId: string,
      claim: { leaseToken: string; attempt: number }, adapter: HelperAdapter, expectedCost = 15) =>
      executeClaimedHelperChild({ pool: rt, scope, parent: gemini },
        { a, childTaskId, leaseToken: claim.leaseToken, attempt: claim.attempt, adapter,
          input: { text: 'extract from the pinned source' }, expectedCost });

    // ---- A. TERMINAL: a definitive rejection takes a durable
    // terminal receipt; no later run ever resubmits the child.
    {
      const { a, childTaskId, claim } = await mkChild('fail-terminal');
      const { adapter, state } = fakeAdapter(async () => { throw coded('INVALID'); });
      const out1: any = await runTail(a, childTaskId, claim, adapter);
      assert.equal(out1.status, 'SUBMIT_FAILED');
      assert.equal(out1.failure.code, 'INVALID');
      assert.equal(out1.failure.retryable, false);
      assert.equal(out1.failure.attempt, 1);
      assert.equal(state.submitCalls, 1);
      const p = await payloadOf(childTaskId);
      assert.equal(p.submission_state, 'FAILED_TERMINAL');
      assert.equal(p.submission_failure.code, 'INVALID');
      assert.equal(p.submission_failures.length, 1);
      assert.equal(p.submission_ref, undefined);
      const out2: any = await runTail(a, childTaskId, claim, adapter);
      assert.equal(out2.status, 'SUBMIT_FAILED', 'a later run observes the durable receipt');
      assert.equal(out2.failure.failedAtMs, out1.failure.failedAtMs, 'the same receipt, not a new failure');
      assert.equal(state.submitCalls, 1, 'a terminally failed child is NEVER resubmitted');
      assert.equal((await beginHelperSubmission(rt, scope, gemini, childTaskId, claim.leaseToken, claim.attempt)).state, 'FAILED_TERMINAL');
    }

    // ---- B. RETRYABLE: refused before acceptance; the same
    // attempt cannot resubmit, a strictly later claim attempt
    // re-arms and completes; failure history is preserved.
    {
      const { a, childTaskId, claim } = await mkChild('fail-retryable');
      let calls = 0;
      const { adapter, state } = fakeAdapter(async () => {
        calls++;
        if (calls === 1) throw coded('RATE_LIMITED');
        return { externalRef: 'retry-ref-1' };
      });
      const out1: any = await runTail(a, childTaskId, claim, adapter);
      assert.equal(out1.status, 'SUBMIT_FAILED');
      assert.equal(out1.failure.retryable, true);
      assert.equal((await payloadOf(childTaskId)).submission_state, 'FAILED_RETRYABLE');
      const outSame: any = await runTail(a, childTaskId, claim, adapter);
      assert.equal(outSame.status, 'SUBMIT_FAILED', 'the SAME attempt observes the receipt, no inline retry');
      assert.equal(state.submitCalls, 1);
      // Expire the child lease and run the queue's reclaim:
      // the child's single fenced retry (maxRetry 1) makes it
      // claimable again, and the surface re-claims it as
      // attempt 2, which may re-arm. (The reclaim also puts a
      // 30s LEASE_EXPIRED cooldown on the worker; clear it as
      // the platform suites do.)
      await qu(`UPDATE agy_tasks SET lease_expires_at=now()-interval '1 minute' WHERE task_id=$1`, [childTaskId]);
      await service.store.reclaimExpired();
      await qu(`UPDATE agy_project_worker_health SET blocked_until=now()-interval '1 second' WHERE worker_id='GEMINI-SEO-WORKER'`);
      // The allocator excludes workers in a task's
      // failed_workers from re-claiming it (resumption is
      // normally by a DIFFERENT worker) - but a helper child
      // is pinned to its parent worker. In production the
      // HOST LANE clears that exclusion itself, fenced by
      // this durable retryable receipt (helper-lane
      // requeueRetryableHelperChildren, proven end-to-end in
      // helper-requeue.integration.test.ts). This tail-level
      // test arranges the same post-requeue state directly
      // to exercise begin's re-arm in isolation.
      await qu(`UPDATE agy_tasks SET failed_workers='{}' WHERE task_id=$1`, [childTaskId]);
      await qu(`UPDATE agy_dispatch_tasks SET failed_workers='{}' WHERE task_id=$1`, [childTaskId]);
      // Re-claim through the store - the same claim the worker
      // daemon's engine uses (the surface claim does not pick
      // up reclaimed RETRY tasks).
      const storeClaim = await service.store.claim({ workerId: 'GEMINI-SEO-WORKER', capabilities: ['text'], leaseSeconds: 600 });
      assert.equal(storeClaim?.taskId, childTaskId);
      const claim2 = { leaseToken: storeClaim!.leaseToken, attempt: storeClaim!.attempt };
      assert.equal(claim2.attempt, 2);
      const out2: any = await runTail(a, childTaskId, claim2, adapter);
      assert.equal(out2.status, 'RECORDED');
      assert.equal(state.submitCalls, 2, 'exactly one resubmission, under the new attempt');
      const p = await payloadOf(childTaskId);
      assert.equal(p.submission_state, 'SUBMITTED');
      assert.equal(p.submission_ref, 'retry-ref-1');
      assert.equal(p.submission_attempt, 2);
      assert.equal(p.submission_failure, undefined, 'the live receipt clears on re-arm');
      assert.equal(p.submission_failures.length, 1, 'the failure history is preserved');
      assert.equal(p.submission_failures[0].code, 'RATE_LIMITED');
    }

    // ---- C. UNCERTAIN: no receipt, the child stays IN_FLIGHT,
    // and a later run reconciles instead of resubmitting.
    {
      const { a, childTaskId, claim } = await mkChild('fail-uncertain');
      const { adapter, state } = fakeAdapter(async () => { throw coded('SUBMISSION_UNCERTAIN'); });
      const out1: any = await runTail(a, childTaskId, claim, adapter);
      assert.equal(out1.status, 'SUBMIT_UNCERTAIN');
      const p = await payloadOf(childTaskId);
      assert.equal(p.submission_state, 'IN_FLIGHT');
      assert.equal(p.submission_failure, undefined, 'an uncertain submission gets NO failure receipt');
      assert.equal(p.submission_failures, undefined);
      const out2: any = await runTail(a, childTaskId, claim, adapter);
      assert.equal(out2.status, 'IN_FLIGHT');
      assert.equal(state.submitCalls, 1, 'an uncertain submission is never resubmitted');
    }

    // ---- D. PRE-SUBMIT FENCE: the budget moved between child
    // creation and submission; validateBeforeSubmit denies and
    // the provider is never called; the denial is durable.
    {
      const { a, childTaskId, claim } = await mkChild('fail-presubmit');
      const moved: HelperAssignment = { ...a, budget: { ...a.budget, spent: 95 } };
      const { adapter, state } = fakeAdapter(async () => ({ externalRef: 'never-created' }));
      const out: any = await runTail(moved, childTaskId, claim, adapter);
      assert.equal(out.status, 'SUBMIT_FAILED');
      assert.equal(out.failure.code, 'PRESUBMIT_DENIED:BUDGET_EXCEEDED');
      assert.equal(out.failure.retryable, false);
      assert.equal(state.submitCalls, 0, 'a pre-submit denial means NO provider call');
      assert.equal((await payloadOf(childTaskId)).submission_state, 'FAILED_TERMINAL');
    }
  } finally {
    await runtime?.end().catch(() => {}); await owner.end().catch(() => {}); await admin.end().catch(() => {});
  }
});
