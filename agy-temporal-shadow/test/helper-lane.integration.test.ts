// Daemon lane wiring (D-057 R1): withHelperDelegation wraps a
// lane's connector adapter so a helper_delegation child claimed
// by the worker engine executes through the delegation host
// loop (begin -> submit -> record -> verified read -> durable
// record) instead of the connector. Proves on real local
// PostgreSQL with a mock Manus adapter (injected fetch - no
// provider contact): a full RECORDED cycle through the
// WorkerAdapter contract (execute / check_status /
// collect_result); an unbound helper fails the task closed
// with NOTHING begun and NO provider call; non-helper tasks
// pass through to the inner adapter untouched.
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
import { withHelperDelegation } from "../src/platform/helper-lane.js";
import { unboundAdapter, type HelperAssignment } from "../src/platform/helper-delegation.js";
import { manusAdapter, type FetchLike } from "../src/platform/helper-providers.js";
import type { ClaimedTask, WorkerAdapter } from "../src/types.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const EQ = { pinnedSource: { ref: 'doc:fixture-input', digest: 'a'.repeat(64) },
  surface: { kind: 'api', model: 'manus-api-v2', authBinding: 'manus:x-manus-api-key' },
  skillRef: 'skill:fixture', criteria: ['output addresses the pinned source'], rework: { maxAttempts: 1 } };

test("helper lane: engine-claimed child executes the delegation; unbound helper fails closed; passthrough intact",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 300000 }, async () => {
  const schema = `agy_hln_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_hln_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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

    let createCalls = 0;
    const fetchMock: FetchLike = async (url) => {
      if (url.includes('/v2/task.create')) { createCalls++;
        return { status: 200, json: async () => ({ ok: true, task_id: 'lane-ref-1' }) }; }
      if (url.includes('task.detail')) return { status: 200, json: async () => ({ ok: true, task: { id: 'lane-ref-1', status: 'stopped', credit_usage: 15 } }) };
      return { status: 200, json: async () => ({ ok: true, task_id: 'lane-ref-1', messages: [{ type: 'assistant_message', content: [{ type: 'text', text: 'lane answer' }] }], has_more: false }) };
    };
    const manus = manusAdapter({ apiKey: 'mock-key', fetch: fetchMock });

    // The lane's inner connector adapter: a stub that must see
    // ONLY non-helper tasks.
    const innerCalls: string[] = [];
    const inner: WorkerAdapter = {
      name: 'gemini-x', capabilities: ['text'],
      execute: async (task) => { innerCalls.push(`execute:${task.taskType}`); return { externalId: 'inner-ext-1' }; },
      check_status: async () => ({ state: 'SUCCEEDED' }),
      collect_result: async () => ({ state: 'SUCCEEDED', output: { inner: true } }),
      cancel: async () => {},
      health: async () => ({ ready: true }),
    };
    const lane = withHelperDelegation(inner, { pool: rt, scope, parent: gemini, adapterFor: () => manus });

    const mkClaimedChild = async (subtaskKey: string): Promise<ClaimedTask> => {
      const a = assignmentFor(subtaskKey);
      const child = await createDelegatedChild(rt, scope, gemini, op, a,
        { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'], parentLeaseToken: parentLease,
          input: { text: 'extract from the pinned source' } });
      const c = await surface(gemini, scope, 'claim', {});
      assert.equal(c.status, 'LEASED');
      assert.equal(c.task.taskId, child.childTaskId);
      return { ...c.task, status: 'CLAIMED', leaseExpiresAt: new Date(Date.now() + 600_000) } as unknown as ClaimedTask;
    };

    // ---- Full cycle through the WorkerAdapter contract.
    const claimed = await mkClaimedChild('lane-1');
    const begun = await lane.execute(claimed, new AbortController().signal);
    assert.equal(begun.externalId, `helper:${claimed.taskId}`);
    assert.equal(createCalls, 1, 'exactly one provider submission through the lane');
    assert.deepEqual(innerCalls, [], 'the connector never sees a helper task');
    assert.equal((await lane.check_status(begun.externalId)).state, 'SUCCEEDED');
    const collected: any = await lane.collect_result(begun.externalId);
    assert.equal(collected.state, 'SUCCEEDED');
    assert.equal(collected.output.delegation_outcome, 'RECORDED');
    assert.equal((collected.output.payload as any).text, 'lane answer');
    assert.equal(collected.output.cost_known, true);
    assert.equal(collected.output.cost_units, 15);
    const durable = await loadRecordedHelperResult(rt, scope, assignmentFor('lane-1'));
    assert.equal(durable?.externalRef, 'lane-ref-1', 'the lane leaves the result durable in the queue');

    // ---- Unbound helper: the task fails closed - nothing is
    // begun on the child and no provider is called.
    const claimed2 = await mkClaimedChild('lane-unbound');
    const laneUnbound = withHelperDelegation(inner, { pool: rt, scope, parent: gemini,
      adapterFor: () => unboundAdapter('manus', 'api') });
    await assert.rejects(() => laneUnbound.execute(claimed2, new AbortController().signal),
      (e: any) => typeof e?.code === 'string' && e.code.length > 0);
    const p2 = (await qu(`SELECT payload FROM agy_tasks WHERE task_id=$1`, [claimed2.taskId]))[0].payload;
    assert.equal(p2.submission_state, undefined, 'an unbound helper begins NOTHING');
    assert.equal(createCalls, 1, 'an unbound helper calls NO provider');

    // ---- Passthrough: non-helper tasks reach the connector.
    const helloTask = { taskId: 'ext-task', jobId: 'ext-job', taskType: 'hello', attempt: 1,
      leaseToken: 'x', status: 'CLAIMED', leaseExpiresAt: new Date(), idempotencyKey: 'k', name: 'h' } as unknown as ClaimedTask;
    const passthrough = await lane.execute(helloTask, new AbortController().signal);
    assert.equal(passthrough.externalId, 'inner-ext-1');
    assert.deepEqual(innerCalls, ['execute:hello']);
    assert.equal((await lane.check_status('inner-ext-1')).state, 'SUCCEEDED');
  } finally {
    await runtime?.end().catch(() => {}); await owner.end().catch(() => {}); await admin.end().catch(() => {});
  }
});
