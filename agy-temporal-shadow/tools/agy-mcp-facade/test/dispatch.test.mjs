// Tests for the agy.dispatch write tool (execution-grant
// package v1.2.1, D-G7 + section 6.1 controls, negative-test
// analogues NT-1/NT-6/NT-7/NT-8/NT-9 + facade-side DRAIN /
// HARD_REVOKE behaviour for NT-11a/NT-10/NT-11b).
// In-process app + in-memory OAuth store + STUB upstream
// implementing POST /v1/agy/dispatch. Loopback only, no real
// credentials, nothing live. The worker-side halves of
// NT-11a/NT-11b (claim/heartbeat/result on the worker
// surface) are NOT facade behaviour and are not tested here.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createFacadeApp } from "../app.mjs";
import { createAgyOAuthProvider } from "../oauth-provider.mjs";
import { InMemoryOAuthStore } from "../oauth-store.mjs";
import { createDispatchControl } from "../dispatch-control.mjs";

const OPERATOR = 'owner-approval-secret';
const P0_SCOPE = 'gl/legacy-workspace/GEMINI_UI_STAGING';
const OTHER_SCOPE = 'gl/legacy-workspace/GL_QUALIFICATION';
const mkClient = (id, extra) => ({ client_id: id, client_secret: `test-secret-${id}`,
  client_name: id, redirect_uris: [`https://chatgpt.com/connector/oauth/${id}`],
  scopes: ['agy.read', 'agy.dispatch'], subject: `${id}-subject`, ...extra });
const READER = { client_id: 'chatgpt-reader', client_secret: 'test-secret-reader', client_name: 'reader',
  redirect_uris: ['https://chatgpt.com/connector/oauth/reader'], scopes: ['agy.read'], subject: 'CHATGPT-ASSISTANT-CONTROL' };
const EXEC = mkClient('chatgpt-exec', { role: 'dispatcher', subject: 'chatgpt-exec-dispatcher' });
const NOALLOW = mkClient('not-allowlisted', { role: 'dispatcher' });
const NOROLE = mkClient('wrong-role', { role: 'operator' });
const DRAINED = mkClient('drained-client', { role: 'dispatcher', status: 'drain' });
const REVOKER = mkClient('revoker-client', { role: 'dispatcher', status: 'active' });
const CLIENTS = [READER, EXEC, NOALLOW, NOROLE, DRAINED, REVOKER];

const b64u = (b) => Buffer.from(b).toString('base64url');
const pkce = () => { const v = b64u(randomBytes(32)); return { verifier: v, challenge: b64u(createHash('sha256').update(v).digest()) }; };

async function boot() {
  const state = { dispatchHits: 0, lastMission: null };
  const upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ status: 'READY' })); return; }
      if (req.method === 'POST' && req.url === '/v1/agy/dispatch') {
        state.dispatchHits += 1;
        state.lastMission = JSON.parse(body).mission;
        res.end(JSON.stringify({ workflow_id: 'wf-test-1', run_id: 'run-wf-1', duplicate: false, evidence_class: 'CONTROLLED_SYNTHETIC' }));
        return;
      }
      if (req.url.includes('/receive/')) { res.statusCode = 404; res.end(JSON.stringify({ found: false })); return; }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    });
  });
  await new Promise((r) => upstream.listen(0, r));
  const probe = createServer();
  await new Promise((r) => probe.listen(0, r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const root = `http://127.0.0.1:${port}`;
  const store = new InMemoryOAuthStore();
  const provider = createAgyOAuthProvider({ store, clients: CLIENTS, operatorSecret: OPERATOR,
    signingSecret: 'signing-secret', resourceUrl: `${root}/mcp` });
  const dispatchControl = createDispatchControl({
    allowlist: [EXEC.client_id, NOROLE.client_id, DRAINED.client_id, REVOKER.client_id],
    taskTypes: ['HELLO'],
    runs: [{ run_id: 'P0-RUN-1', scope: P0_SCOPE, opens_at: Date.now() - 60_000, closes_at: Date.now() + 3_600_000 }],
    rateLimitMax: 3, rateLimitWindowMs: 60_000, timestampSkewMs: 300_000 });
  const app = createFacadeApp({ authMode: 'oauth', publicBaseUrl: root, oauthProvider: provider,
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}`, upstreamToken: 'upstream-token',
    allowedScopes: [P0_SCOPE, OTHER_SCOPE], dispatchControl });
  const server = await new Promise((r) => { const s = app.listen(port, () => r(s)); });
  return { root, upstream, server, state };
}

async function mcp(root, token, method, params) {
  const res = await fetch(`${root}/mcp`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (line) { try { json = JSON.parse(line.slice(5)); } catch { /* leave null */ } }
  }
  return { status: res.status, json, raw: text };
}

async function mint(root, client, scope) {
  const { verifier, challenge } = pkce();
  const resource = `${root}/mcp`;
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id,
    redirect_uri: client.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256',
    state: 'st', scope, resource });
  const authRes = await fetch(`${root}/authorize?${q}`, { redirect: 'manual' });
  const html = await authRes.text();
  const blob = /name="blob" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(blob, `consent blob issued for ${client.client_id}`);
  const consentRes = await fetch(`${root}/oauth/consent-decision`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ blob, operator_secret: OPERATOR, decision: 'approve' }) });
  const code = new URL(consentRes.headers.get('location')).searchParams.get('code');
  assert.ok(code, `code issued for ${client.client_id}`);
  const tokBody = new URLSearchParams({ grant_type: 'authorization_code', code,
    redirect_uri: client.redirect_uris[0], code_verifier: verifier, resource, client_id: client.client_id });
  tokBody.set('client_' + 'secret', client.client_secret);
  const tokRes = await fetch(`${root}/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: tokBody });
  assert.equal(tokRes.status, 200, `token issued for ${client.client_id}`);
  const tokens = await tokRes.json();
  await mcp(root, tokens.access_token, 'initialize',
    { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  return tokens.access_token;
}

const helloArgs = (over = {}) => { const [t, w, p] = P0_SCOPE.split('/'); return {
  tenant_id: t, workspace_id: w, project_id: p, task_type: 'HELLO', run_id: 'P0-RUN-1',
  mission_id: 'P0-MISSION-1', task_id: 'P0-TASK-1', executor_worker_id: 'GEMINI-SEO-WORKER',
  objective: 'provider-less HELLO (P0 proof)', idempotency_key: 'P0-HELLO-KEY-1',
  nonce: 'nonce-1', timestamp: Date.now(), ...over }; };

async function callDispatch(root, token, args) {
  const r = await mcp(root, token, 'tools/call', { name: 'agy.dispatch', arguments: args });
  const text = r.json?.result?.content?.[0]?.text;
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* denial text is not JSON */ }
  return { ...r, parsed, blob: JSON.stringify(r.json ?? r.raw) };
}

test('agy.dispatch: section-6.1 controls end to end', { timeout: 60000 }, async () => {
  const { root, upstream, server, state } = await boot();
  try {
    // Discovery advertises the dispatch scope alongside read.
    const meta = await (await fetch(`${root}/.well-known/oauth-authorization-server`)).json();
    assert.ok(meta.scopes_supported.includes('agy.read') && meta.scopes_supported.includes('agy.dispatch'));

    const readerTok = await mint(root, READER, 'agy.read');
    const execTok = await mint(root, EXEC, 'agy.read agy.dispatch');
    const noallowTok = await mint(root, NOALLOW, 'agy.read agy.dispatch');
    const noroleTok = await mint(root, NOROLE, 'agy.read agy.dispatch');
    const drainedTok = await mint(root, DRAINED, 'agy.read agy.dispatch');

    // tools/list shows the tool; claim/ack/result tools do NOT
    // exist on the facade at all (NT-2 analogue).
    const list = await mcp(root, execTok, 'tools/list', {});
    const names = (list.json?.result?.tools ?? []).map((t) => t.name);
    assert.ok(names.includes('agy.dispatch') && names.includes('agy.health') && names.includes('agy.callback_lookup'));
    assert.ok(!names.some((n) => /(^|\.)(claim|ack|heartbeat|checkpoint|result)$/.test(n)), 'no worker tools on the facade');

    // NT-1: the read-only client calling agy.dispatch is
    // denied BEFORE any upstream call.
    const nt1 = await callDispatch(root, readerTok, helloArgs());
    assert.ok(nt1.blob.includes('ACTION_DENIED'), `NT-1 denied: ${nt1.blob}`);
    assert.equal(state.dispatchHits, 0);

    // Happy path: exactly one upstream dispatch, mission in
    // the exact upstream contract shape.
    const ok = await callDispatch(root, execTok, helloArgs());
    assert.equal(ok.parsed?.dispatched, true, `happy path: ${ok.blob}`);
    assert.equal(ok.parsed?.workflow_id, 'wf-test-1');
    assert.equal(state.dispatchHits, 1);
    assert.equal(state.lastMission.mode, 'TEMPORAL_SHADOW');
    assert.equal(state.lastMission.qa_contract_version, '1.1');
    assert.equal(state.lastMission.attempt, 1);
    assert.deepEqual(state.lastMission.payload, { value: 0, delay_ms: 0, fixture: 'normal' });
    assert.equal(state.lastMission.executor_worker_id, 'GEMINI-SEO-WORKER');
    assert.ok(state.lastMission.source_ref.includes('chatgpt-exec-dispatcher'));

    // NT-8: verbatim replay (same key + nonce) reconciles to
    // the original - no second upstream dispatch.
    const replay = await callDispatch(root, execTok, helloArgs({ timestamp: Date.now() }));
    assert.equal(replay.parsed?.duplicate, true, `replay reconciled: ${replay.blob}`);
    assert.equal(state.dispatchHits, 1);
    // Same key, different nonce = conflict, still no new task.
    const conflict = await callDispatch(root, execTok, helloArgs({ nonce: 'nonce-2', timestamp: Date.now() }));
    assert.ok(conflict.blob.includes('IDEMPOTENCY_CONFLICT'), `conflict: ${conflict.blob}`);
    assert.equal(state.dispatchHits, 1);

    // NT-6: dispatch scope but NOT on the server allowlist.
    const nt6 = await callDispatch(root, noallowTok, helloArgs({ idempotency_key: 'K-X', nonce: 'n-x' }));
    assert.ok(nt6.blob.includes('DISPATCH_NOT_ALLOWLISTED'), `NT-6: ${nt6.blob}`);
    assert.equal(state.dispatchHits, 1);

    // 6.1.2(i): allowlisted + scoped, but role is not dispatcher.
    const role = await callDispatch(root, noroleTok, helloArgs({ idempotency_key: 'K-R', nonce: 'n-r' }));
    assert.ok(role.blob.includes('DISPATCH_ROLE_DENIED'), `role: ${role.blob}`);
    assert.equal(state.dispatchHits, 1);

    // NT-9 (facade layer): a provider-calling task class is
    // refused at the intake point, independent of spendCap.
    const nt9 = await callDispatch(root, execTok, helloArgs({ task_type: 'PROVIDER_CALL', idempotency_key: 'K-9', nonce: 'n-9' }));
    assert.ok(nt9.blob.includes('TASK_TYPE_NOT_ALLOWLISTED'), `NT-9: ${nt9.blob}`);
    assert.equal(state.dispatchHits, 1);

    // 6.1.2(iii): unknown/closed run, and run-scope mismatch.
    const runBad = await callDispatch(root, execTok, helloArgs({ run_id: 'P0-CLOSED', idempotency_key: 'K-7a', nonce: 'n-7a' }));
    assert.ok(runBad.blob.includes('RUN_NOT_OPEN'), `run: ${runBad.blob}`);
    const [t2, w2, p2] = OTHER_SCOPE.split('/');
    const runScope = await callDispatch(root, execTok, helloArgs({ tenant_id: t2, workspace_id: w2, project_id: p2, idempotency_key: 'K-7b', nonce: 'n-7b' }));
    assert.ok(runScope.blob.includes('RUN_SCOPE_MISMATCH'), `run scope: ${runScope.blob}`);
    assert.equal(state.dispatchHits, 1);

    // 6.1.4: stale timestamp is rejected.
    const stale = await callDispatch(root, execTok, helloArgs({ idempotency_key: 'K-8', nonce: 'n-8', timestamp: Date.now() - 600_000 }));
    assert.ok(stale.blob.includes('TIMESTAMP_OUT_OF_WINDOW'), `stale: ${stale.blob}`);
    assert.equal(state.dispatchHits, 1);

    // NT-7: rate limit - EXEC has admitted 1 new dispatch;
    // two more pass (total 3), the next is refused.
    for (const k of ['K-2', 'K-3']) {
      const r = await callDispatch(root, execTok, helloArgs({ idempotency_key: k, nonce: `n-${k}`, task_id: `T-${k}`, mission_id: `M-${k}` }));
      assert.equal(r.parsed?.dispatched, true, `admitted ${k}: ${r.blob}`);
    }
    assert.equal(state.dispatchHits, 3);
    const limited = await callDispatch(root, execTok, helloArgs({ idempotency_key: 'K-4', nonce: 'n-K-4', task_id: 'T-K-4', mission_id: 'M-K-4' }));
    assert.ok(limited.blob.includes('RATE_LIMITED'), `NT-7: ${limited.blob}`);
    assert.equal(state.dispatchHits, 3);

    // DRAIN (facade side of NT-11a): dispatch denied, reads
    // still work - the drained client has no result tool on
    // the facade, so DRAIN opens no extra path here.
    const dr = await callDispatch(root, drainedTok, helloArgs({ idempotency_key: 'K-D', nonce: 'n-d' }));
    assert.ok(dr.blob.includes('CLIENT_IN_DRAIN'), `drain: ${dr.blob}`);
    assert.equal(state.dispatchHits, 3);
    const health = await mcp(root, drainedTok, 'tools/call', { name: 'agy.health', arguments: {} });
    assert.ok(JSON.stringify(health.json).includes('READY'), 'drained client can still read');

    // HARD_REVOKE (facade side of NT-10/NT-11b): a token
    // minted while the client was active dies at its next
    // use once the registry status flips to 'revoked' -
    // including a token a connector is still holding.
    const revTok = await mint(root, REVOKER, 'agy.read agy.dispatch');
    const before = await mcp(root, revTok, 'tools/list', {});
    assert.equal(before.status, 200);
    REVOKER.status = 'revoked';
    const after = await mcp(root, revTok, 'tools/call', { name: 'agy.health', arguments: {} });
    assert.equal(after.status, 401, 'connector-held token refused after HARD_REVOKE');
  } finally {
    server.close(); upstream.close();
  }
});

test('dispatch-control unit: expired run window denies', { timeout: 30000 }, async () => {
  const ctl = createDispatchControl({ allowlist: ['c1'], taskTypes: ['HELLO'],
    runs: [{ run_id: 'OLD', scope: 'gl/legacy-workspace/GEMINI_UI_STAGING', opens_at: 1_000, closes_at: 2_000 }],
    rateLimitMax: 3, rateLimitWindowMs: 60_000, timestampSkewMs: 300_000 }, () => 10_000);
  assert.throws(() => ctl.check({ clientId: 'c1', role: 'dispatcher', status: 'active',
    scope: 'gl/legacy-workspace/GEMINI_UI_STAGING', taskType: 'HELLO', runId: 'OLD',
    idempotencyKey: 'k', nonce: 'n', timestamp: 10_000 }), /RUN_NOT_OPEN/);
});
