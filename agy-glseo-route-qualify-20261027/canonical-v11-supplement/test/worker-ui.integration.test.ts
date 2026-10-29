// Integration tests for the CANDIDATE browser worker UI v2 (findings
// S4–S5). Evidence class: LOCAL integration — real local PostgreSQL
// 18.4, repo migrations 001-008 + candidate 012, real HTTP through the
// patched gateway entrypoint. The UI dispatches ONLY to the canonical
// worker surface v3; no shadow RPC exists in this tree's request path.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID, createHmac } from "node:crypto";
import { Pool } from "pg";
import { ProjectPool } from "../src/platform/scoped-pool.js";
import { ProjectService } from "../src/platform/service.js";
import { ResourceStore } from "../src/resource-store.js";
import { discoverResource } from "../src/resources/discovery.js";
import { createWorkerSurface } from "../src/platform/worker-surface.js";
import { createWorkerUi } from "../src/platform/worker-ui.js";
import { createGatewayHttpServer } from "../src/temporal/http-server.js";
import type { IdentityConfig, Principal } from "../src/platform/auth.js";

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' };
const SECRET = 'test-ui-secret';
// auth.ts IdentityConfig carries the raw server-side token (test-local).
const identities: IdentityConfig[] = [
  { subject: 'control-op', token: 'operator-token', role: 'operator', scopes: [scope] },
  { subject: 'claude-worker', token: 'claude-ui-token', role: 'worker', workerId: 'MUSE-SEO-WORKER', scopes: [scope] },
  { subject: 'evil-worker', token: 'evil-token', role: 'worker', workerId: 'W<svg onload=1>', scopes: [scope] },
];
const op: Principal = { subject: 'control-op', role: 'operator', scopes: [scope] };

test("worker UI v2: Origin, login CSRF, revocation, escaping, full form flow",
  { skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const schema = `agy_ui2_${randomUUID().replaceAll('-', '')}`;
  const role = `agy_ui2_role_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const owner = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
  let runtime: Pool | undefined; let server: any;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','012_worker_callbacks.sql'])
      await owner.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    const seed = await owner.connect();
    try { await seed.query('BEGIN');
      await seed.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query("INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'Greenlife Spa','repo:gl','policy:gl') ON CONFLICT DO NOTHING", [scope.tenantId, scope.workspaceId, scope.projectId]);
      await seed.query("INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES($1,$2,$3,'muse-x','muse',ARRAY['text'],'local','vault:test',true,ARRAY['read','analyze','planning','qa'])", [scope.tenantId, scope.workspaceId, scope.projectId]);
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
    // LOCAL TEST FIXTURE values only (see C6 note in the surface tests).
    await resources.register({ ...discoverResource('MUSE-SEO-WORKER', ['text', 'planning'], Date.now()), status: 'READY', ready: true,
      quotaRemaining: 100, quotaReserve: 20, maxConcurrency: 1, passRate: .95, retryRate: 0, errorRate: 0, contextLossRisk: 0,
      costPerTask: 0, spendCap: 0, quotaCap: 200, permissions: ['read', 'analyze', 'planning', 'qa'] }, 'muse');
    await owner.query(`UPDATE agy_workers SET metadata=$1 WHERE worker_id='MUSE-SEO-WORKER'`,
      [JSON.stringify({ bindings: { missions: ['M-SEO'], task_types: ['planning'], reply_targets: ['CHATGPT_ASSISTANT_CONTROL_PLANE'] } })]);
    const service = new ProjectService(runtime, scope, op);
    await service.execute('/jobs', 'POST', { idempotency_key: 'ui-job', objective: 'ui job', tasks: [{ name: 'ui-task', idempotencyKey: 'ui-t',
      taskType: 'planning', requiredCapabilities: ['text', 'planning'], requiredPermissions: ['read'], permissionGranted: true,
      safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0,
      payload: { mission_id: 'M-SEO', target_worker_id: 'MUSE-SEO-WORKER', callback_target: 'CHATGPT_ASSISTANT_CONTROL_PLANE' } }] });

    const surface = createWorkerSurface(runtime);
    const ui = createWorkerUi({ identities, surface, secret: SECRET });
    server = createGatewayHttpServer({ identities, worker: surface, ui,
      status: async () => ({}), start: async () => ({ status: 'ACCEPTED', run_id: 'x', replayed: false }),
      signal: async () => ({ status: 'ACCEPTED' }), query: async () => ({}) } as any);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path: string, init: any = {}) => {
      const res = await fetch(base + path, { redirect: 'manual', ...init });
      return { status: res.status, headers: res.headers, body: await res.text() };
    };
    const asJson = (r: any) => JSON.parse(r.body);
    // T2: results are read from the VISIBLE rendered envelope text
    // (<pre id="agy-response-envelope">), the way a DOM/AX worker sees
    // them — never from a hidden script block.
    const unesc = (t: string) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const envelopeJson = (htmlBody: string) => JSON.parse(unesc(htmlBody.match(/<pre id="agy-response-envelope">([\s\S]*?)<\/pre>/)![1]));
    const cookiesFrom = (r: any) => (r.headers.getSetCookie?.() ?? []).map((c: string) => c.split(';')[0]);
    const freshPre = async () => {
      const home = await call('/worker/ui');
      assert.equal(home.status, 200); assert.match(home.body, /agy-signin-form/);
      const pre = home.body.match(/name="pre_csrf" value="([^"]+)"/)![1];
      const preCookie = cookiesFrom(home).find((c: string) => c.startsWith('agy_ui_pre='))!;
      return { pre, preCookie };
    };
    const signin = async (token: string, opts: any = {}) => {
      const headers: any = { 'content-type': 'application/json', cookie: opts.preCookie ?? '' };
      if (opts.origin !== null) headers.origin = opts.origin ?? base;
      const payload: any = { token };
      if (!opts.skipPre) payload.pre_csrf = opts.pre;
      if (opts.scopeFields) Object.assign(payload, opts.scopeFields);
      return call('/worker/ui/signin', { method: 'POST', headers, body: JSON.stringify(payload) });
    };

    // S4: sign-in defenses — Origin required/exact, login CSRF, then auth.
    const { pre, preCookie } = await freshPre();
    const noOrigin = await signin('claude-ui-token', { pre, preCookie, origin: null });
    assert.equal(noOrigin.status, 403); assert.equal(asJson(noOrigin).error, 'ORIGIN_REQUIRED');
    const noPre = await signin('claude-ui-token', { pre, preCookie, skipPre: true });
    assert.equal(noPre.status, 403); assert.equal(asJson(noPre).error, 'CSRF_DENIED');
    const evilOrigin = await signin('claude-ui-token', { pre, preCookie, origin: 'https://evil.example' });
    assert.equal(evilOrigin.status, 403); assert.equal(asJson(evilOrigin).error, 'ORIGIN_DENIED');
    const bad = await signin('wrong', { pre, preCookie });
    assert.equal(bad.status, 401);
    const opSignin = await signin('operator-token', { pre, preCookie });
    assert.equal(opSignin.status, 403);
    const ok = await signin('claude-ui-token', { pre, preCookie, scopeFields: { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' } });
    assert.equal(ok.status, 200); assert.equal(asJson(ok).http_status, 200);
    const setCookies = ok.headers.getSetCookie?.() ?? [];
    const sessionSet = setCookies.find((c: string) => c.startsWith('agy_worker_session='));
    assert.ok(sessionSet); assert.match(sessionSet, /HttpOnly/); assert.match(sessionSet, /Secure/); assert.match(sessionSet, /SameSite=Lax/);
    const cookie = sessionSet.split(';')[0];
    const csrf = asJson(ok).csrf; assert.ok(csrf);

    // S5: the action form carries every field a DOM worker needs.
    const formPage = await call('/worker/ui', { headers: { cookie } });
    assert.equal(formPage.status, 200);
    for (const marker of ['agy-action-form', 'name="state"', 'name="result_summary"', 'name="external_operation_id"', 'name="quota_units"', 'name="idempotency_key"', 'data-worker="MUSE-SEO-WORKER"'])
      assert.ok(formPage.body.includes(marker), `action form contains ${marker}`);

    const post = (path: string, body: any, opts: any = {}) => {
      const headers: any = { 'content-type': opts.form ? 'application/x-www-form-urlencoded' : 'application/json', cookie: opts.cookie ?? cookie };
      if (opts.origin !== null) headers.origin = opts.origin ?? base;
      return call(path, { method: 'POST', headers, body: opts.form ? new URLSearchParams(body).toString() : JSON.stringify(body) });
    };
    // S4: Origin + CSRF on actions.
    const actNoOrigin = await post('/worker/ui/action', { action: 'claim', csrf }, { origin: null });
    assert.equal(actNoOrigin.status, 403); assert.equal(asJson(actNoOrigin).error, 'ORIGIN_REQUIRED');
    const actNoCsrf = await post('/worker/ui/action', { action: 'claim' });
    assert.equal(actNoCsrf.status, 403); assert.equal(asJson(actNoCsrf).error, 'CSRF_DENIED');
    const claim = await post('/worker/ui/action', { action: 'claim', csrf }, { form: true });
    assert.equal(claim.status, 200);
    assert.ok(claim.body.includes('agy-response-envelope'), 'result renders as visible text');
    const claimEnv = envelopeJson(claim.body);
    assert.equal(claimEnv.http_status, 200); assert.equal(claimEnv.result.status, 'LEASED');
    const task = claimEnv.result.task;
    assert.ok(claim.body.includes(task.taskId) && claim.body.includes(task.leaseToken),
      'task id and lease token are visible in the rendered DOM text');

    // Tampered / expired sessions are 401 (with Origin + CSRF present).
    const tampered = await post('/worker/ui/action', { action: 'readback', csrf, task_id: task.taskId }, { cookie: cookie.slice(0, -4) + 'AAAA' });
    assert.equal(tampered.status, 401);
    const expiredPayload = Buffer.from(JSON.stringify({ sub: 'claude-worker', workerId: 'MUSE-SEO-WORKER', scope, exp: Math.floor(Date.now() / 1000) - 10, csrf })).toString('base64url');
    const expiredSig = createHmac('sha256', SECRET).update(expiredPayload).digest('base64url');
    const expired = await post('/worker/ui/action', { action: 'claim', csrf }, { cookie: `agy_worker_session=${expiredPayload}.${expiredSig}` });
    assert.equal(expired.status, 401); assert.equal(asJson(expired).error, 'SESSION_EXPIRED');

    // Full form flow with stable DOM envelopes; result composed from
    // PLAIN fields (summary + external operation id), no raw JSON.
    const ack = await post('/worker/ui/action', { action: 'ack', csrf, task_id: task.taskId, lease_token: task.leaseToken, attempt: String(task.attempt) }, { form: true });
    assert.match(ack.body, /data-ok="true"/); assert.match(ack.body, /data-http-status="200"/);
    assert.equal(envelopeJson(ack.body).result.status, 'RUNNING');
    const ck = await post('/worker/ui/action', { action: 'checkpoint', csrf, task_id: task.taskId, lease_token: task.leaseToken, attempt: String(task.attempt), external_id: 'op-ui-1', state: JSON.stringify({ step: 'ui' }) }, { form: true });
    assert.equal(envelopeJson(ck.body).result.status, 'CHECKPOINTED');
    assert.equal(envelopeJson(ck.body).result.version, 1);
    const resFields = { action: 'result', csrf, task_id: task.taskId, lease_token: task.leaseToken, attempt: String(task.attempt), result_summary: 'via browser', external_operation_id: 'op-ui-1' };
    const res1 = await post('/worker/ui/action', resFields, { form: true });
    assert.equal(envelopeJson(res1.body).result.status, 'RESULT_SUBMITTED');
    const conflict = await post('/worker/ui/action', { ...resFields, result_summary: 'CHANGED' }, { form: true });
    assert.match(conflict.body, /data-ok="false"/); assert.match(conflict.body, /data-http-status="403"/);
    assert.equal(envelopeJson(conflict.body).error, 'RESULT_CONTENT_CONFLICT');
    const rb = await post('/worker/ui/action', { action: 'readback', csrf, task_id: task.taskId }, { form: true });
    assert.equal(envelopeJson(rb.body).result.callback.status, 'PENDING');
    assert.equal((await owner.query(`SELECT status FROM agy_tasks WHERE task_id=$1`, [task.taskId])).rows[0].status, 'QA');

    // S4: sign-out requires CSRF too.
    const soNoCsrf = await post('/worker/ui/signout', {});
    assert.equal(soNoCsrf.status, 403); assert.equal(asJson(soNoCsrf).error, 'CSRF_DENIED');
    const so = await post('/worker/ui/signout', { csrf });
    assert.equal(so.status, 200); assert.equal(asJson(so).status, 'SIGNED_OUT');
    assert.ok((so.headers.getSetCookie?.() ?? []).some((c: string) => c.includes('Max-Age=0')));

    // S4: identity/scope values are HTML-escaped in the action form.
    const pre2 = await freshPre();
    const evil = await signin('evil-token', { pre: pre2.pre, preCookie: pre2.preCookie });
    assert.equal(evil.status, 200);
    const evilCookie = (evil.headers.getSetCookie?.() ?? []).find((c: string) => c.startsWith('agy_worker_session='))!.split(';')[0];
    const evilPage = await call('/worker/ui', { headers: { cookie: evilCookie } });
    assert.ok(evilPage.body.includes('W&lt;svg onload=1&gt;'), 'worker id is escaped');
    assert.ok(!evilPage.body.includes('<svg onload=1>'), 'no raw injection');

    // S4: removing the identity revokes even a validly signed session.
    const idx = identities.findIndex((i) => i.subject === 'claude-worker');
    identities.splice(idx, 1);
    const revoked = await post('/worker/ui/action', { action: 'readback', csrf, task_id: task.taskId });
    assert.equal(revoked.status, 401); assert.equal(asJson(revoked).error, 'SESSION_REVOKED');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    if (runtime) await runtime.end();
    await owner.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin.end();
  }
});
