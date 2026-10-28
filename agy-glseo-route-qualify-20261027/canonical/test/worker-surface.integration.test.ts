// Integration test for the CANDIDATE canonical worker surface
// (src/platform/worker-surface.ts + the http-server worker namespace).
// Evidence class: LOCAL integration against a real local PostgreSQL 18.4
// (embedded-postgres) with the repo's own migrations 001-008 applied to a
// throwaway schema and an RLS-bound runtime role — the same pattern as the
// repo's platform-postgres.integration.test.ts. Not the live D049 database.
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
import { createGatewayHttpServer } from "../src/temporal/http-server.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' };
const opPrincipal: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const claudePrincipal: Principal = { subject: 'claude-worker', role: 'worker', scopes: [scope], workerId: 'MUSE-SEO-WORKER' };
const geminiPrincipal: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };

test("canonical worker surface: scoped claim/ack/heartbeat/checkpoint/result/readback on PostgresStore leases",
  { skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const schema = `agy_ws_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_ws_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const owner = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  let runtime: Pool | undefined; let server: any;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql'])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    // Seed the GL project in scope (administrator supplies transaction scope).
    const seed = await owner.connect();
    try {
      await seed.query('BEGIN');
      await seed.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query("INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'Greenlife Spa','repo:gl','policy:gl') ON CONFLICT DO NOTHING", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query('COMMIT');
    } catch (e) { await seed.query('ROLLBACK'); throw e; } finally { seed.release(); }

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
    await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    runtime = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });

    const scoped = new ProjectPool(runtime, scope, 'setup').asPool();
    await scoped.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read','analyze','planning','qa'],resource_policy='{"maxConcurrentTasks":2,"quotaCap":100,"spendCap":10,"reservation":1}'`);

    const resources = new ResourceStore(owner);
    const profile = (workerId: string, caps: string[]) => ({ ...discoverResource(workerId, caps, Date.now()),
      status: 'READY' as const, ready: true, quotaRemaining: 100, quotaReserve: 20, maxConcurrency: 1,
      passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0, costPerTask: 0, spendCap: 0, quotaCap: 200,
      permissions: ['read', 'analyze', 'planning', 'qa'] });
    await resources.register(profile('MUSE-SEO-WORKER', ['text', 'creative', 'planning', 'qa']), 'muse');
    await resources.register(profile('GEMINI-SEO-WORKER', ['text', 'qa']), 'gemini');

    // Canonical project binding: a worker is allocatable only when its
    // adapter matches an ENABLED connector kind in the project scope
    // (agy_dispatch_projects.adapter_kinds is projected from agy_connectors).
    const bind = await owner.connect();
    try {
      await bind.query('BEGIN');
      await bind.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await bind.query("INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES($1,$2,$3,'muse-seo','muse',ARRAY['text','creative','planning','qa'],'https://agy-temporal-staging-staging.up.railway.app/v1/worker','vault:agy-worker-claude-token',true,ARRAY['read','analyze','planning','qa'])", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await bind.query("INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES($1,$2,$3,'gemini-seo','gemini',ARRAY['text','qa'],'browser-adapter:gemini','vault:agy-worker-gemini-token',true,ARRAY['read','analyze','planning','qa'])", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await bind.query('COMMIT');
    } catch (e) { await bind.query('ROLLBACK'); throw e; } finally { bind.release(); }

    const service = new ProjectService(runtime, scope, opPrincipal);
    const job = await service.execute('/jobs', 'POST', { idempotency_key: 'ws-job-1', objective: 'worker surface qualification',
      tasks: [{ name: 'seo-plan', idempotencyKey: 'ws-task-1', taskType: 'planning', requiredCapabilities: ['text', 'planning'],
        requiredPermissions: ['read'], permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0 }] });
    assert.ok(job.jobId, 'job created through the canonical ProjectService');

    const surface = createWorkerSurface(runtime);

    // Wrong project scope: the principal's scopes do not include it.
    await assert.rejects(() => surface(claudePrincipal, { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'SIMULATED_B' }, 'claim', {}), /PROJECT_SCOPE_DENIED/);
    // A worker principal without a workerId cannot execute.
    await assert.rejects(() => surface({ subject: 'anon-worker', role: 'worker', scopes: [scope] }, scope, 'claim', {}), /WORKER_IDENTITY_REQUIRED/);
    // An operator cannot claim (authorize: execute requires role worker).
    await assert.rejects(() => surface(opPrincipal, scope, 'claim', {}), /ACTION_DENIED/);
    // Allocation: the task requires planning, which GEMINI does not hold.
    const gClaim = await surface(geminiPrincipal, scope, 'claim', {});
    assert.equal(gClaim.status, 'EMPTY');
    // Body can never override scope or worker identity.
    await assert.rejects(() => surface(claudePrincipal, scope, 'claim', { worker_id: 'GEMINI-SEO-WORKER' }), /BODY_SCOPE_OVERRIDE_DENIED/);

    // Full lifecycle over HTTP, through the patched gateway entrypoint.
    const identities = [
      { ...claudePrincipal, token: 'tok-claude' },
      { ...opPrincipal, token: 'tok-op' },
    ];
    server = createGatewayHttpServer({ identities, worker: surface,
      execute: async () => ({}), health: async () => ({ postgres: true, temporal: true, worker: true }) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/v1/worker/tenants/gl/workspaces/legacy-workspace/projects/GL_AUTOMATION`;
    const call = async (action: string, token?: string, body: any = {}) => {
      const res = await fetch(`${base}/${action}`, { method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() as any };
    };

    let r = await call('claim');
    assert.equal(r.status, 401, 'unauthenticated claim is refused before routing');
    r = await call('claim', 'tok-op');
    assert.equal(r.status, 403, 'operator token cannot use the worker namespace');
    r = await call('claim', 'tok-claude');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'LEASED');
    const taskId = r.json.task.taskId, leaseToken = r.json.task.leaseToken;
    assert.ok(taskId && leaseToken, 'claim returns the canonical lease binding');

    r = await call('heartbeat', 'tok-claude', { task_id: taskId, lease_token: randomUUID() });
    assert.equal(r.status, 403, 'heartbeat with a foreign lease token is denied');
    r = await call('ack', 'tok-claude', { task_id: taskId, lease_token: leaseToken });
    assert.equal(r.json.status, 'RUNNING');
    r = await call('heartbeat', 'tok-claude', { task_id: taskId, lease_token: leaseToken });
    assert.equal(r.json.status, 'HEARTBEAT');
    r = await call('checkpoint', 'tok-claude', { task_id: taskId, lease_token: leaseToken, external_id: 'op-ws-1' });
    assert.equal(r.json.status, 'CHECKPOINTED');
    r = await call('result', 'tok-claude', { task_id: taskId, lease_token: leaseToken,
      result: { summary: 'plan ready' }, evidence: { external_operation_id: 'op-ws-1' } });
    assert.equal(r.json.status, 'RESULT_SUBMITTED');
    assert.equal(r.json.task.status, 'QA', 'result lands in QA; acceptance stays a separate reviewer act');
    r = await call('readback', 'tok-claude', { task_id: taskId });
    assert.equal(r.json.task.status, 'QA');
    assert.equal(r.json.task.result.summary, 'plan ready');

    const after = await surface(geminiPrincipal, scope, 'claim', {});
    assert.equal(after.status, 'EMPTY', 'no further claimable task remains');
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (runtime) await runtime.end();
    await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  }
});
