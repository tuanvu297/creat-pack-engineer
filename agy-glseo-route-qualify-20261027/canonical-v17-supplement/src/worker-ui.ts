import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { authenticate, type IdentityConfig, type Principal } from './auth.js';
import { validateScope, type ProjectScope } from './scope.js';

// Browser surface for workers without a native MCP/connector client —
// v2 (candidate for AGY-GLSEO-ROUTE-QUALIFY-20261027; hardens the C5
// surface after QA findings S4–S5). Every action dispatches ONLY to the
// canonical worker surface (PostgresStore leases on
// EXISTING_POSTGRES_D049). No shadow RPC, no new queue.
//
// Routes:
//   GET  /worker/ui           sign-in form (with a login-CSRF
//                             pre-session), or the action form when a
//                             live, non-revoked session cookie is present
//   POST /worker/ui/signin    bearer token -> session cookie
//   POST /worker/ui/action    {action, csrf, ...fields} -> envelope
//   POST /worker/ui/signout   CSRF-checked; clears the cookie
//
// S4 hardening:
//  - EVERY POST requires an Origin header exactly matching the
//    request's own origin (scheme from x-forwarded-proto / socket,
//    host from the Host header) — cross-site posts are denied even
//    with a valid cookie.
//  - Sign-in is login-CSRF protected: GET issues an HMAC pre-session
//    cookie + hidden field; sign-in must present both, matching.
//  - Sign-out requires the session CSRF token.
//  - Sessions are re-validated against the CURRENT identity registry on
//    every request: if the identity was removed, demoted, re-scoped, or
//    its workerId changed, the session is revoked (401 SESSION_REVOKED)
//    despite a valid signature. Expiry is checked the same way.
//  - All identity/scope values interpolated into HTML are escaped.
// S5 completeness:
//  - The form carries every field a worker needs — claim lease seconds,
//    checkpoint state (payload JSON), result summary or result JSON,
//    external operation id (the idempotency key for evidence), quota /
//    cost actuals — so a DOM worker never needs raw JSON or a token in
//    a prompt after sign-in.
//  - Responses are stable envelopes: JSON {ok, action, http_status,
//    result|error}, or for form posts an HTML page whose
//    <div id="agy-envelope" data-ok data-action data-http-status> wraps
//    the same JSON as VISIBLE text in <pre id="agy-response-envelope">,
//    readable from the rendered DOM/accessibility tree.
// Session cookie: HMAC-SHA256-signed claims, HttpOnly, Secure,
// SameSite=Lax, Path=/worker/ui, 30 min TTL. The bearer token is never
// stored in the cookie. The UI is wired only when
// AGY_WORKER_UI_SESSION_SECRET is set (server.ts).
export interface WorkerUiDeps {
  identities: IdentityConfig[];
  surface: (principal: Principal, scope: ProjectScope, action: string, body: any) => Promise<any>;
  secret: string;
  ttlSeconds?: number;
}

interface Claims { sub: string; workerId: string; scope: ProjectScope; exp: number; csrf: string }

const COOKIE = 'agy_worker_session';
const PRE_COOKIE = 'agy_ui_pre';
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (secret: string, data: string) => b64u(createHmac('sha256', secret).update(data).digest());
const hashToken = (t: string) => createHash('sha256').update(t).digest();
const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const sameSecret = (a: string, b: string) => timingSafeEqual(hashToken(a), hashToken(b));

function mint(deps: WorkerUiDeps, claims: Claims): string {
  const payload = b64u(JSON.stringify(claims));
  return `${payload}.${sign(deps.secret, payload)}`;
}

function parse(deps: WorkerUiDeps, value: string | undefined): Claims | null {
  if (!value) return null;
  const [payload, sig] = value.split('.');
  if (!payload || !sig) return null;
  const expected = sign(deps.secret, payload);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
    if (!claims.sub || !claims.workerId || !claims.scope || !claims.csrf) return null;
    validateScope(claims.scope);
    return claims;
  } catch { return null; }
}

// A session lives only while the registry still backs it: same subject,
// still a worker, same workerId, and the bound scope still granted.
function recheck(deps: WorkerUiDeps, claims: Claims): boolean {
  const id = deps.identities.find((i) => i.subject === claims.sub);
  if (!id || id.role !== 'worker' || id.workerId !== claims.workerId) return false;
  return id.scopes.some((s) => s.tenantId === claims.scope.tenantId && s.workspaceId === claims.scope.workspaceId && s.projectId === claims.scope.projectId);
}

function cookiesOf(req: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function expectedOrigin(req: any): string {
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = fwd || (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${String(req.headers.host ?? '')}`;
}

function checkOrigin(req: any): void {
  const origin = req.headers.origin;
  if (!origin) throw new Error('ORIGIN_REQUIRED');
  if (String(origin) !== expectedOrigin(req)) throw new Error('ORIGIN_DENIED');
}

const page = (title: string, inner: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><main>${inner}</main></body></html>`;

const signinForm = (preCsrf: string) => page('AGY worker sign-in', `
  <h1>AGY worker sign-in</h1>
  <form id="agy-signin-form" method="post" action="/worker/ui/signin">
    <input type="hidden" name="pre_csrf" value="${esc(preCsrf)}">
    <label>Bearer token <input type="password" name="token" required autocomplete="off"></label>
    <fieldset><legend>Project scope (must be one of your identity scopes)</legend>
      <label>Tenant <input name="tenantId"></label>
      <label>Workspace <input name="workspaceId"></label>
      <label>Project <input name="projectId"></label>
    </fieldset>
    <button type="submit">Sign in</button>
  </form>`);

const actionForm = (claims: Claims) => page('AGY worker', `
  <h1>AGY worker: ${esc(claims.workerId)}</h1>
  <p>Scope: ${esc(claims.scope.tenantId)}/${esc(claims.scope.workspaceId)}/${esc(claims.scope.projectId)}</p>
  <form id="agy-action-form" data-worker="${esc(claims.workerId)}" method="post" action="/worker/ui/action">
    <input type="hidden" name="csrf" value="${esc(claims.csrf)}">
    <label>Action <select name="action">
      <option>claim</option><option>ack</option><option>heartbeat</option>
      <option>checkpoint</option><option>result</option><option>readback</option>
    </select></label>
    <label>Task ID <input name="task_id"></label>
    <label>Lease token <input name="lease_token"></label>
    <label>Attempt <input name="attempt" type="number"></label>
    <label>Lease seconds (claim/heartbeat) <input name="lease_seconds" type="number"></label>
    <label>External ID (checkpoint; also the idempotency key) <input name="external_id"></label>
    <label>Checkpoint state JSON <textarea name="state"></textarea></label>
    <label>Result summary <input name="result_summary"></label>
    <label>Result JSON (overrides summary) <textarea name="result"></textarea></label>
    <label>External operation ID (result evidence / idempotency key) <input name="external_operation_id"></label>
    <label>Evidence JSON (overrides operation id) <textarea name="evidence"></textarea></label>
    <label>Quota units used (result) <input name="quota_units" type="number" step="any"></label>
    <label>Cost amount (result) <input name="cost_amount" type="number" step="any"></label>
    <label>Idempotency key (optional alias) <input name="idempotency_key"></label>
    <button type="submit">Submit</button>
  </form>
  <form id="agy-signout-form" method="post" action="/worker/ui/signout">
    <input type="hidden" name="csrf" value="${esc(claims.csrf)}">
    <button type="submit">Sign out</button>
  </form>`);

// The envelope is VISIBLE text: a browser/DOM worker reads the result
// (http_status, action, and the full result incl. task/attempt/lease
// fields) from the rendered <pre>, never from a hidden script block.
const envelopePage = (status: number, action: string, payload: Record<string, unknown>) => page('AGY worker result', `
  <div id="agy-envelope" data-ok="${payload.ok === true}" data-action="${esc(action)}" data-http-status="${status}">
  <pre id="agy-response-envelope">${esc(JSON.stringify({ http_status: status, ...payload }, null, 2))}</pre>
  </div>`);

async function readBody(req: any): Promise<Record<string, any>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('REQUEST_TOO_LARGE'); chunks.push(Buffer.from(chunk)); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/json')) return JSON.parse(text);
  return Object.fromEntries(new URLSearchParams(text));
}

export function createWorkerUi(deps: WorkerUiDeps) {
  const ttl = deps.ttlSeconds ?? 1800;
  return async function workerUi(req: any, res: any): Promise<boolean> {
    const url = String(req.url ?? '');
    if (!url.startsWith('/worker/ui')) return false;
    const isForm = String(req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded');
    const json = (status: number, body: any) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ http_status: status, ...body })); };
    const html = (status: number, body: string) => { res.statusCode = status; res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(body); };
    const statusOf = (message: string) =>
      message === 'UNAUTHORIZED' || /SESSION/.test(message) ? 401 : /DENIED|CONFLICT|ORIGIN|CSRF/.test(message) ? 403 : 400;
    const fail = (e: any, action = '') => {
      const message = e instanceof Error ? e.message : 'REQUEST_FAILED';
      const code = /^[A-Z_]+$/.test(message) ? message : 'REQUEST_FAILED';
      const status = statusOf(code);
      if (isForm && req.method === 'POST') html(status, envelopePage(status, action, { ok: false, action, error: code }));
      else json(status, { ok: false, error: code });
    };
    const now = () => Math.floor(Date.now() / 1000);
    const liveClaims = (): Claims => {
      const claims = parse(deps, cookiesOf(req)[COOKIE]);
      if (!claims) throw new Error('SESSION_INVALID');
      if (claims.exp <= now()) throw new Error('SESSION_EXPIRED');
      if (!recheck(deps, claims)) throw new Error('SESSION_REVOKED');
      return claims;
    };
    try {
      if (req.method === 'GET' && url === '/worker/ui') {
        let claims: Claims | null = null;
        try { claims = liveClaims(); } catch { claims = null; }
        if (claims) { html(200, actionForm(claims)); return true; }
        const nonce = randomBytes(24).toString('base64url');
        const pre = `${nonce}.${sign(deps.secret, `pre:${nonce}`)}`;
        res.setHeader('set-cookie', `${PRE_COOKIE}=${pre}; HttpOnly; Secure; SameSite=Lax; Path=/worker/ui; Max-Age=600`);
        html(200, signinForm(pre));
        return true;
      }
      if (req.method === 'POST' && url === '/worker/ui/signout') {
        checkOrigin(req);
        const claims = liveClaims();
        const body = await readBody(req);
        if (!body.csrf || !sameSecret(String(body.csrf), claims.csrf)) throw new Error('CSRF_DENIED');
        res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/worker/ui; Max-Age=0`);
        if (isForm) html(200, envelopePage(200, 'signout', { ok: true, action: 'signout', status: 'SIGNED_OUT' }));
        else json(200, { ok: true, status: 'SIGNED_OUT' });
        return true;
      }
      if (req.method === 'POST' && url === '/worker/ui/signin') {
        checkOrigin(req);
        const body = await readBody(req);
        // Login CSRF: the pre-session cookie and the hidden field must
        // both be present, equal, and HMAC-valid.
        const preCookie = cookiesOf(req)[PRE_COOKIE];
        const [nonce, sig] = String(preCookie ?? '').split('.');
        if (!preCookie || !body.pre_csrf || !sameSecret(String(body.pre_csrf), preCookie)
          || !nonce || !sig || !sameSecret(sig, sign(deps.secret, `pre:${nonce}`))) {
          throw new Error('CSRF_DENIED');
        }
        const principal = authenticate(body.token ? `Bearer ${body.token}` : undefined, deps.identities);
        if (principal.role !== 'worker' || !principal.workerId) throw new Error('ACTION_DENIED');
        let scope = principal.scopes[0];
        if (body.tenantId || body.workspaceId || body.projectId) {
          scope = validateScope({ tenantId: body.tenantId, workspaceId: body.workspaceId, projectId: body.projectId });
          const match = principal.scopes.some((s) => s.tenantId === scope.tenantId && s.workspaceId === scope.workspaceId && s.projectId === scope.projectId);
          if (!match) throw new Error('PROJECT_SCOPE_DENIED');
        }
        const claims: Claims = { sub: principal.subject, workerId: principal.workerId, scope,
          exp: now() + ttl, csrf: randomBytes(24).toString('base64url') };
        res.setHeader('set-cookie', [`${COOKIE}=${mint(deps, claims)}; HttpOnly; Secure; SameSite=Lax; Path=/worker/ui; Max-Age=${ttl}`,
          `${PRE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/worker/ui; Max-Age=0`]);
        if (isForm) html(200, actionForm(claims));
        else json(200, { ok: true, status: 'SIGNED_IN', worker_id: claims.workerId, scope, csrf: claims.csrf, expires_at: claims.exp });
        return true;
      }
      if (req.method === 'POST' && url === '/worker/ui/action') {
        checkOrigin(req);
        const claims = liveClaims();
        const body = await readBody(req);
        if (!body.csrf || !sameSecret(String(body.csrf), claims.csrf)) throw new Error('CSRF_DENIED');
        const { action, csrf: _csrf, ...fields } = body;
        for (const k of ['result', 'evidence', 'state', 'payload']) {
          if (typeof fields[k] === 'string' && fields[k]) { try { fields[k] = JSON.parse(fields[k]); } catch { throw new Error('INVALID_JSON_FIELD'); } }
        }
        for (const k of ['attempt', 'lease_seconds', 'quota_units', 'cost_amount']) {
          if (fields[k] !== undefined && fields[k] !== '') fields[k] = Number(fields[k]);
        }
        // Plain-field composition so a DOM worker needs no raw JSON:
        if (!fields.result && fields.result_summary) fields.result = { summary: String(fields.result_summary) };
        if (!fields.evidence && fields.external_operation_id) fields.evidence = { external_operation_id: String(fields.external_operation_id) };
        if (fields.idempotency_key) {
          if (action === 'result' && fields.evidence && !fields.evidence.idempotency_key) fields.evidence.idempotency_key = String(fields.idempotency_key);
          if (action === 'checkpoint' && !fields.external_id) fields.external_id = String(fields.idempotency_key);
        }
        delete fields.result_summary; delete fields.external_operation_id; delete fields.idempotency_key;
        const principal: Principal = { subject: claims.sub, role: 'worker', scopes: [claims.scope], workerId: claims.workerId };
        const result = await deps.surface(principal, claims.scope, String(action ?? ''), fields);
        if (isForm) html(200, envelopePage(200, String(action ?? ''), { ok: true, action, result }));
        else json(200, { ok: true, action, result });
        return true;
      }
      json(404, { ok: false, error: 'NOT_FOUND' });
      return true;
    } catch (e) { fail(e, String((e as any)?.action ?? '')); return true; }
  };
}
