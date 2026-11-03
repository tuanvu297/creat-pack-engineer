// Integration regressions for the worker-surface 'delegate'
// action (D-057 wiring, 2026-11-03). Real local PostgreSQL, real
// surface + helper-queue code. Proves the surface path honours
// the same guarantees as the module path: identity and scope
// come from the authenticated principal (never the body), the
// parent lease token is required as possession proof, creation
// runs under the configured system operator only, and an
// unconfigured surface denies instead of fabricating one.
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
import { childKey } from "../src/platform/helper-delegation.js";
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const other: Principal = { subject: 'other-worker', role: 'worker', scopes: [scope], workerId: 'OTHER-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';

test("worker surface delegate: configured-only creation, principal-bound identity, lease possession",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 180000 }, async () => {
  const schema = `agy_sd_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_sd_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
    const scopedSetup = new ProjectPool(rt, scope, 'setup').asPool();
    await scopedSetup.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read'],resource_policy='{"maxConcurrentTasks":4,"quotaCap":100,"spendCap":0,"reservation":1}'`);
    const resources = new ResourceStore(owner);
    const profile = { ...discoverResource('GEMINI-SEO-WORKER', ['text'], Date.now()),
      status: 'READY' as const, ready: true, quotaRemaining: 10, quotaReserve: 0, maxConcurrency: 4,
      passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0, costPerTask: 0, spendCap: 0, quotaCap: 10,
      permissions: ['read'] };
    await resources.register(profile as any, 'gemini');
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='GEMINI-SEO-WORKER'`,
      [JSON.stringify({ bindings: { missions: ['GEMINI_UI_STAGING'], task_types: ['hello', 'helper_delegation'], reply_targets: [RT] } })]);

    const service = new ProjectService(rt, scope, op);
    await service.execute('/jobs', 'POST', { idempotency_key: 'job-parent-sd', objective: 'parent',
      tasks: [{ name: 'parent', idempotencyKey: 'job-parent-sd-t', taskType: 'hello', requiredCapabilities: ['text'], requiredPermissions: ['read'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 10,
        payload: { mission_id: 'GEMINI_UI_STAGING', target_worker_id: 'GEMINI-SEO-WORKER', callback_target: RT } }] });

    const plain = createWorkerSurface(rt);
    const parentClaim = await plain(gemini, scope, 'claim', {});
    assert.equal(parentClaim.status, 'LEASED');
    const parentId = parentClaim.task.taskId;
    const leaseToken = parentClaim.task.leaseToken;

    const body = (over: Record<string, unknown> = {}) => ({
      assignment: { parentTaskId: parentId, parentAttempt: 1, subtaskKey: 'extract-1', helperId: 'grok',
        sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
        budget: { unit: 'provider_credits', cap: 5, spent: 0, enforcement: 'runtime', hard: true },
        actualCostBounded: true, expiresAtMs: Date.now() + 600_000, replyTarget: RT },
      spec: { estimatedQuota: 1, estimatedCost: 0, requiredCapabilities: ['text'] },
      parentLeaseToken: leaseToken, ...over });

    // Unconfigured surface: denies, fabricates nothing.
    const unconf = await plain(gemini, scope, 'delegate', body());
    assert.equal(unconf.status, 'DENIED');
    assert.equal(unconf.reason, 'DELEGATION_NOT_CONFIGURED');

    const surface = createWorkerSurface(rt, { delegationSystemPrincipal: () => op });

    // Missing possession proof.
    const noTok = await surface(gemini, scope, 'delegate', body({ parentLeaseToken: undefined }));
    assert.equal(noTok.status, 'DENIED');
    assert.equal(noTok.reason, 'PARENT_LEASE_TOKEN_REQUIRED');
    // Wrong possession proof.
    const badTok = await surface(gemini, scope, 'delegate', body({ parentLeaseToken: 'forged' }));
    assert.equal(badTok.status, 'DENIED');
    assert.match(badTok.reason, /PARENT_LEASE_DENIED/);

    // Happy path through the surface; identity is injected, so a
    // body claiming a different parent worker changes nothing -
    // the child binds to the authenticated worker's parent.
    const forged = body();
    (forged.assignment as any).parentWorkerId = 'OTHER-WORKER';
    const created = await surface(gemini, scope, 'delegate', forged);
    assert.equal(created.status, 'CREATED');
    const key = childKey({ parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: parentId, parentAttempt: 1,
      subtaskKey: 'extract-1', helperId: 'grok', scope: { ...scope }, sourceAllowlist: [], toolAllowlist: [],
      budget: { unit: 'x', cap: 0, spent: 0, enforcement: 'runtime', hard: false }, expiresAtMs: 0, replyTarget: RT } as any);
    assert.equal(created.childKey, key);
    // Idempotent through the surface too.
    const again = await surface(gemini, scope, 'delegate', body());
    assert.equal(again.status, 'EXISTS');
    assert.equal(again.childTaskId, created.childTaskId);

    // A different authenticated worker cannot delegate against
    // gemini's parent: the surface binds the assignment to the
    // CALLER, and the persisted row belongs to gemini.
    const alien = await surface(other, scope, 'delegate', body());
    assert.equal(alien.status, 'DENIED');
    assert.match(alien.reason, /PARENT_NOT_OWNER|PARENT_MISMATCH/);
  } finally {
    await runtime?.end().catch(() => {}); await owner.end().catch(() => {}); await admin.end().catch(() => {});
  }
});
