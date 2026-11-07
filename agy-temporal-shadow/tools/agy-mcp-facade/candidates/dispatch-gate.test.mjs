import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeDispatch } from './dispatch-gate.mjs';

const now = 100000;
const principal = { identityId: 'gemini-real', role: 'worker', authenticated: true,
  scopes: ['agy.dispatch'], runId: 'run-p0', revocation: null,
  tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION' };
const task = { runId: 'run-p0', taskId: 'task-a0', taskType: 'inventory', adapter: 'offline',
  idempotencyKey: 'a'.repeat(64), nonce: 'b'.repeat(64), timestampMs: now, spendCap: 0,
  tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION',
  targetWorkerId: 'gemini-real', callbackTarget: 'CHATGPT_ASSISTANT_CONTROL_PLANE' };
const policy = { serverAllowlist: ['gemini-real'], allowedRoles: ['worker'], allowedTaskTypes: ['inventory'],
  allowedAdapters: ['offline'], noProviderTaskTypes: ['inventory'], noProviderAdapters: ['offline'],
  tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_AUTOMATION',
  allowedTargetWorkerIds: ['gemini-real'], allowedCallbackTargets: ['CHATGPT_ASSISTANT_CONTROL_PLANE'],
  runId: 'run-p0', runExpiresAtMs: now + 1000, replayWindowMs: 1000, rateLimit: 2, rateWindowMs: 1000 };
const store = { calls: 0, async reserve(v) { this.calls++; return { status: 'NEW', operationId: 'op-1', taskId: v.taskId }; } };
const call = (overrides = {}) => authorizeDispatch({ principal, task, policy, store, now, ...overrides });
const rejected = async (code, overrides) => {
  const before = store.calls;
  await assert.rejects(call(overrides), new RegExp(code));
  assert.equal(store.calls, before, 'denied request must not reserve an operation');
};

test('P0 no-provider task gets one durable reservation', async () => {
  assert.deepEqual(await call(), { status: 'NEW', operationId: 'op-1', taskId: 'task-a0' });
});
test('identity and scope fail closed before reservation', async () => {
  await rejected('SCOPE_DENIED', { principal: { ...principal, scopes: ['agy.read'] } });
  await rejected('SCOPE_DENIED', { principal: { ...principal, identityId: undefined } });
  await rejected('IDENTITY_NOT_ALLOWLISTED', { policy: { ...policy, serverAllowlist: [] } });
  await rejected('ROLE_DENIED', { principal: { ...principal, role: 'viewer' } });
  await rejected('RUN_DENIED', { task: { ...task, runId: 'other' } });
  await rejected('PROJECT_SCOPE_DENIED', { task: { ...task, projectId: 'other' } });
  await rejected('TARGET_WORKER_DENIED', { task: { ...task, targetWorkerId: 'other' } });
  await rejected('CALLBACK_TARGET_DENIED', { task: { ...task, callbackTarget: 'other' } });
});
test('P0 provider and spend controls are independent', async () => {
  await rejected('SPEND_CAP_DENIED', { task: { ...task, spendCap: 1 } });
  await rejected('PROVIDER_ROUTE_DENIED', { task: { ...task, adapter: 'gemini' },
    policy: { ...policy, allowedAdapters: ['gemini'] } });
  await rejected('TASK_TYPE_DENIED', { task: { ...task, taskType: 'video' } });
});
test('revocation, time and rate policy fail closed', async () => {
  await rejected('IDENTITY_REVOKED', { principal: { ...principal, revocation: 'HARD_REVOKE' } });
  await rejected('DRAIN_NO_NEW_CLAIM', { principal: { ...principal, revocation: 'DRAIN' } });
  await rejected('REVOCATION_STATE_DENIED', { principal: { ...principal, revocation: 'SUSPENDED' } });
  await rejected('TIMESTAMP_DENIED', { task: { ...task, timestampMs: 0 } });
  await rejected('TIMESTAMP_DENIED', { policy: { ...policy, replayWindowMs: undefined } });
  await rejected('RATE_POLICY_MISSING', { policy: { ...policy, rateLimit: undefined } });
  await rejected('RUN_EXPIRED', { policy: { ...policy, runExpiresAtMs: now } });
});
test('replay can only resolve to original task and operation', async () => {
  const replayStore = { async reserve(v) { return { status: 'EXISTING', operationId: 'op-1', taskId: v.taskId }; } };
  assert.equal((await call({ store: replayStore })).operationId, 'op-1');
  await assert.rejects(call({ store: { async reserve() { return { status: 'EXISTING', operationId: 'op-2', taskId: 'another' }; } } }),
    /IDEMPOTENCY_CONFLICT/);
});

