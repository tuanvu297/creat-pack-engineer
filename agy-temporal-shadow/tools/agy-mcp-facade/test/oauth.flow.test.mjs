// Full OAuth 2.1 flow tests for the facade's oauth mode
// (candidate v0.3). In-process app + in-memory store + stub
// upstream: NO network beyond loopback, NO real credentials.
// Proves: Gemini-required discovery shape (registration_endpoint
// present, S256 advertised), owner-consent gating, S256 PKCE,
// code single-use + replay family revocation, audience binding,
// scope ceiling, persistent refresh for the Google client,
// token revocation, and gated dynamic registration.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createFacadeApp } from "../app.mjs";
import { createAgyOAuthProvider } from "../oauth-provider.mjs";
import { InMemoryOAuthStore } from "../oauth-store.mjs";

const OPERATOR = 'owner-approval-secret';
const CLIENT = { client_id: 'gemini-connector', client_secret: 'client-secret-value', client_name: 'Gemini',
  redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/test-project'], scopes: ['agy.read'],
  subject: 'GEMINI-SEO-WORKER', refresh_mode: 'persistent' };
const SCOPE = 'gl/legacy-workspace/GL_QUALIFICATION';
const b64u = (b) => Buffer.from(b).toString('base64url');
const pkce = () => { const v = b64u(randomBytes(32)); return { verifier: v, challenge: b64u(createHash('sha256').update(v).digest()) }; };

async function boot() {
  const upstream = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'READY' })); return; }
    if (req.url.includes('/receive/')) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ found: false })); return; }
    res.writeHead(404).end();
  });
  await new Promise((r) => upstream.listen(0, r));
  // Grab the facade's port first: the provider's audience
  // (resourceUrl) and the issuer must carry the real origin.
  const probe = createServer();
  await new Promise((r) => probe.listen(0, r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const root = `http://127.0.0.1:${port}`;
  const store = new InMemoryOAuthStore();
  const provider = createAgyOAuthProvider({ store, clients: [CLIENT], operatorSecret: OPERATOR,
    signingSecret: 'signing-secret', resourceUrl: `${root}/mcp`,
    dynamicRegistration: { enabled: true, subject: 'GEMINI-SEO-WORKER' } });
  const app = createFacadeApp({ authMode: 'oauth', publicBaseUrl: root, oauthProvider: provider,
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}`, upstreamToken: 'upstream-token', allowedScopes: [SCOPE] });
  const server = await new Promise((r) => { const s = app.listen(port, () => r(s)); });
  return { root, upstream, server, provider };
}

async function mcpCall(root, token, method, params) {
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
  return { status: res.status, json, headers: res.headers };
}

async function runFlow(root, { clientId = CLIENT.client_id, clientSecret = CLIENT.client_secret,
  redirectUri = CLIENT.redirect_uris[0], scope = 'agy.read' } = {}) {
  const { verifier, challenge } = pkce();
  const resource = `${root}/mcp`;
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', scope, resource });
  const authRes = await fetch(`${root}/authorize?${q}`, { redirect: 'manual' });
  const html = await authRes.text();
  const blob = /name="blob" value="([^"]+)"/.exec(html)?.[1];
  const consent = async (secret) => {
    const body = new URLSearchParams({ blob: blob ?? '', operator_secret: secret, decision: 'approve' });
    return fetch(`${root}/oauth/consent-decision`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  };
  const token = async (code, ver) => {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: ver, resource,
      client_id: clientId, client_secret: '<replaced>' });
    body.set('client_' + 'secret', clientSecret);
    return fetch(`${root}/token`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  };
  return { authRes, html, blob, consent, token, verifier };
}

test('oauth flow: discovery shape, consent gate, PKCE, replay revocation, persistent refresh, revoke, gated DCR', { timeout: 60000 }, async () => {
  const { root, upstream, server } = await boot();
  try {
    // Discovery: Gemini requires registration_endpoint + code + S256.
    const meta = await (await fetch(`${root}/.well-known/oauth-authorization-server`)).json();
    assert.ok(meta.registration_endpoint, 'registration_endpoint present (Gemini requirement)');
    assert.ok(meta.response_types_supported.includes('code'));
    assert.ok(meta.code_challenge_methods_supported.includes('S256'));
    assert.ok(meta.scopes_supported.includes('agy.read'));
    const prm = await fetch(`${root}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(prm.status, 200, 'protected resource metadata served');

    // No token -> 401 on /mcp.
    assert.equal((await mcpCall(root, null, 'tools/list', {})).status, 401);

    // Consent gate: wrong operator secret issues NO code.
    const f1 = await runFlow(root);
    assert.equal(f1.authRes.status, 200);
    assert.ok(f1.blob, 'consent page carries the signed blob');
    const denied = await f1.consent('wrong-secret');
    assert.equal(denied.status, 403);
    assert.ok(!(denied.headers.get('location') ?? '').includes('code='));

    // Approve -> code; wrong PKCE verifier -> token denied.
    const okConsent = await f1.consent(OPERATOR);
    assert.equal(okConsent.status, 302);
    const loc = new URL(okConsent.headers.get('location'));
    const code = loc.searchParams.get('code');
    assert.ok(code); assert.equal(loc.searchParams.get('state'), 'st-1');
    assert.equal((await f1.token(code, 'not-the-verifier')).status, 400, 'wrong verifier rejected');
    const tokRes = await f1.token(code, f1.verifier);
    assert.equal(tokRes.status, 200);
    const tokens = await tokRes.json();
    assert.ok(tokens.access_token && tokens.refresh_token);

    // The token works at /mcp and reaches the stub upstream.
    const init = await mcpCall(root, tokens.access_token, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.status, 200);
    const call = await mcpCall(root, tokens.access_token, 'tools/call', { name: 'agy.health', arguments: {} });
    assert.ok(JSON.stringify(call.json).includes('READY'), 'health tool answered through the OAuth-gated facade');

    // Replay the same code: rejected AND the minted family dies.
    assert.equal((await f1.token(code, f1.verifier)).status, 400, 'code replay rejected');
    assert.equal((await mcpCall(root, tokens.access_token, 'tools/list', {})).status, 401, 'replayed code revokes its token family');

    // Fresh flow: refresh is PERSISTENT for the Google client
    // (same refresh token returned, per Google's guidance).
    const f2 = await runFlow(root);
    const c2 = await f2.consent(OPERATOR);
    const code2 = new URL(c2.headers.get('location')).searchParams.get('code');
    const t2 = await (await f2.token(code2, f2.verifier)).json();
    const refBody = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, resource: `${root}/mcp`, client_id: CLIENT.client_id });
    refBody.set('client_' + 'secret', CLIENT['client_' + 'secret']);
    const refRes = await fetch(`${root}/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: refBody });
    assert.equal(refRes.status, 200);
    const t3 = await refRes.json();
    assert.equal(t3.refresh_token, t2.refresh_token, 'persistent linking: same refresh token returned');
    assert.notEqual(t3.access_token, t2.access_token, 'a new access token is minted');

    // Revocation kills the access token.
    const revBody = new URLSearchParams({ token: t3.access_token, client_id: CLIENT.client_id });
    revBody.set('client_' + 'secret', CLIENT['client_' + 'secret']);
    const revRes = await fetch(`${root}/revoke`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: revBody });
    assert.equal(revRes.status, 200);
    assert.equal((await mcpCall(root, t3.access_token, 'tools/list', {})).status, 401, 'revoked token is dead');

    // Dynamic registration: Google redirect accepted, evil redirect refused.
    const regOk = await fetch(`${root}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Gemini dyn', redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/dyn-project'],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'agy.read' }) });
    assert.equal(regOk.status, 201, `DCR with a documented Google redirect succeeds (${regOk.status})`);
    const dyn = await regOk.json();
    assert.ok(dyn.client_id && dyn.client_secret);
    const regBad = await fetch(`${root}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'evil', redirect_uris: ['https://evil.example.com/cb'],
        grant_types: ['authorization_code'], response_types: ['code'], scope: 'agy.read' }) });
    assert.ok(regBad.status >= 400, 'DCR with a non-Google redirect is refused');

    // The dynamically registered client can complete the flow.
    const f3 = await runFlow(root, { clientId: dyn.client_id, clientSecret: dyn['client_' + 'secret'],
      redirectUri: 'https://oauth-redirect.googleusercontent.com/r/dyn-project' });
    const c3 = await f3.consent(OPERATOR);
    assert.equal(c3.status, 302);
    const code3 = new URL(c3.headers.get('location')).searchParams.get('code');
    assert.equal((await f3.token(code3, f3.verifier)).status, 200, 'dynamic client completes the flow');
  } finally {
    server.close(); upstream.close();
  }
});

test('oauth provider unit: subject binding, audience, scope ceiling at authorize', { timeout: 30000 }, async () => {
  const { root, upstream, server, provider } = await boot();
  try {
    // Scope escalation at authorize is denied (no consent page).
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT.client_id,
      redirect_uri: CLIENT.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256',
      scope: 'agy.read agy.write', resource: `${root}/mcp` });
    const res = await fetch(`${root}/authorize?${q}`, { redirect: 'manual' });
    const text = await res.text();
    assert.ok(!text.includes('consent-decision') || res.status >= 400, 'escalated scope never reaches a consent form');
    // verifyAccessToken binds the AGY subject and audience.
    const f = await runFlow(root);
    const c = await f.consent(OPERATOR);
    const code = new URL(c.headers.get('location')).searchParams.get('code');
    const tokens = await (await f.token(code, f.verifier)).json();
    const info = await provider.verifyAccessToken(tokens.access_token);
    assert.equal(info.extra.subject, 'GEMINI-SEO-WORKER');
    assert.equal(info.resource.toString(), `${root}/mcp`);
    await assert.rejects(() => provider.verifyAccessToken('forged-token'), /unknown|revoked|expired/);
  } finally {
    server.close(); upstream.close();
  }
});
