// HTTP tests for the AGY MCP facade (candidate v0.2).
// The facade runs as a real HTTP server; the upstream is a STUB
// implementing the two route contracts exactly as declared in the
// runtime source (src/temporal/http-server.ts + worker-callback-
// receiver.ts lookup shape), including its Bearer auth. Happy-path
// MCP traffic uses the official SDK client; negative cases use raw
// fetch. Nothing here touches a live runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const INBOUND = 'inbound-test-token';
const UPSTREAM_TOKEN = 'upstream-operator-token';
const SCOPE = 'gl/legacy-workspace/GL_QUALIFICATION';
const CB_ID = 'dacea26f-c7ce-4949-b1ff-f2caca7624e5';
let upstreamHits = 0;

function startStubUpstream(port) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      upstreamHits += 1;
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/health') {
        res.end(JSON.stringify({ status: 'READY', dependencies: { postgres: true, temporal: true, worker: true },
          mode: 'TEMPORAL_SHADOW', canonical_authority: 'EXISTING_POSTGRES_D049', production: false }));
        return;
      }
      const m = /^\/v1\/callbacks\/tenants\/([A-Za-z0-9_-]+)\/workspaces\/([A-Za-z0-9_-]+)\/projects\/([A-Za-z0-9_-]+)\/receive\/([a-f0-9-]{36})$/.exec(req.url ?? '');
      if (req.method === 'GET' && m) {
        if (req.headers.authorization !== `Bearer ${UPSTREAM_TOKEN}`) { res.statusCode = 401; res.end(JSON.stringify({ error: 'UNAUTHORIZED' })); return; }
        if (m[4] === CB_ID) {
          res.end(JSON.stringify({ found: true, callback_id: CB_ID, task_id: 'ebabfa62-81a1-406a-99e6-ad09af639181',
            attempt: 1, worker_id: 'MUSE-QUAL-WORKER', target: 'CHATGPT_ASSISTANT_CONTROL_PLANE',
            content_digest: '7c2160d1bf77ffbb4da7df45d28d51d3ff5762b34a26ea376f30c113b74e6a90',
            received_at: '2026-11-02T08:42:57Z', effect_count: 1 }));
        } else { res.statusCode = 404; res.end(JSON.stringify({ found: false })); }
        return;
      }
      res.statusCode = 404; res.end(JSON.stringify({ error: 'NOT_FOUND' }));
    });
    srv.listen(port, () => resolve(srv));
  });
}

async function startFacade(port, upstreamPort, overrides = {}) {
  const env = { ...process.env,
    AGY_FACADE_INBOUND_TOKEN: INBOUND,
    AGY_UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}`,
    AGY_UPSTREAM_TOKEN: UPSTREAM_TOKEN,
    AGY_FACADE_ALLOWED_SCOPES: SCOPE,
    PORT: String(port), ...overrides };
  const proc = spawn('node', ['server.mjs'], { cwd: new URL('..', import.meta.url).pathname, env });
  for (let i = 0; i < 50; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' }); if (r.status === 401) break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return proc;
}

async function sdkClient(port, token = INBOUND) {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'facade-test', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

const rpc = (port, body, token) => fetch(`http://127.0.0.1:${port}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('facade: auth, scope, transport and proven-route behaviour', { timeout: 60000 }, async (t) => {
  const upstream = await startStubUpstream(18931);
  const facade = await startFacade(18932, 18931);
  t.after(() => { facade.kill(); upstream.close(); });

  // Initialize via the official SDK client (supported transport).
  const client = await sdkClient(18932);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((x) => x.name).sort(), ['agy.callback_lookup', 'agy.health'],
    'exactly the two proven-route tools are exposed — no invented mission_result');

  // Health proxied verbatim from the proven route.
  const health = await client.callTool({ name: 'agy.health', arguments: {} });
  assert.match(health.content[0].text, /"status":"READY"/);
  assert.match(health.content[0].text, /EXISTING_POSTGRES_D049/);

  // Callback lookup returns the full receipt identity.
  const look = await client.callTool({ name: 'agy.callback_lookup', arguments: {
    tenant_id: 'gl', workspace_id: 'legacy-workspace', project_id: 'GL_QUALIFICATION', callback_id: CB_ID } });
  const receipt = JSON.parse(look.content[0].text);
  assert.equal(receipt.found, true);
  assert.equal(receipt.effect_count, 1);
  assert.equal(receipt.content_digest, '7c2160d1bf77ffbb4da7df45d28d51d3ff5762b34a26ea376f30c113b74e6a90');

  // Unknown callback id -> {found:false} passthrough, not an error.
  const missing = await client.callTool({ name: 'agy.callback_lookup', arguments: {
    tenant_id: 'gl', workspace_id: 'legacy-workspace', project_id: 'GL_QUALIFICATION',
    callback_id: '123e4567-e89b-12d3-a456-426614174000' } });
  assert.equal(JSON.parse(missing.content[0].text).found, false);
  await client.close();

  // Notification: notifications/initialized is accepted (202, no body).
  const notif = await rpc(18932, { jsonrpc: '2.0', method: 'notifications/initialized' }, INBOUND);
  assert.equal(notif.status, 202);

  // Inbound auth fails closed: no token and wrong token both 401,
  // and the upstream is never touched by either attempt.
  const hitsBefore = upstreamHits;
  assert.equal((await rpc(18932, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).status, 401);
  assert.equal((await rpc(18932, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 'wrong-token')).status, 401);
  assert.equal(upstreamHits, hitsBefore, 'unauthenticated requests never reach the upstream');

  // Cross-scope IDs are rejected before any upstream call.
  const client2 = await sdkClient(18932);
  const hitsBeforeScope = upstreamHits;
  const crossScope = await client2.callTool({ name: 'agy.callback_lookup', arguments: {
    tenant_id: 'gl', workspace_id: 'legacy-workspace', project_id: 'OTHER_PROJECT', callback_id: CB_ID } });
  assert.equal(crossScope.isError, true);
  assert.match(crossScope.content[0].text, /SCOPE_NOT_ALLOWED/);
  assert.equal(upstreamHits, hitsBeforeScope, 'cross-scope lookup never reaches the upstream');
  // Malformed callback id likewise.
  const badId = await client2.callTool({ name: 'agy.callback_lookup', arguments: {
    tenant_id: 'gl', workspace_id: 'legacy-workspace', project_id: 'GL_QUALIFICATION', callback_id: 'not-a-uuid' } });
  assert.equal(badId.isError, true);
  assert.match(badId.content[0].text, /CALLBACK_ID_INVALID/);
  await client2.close();

  // Oversized bodies are bounded (413) even with valid auth.
  const big = await rpc(18932, `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{},"pad":"${'x'.repeat(70000)}"}`, INBOUND);
  assert.equal(big.status, 413);
});

test('facade: inbound auth and upstream identity are separate — a bad upstream token surfaces as an upstream error, not access', { timeout: 60000 }, async (t) => {
  const upstream = await startStubUpstream(18941);
  const facade = await startFacade(18942, 18941, { AGY_UPSTREAM_TOKEN: 'not-the-operator-token' });
  t.after(() => { facade.kill(); upstream.close(); });
  const client = await sdkClient(18942);
  const out = await client.callTool({ name: 'agy.callback_lookup', arguments: {
    tenant_id: 'gl', workspace_id: 'legacy-workspace', project_id: 'GL_QUALIFICATION', callback_id: CB_ID } });
  assert.equal(out.isError, true, 'upstream 401 is surfaced as a tool error');
  await client.close();
});

test('facade: refuses to start without its credentials and allowlist (fail closed)', { timeout: 30000 }, async () => {
  const proc = spawn('node', ['server.mjs'], { cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, AGY_FACADE_INBOUND_TOKEN: '', AGY_UPSTREAM_URL: '', AGY_UPSTREAM_TOKEN: '', AGY_FACADE_ALLOWED_SCOPES: '' } });
  const code = await new Promise((resolve) => proc.on('exit', resolve));
  assert.equal(code, 2);
});
