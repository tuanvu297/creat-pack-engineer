// Express app factory for the AGY MCP facade (candidate v0.3).
// server.mjs wires environment config into this factory; tests
// import it directly with injected config and a stub upstream.
//
// Two inbound auth modes, chosen by config - never both:
//  - 'bearer' (v0.2 behaviour, unchanged): one static inbound
//    bearer token, timing-safe compared.
//  - 'oauth' (v0.3): the official SDK's mcpAuthRouter serves
//    the OAuth endpoints + RFC 8414/9728 metadata, and /mcp sits
//    behind the SDK's requireBearerAuth with the AGY provider
//    (S256 PKCE, audience-bound tokens, scope 'agy.read').
// Either way the two READ-ONLY tools are served and the
// upstream call uses the facade's own scoped identity token.
// The WRITE tool agy.dispatch (execution-grant package
// v1.2.1, D-G7) is registered ONLY when a dispatch control
// configuration is injected (cfg.dispatchControl) and ONLY
// works in oauth mode, where every call carries a per-client
// OAuth identity - bearer mode has no per-client identity, so
// the dispatch handler refuses there. All section-6.1
// controls are enforced server-side in dispatch-control.mjs
// plus the per-tool scope check below.
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { z } from 'zod';

const MAX_BODY = 65536;
const SCOPE_PART = /^[A-Za-z0-9_-]+$/;
const UUID = /^[a-f0-9-]{36}$/;

export function buildMcpServer({ upstreamUrl, upstreamToken, allowedScopes, dispatchControl = null, authInfo = null }) {
  const upstreamJson = async (path) => {
    const res = await fetch(`${upstreamUrl}${path}`, { headers: { authorization: `Bearer ${upstreamToken}` } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`upstream ${path} returned non-JSON (HTTP ${res.status})`); }
    return { status: res.status, body };
  };
  const upstreamPostJson = async (path, payload) => {
    const res = await fetch(`${upstreamUrl}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${upstreamToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload) });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new Error(`upstream ${path} returned non-JSON (HTTP ${res.status})`); }
    return { status: res.status, body };
  };
  const server = new McpServer({ name: 'agy-mcp-facade', version: '0.3.0' });
  server.tool('agy.health',
    'Runtime health of the AGY staging service, proxied verbatim from the proven GET /health route. READ-ONLY.',
    {},
    async () => {
      const { body } = await upstreamJson('/health');
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    });
  server.tool('agy.callback_lookup',
    'Look up one worker callback receipt by id within an allowlisted scope (proven receiver lookup route). Returns the full receipt identity incl. effect_count, or {found:false}. READ-ONLY.',
    { tenant_id: z.string(), workspace_id: z.string(), project_id: z.string(), callback_id: z.string() },
    async ({ tenant_id, workspace_id, project_id, callback_id }) => {
      if (!SCOPE_PART.test(tenant_id) || !SCOPE_PART.test(workspace_id) || !SCOPE_PART.test(project_id)) {
        throw new Error('SCOPE_PART_INVALID');
      }
      const scope = `${tenant_id}/${workspace_id}/${project_id}`;
      if (!allowedScopes.includes(scope)) throw new Error(`SCOPE_NOT_ALLOWED: ${scope}`);
      if (!UUID.test(callback_id)) throw new Error('CALLBACK_ID_INVALID');
      const { status, body } = await upstreamJson(
        `/v1/callbacks/tenants/${tenant_id}/workspaces/${workspace_id}/projects/${project_id}/receive/${callback_id}`);
      if (status === 401 || status === 403) throw new Error(`UPSTREAM_AUTH_FAILED (HTTP ${status})`);
      if (status !== 200 && status !== 404) throw new Error(`UPSTREAM_ERROR (HTTP ${status})`);
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    });
  if (dispatchControl) {
    // agy.dispatch - the facade's ONLY write tool (grant
    // package v1.2.1 section 3.1/6.1). Creates exactly one
    // provider-less task by calling the gateway's proven
    // POST /v1/agy/dispatch action with a Mission contract in
    // the exact shape src/temporal/contracts.ts +
    // bridge.validateMission require (payload restricted to
    // the synthetic fixture shape, so a dispatched P0 task
    // cannot smuggle provider calls, endpoints or
    // instructions). P0 HELLO timeouts follow the MB-043
    // contract (lease 300 s, 30 min run window).
    server.tool('agy.dispatch',
      'Create ONE provider-less task (phase-allowlisted task types only) in the caller\'s pinned scope, via the AGY gateway dispatch action. WRITE. Enforced server-side (grant package 6.1): dispatch allowlist, dispatcher role, run window, per-identity rate limit, idempotency anti-replay (idempotency_key + nonce + timestamp).',
      { tenant_id: z.string(), workspace_id: z.string(), project_id: z.string(),
        task_type: z.string(), run_id: z.string(), mission_id: z.string(), task_id: z.string(),
        executor_worker_id: z.string(), objective: z.string(),
        idempotency_key: z.string(), nonce: z.string(), timestamp: z.number() },
      async ({ tenant_id, workspace_id, project_id, task_type, run_id, mission_id, task_id,
        executor_worker_id, objective, idempotency_key, nonce, timestamp }, extra) => {
        const auth = extra?.authInfo ?? authInfo;
        if (!auth) throw new Error('DISPATCH_AUTH_REQUIRED');
        if (!(auth.scopes ?? []).includes('agy.dispatch')) throw new Error('ACTION_DENIED');
        if (!SCOPE_PART.test(tenant_id) || !SCOPE_PART.test(workspace_id) || !SCOPE_PART.test(project_id)) {
          throw new Error('SCOPE_PART_INVALID');
        }
        const scope = `${tenant_id}/${workspace_id}/${project_id}`;
        if (!allowedScopes.includes(scope)) throw new Error(`SCOPE_NOT_ALLOWED: ${scope}`);
        const verdict = dispatchControl.check({ clientId: auth.clientId,
          role: auth.extra?.role ?? null, status: auth.extra?.status ?? 'active',
          scope, taskType: task_type, runId: run_id, idempotencyKey: idempotency_key, nonce, timestamp });
        if (verdict.replay) {
          return { content: [{ type: 'text', text: JSON.stringify({ ...verdict.result, duplicate: true, reconciled: 'facade-ledger' }) }] };
        }
        const mission = { tenantId: tenant_id, workspaceId: workspace_id, projectId: project_id,
          mission_id, task_id, attempt: 1, idempotency_key, objective, executor_worker_id,
          source_ref: `mcp-facade:agy.dispatch:${auth.extra?.subject ?? auth.clientId}`,
          qa_contract_version: '1.1', mode: 'TEMPORAL_SHADOW',
          payload: { value: 0, delay_ms: 0, fixture: 'normal' },
          ack_timeout_ms: 300_000, result_timeout_ms: 300_000, qa_timeout_ms: 300_000, max_corrections: 0 };
        const { status, body } = await upstreamPostJson('/v1/agy/dispatch', { mission });
        if (status === 401 || status === 403) throw new Error(`UPSTREAM_AUTH_FAILED (HTTP ${status})`);
        if (status !== 200) throw new Error(`UPSTREAM_ERROR (HTTP ${status}): ${body?.error ?? 'unknown'}`);
        const result = { dispatched: true, duplicate: body.duplicate === true,
          workflow_id: body.workflow_id ?? null, run_id: body.run_id ?? null,
          evidence_class: body.evidence_class ?? null, scope, task_id, idempotency_key };
        verdict.record(result);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      });
  }
  return server;
}

async function readBoundedJson(req, res) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) { res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'REQUEST_TOO_LARGE' })); return null; }
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'INVALID_JSON' })); return null; }
}

export function createFacadeApp(cfg) {
  const app = express();
  app.disable('x-powered-by');
  // Express 4 does not catch async rejections: the handler
  // implementation is wrapped so every rejection funnels to
  // next(err) and the controlled error middleware below
  // (release triage: Promise.resolve(...).catch(next)).
  const mcpHandlerImpl = async (req, res) => {
    const body = await readBoundedJson(req, res);
    if (body === null) return;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer({ ...cfg, authInfo: req.auth ?? null });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const mcpHandler = (req, res, next) => Promise.resolve(mcpHandlerImpl(req, res)).catch(next);
  if (cfg.authMode === 'oauth') {
    // Bootstrap capture: log the client_id + redirect_uri of
    // every authorize attempt (neither is a secret). When a
    // connect attempt is DENIED for an unregistered redirect,
    // this line is how the exact platform redirect URI is
    // captured and then registered verbatim - see the deploy
    // runbook's capture flow.
    // Log hygiene (release triage): scalar strings only, CR/LF
    // stripped (no log forging), length-bounded, and the
    // redirect is only logged when it parses as a URL.
    const logScalar = (v, max = 256) => (typeof v === 'string' ? v.replace(/[\r\n]/g, ' ').slice(0, max) : '');
    app.use('/authorize', (req, _res, next) => {
      if (req.method === 'GET') {
        let redirect = logScalar(req.query.redirect_uri, 512);
        try { redirect = new URL(redirect).toString(); } catch { redirect = '<invalid>'; }
        console.log(`agy-oauth authorize attempt client_id=${logScalar(req.query.client_id, 128)} redirect_uri=${redirect}`);
      }
      next();
    });
    const issuerUrl = new URL(cfg.publicBaseUrl);
    const resourceUrl = new URL('/mcp', cfg.publicBaseUrl);
    app.use(mcpAuthRouter({
      provider: cfg.oauthProvider,
      issuerUrl,
      resourceServerUrl: resourceUrl,
      scopesSupported: ['agy.read', 'agy.dispatch'],
      resourceName: 'AGY MCP facade (read-only candidate)',
    }));
    app.post('/oauth/consent-decision', express.urlencoded({ extended: false, limit: '16kb' }),
      (req, res, next) => Promise.resolve(cfg.oauthProvider.handleConsentDecision(req, res)).catch(next));
    const resourceMetadataUrl = new URL(`/.well-known/oauth-protected-resource/mcp`, cfg.publicBaseUrl);
    app.all('/mcp', requireBearerAuth({ verifier: cfg.oauthProvider, requiredScopes: ['agy.read'], resourceMetadataUrl }), mcpHandler);
  } else {
    const bearerOk = (header) => {
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
      const got = Buffer.from(header.slice(7));
      const want = Buffer.from(cfg.inboundToken);
      return got.length === want.length && timingSafeEqual(got, want);
    };
    app.all('/mcp', (req, res, next) => {
      if (!bearerOk(req.headers.authorization)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'UNAUTHORIZED' }));
        return;
      }
      return mcpHandler(req, res, next);
    });
  }
  // Controlled 500: no stack, no internal message text, and the
  // process keeps serving (discovery included).
  app.use((err, _req, res, _next) => {
    console.error('agy-mcp-facade: controlled error', err?.name ?? 'Error');
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return app;
}
