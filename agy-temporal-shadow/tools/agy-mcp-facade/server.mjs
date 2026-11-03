// AGY MCP facade — CANDIDATE, NOT INSTALLED (2026-11-03, v0.2).
//
// A Model Context Protocol server (official SDK, streamable HTTP)
// exposing ONLY the AGY runtime read routes whose contracts are
// proven in the runtime source (src/temporal/http-server.ts):
//
//   GET /health
//     -> 200 {status:'READY', dependencies:{...}, mode, production}
//        or 503 when a dependency is down.
//   GET /v1/callbacks/tenants/:t/workspaces/:w/projects/:p/receive/:callbackId
//     -> the callback receiver's lookup: {found:true, callback_id,
//        task_id, attempt, worker_id, target, content_digest,
//        received_at, effect_count} or {found:false} (HTTP 404).
//
// Tools whose routes are NOT proven under an operator identity are
// omitted by design: there is no mission-result read here (worker
// 'readback' belongs to the worker's own identity; this facade
// never impersonates a worker), and no reconcile/dispatch tool
// (submissions require an owner-granted window, not an MCP call).
//
// Security model — two SEPARATE credentials, fail closed:
// - AGY_FACADE_INBOUND_TOKEN: the host's credential TO this facade.
//   Every /mcp request must carry it as a Bearer token; missing or
//   wrong -> 401, nothing is executed, upstream is never touched.
// - AGY_UPSTREAM_TOKEN: this facade's own operator identity token
//   toward the runtime, used only after inbound auth + scope checks.
// Scope: AGY_FACADE_ALLOWED_SCOPES is an exact allowlist of
// tenant/workspace/project triples. A lookup naming any other scope
// is rejected before the upstream call. Request bodies are bounded
// at 64 KiB (mirroring the runtime's own limit). The facade refuses
// to start when any required variable is missing.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const INBOUND = process.env.AGY_FACADE_INBOUND_TOKEN ?? '';
const UPSTREAM = process.env.AGY_UPSTREAM_URL ?? '';
const UPSTREAM_TOKEN = process.env.AGY_UPSTREAM_TOKEN ?? '';
const ALLOWED = (process.env.AGY_FACADE_ALLOWED_SCOPES ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT ?? 8787);
const MAX_BODY = 65536;

if (!INBOUND || !UPSTREAM || !UPSTREAM_TOKEN || !ALLOWED.length) {
  console.error('agy-mcp-facade: AGY_FACADE_INBOUND_TOKEN, AGY_UPSTREAM_URL, AGY_UPSTREAM_TOKEN and a non-empty AGY_FACADE_ALLOWED_SCOPES are all required; refusing to start.');
  process.exit(2);
}

const bearerOk = (header) => {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(INBOUND);
  return got.length === want.length && timingSafeEqual(got, want);
};

const SCOPE_PART = /^[A-Za-z0-9_-]+$/;
const UUID = /^[a-f0-9-]{36}$/;

async function upstreamJson(path) {
  const res = await fetch(`${UPSTREAM}${path}`, { headers: { authorization: `Bearer ${UPSTREAM_TOKEN}` } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`upstream ${path} returned non-JSON (HTTP ${res.status})`); }
  return { status: res.status, body };
}

function buildServer() {
  const server = new McpServer({ name: 'agy-mcp-facade', version: '0.2.0' });
  server.tool('agy.health',
    'Runtime health of the AGY staging service, proxied verbatim from the proven GET /health route.',
    {},
    async () => {
      const { body } = await upstreamJson('/health');
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    });
  server.tool('agy.callback_lookup',
    'Look up one worker callback receipt by id within an allowlisted scope (proven receiver lookup route). Returns the full receipt identity incl. effect_count, or {found:false}.',
    { tenant_id: z.string(), workspace_id: z.string(), project_id: z.string(), callback_id: z.string() },
    async ({ tenant_id, workspace_id, project_id, callback_id }) => {
      if (!SCOPE_PART.test(tenant_id) || !SCOPE_PART.test(workspace_id) || !SCOPE_PART.test(project_id)) {
        throw new Error('SCOPE_PART_INVALID');
      }
      const scope = `${tenant_id}/${workspace_id}/${project_id}`;
      if (!ALLOWED.includes(scope)) throw new Error(`SCOPE_NOT_ALLOWED: ${scope}`);
      if (!UUID.test(callback_id)) throw new Error('CALLBACK_ID_INVALID');
      const { status, body } = await upstreamJson(
        `/v1/callbacks/tenants/${tenant_id}/workspaces/${workspace_id}/projects/${project_id}/receive/${callback_id}`);
      // An upstream auth failure is never data: surface it as a
      // tool error. The route's own 404 carries {found:false},
      // which IS data and passes through untouched.
      if (status === 401 || status === 403) throw new Error(`UPSTREAM_AUTH_FAILED (HTTP ${status})`);
      if (status !== 200 && status !== 404) throw new Error(`UPSTREAM_ERROR (HTTP ${status})`);
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    });
  return server;
}

createServer(async (req, res) => {
  if (req.url !== '/mcp' || (req.method !== 'POST' && req.method !== 'GET' && req.method !== 'DELETE')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'NOT_FOUND' }));
    return;
  }
  if (!bearerOk(req.headers.authorization)) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'UNAUTHORIZED' }));
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'REQUEST_TOO_LARGE' }));
      return;
    }
    chunks.push(Buffer.from(chunk));
  }
  let body;
  try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined; }
  catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'INVALID_JSON' })); return; }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}).listen(PORT, () => console.log(`agy-mcp-facade listening on :${PORT} (candidate; inbound-authenticated; scopes: ${ALLOWED.join(' ')})`));
