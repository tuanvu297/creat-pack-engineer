// Source-only candidate. This gate does not register an MCP tool or grant access.
// The caller must supply an authenticated principal and a durable server-side
// idempotency store. A prompt, a client claim, or a cached token is insufficient.
const id = /^[A-Za-z0-9_-]{1,128}$/;
const hex = /^[a-f0-9]{32,128}$/;
const valid = (pattern, value) => typeof value === 'string' && pattern.test(value);

function deny(code) { throw new Error(code); }

export async function authorizeDispatch({ principal, task, policy, store, now = Date.now() }) {
  if (!principal || !task || !policy || !store) deny('DISPATCH_CONTEXT_MISSING');
  if (principal.revocation === 'HARD_REVOKE') deny('IDENTITY_REVOKED');
  if (principal.revocation === 'DRAIN') deny('DRAIN_NO_NEW_CLAIM');
  if (principal.revocation !== null && principal.revocation !== 'ACTIVE') deny('REVOCATION_STATE_DENIED');
  if (!valid(id, principal.identityId) || !principal.authenticated || !principal.scopes?.includes('agy.dispatch')) deny('SCOPE_DENIED');
  if (!policy.serverAllowlist?.includes(principal.identityId)) deny('IDENTITY_NOT_ALLOWLISTED');
  if (!policy.allowedRoles?.includes(principal.role)) deny('ROLE_DENIED');
  for (const field of ['tenantId', 'workspaceId', 'projectId']) {
    if (!valid(id, principal[field]) || !valid(id, task[field]) || principal[field] !== task[field] || policy[field] !== task[field])
      deny('PROJECT_SCOPE_DENIED');
  }
  if (!valid(id, task.targetWorkerId) || !policy.allowedTargetWorkerIds?.includes(task.targetWorkerId)) deny('TARGET_WORKER_DENIED');
  if (!valid(id, task.callbackTarget) || !policy.allowedCallbackTargets?.includes(task.callbackTarget)) deny('CALLBACK_TARGET_DENIED');
  if (!policy.allowedTaskTypes?.includes(task.taskType)) deny('TASK_TYPE_DENIED');
  if (!policy.allowedAdapters?.includes(task.adapter)) deny('ADAPTER_DENIED');
  if (principal.runId !== task.runId || policy.runId !== task.runId) deny('RUN_DENIED');
  if (!valid(id, task.runId) || !valid(id, task.taskId) || !valid(hex, task.idempotencyKey) || !valid(hex, task.nonce))
    deny('TASK_IDENTITY_INVALID');
  if (!Number.isInteger(policy.replayWindowMs) || policy.replayWindowMs < 1 ||
      !Number.isFinite(task.timestampMs) || Math.abs(now - task.timestampMs) > policy.replayWindowMs)
    deny('TIMESTAMP_DENIED');
  if (!Number.isInteger(policy.rateLimit) || policy.rateLimit < 1 || !Number.isInteger(policy.rateWindowMs) || policy.rateWindowMs < 1)
    deny('RATE_POLICY_MISSING');
  if (!Number.isFinite(policy.runExpiresAtMs) || now >= policy.runExpiresAtMs) deny('RUN_EXPIRED');
  if (!Number.isInteger(task.spendCap) || task.spendCap !== 0) deny('SPEND_CAP_DENIED');
  // A zero cap and a no-provider adapter are independent controls.
  if (!policy.noProviderTaskTypes?.includes(task.taskType) || !policy.noProviderAdapters?.includes(task.adapter))
    deny('PROVIDER_ROUTE_DENIED');
  // The store operation must be atomic and durable across process restarts.
  // It owns the nonce, rate counter, key->operation binding and replay result.
  const result = await store.reserve({ identityId: principal.identityId, runId: task.runId,
    taskId: task.taskId, idempotencyKey: task.idempotencyKey, nonce: task.nonce,
    timestampMs: task.timestampMs, rateLimit: policy.rateLimit, rateWindowMs: policy.rateWindowMs });
  if (!result || !['NEW', 'EXISTING'].includes(result.status) || !result.operationId) deny('RESERVATION_FAILED');
  if (result.status === 'EXISTING' && result.taskId !== task.taskId) deny('IDEMPOTENCY_CONFLICT');
  return { status: result.status, operationId: result.operationId, taskId: task.taskId };
}

