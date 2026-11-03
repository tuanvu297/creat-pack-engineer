// Worker-UI regressions (QA round 5, 2026-11-03):
//  (a) the configured identity's actions allowlist is PRESERVED on the
//      Principal handed to the surface and ENFORCED per UI action —
//      a read-restricted worker cannot claim/result through the UI;
//  (b) a restriction applied MID-SESSION takes effect on the next
//      action (recheck reads the CURRENT configured identity), and
//      full revocation ends the session;
//  (c) the action form offers arrive and recover (surface-supported
//      actions the old dropdown omitted).
// Drives the real createWorkerUi handler with a stub surface; no DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerUi } from '../src/platform/worker-ui.js';
import type { IdentityConfig } from '../src/platform/auth.js';

const SCOPE = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' };
const TOKEN = ['ui', 'test', 'token', '1'].join('-');
const HOST = 'ui.test';
const ORIGIN = `http://${HOST}`;

function makeWorker(over: Partial<IdentityConfig> = {}): IdentityConfig {
  return { subject: 'gemini-worker', token: TOKEN, role: 'worker',
    workerId: 'GEMINI-SEO-WORKER', scopes: [SCOPE], ...over } as IdentityConfig;
}

function mockReq(opts: { method: string; url: string; cookie?: string; body?: string; accept?: string }) {
  const body = Buffer.from(opts.body ?? '');
  const req: any = { method: opts.method, url: opts.url, socket: {},
    headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded',
      ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.accept ? { accept: opts.accept } : {}) } };
  req[Symbol.asyncIterator] = async function* () { if (body.length) yield body; };
  return req;
}
function mockRes() {
  const res: any = { statusCode: 0, headers: {} as Record<string, any>, body: '',
    setHeader(k: string, v: any) { res.headers[k.toLowerCase()] = v; },
    end(b: string) { res.body = b; } };
  return res;
}
const cookiesFrom = (res: any): string => {
  const sc = res.headers['set-cookie'];
  const arr = Array.isArray(sc) ? sc : sc ? [sc] : [];
  return arr.map((c: string) => c.split(';')[0]).filter((c: string) => !c.endsWith('=')).join('; ');
};

async function signIn(ui: any, token: string) {
  // GET the sign-in form for the pre-session cookie + pre_csrf.
  const gRes = mockRes();
  await ui(mockReq({ method: 'GET', url: '/worker/ui' }), gRes);
  const pre = /name="pre_csrf" value="([^"]+)"/.exec(gRes.body)?.[1];
  assert.ok(pre, 'pre_csrf present');
  const preCookie = cookiesFrom(gRes);
  const sRes = mockRes();
  const form = new URLSearchParams({ pre_csrf: pre, token, tenantId: SCOPE.tenantId, workspaceId: SCOPE.workspaceId, projectId: SCOPE.projectId });
  await ui(mockReq({ method: 'POST', url: '/worker/ui/signin', cookie: preCookie, body: form.toString(), accept: 'application/json' }), sRes);
  const parsed = JSON.parse(sRes.body);
  assert.equal(parsed.ok, true, `signin ok: ${sRes.body}`);
  return { cookie: cookiesFrom(sRes), csrf: parsed.csrf as string };
}
async function act(ui: any, session: { cookie: string; csrf: string }, action: string) {
  const res = mockRes();
  const form = new URLSearchParams({ csrf: session.csrf, action });
  await ui(mockReq({ method: 'POST', url: '/worker/ui/action', cookie: session.cookie, body: form.toString(), accept: 'application/json' }), res);
  return { status: res.statusCode, body: JSON.parse(res.body) };
}
function setup(identities: IdentityConfig[]) {
  const calls: { principal: any; action: string }[] = [];
  const ui = createWorkerUi({ identities, secret: '<redacted>', ttlSeconds: 1800,
    surface: async (principal: any, _scope: any, action: string) => { calls.push({ principal, action }); return { status: 'STUBBED' }; } });
  return { ui, calls };
}

test('a read-restricted worker can sign in but cannot claim or result; readback passes WITH the allowlist on the Principal', async () => {
  const { ui, calls } = setup([makeWorker({ actions: ['read'] })]);
  const session = await signIn(ui, TOKEN);
  const claim = await act(ui, session, 'claim');
  assert.equal(claim.body.ok, false);
  assert.equal(claim.body.error, 'ACTION_DENIED');
  const result = await act(ui, session, 'result');
  assert.equal(result.body.error, 'ACTION_DENIED');
  assert.equal(calls.length, 0, 'surface never called for denied actions');
  const readback = await act(ui, session, 'readback');
  assert.equal(readback.body.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].principal.actions, ['read'], 'allowlist preserved on the Principal');
});

test('an unrestricted worker claims; its Principal carries no actions field', async () => {
  const { ui, calls } = setup([makeWorker()]);
  const session = await signIn(ui, TOKEN);
  const claim = await act(ui, session, 'claim');
  assert.equal(claim.body.ok, true);
  assert.equal(calls.length, 1);
  assert.equal('actions' in calls[0].principal, false);
});

test('a restriction applied MID-SESSION takes effect on the next action', async () => {
  const identity = makeWorker();
  const { ui, calls } = setup([identity]);
  const session = await signIn(ui, TOKEN);
  assert.equal((await act(ui, session, 'claim')).body.ok, true);
  (identity as any).actions = ['read']; // control plane narrows the identity now
  const after = await act(ui, session, 'claim');
  assert.equal(after.body.ok, false);
  assert.equal(after.body.error, 'ACTION_DENIED');
  assert.equal(calls.length, 1, 'no second surface call after restriction');
});

test('full revocation mid-session ends the session (SESSION_REVOKED)', async () => {
  const identities = [makeWorker()];
  const { ui } = setup(identities);
  const session = await signIn(ui, TOKEN);
  identities.length = 0;
  const after = await act(ui, session, 'claim');
  assert.equal(after.body.ok, false);
  assert.equal(after.body.error, 'SESSION_REVOKED');
});

test('the action form offers arrive and recover alongside the existing actions', async () => {
  const { ui } = setup([makeWorker()]);
  const session = await signIn(ui, TOKEN);
  const res = mockRes();
  await ui(mockReq({ method: 'GET', url: '/worker/ui', cookie: session.cookie }), res);
  for (const opt of ['arrive', 'claim', 'ack', 'heartbeat', 'checkpoint', 'result', 'readback', 'recover'])
    assert.ok(res.body.includes(`<option>${opt}</option>`), `form offers ${opt}`);
  assert.ok(res.body.includes('name="run_id"'), 'form carries the recover run_id field');
});
