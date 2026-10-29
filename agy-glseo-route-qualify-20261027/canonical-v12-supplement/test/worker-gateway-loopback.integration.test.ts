// Loopback integration tests for the canonical gateway HTTP
// transport + the custom.agy-worker CLI candidate.
// Evidence class: LOCAL — the real createGatewayHttpServer, the
// real worker surface and callback receiver, a real local
// PostgreSQL 18.4 (embedded), real HTTP on a loopback port, and
// the real Python CLI driven by test/agy-worker-cli-driver.py.
// The ONLY stub is the CLI's credential swap (the test identity
// token stands in for the registered connection's surrogate swap,
// because no connection exists in a test environment). Nothing
// here is live evidence: the deployed gateway was not touched.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { Pool } from "pg";
import { createGatewayHttpServer } from "../src/temporal/http-server.js";
import { createWorkerSurface } from "../src/platform/worker-surface.js";
import { createCallbackReceiver } from "../src/platform/worker-callback-receiver.js";
import { createQualificationController, QUALIFICATION_SCOPE } from "../src/platform/qualification-controller.js";
import type { IdentityConfig } from "../src/platform/auth.js";

const scopeQ = QUALIFICATION_SCOPE;
const scopeBiz = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLI_PATH = process.env.AGY_WORKER_CLI_PATH ?? "/home/hatch/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py";

test("gateway loopback: HTTP transport contract + CLI driver (wrong token/worker/project, disconnect claim, stale lease, duplicates, callback lookup)",
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const schema = `agy_loop_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_loop_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const owner = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  let runtime: Pool | undefined;
  let server: ReturnType<typeof createGatewayHttpServer> | undefined;
  const q = async (sql: string, params?: unknown[]) => (await owner.query(sql, params as any)).rows;
  const scopedTx = async (scope: typeof scopeQ, fn: (c: any) => Promise<void>) => {
    const c = await owner.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true),set_config('agy.subject','setup',true)",
        [scope.tenantId, scope.workspaceId, scope.projectId]);
      await fn(c);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','012_worker_callbacks.sql'])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
    await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    runtime = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public -c role=${role}` });
    const rawQ: Pool = runtime;
    // Business scope seeded for wrong-project checks + byte-identity.
    await scopedTx(scopeBiz, async (c) => {
      await c.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'Greenlife Spa','repo:gl','policy:gl') ON CONFLICT DO NOTHING`,
        [scopeBiz.tenantId, scopeBiz.workspaceId, scopeBiz.projectId]);
      await c.query(`UPDATE agy_projects SET status='ACTIVE',priority=5,permissions=ARRAY['read','analyze','planning','qa'],resource_policy='{"maxConcurrentTasks":2,"quotaCap":100,"spendCap":0,"reservation":0}' WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_AUTOMATION'`);
    });
    await owner.query(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES('MUSE-SEO-WORKER','muse',ARRAY['planning'],'OFFLINE',1,'{"spendCap":0,"quotaCap":null}',null,0,false,'{"team":"business"}')`);
    const bizWorkerBefore = (await q(`SELECT status,metadata,quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0];

    // The qualification window, granted by the controller candidate.
    const cfg = { enabled: true, runId: 'run-loop', expiresAtMs: Date.now() + 120_000, intervalMs: 50 };
    const ctl = createQualificationController(rawQ, { config: cfg, log: () => {} });
    ctl.start();
    for (let i = 0; i < 80; i++) { if (ctl.state() === 'ACTIVE' || ctl.state() === 'BLOCKED') break; await sleep(50); }
    assert.equal(ctl.state(), 'ACTIVE');
    ctl.stop();
    const job = (await q(`SELECT job_id FROM agy_jobs WHERE idempotency_key='run-loop'`))[0];
    const task = (await q(`SELECT task_id FROM agy_tasks WHERE job_id=$1`, [job.job_id]))[0];

    const identities: IdentityConfig[] = [
      { subject: 'claude-qual-worker', role: 'worker', workerId: 'MUSE-QUAL-WORKER', scopes: [scopeQ], token: 'loopback-qual-token' },
      { subject: 'control-plane', role: 'operator', scopes: [scopeQ], token: 'loopback-op-token' },
      { subject: 'ghost', role: 'worker', workerId: 'GHOST-WORKER', scopes: [scopeQ], token: 'loopback-ghost-token' },
      { subject: 'claude-biz-worker', role: 'worker', workerId: 'MUSE-SEO-WORKER', scopes: [scopeBiz], token: 'loopback-biz-token' },
    ];
    server = createGatewayHttpServer({
      identities,
      execute: async () => { throw new Error('MISSION_ACTIONS_UNUSED'); },
      health: async () => ({ postgres: true, temporal: true, worker: true }),
      worker: createWorkerSurface(rawQ),
      callbacks: createCallbackReceiver(rawQ),
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const wp = (project: string, action: string) => `/v1/worker/tenants/gl/workspaces/legacy-workspace/projects/${project}/${action}`;
    const call = async (method: string, path: string, token?: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json().catch(() => ({})) as any };
    };

    // Health: public, READY, canonical authority named.
    const health = await call('GET', '/health');
    assert.equal(health.status, 200); assert.equal(health.json.status, 'READY');
    assert.equal(health.json.canonical_authority, 'EXISTING_POSTGRES_D049');

    // Wrong/absent credentials over HTTP.
    assert.equal((await call('POST', wp('GL_QUALIFICATION', 'arrive'), undefined, {})).status, 401, 'no token -> 401');
    const badTok = await call('POST', wp('GL_QUALIFICATION', 'arrive'), 'not-a-token', {});
    assert.equal(badTok.status, 401); assert.equal(badTok.json.error, 'UNAUTHORIZED');
    const ghost = await call('POST', wp('GL_QUALIFICATION', 'arrive'), 'loopback-ghost-token', {});
    assert.equal(ghost.status, 400); assert.equal(ghost.json.error, 'WORKER_NOT_PROVISIONED',
      'an authenticated but unprovisioned worker cannot arrive (no self-provisioning)');

    // Wrong project in both directions is a scope denial, not a leak.
    const wrongProj = await call('POST', wp('GL_AUTOMATION', 'claim'), 'loopback-qual-token', {});
    assert.equal(wrongProj.status, 403); assert.equal(wrongProj.json.error, 'PROJECT_SCOPE_DENIED');
    const wrongProj2 = await call('POST', wp('GL_QUALIFICATION', 'claim'), 'loopback-biz-token', {});
    assert.equal(wrongProj2.status, 403); assert.equal(wrongProj2.json.error, 'PROJECT_SCOPE_DENIED');

    // Arrive over the real route (the v12 route fix), then the
    // DISCONNECT claim: a complete claim request whose client
    // destroys the socket without reading the response. The claim
    // must commit exactly once server-side.
    const arrived = await call('POST', wp('GL_QUALIFICATION', 'arrive'), 'loopback-qual-token', {});
    assert.equal(arrived.status, 200); assert.equal(arrived.json.status, 'READY');
    const claimBody = JSON.stringify({});
    const rawReq = `POST ${wp('GL_QUALIFICATION', 'claim')} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nauthorization: Bearer loopback-qual-token\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(claimBody)}\r\nconnection: close\r\n\r\n${claimBody}`;
    await new Promise<void>((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => { sock.write(rawReq, () => { sock.destroy(); resolve(); }); });
      sock.on('error', () => resolve());
    });
    await sleep(500);
    const claimedRow = (await q(`SELECT status,attempt,lease_token FROM agy_tasks WHERE task_id=$1`, [task.task_id]))[0];
    assert.equal(claimedRow.status, 'CLAIMED', 'the disconnected claim committed server-side');
    assert.equal(Number(claimedRow.attempt), 1);
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_resource_reservations`))[0].n, 1, 'exactly one reservation exists');
    const secondClaim = await call('POST', wp('GL_QUALIFICATION', 'claim'), 'loopback-qual-token', {});
    assert.equal(secondClaim.json.status, 'EMPTY', 'no duplicate lease is issued after the disconnect');
    const rb0 = await call('POST', wp('GL_QUALIFICATION', 'readback'), 'loopback-qual-token', { task_id: task.task_id });
    assert.equal(rb0.json.task.status, 'CLAIMED', 'readback is the recovery read: the worker sees its committed claim');

    // Stale lease over HTTP: force the stored lease into the past
    // (fixture), heartbeat is denied; restore it and continue.
    const leaseToken = String(claimedRow.lease_token);
    const lease = { task_id: task.task_id, lease_token: leaseToken, attempt: 1 };
    await scopedTx(scopeQ, async (c) => { await c.query(`UPDATE agy_tasks SET lease_expires_at=now()-interval '5 seconds' WHERE task_id=$1`, [task.task_id]); });
    const staleHb = await call('POST', wp('GL_QUALIFICATION', 'heartbeat'), 'loopback-qual-token', lease);
    assert.equal(staleHb.status, 400); assert.equal(staleHb.json.error, 'LEASE_EXPIRED');
    await scopedTx(scopeQ, async (c) => { await c.query(`UPDATE agy_tasks SET lease_expires_at=now()+interval '300 seconds' WHERE task_id=$1`, [task.task_id]); });

    // The real CLI drives the rest of the lifecycle.
    const workdir = await mkdtemp(join(tmpdir(), 'agy-loop-'));
    const leaseFile = join(workdir, 'lease.json');
    await writeFile(leaseFile, JSON.stringify({ status: 'LEASED', task: { taskId: task.task_id, leaseToken, attempt: 1 } }));
    const sessionFile = join(workdir, 'session.json');
    await writeFile(sessionFile, JSON.stringify({
      base_url: base, token: 'loopback-qual-token', wrong_token: 'loopback-WRONG-token',
      lease_file: leaseFile, workdir, result: { summary: 'loopback driver result' },
      external_operation_id: 'op-loop-1', checkpoint_external_id: 'op-loop-ckpt',
    }));
    const driverOut = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile('python3', [new URL('./agy-worker-cli-driver.py', import.meta.url).pathname, sessionFile, CLI_PATH],
        { timeout: 60000 }, (err, stdout, stderr) =>
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr }));
    });
    assert.equal(driverOut.code, 0, `CLI driver failed:\n${driverOut.stdout}\n${driverOut.stderr}`);
    const summary = JSON.parse(driverOut.stdout.trim().split('\n').pop()!);
    assert.equal(summary.ok, true);
    const callbackId = summary.callback_id as string;
    assert.equal((await q(`SELECT status FROM agy_tasks WHERE task_id=$1`, [task.task_id]))[0].status, 'QA');
    assert.equal((await q(`SELECT state FROM agy_resource_reservations WHERE reservation_id=$1`, [leaseToken]))[0].state, 'SETTLED');

    // Checkpoint replay/conflict were exercised by the driver while
    // the task was RUNNING (after QA a checkpoint is correctly
    // denied as a stale writer, so it cannot be replayed here).

    // Result replay is exactly-once; different content conflicts.
    const resultBody = { ...lease, result: { summary: 'loopback driver result' }, evidence: { external_operation_id: 'op-loop-1' } };
    const replay = await call('POST', wp('GL_QUALIFICATION', 'result'), 'loopback-qual-token', resultBody);
    assert.equal(replay.status, 200); assert.equal(replay.json.replay, true, 'identical result returns the recorded callback');
    assert.equal((await q(`SELECT count(*)::int AS n FROM agy_worker_callbacks WHERE task_id=$1`, [task.task_id]))[0].n, 1);
    const conflict = await call('POST', wp('GL_QUALIFICATION', 'result'), 'loopback-qual-token',
      { ...resultBody, result: { summary: 'different content' } });
    assert.equal(conflict.status, 400); assert.equal(conflict.json.error, 'RESULT_CONTENT_CONFLICT');

    // Deliver the callback through the real receive route (the
    // server-side driver normally does this in-process; here the
    // HTTP route itself is under test), then read the receipt back.
    const outbox = (await q(`SELECT callback_id,task_id,attempt,worker_id,target,content_digest,payload FROM agy_worker_callbacks WHERE callback_id=$1`, [callbackId]))[0];
    const receivePath = `/v1/callbacks/tenants/gl/workspaces/legacy-workspace/projects/GL_QUALIFICATION/receive`;
    const delivered = await call('POST', receivePath, 'loopback-op-token', outbox);
    assert.equal(delivered.status, 200); assert.equal(delivered.json.accepted, true); assert.equal(delivered.json.effect_count, 1);
    const redelivered = await call('POST', receivePath, 'loopback-op-token', outbox);
    assert.equal(redelivered.json.duplicate, true); assert.equal(redelivered.json.effect_count, 1, 'replay does not double the effect');

    // Callback readback at the receiver route is operator-only.
    const cbPath = `/v1/callbacks/tenants/gl/workspaces/legacy-workspace/projects/GL_QUALIFICATION/receive/${callbackId}`;
    const look = await call('GET', cbPath, 'loopback-op-token');
    assert.equal(look.status, 200); assert.equal(look.json.found, true);
    assert.equal(look.json.task_id, task.task_id); assert.equal(look.json.effect_count, 1);
    const lookWorker = await call('GET', cbPath, 'loopback-qual-token');
    assert.equal(lookWorker.status, 403, 'the worker cannot use the operator lookup route');
    const lookUnknown = await call('GET', `/v1/callbacks/tenants/gl/workspaces/legacy-workspace/projects/GL_QUALIFICATION/receive/${randomUUID()}`, 'loopback-op-token');
    assert.equal(lookUnknown.status, 404); assert.equal(lookUnknown.json.found, false, 'a clean not-found is distinct from a route error');

    const bizWorkerAfter = (await q(`SELECT status,metadata,quota_remaining FROM agy_workers WHERE worker_id='MUSE-SEO-WORKER'`))[0];
    assert.equal(JSON.stringify(bizWorkerAfter), JSON.stringify(bizWorkerBefore), 'business worker untouched by the loopback run');
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    if (runtime) await runtime.end();
    await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  }
});
