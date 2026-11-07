// Action-allowlist restriction for principals (candidate,
// 2026-11-03). The deployed auth model grants an operator read
// AND write within scope; a least-privilege read identity (e.g.
// for the MCP facade) is only honest if the restriction is
// enforced here, at the principal level — not by the facade
// merely choosing to call GET routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, authorize, identitiesFromEnv, type Principal } from '../src/platform/auth.js';

const scope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_QUALIFICATION' };
const other = { ...scope, projectId: 'OTHER' };

test('a read-restricted operator can read but cannot write, execute, qa or approve', () => {
  const p: Principal = { subject: 'facade-read', role: 'operator', scopes: [scope], actions: ['read'] };
  authorize(p, scope, 'read');
  for (const action of ['write', 'execute', 'qa', 'approve', 'platform'] as const)
    assert.throws(() => authorize(p, scope, action), /ACTION_DENIED/);
});

test('the allowlist narrows even platform-admin; an unrestricted principal keeps legacy behaviour', () => {
  const admin: Principal = { subject: 'admin-read', role: 'platform-admin', scopes: [scope], actions: ['read'] };
  authorize(admin, scope, 'read');
  assert.throws(() => authorize(admin, scope, 'write'), /ACTION_DENIED/);
  const legacy: Principal = { subject: 'operator-a', role: 'operator', scopes: [scope] };
  authorize(legacy, scope, 'read');
  authorize(legacy, scope, 'write'); // unchanged: operator writes in scope
  const legacyAdmin: Principal = { subject: 'root', role: 'platform-admin', scopes: [] };
  authorize(legacyAdmin, other, 'write'); // unchanged: admin bypass
});

test('scope fences still apply to restricted principals, and worker fences are untouched', () => {
  const p: Principal = { subject: 'facade-read', role: 'operator', scopes: [scope], actions: ['read'] };
  assert.throws(() => authorize(p, other, 'read'), /PROJECT_SCOPE_DENIED/);
  const worker: Principal = { subject: 'w', role: 'worker', workerId: 'W-1', scopes: [scope], actions: ['execute', 'read'] };
  authorize(worker, scope, 'execute');
  assert.throws(() => authorize(worker, scope, 'write'), /ACTION_DENIED/);
});

test('identitiesFromEnv validates the allowlist and authenticate carries it into the principal', () => {
  const env = { AGY_IDENTITIES_JSON: JSON.stringify([
    { subject: 'facade-read', role: 'operator', scopes: [scope], actions: ['read'], token: 'tok-read' },
    { subject: 'op', role: 'operator', scopes: [scope], token: 'tok-op' }]) };
  const ids = identitiesFromEnv(env);
  const p = authenticate('Bearer tok-read', ids);
  assert.deepEqual(p.actions, ['read']);
  assert.throws(() => authorize(p, scope, 'write'), /ACTION_DENIED/);
  const op = authenticate('Bearer tok-op', ids);
  assert.equal(op.actions, undefined);
  authorize(op, scope, 'write');
  // Malformed allowlists are configuration errors, not silent grants.
  assert.throws(() => identitiesFromEnv({ AGY_IDENTITIES_JSON: JSON.stringify([
    { subject: 'x', role: 'operator', scopes: [scope], actions: [], token: 't1' }]) }), /INVALID_IDENTITIES/);
  assert.throws(() => identitiesFromEnv({ AGY_IDENTITIES_JSON: JSON.stringify([
    { subject: 'x', role: 'operator', scopes: [scope], actions: ['bogus'], token: 't1' }]) }), /INVALID_IDENTITIES/);
});
