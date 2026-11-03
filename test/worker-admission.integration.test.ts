// Integration regressions for the single-task admission candidate
// (AGY Gemini admission, 2026-11-03). Real local PostgreSQL, real
// ProjectService / PostgresStore / worker-surface code, scope
// GEMINI_UI_STAGING with the two seeded-task shape root verified:
// a QUEUED hello task and a QUEUED video_preview task under the old
// massage mission. Under an admission pinning the hello task:
//   claim before arrival      -> DENIED ADMISSION_PRESENCE_REQUIRED
//   arrive                    -> ARRIVED via ADMISSION
//   claim                     -> LEASED, the HELLO task (never the
//                                higher-priority video task)
//   video task attempt        -> stays 0
//   second claim              -> not leased (one-task capacity)
//   admission expiry          -> arrive ADMISSION_EXPIRED, claim
//                                DENIED ADMISSION_EXPIRED (fail-closed
//                                with no cleanup having run)
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
import type { Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };
const gemini: Principal = { subject: 'gemini-worker', role: 'worker', scopes: [scope], workerId: 'GEMINI-SEO-WORKER' };
const RT = 'CHATGPT_ASSISTANT_CONTROL_PLANE';

test("worker admission: presence, pinning, one-task capacity, fail-closed expiry",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 180000 }, async () => {
  const schema = `agy_adm_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_adm_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
    const scopedSetup = new ProjectPool(runtime, scope, 'setup').asPool();
    await scopedSetup.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read'],resource_policy='{"maxConcurrentTasks":4,"quotaCap":100,"spendCap":0,"reservation":1}'`);

    const resources = new ResourceStore(owner);
    const profile = { ...discoverResource('GEMINI-SEO-WORKER', ['text'], Date.now()),
      status: 'READY' as const, ready: true, quotaRemaining: 1, quotaReserve: 0, maxConcurrency: 1,
      passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0, costPerTask: 0, spendCap: 0, quotaCap: 1,
      permissions: ['read'] };
    await resources.register(profile as any, 'gemini');

    const service = new ProjectService(runtime, scope, op);
    const mkJob = async (key: string, task: any) => (await service.execute('/jobs', 'POST', { idempotency_key: key, objective: key,
      tasks: [{ name: key, idempotencyKey: key + '-t', requiredPermissions: ['read'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, ...task }] })).jobId;
    await mkJob('job-hello', { taskType: 'hello', requiredCapabilities: ['text'], priority: 10,
      payload: { mission_id: 'GEMINI_UI_STAGING', target_worker_id: 'GEMINI-SEO-WORKER', callback_target: RT } });
    await mkJob('job-video', { taskType: 'video_preview', requiredCapabilities: ['text'], priority: 200,
      payload: { mission_id: 'AGY_MASSAGE_CRAFT_30S', target_worker_id: 'GEMINI-SEO-WORKER', callback_target: RT } });
    const q = async (sql: string, args: any[] = []) => (await owner.query(sql, args)).rows;
    const helloId = (await q(`SELECT task_id FROM agy_tasks WHERE task_type='hello'`))[0].task_id;
    const videoId = (await q(`SELECT task_id FROM agy_tasks WHERE task_type='video_preview'`))[0].task_id;
    assert.ok(helloId && videoId, 'both seeded tasks exist');

    const admission = { task_id: helloId, mission_id: 'GEMINI_UI_STAGING', task_type: 'hello',
      scope: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, project_id: scope.projectId },
      expires_at: new Date(Date.now() + 600_000).toISOString(), presence_ttl_seconds: 300 };
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='GEMINI-SEO-WORKER'`,
      [JSON.stringify({ bindings: { missions: ['GEMINI_UI_STAGING', 'AGY_MASSAGE_CRAFT_30S'], task_types: ['hello', 'video_preview'], reply_targets: [RT] }, admission })]);

    // Registration stamps heartbeat_at=now(); the real worker's last
    // heartbeat is days old, so age it past the admission TTL to
    // exercise the presence gate honestly.
    await owner.query(`UPDATE agy_workers SET heartbeat_at=now()-interval '1 hour' WHERE worker_id='GEMINI-SEO-WORKER'`);
    const surface = createWorkerSurface(runtime);

    const early = await surface(gemini, scope, 'claim', {});
    assert.equal(early.status, 'DENIED', 'claim before arrival is denied');
    assert.equal(early.reason, 'ADMISSION_PRESENCE_REQUIRED');

    const arrived = await surface(gemini, scope, 'arrive', {});
    assert.equal(arrived.status, 'ARRIVED');
    assert.equal(arrived.via, 'ADMISSION');

    const claim = await surface(gemini, scope, 'claim', {});
    assert.equal(claim.status, 'LEASED', 'claim after arrival leases');
    assert.equal(claim.task.taskId, helloId, 'the leased task is the pinned HELLO task');
    assert.equal((await q(`SELECT attempt FROM agy_tasks WHERE task_id=$1`, [videoId]))[0].attempt, 0,
      'the higher-priority old video task was never attempted');

    const second = await surface(gemini, scope, 'claim', {});
    assert.notEqual(second.status, 'LEASED', 'one-task capacity: no second lease');

    // Expiry with NO cleanup: the admission record stays in place,
    // only its expires_at passes — everything must fail closed.
    await owner.query(`UPDATE agy_workers SET metadata=jsonb_set(metadata,'{admission,expires_at}',to_jsonb($1::text)) WHERE worker_id='GEMINI-SEO-WORKER'`,
      [new Date(Date.now() - 1000).toISOString()]);
    await assert.rejects(() => surface(gemini, scope, 'arrive', {}), /ADMISSION_EXPIRED/);
    const late = await surface(gemini, scope, 'claim', {});
    assert.equal(late.status, 'DENIED');
    assert.equal(late.reason, 'ADMISSION_EXPIRED');
    assert.equal((await q(`SELECT attempt FROM agy_tasks WHERE task_id=$1`, [videoId]))[0].attempt, 0,
      'video task still untouched after expiry');
  } finally {
    if (runtime) await runtime.end().catch(() => {});
    await owner.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await owner.end().catch(() => {}); await admin.end().catch(() => {});
  }
});
