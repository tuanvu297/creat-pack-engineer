// Host-loop integration (D-057, 2026-11-05): runHelperDelegation
// composes routing -> equipped assignment -> adapter guard ->
// queue create/claim -> begin -> submit -> record -> verified
// read -> durable record, against a MOCK Manus adapter
// (injected fetch - no provider contact) on real local
// PostgreSQL. Proves: one full RECORDED cycle; an idempotent
// re-run reconciles through the persisted submission without
// a second provider submit; an IN_FLIGHT child is never
// resubmitted; a hard-budget routing denial creates nothing
// and calls nothing.
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
import { createDelegatedChild, beginHelperSubmission, loadRecordedHelperResult } from "../src/platform/helper-queue.js";
import { runHelperDelegation, type HelperDelegationRequest } from "../src/platform/helper-executor.js";
import { childKey, type HelperAssignment } from "../src/platform/helper-delegation.js";
import { manusAdapter, type FetchLike } from "../src/platform/helper-providers.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const EQ = { pinnedSource: { ref: 'doc:fixture-input', digest: 'a'.repeat(64) },
  surface: { kind: 'api', model: 'manus-api-v2', authBinding: 'manus:x-manus-api-key' },
  skillRef: 'skill:fixture', criteria: ['output addresses the pinned source'], rework: { maxAttempts: 1 } };

test("helper executor: full delegation cycle, idempotent reconcile, IN_FLIGHT safety, routing denial",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 300000 }, async () => {
  const schema = `agy_hex_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_hex_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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

    const assignmentFor = (subtaskKey: string) => (helperId: 'manus' | 'grok'): HelperAssignment => ({
      parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: parentId, parentAttempt: 1,
      subtaskKey, helperId, scope: { ...scope },
      sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
      budget: { unit: 'provider_credits', cap: 100, spent: 0, enforcement: 'prompt_only', hard: false },
      expiresAtMs: Date.now() + 600_000, replyTarget: RT, equipment: EQ });
    // The host's claim path: if this worker already holds the
    // child's live lease (a re-run), reuse that fence; otherwise
    // claim through the worker surface.
    const claimChild = async (childTaskId: string) => {
      const rows = await qu(`SELECT claimed_by, lease_token, attempt, status FROM agy_tasks WHERE task_id=$1`, [childTaskId]);
      const r = rows[0];
      if (r?.claimed_by === 'GEMINI-SEO-WORKER' && ['CLAIMED', 'RUNNING'].includes(r.status))
        return { leaseToken: String(r.lease_token), attempt: Number(r.attempt) };
      const c = await surface(gemini, scope, 'claim', {});
      assert.equal(c.status, 'LEASED');
      assert.equal(c.task.taskId, childTaskId);
      return { leaseToken: c.task.leaseToken, attempt: c.task.attempt };
    };

    let createCalls = 0;
    const fetchMock: FetchLike = async (url) => {
      if (url.includes('/v2/task.create')) { createCalls++;
        return { status: 200, json: async () => ({ ok: true, task_id: 'exec-ref-1' }) }; }
      if (url.includes('task.detail')) return { status: 200, json: async () => ({ ok: true, task: { id: 'exec-ref-1', status: 'stopped', credit_usage: 15 } }) };
      return { status: 200, json: async () => ({ ok: true, task_id: 'exec-ref-1', messages: [{ type: 'assistant_message', content: [{ type: 'text', text: 'executor answer' }] }], has_more: false }) };
    };
    const adapter = manusAdapter({ apiKey: 'mock-key', fetch: fetchMock });
    const deps = { pool: rt, scope, parent: gemini, system: op, adapters: { manus: adapter }, claimChild };
    const requestFor = (subtaskKey: string): HelperDelegationRequest => ({
      buildAssignment: assignmentFor(subtaskKey),
      requiredCapabilities: ['text'], surfaceKind: 'api',
      budget: { cap: 100, spent: 0, hard: false },
      telemetry: { manus: { capabilities: ['text', 'web-research'], balance: { known: true, units: 500 }, fitScore: 0.8, expectedCost: 15 } },
      spec: { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'], parentLeaseToken: parentLease },
      input: { text: 'extract from the pinned source' },
    });

    // ---- Full cycle: RECORDED, exactly one provider submit.
    const out1: any = await runHelperDelegation(deps, requestFor('exec-1'));
    assert.equal(out1.status, 'RECORDED');
    assert.equal(out1.helperId, 'manus');
    assert.equal(out1.externalRef, 'exec-ref-1');
    assert.equal(out1.envelope.costUnits, 15);
    assert.equal((out1.envelope.payload as any).text, 'executor answer');
    assert.equal(out1.alreadyRecorded, false);
    assert.equal(createCalls, 1, 'exactly one provider submission for the cycle');
    const durable = await loadRecordedHelperResult(rt, scope, assignmentFor('exec-1')('manus'));
    assert.equal(durable?.externalRef, 'exec-ref-1', 'the loop leaves the result durable in the queue');

    // ---- Idempotent re-run: reconcile, never resubmit.
    const out2: any = await runHelperDelegation(deps, requestFor('exec-1'));
    assert.equal(out2.status, 'RECORDED');
    assert.equal(out2.alreadyRecorded, true, 'the re-run reconciles the recorded result');
    assert.equal(createCalls, 1, 'no second provider submission on re-run');

    // ---- IN_FLIGHT safety: a begun-but-unrecorded child is
    // reported, never resubmitted.
    const aF = assignmentFor('exec-flight')('manus');
    const cF = await createDelegatedChild(rt, scope, gemini, op, aF,
      { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'], parentLeaseToken: parentLease });
    const fenceF = await claimChild(cF.childTaskId);
    assert.equal((await beginHelperSubmission(rt, scope, gemini, cF.childTaskId, fenceF.leaseToken, fenceF.attempt)).state, 'NEW');
    const out3: any = await runHelperDelegation(deps, requestFor('exec-flight'));
    assert.equal(out3.status, 'IN_FLIGHT');
    assert.equal(createCalls, 1, 'an IN_FLIGHT child is never resubmitted');

    // ---- Routing denial: hard budget vs prompt-only posture
    // creates nothing and calls nothing.
    const deniedReq: HelperDelegationRequest = { ...requestFor('exec-denied'), budget: { cap: 100, spent: 0, hard: true } };
    const out4: any = await runHelperDelegation(deps, deniedReq);
    assert.equal(out4.status, 'ROUTING_DENIED');
    assert.ok(out4.denial.denied.some((d: any) => d.helperId === 'manus' && d.reasons.includes('HARD_BUDGET_UNENFORCED')));
    const wouldBe = assignmentFor('exec-denied')('manus');
    assert.equal((await qu(`SELECT count(*)::int n FROM agy_jobs WHERE idempotency_key=$1`, [childKey(wouldBe)]))[0].n, 0,
      'a routing denial writes no child');
    assert.equal(createCalls, 1, 'a routing denial calls no provider');
  } finally {
    await runtime?.end().catch(() => {}); await owner.end().catch(() => {}); await admin.end().catch(() => {});
  }
});
