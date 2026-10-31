// AGY Gemini worker route repair — 20261030 (job gl_4d5bd416-63fb-47c6-9dd8-12fb289c3c4e).
// Scope honesty: every test here runs against a LOCAL fake connector / stub
// worker surface on 127.0.0.1. No real Gemini provider, no production AGY
// runtime, no business task was contacted. These tests qualify the ADAPTER
// and SURFACE parsing/identity contract only; they are not an end-to-end
// PASS for task gl_7ff68d2e-0c33-482b-be41-af18fb0f77dc.
// T1 adapter basic | T2 structured schema | T3 task identity |
// T4 callback identity (no cross-task result) | T5 duplicate protection |
// T6 failure parsing | T7 timeout/reconcile | T8 existing-task catch-up
// (dry-run envelope carrying the existing task/job ids, unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type RequestListener} from 'node:http';
import {HttpJsonAdapter, ConnectorError} from '../src/adapters.js';
import {createWorkerUi} from '../src/platform/worker-ui.js';
import type {ClaimedTask} from '../src/types.js';

const TASK_ID = 'gl_7ff68d2e-0c33-482b-be41-af18fb0f77dc';
const JOB_ID = 'gl_4d5bd416-63fb-47c6-9dd8-12fb289c3c4e';
const ENVELOPE_KEY = 'AGY|GEMINI|gl_7ff68d2e|A1';

function task(payload: Record<string, unknown> = {}, key = ENVELOPE_KEY): ClaimedTask {
  return {taskId: TASK_ID, jobId: JOB_ID, name: 'gemini-route-repair-dry-run', taskType: 'planning',
    idempotencyKey: key, status: 'CLAIMED', attempt: 1, leaseToken: 'lease-test-1',
    leaseExpiresAt: new Date(Date.now() + 120_000), payload,
    checkpoint: {idempotencyKey: key, digest: 'test-digest', adapter: 'gemini'}} as ClaimedTask;
}

interface Seen {url: string; body: any; headers: any}
// Fake AGY connector: dedupes business executions by idempotency key, the
// way the connector contract requires. Modes are driven by payload.mode.
function fakeConnector(seen: Seen[], business: {executions: number}) {
  const byKey = new Map<string, string>();
  const dropped = new Set<string>();
  const handler: RequestListener = async (req, res) => {
    const parts: Buffer[] = []; for await (const c of req) parts.push(Buffer.from(c as any));
    const text = Buffer.concat(parts).toString();
    let body: any; try { body = JSON.parse(text); } catch { body = {}; }
    seen.push({url: String(req.url), body, headers: req.headers});
    const json = (obj: unknown, type = 'application/json') => { res.setHeader('content-type', type); res.setHeader('x-request-id', 'fake-req-1'); res.end(JSON.stringify(obj)); };
    if (req.url === '/execute') {
      const key = String(body.idempotency_key ?? '');
      const mode = String(body.task?.payload?.mode ?? 'json');
      if (mode === 'drop-first' && !dropped.has(key)) { dropped.add(key); business.executions++; byKey.set(key, 'op-drop'); (res as any).socket?.destroy(); return; }
      if (!byKey.has(key)) { business.executions++; byKey.set(key, mode === 'sse' ? 'op-sse' : mode.startsWith('result-') ? `op-${mode}` : 'op-1'); }
      const externalId = byKey.get(key)!;
      if (mode === 'html-ok') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<html><body>worker ui page, not json</body></html>'); return; }
      if (mode === 'sse') { res.setHeader('content-type', 'text/event-stream'); res.end(`data: {"partial":true}\n\ndata: ${JSON.stringify({externalId})}\n\n`); return; }
      json({externalId}); return;
    }
    const m = String(req.url).match(/^\/(status|result)\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[2]);
      if (id === 'op-malformed') { res.setHeader('content-type', 'application/json'); res.end('{not json'); return; }
      if (m[1] === 'status') { json({state: 'SUCCEEDED', externalOperationId: id}); return; }
      if (id === 'op-result-string') { json({state: 'SUCCEEDED', externalOperationId: id, output: JSON.stringify({summary: 'structured', score: 1})}); return; }
      if (id === 'op-result-fenced') { json({state: 'SUCCEEDED', externalOperationId: id, output: 'Here is the result:\n```json\n{"summary":"fenced"}\n```'}); return; }
      if (id === 'op-result-bad') { json({state: 'SUCCEEDED', externalOperationId: id, output: 'plain prose, no json object'}); return; }
      if (id === 'op-result-mismatch') { json({state: 'SUCCEEDED', externalOperationId: 'op-someone-else', output: {summary: 'wrong task'}}); return; }
      json({state: 'SUCCEEDED', externalOperationId: id, output: {summary: 'ok'}}); return;
    }
    if (req.url === '/usage/op-1') { json({tokens: 3}); return; }
    res.statusCode = 404; res.end('{}');
  };
  return handler;
}

async function fixture(run: (adapter: HttpJsonAdapter, seen: Seen[], business: {executions: number}) => Promise<void>) {
  const seen: Seen[] = []; const business = {executions: 0};
  const server = createServer(fakeConnector(seen, business));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const a = server.address(); assert.ok(a && typeof a !== 'string');
  try { await run(new HttpJsonAdapter('gemini', ['text', 'planning', 'qa'], `http://127.0.0.1:${a.port}`), seen, business); }
  finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
const isCode = (code: string) => (e: any) => e instanceof ConnectorError && e.code === code;

test('T1 adapter basic: JSON execute/status/result round-trip parses', async () => {
  await fixture(async adapter => {
    const {externalId} = await adapter.execute(task(), new AbortController().signal);
    assert.equal(externalId, 'op-1');
    assert.equal((await adapter.check_status(externalId)).state, 'SUCCEEDED');
    const collected = await adapter.collect_result(externalId);
    assert.equal(collected.state, 'SUCCEEDED');
    assert.deepEqual(collected.output, {summary: 'ok'});
  });
});

test('T1b adapter basic: SSE/streaming body contributes its final data frame', async () => {
  await fixture(async adapter => {
    const {externalId} = await adapter.execute(task({mode: 'sse'}), new AbortController().signal);
    assert.equal(externalId, 'op-sse');
  });
});

test('T2 structured schema: string and fenced JSON outputs validate to objects', async () => {
  await fixture(async adapter => {
    const a = await adapter.execute(task({mode: 'result-string'}), new AbortController().signal);
    assert.deepEqual((await adapter.collect_result(a.externalId)).output, {summary: 'structured', score: 1});
    const b = await adapter.execute(task({mode: 'result-fenced'}, ENVELOPE_KEY + '|FENCED'), new AbortController().signal);
    assert.deepEqual((await adapter.collect_result(b.externalId)).output, {summary: 'fenced'});
  });
});

test('T2b structured schema: non-object string output is a deterministic failure', async () => {
  await fixture(async adapter => {
    const a = await adapter.execute(task({mode: 'result-bad'}), new AbortController().signal);
    await assert.rejects(() => adapter.collect_result(a.externalId),
      (e: any) => isCode('RESULT_SCHEMA_INVALID')(e) && e.retryable === false);
  });
});

test('T3 task identity: envelope task/job/attempt and idempotency key reach the connector unchanged', async () => {
  await fixture(async (adapter, seen) => {
    await adapter.execute(task(), new AbortController().signal);
    const exec = seen.find(s => s.url === '/execute')!;
    assert.equal(exec.body.task.taskId, TASK_ID);
    assert.equal(exec.body.task.jobId, JOB_ID);
    assert.equal(exec.body.task.attempt, 1);
    assert.equal(exec.body.idempotency_key, ENVELOPE_KEY);
    assert.equal(exec.headers['idempotency-key'], ENVELOPE_KEY);
  });
});

test('T4 callback identity: a result naming another execution is rejected, never committed', async () => {
  await fixture(async adapter => {
    const a = await adapter.execute(task({mode: 'result-mismatch'}), new AbortController().signal);
    await assert.rejects(() => adapter.collect_result(a.externalId),
      (e: any) => isCode('RESULT_IDENTITY_MISMATCH')(e) && e.retryable === false);
    // The matching execution still collects under its own identity only.
    const b = await adapter.execute(task({}, ENVELOPE_KEY + '|MATCH'), new AbortController().signal);
    const ok = await adapter.collect_result(b.externalId);
    assert.equal(ok.externalOperationId, b.externalId);
  });
});

test('T5 duplicate protection: same task+attempt+key executes business work once', async () => {
  await fixture(async (adapter, _seen, business) => {
    const first = await adapter.execute(task(), new AbortController().signal);
    const second = await adapter.execute(task(), new AbortController().signal);
    assert.equal(second.externalId, first.externalId);
    assert.equal(business.executions, 1);
  });
});

test('T6 failure parsing: non-JSON success on /execute is SUBMISSION_UNCERTAIN with redacted diagnostic, not a SyntaxError', async () => {
  await fixture(async adapter => {
    await assert.rejects(() => adapter.execute(task({mode: 'html-ok'}), new AbortController().signal),
      (e: any) => e instanceof ConnectorError && !(e instanceof SyntaxError) && e.code === 'SUBMISSION_UNCERTAIN'
        && e.retryable === false && e.diagnostic?.cause === 'NON_JSON_RESPONSE'
        && String(e.diagnostic?.contentType).includes('text/html'));
  });
});

test('T6b failure parsing: malformed JSON on a read is deterministic NON_JSON_RESPONSE', async () => {
  await fixture(async adapter => {
    await assert.rejects(() => adapter.collect_result('op-malformed'),
      (e: any) => isCode('NON_JSON_RESPONSE')(e) && e.retryable === false && !(e instanceof SyntaxError));
  });
});

test('T7 timeout/reconcile: dropped submission is uncertain, single attempt, reconcile by same key finds the same execution', async () => {
  await fixture(async (adapter, seen, business) => {
    await assert.rejects(() => adapter.execute(task({mode: 'drop-first'}), new AbortController().signal), isCode('SUBMISSION_UNCERTAIN'));
    assert.equal(seen.filter(s => s.url === '/execute').length, 1, 'no blind in-call replay');
    // Reconcile (not a blind retry): same task, same idempotency key.
    const reconciled = await adapter.execute(task({mode: 'drop-first'}), new AbortController().signal);
    assert.equal(reconciled.externalId, 'op-drop');
    assert.equal(business.executions, 1, 'provider business execution was not duplicated');
  });
});

test('T8 catch-up compatibility: dry-run envelope for the existing task completes without minting a new job', async () => {
  await fixture(async (adapter, seen) => {
    const t = task({dry_run: true});
    const {externalId} = await adapter.execute(t, new AbortController().signal);
    const status = await adapter.check_status(externalId);
    const collected = await adapter.collect_result(externalId);
    assert.equal(status.state, 'SUCCEEDED');
    // Evidence shape the worker result/callback carries (qa stays PENDING:
    // this is a PASS candidate only, never a self-declared PASS).
    const evidence = {external_operation_id: externalId, qa_state: 'PENDING'};
    assert.equal(evidence.external_operation_id, 'op-1');
    assert.equal(collected.externalOperationId, externalId);
    for (const s of seen) { if (s.body?.task) { assert.equal(s.body.task.taskId, TASK_ID); assert.equal(s.body.task.jobId, JOB_ID); } }
  });
});

// --- Worker UI surface: the browser-adapter route Gemini was registered on.
const scope = {tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION'};
async function uiFixture(run: (base: string) => Promise<void>) {
  const ui = createWorkerUi({secret: '<redacted>', ttlSeconds: 1800,
    identities: [{subject: 'gemini-worker', token: '<redacted>', role: 'worker', workerId: 'GEMINI-SEO-WORKER', scopes: [scope]}],
    surface: async (principal: any, _scope: any, action: string) => {
      assert.equal(principal.workerId, 'GEMINI-SEO-WORKER');
      if (action === 'claim') return {status: 'LEASED', task_id: TASK_ID, attempt: 1};
      return {status: 'OK', action};
    }});
  const server = createServer(async (req, res) => { if (!await ui(req, res)) { res.statusCode = 404; res.end('{}'); } });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const a = server.address(); assert.ok(a && typeof a !== 'string');
  try { await run(`http://127.0.0.1:${a.port}`); }
  finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}
async function signIn(base: string): Promise<{cookie: string; csrf: string}> {
  const get = await fetch(`${base}/worker/ui`);
  const preCookie = (get.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  const html = await get.text();
  const pre = html.match(/name="pre_csrf" value="([^"]+)"/)![1];
  const res = await fetch(`${base}/worker/ui/signin`, {method: 'POST', redirect: 'manual',
    headers: {'content-type': 'application/x-www-form-urlencoded', origin: base, cookie: preCookie},
    body: new URLSearchParams({token: '<redacted>', pre_csrf: pre}).toString()});
  const cookie = (res.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).filter(c => c.startsWith('agy_worker_session=')).join('; ');
  const form = await res.text();
  const csrf = form.match(/name="csrf" value="([^"]+)"/)![1];
  assert.ok(cookie && csrf);
  return {cookie, csrf};
}

test('UI-1 form action defaults to the HTML envelope (legacy DOM flow unchanged)', async () => {
  await uiFixture(async base => {
    const {cookie, csrf} = await signIn(base);
    const res = await fetch(`${base}/worker/ui/action`, {method: 'POST', redirect: 'manual',
      headers: {'content-type': 'application/x-www-form-urlencoded', origin: base, cookie},
      body: new URLSearchParams({action: 'claim', csrf}).toString()});
    assert.ok(String(res.headers.get('content-type')).includes('text/html'));
    const body = await res.text();
    assert.ok(body.includes('agy-response-envelope'));
    assert.throws(() => JSON.parse(body), SyntaxError, 'whole-body JSON parse fails on the HTML envelope — the observed Non-JSON mechanism');
  });
});

test('UI-2 form action with Accept: application/json returns a directly parseable JSON body', async () => {
  await uiFixture(async base => {
    const {cookie, csrf} = await signIn(base);
    const res = await fetch(`${base}/worker/ui/action`, {method: 'POST', redirect: 'manual',
      headers: {'content-type': 'application/x-www-form-urlencoded', origin: base, cookie, accept: 'application/json'},
      body: new URLSearchParams({action: 'claim', csrf}).toString()});
    assert.ok(String(res.headers.get('content-type')).includes('application/json'));
    const body = JSON.parse(await res.text());
    assert.equal(body.ok, true);
    assert.equal(body.result.status, 'LEASED');
    assert.equal(body.result.task_id, TASK_ID);
  });
});

test('UI-3 malformed JSON body is a deterministic INVALID_JSON_BODY, not REQUEST_FAILED', async () => {
  await uiFixture(async base => {
    const {cookie, csrf} = await signIn(base);
    const res = await fetch(`${base}/worker/ui/action`, {method: 'POST', redirect: 'manual',
      headers: {'content-type': 'application/json', origin: base, cookie},
      body: '{"action":"claim","csrf":"' + csrf + '", broken'});
    const body = JSON.parse(await res.text());
    assert.equal(body.ok, false);
    assert.equal(body.error, 'INVALID_JSON_BODY');
  });
});
