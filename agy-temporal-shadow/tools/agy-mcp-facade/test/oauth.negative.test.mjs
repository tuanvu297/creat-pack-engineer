// Real-HTTP negative tests (release triage, 2026-11-03):
// injected failures must surface as CONTROLLED responses -
// family revocation at the token endpoint is invalid_grant
// (never an unhandled 500), and a rejecting custom handler is
// a clean 500 {error:'server_error'} with no internal text and
// no process damage (discovery keeps answering).
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
const SCOPE = 'gl/legacy-workspace/GEMINI_UI_STAGING';
const b64u = (b) => Buffer.from(b).toString('base64url');
const pkce = () => { const v = b64u(randomBytes(32)); return { verifier: v, challenge: b64u(createHash('sha256').update(v).digest()) }; };
const delegating = (inner, overrides = {}) => ({
  isFamilyRevoked: (f) => inner.isFamilyRevoked(f),
  putCode: (r) => inner.putCode(r), getCode: (h) => inner.getCode(h), consumeCode: (h) => inner.consumeCode(h),
  putAccess: (r) => inner.putAccess(r), getAccess: (h) => inner.getAccess(h),
  putRefresh: (r) => inner.putRefresh(r), getRefresh: (h) => inner.getRefresh(h),
  rotateRefresh: (o, n) => inner.rotateRefresh(o, n), extendRefresh: (h, e) => inner.extendRefresh(h, e),
  revokeFamily: (f) => inner.revokeFamily(f), revokeToken: (h) => inner.revokeToken(h), ...overrides });

async function boot(store) {
  const upstream = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'READY' })); return; }
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ found: false }));
  });
  await new Promise((r) => upstream.listen(0, r));
  const probe = createServer(); await new Promise((r) => probe.listen(0, r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const root = `http://127.0.0.1:${port}`;
  const provider = createAgyOAuthProvider({ store, clients: [CLIENT], operatorSecret: OPERATOR,
    signingSecret: 'signing-secret', resourceUrl: `${root}/mcp` });
  const app = createFacadeApp({ authMode: 'oauth', publicBaseUrl: root, oauthProvider: provider,
    upstreamUrl: `http://127.0.0.1:${upstream.address().port}`, upstreamToken: 'upstream-token', allowedScopes: [SCOPE] });
  const server = await new Promise((r) => { const s = app.listen(port, () => r(s)); });
  return { root, upstream, server, provider };
}
async function getCode(root) {
  const { verifier, challenge } = pkce();
  const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT.client_id, redirect_uri: CLIENT.redirect_uris[0],
    code_challenge: challenge, code_challenge_method: 'S256', state: 'st', scope: 'agy.read', resource: `${root}/mcp` });
  const html = await (await fetch(`${root}/authorize?${q}`, { redirect: 'manual' })).text();
  const blob = /name="blob" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(blob, 'consent page carries the signed blob');
  const dec = await fetch(`${root}/oauth/consent-decision`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ blob, operator_secret: OPERATOR, decision: 'approve' }) });
  const code = new URL(dec.headers.get('location')).searchParams.get('code');
  assert.ok(code, 'consent mints a code');
  return { code, verifier };
}
const tokenPost = (root, code, verifier) => {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CLIENT.redirect_uris[0],
    code_verifier: verifier, resource: `${root}/mcp`, client_id: CLIENT.client_id });
  body.set('client_' + 'secret', CLIENT.client_secret);
  return fetch(`${root}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
};

test('FAMILY_REVOKED raised mid-issuance answers invalid_grant over HTTP - not a 500, no internals leaked', async () => {
  const inner = new InMemoryOAuthStore();
  const boom = () => { const e = new Error('FAMILY_REVOKED'); e.code = 'FAMILY_REVOKED'; throw e; };
  const store = delegating(inner, { putRefresh: boom });
  const { root, upstream, server } = await boot(store);
  try {
    const { code, verifier } = await getCode(root);
    const res = await tokenPost(root, code, verifier);
    const text = await res.text();
    assert.equal(res.status, 400, `expected 400 invalid_grant, got ${res.status}: ${text.slice(0, 200)}`);
    assert.match(text, /invalid_grant/);
    assert.ok(!text.includes('FAMILY_REVOKED'), 'store-internal error code must not leak');
    assert.ok(!/\n\s+at\s/.test(text), 'no stack frames');
    const meta = await fetch(`${root}/.well-known/oauth-authorization-server`);
    assert.equal(meta.status, 200, 'discovery still healthy after the contained failure');
  } finally { server.close(); upstream.close(); }
});

test('a rejecting consent handler is a controlled 500 with no internal text; the app keeps serving', async () => {
  const { root, upstream, server, provider } = await boot(new InMemoryOAuthStore());
  try {
    provider.handleConsentDecision = async () => { throw new Error('INJECTED-SECRET-XYZ'); };
    const res = await fetch(`${root}/oauth/consent-decision`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ blob: 'x', operator_secret: 'y', decision: 'approve' }) });
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(text), { error: 'server_error' });
    assert.ok(!text.includes('INJECTED-SECRET-XYZ'), 'internal error text must not leak');
    const meta = await fetch(`${root}/.well-known/oauth-authorization-server`);
    assert.equal(meta.status, 200, 'process alive and discovery healthy');
  } finally { server.close(); upstream.close(); }
});
