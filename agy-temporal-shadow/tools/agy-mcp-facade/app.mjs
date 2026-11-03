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
// Either way the tools are the same two READ-ONLY tools and the
// upstream call uses the facade's own scoped identity token.
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

export function buildMcpServer({ upstreamUrl, upstreamToken, allowedScopes }) {
  const upstreamJson = async (path) => {
    const res = await fetch(`${upstreamUrl}${path}`, { headers: { authorization: `Bearer ${upstreamToken}` } });
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
  const mcpHandler = async (req, res) => {
    const body = await readBoundedJson(req, res);
    if (body === null) return;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildMcpServer(cfg);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  if (cfg.authMode === 'oauth') {
    // Bootstrap capture: log the client_id + redirect_uri of
    // every authorize attempt (neither is a secret). When a
    // connect attempt is DENIED for an unregistered redirect,
    // this line is how the exact platform redirect URI is
    // captured and then registered verbatim - see the deploy
    // runbook's capture flow.
    app.use('/authorize', (req, _res, next) => {
      if (req.method === 'GET') console.log(`agy-oauth authorize attempt client_id=${req.query.client_id ?? ''} redirect_uri=${req.query.redirect_uri ?? ''}`);
      next();
    });
    const issuerUrl = new URL(cfg.publicBaseUrl);
    const resourceUrl = new URL('/mcp', cfg.publicBaseUrl);
    app.use(mcpAuthRouter({
      provider: cfg.oauthProvider,
      issuerUrl,
      resourceServerUrl: resourceUrl,
      scopesSupported: ['agy.read'],
      resourceName: 'AGY MCP facade (read-only candidate)',
    }));
    app.post('/oauth/consent-decision', express.urlencoded({ extended: false, limit: '16kb' }),
      (req, res) => cfg.oauthProvider.handleConsentDecision(req, res));
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
      return mcpHandler(req, res);
    });
  }
  app.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return app;
}
