// Helper delegation contract regressions (D-057, 2026-11-03):
// every deny the directive names, plus the happy path, the
// runtime budget fence, and child-key idempotency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssignment, validateBeforeSubmit, childKey, resultMatchesAssignment,
  unboundAdapter, type HelperAssignment } from '../src/platform/helper-delegation.js';

const NOW = Date.parse('2026-11-03T05:00:00Z');
const ok: HelperAssignment = { parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: '59a8e025-5779-4dc5-8f25-4d07c941471c',
  parentAttempt: 1, subtaskKey: 'extract-sources', helperId: 'grok',
  scope: { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' },
  sourceAllowlist: ['https://developers.facebook.com'], toolAllowlist: ['browser.read'],
  budget: { unit: 'provider_credits', cap: 10, spent: 0, enforcement: 'runtime', hard: true },
  expiresAtMs: NOW + 600_000, replyTarget: 'CHATGPT_ASSISTANT_CONTROL_PLANE' };

test('a complete bounded assignment validates', () => {
  assert.deepEqual(validateAssignment(ok, NOW), { ok: true, denies: [] });
});
test('wrong or missing parent is denied', () => {
  assert.ok(validateAssignment({ ...ok, parentWorkerId: '' }, NOW).denies.includes('PARENT_REQUIRED'));
  assert.ok(validateAssignment({ ...ok, parentAttempt: 0 }, NOW).denies.includes('ATTEMPT_INVALID'));
});
test('cross-scope (incomplete scope fence) is denied', () => {
  assert.ok(validateAssignment({ ...ok, scope: { tenantId: 'gl', workspaceId: '', projectId: 'X' } }, NOW).denies.includes('CROSS_SCOPE'));
});
test('an expired lease is denied', () => {
  assert.ok(validateAssignment(ok, NOW + 600_001).denies.includes('EXPIRED'));
});
test('unknown resource authority is denied (unnamed unit / unknown enforcement)', () => {
  assert.ok(validateAssignment({ ...ok, budget: { ...ok.budget, unit: '' } }, NOW).denies.includes('BUDGET_UNKNOWN'));
  assert.ok(validateAssignment({ ...ok, budget: { ...ok.budget, enforcement: 'unknown' } }, NOW).denies.includes('BUDGET_UNKNOWN'));
});
test('a hard budget on a prompt-only surface is denied (the Manus lesson)', () => {
  const v = validateAssignment({ ...ok, helperId: 'manus', budget: { ...ok.budget, enforcement: 'prompt_only' } }, NOW);
  assert.ok(v.denies.includes('HARD_BUDGET_UNENFORCED'));
  // ...but the same surface with a runtime fence validates:
  assert.equal(validateAssignment({ ...ok, helperId: 'manus' }, NOW).ok, true);
});
test('empty allowlists and a missing reply target are denied', () => {
  assert.ok(validateAssignment({ ...ok, toolAllowlist: [] }, NOW).denies.includes('ALLOWLIST_EMPTY'));
  assert.ok(validateAssignment({ ...ok, replyTarget: '' }, NOW).denies.includes('REPLY_TARGET_REQUIRED'));
});
test('the runtime fence stops a submission that would exceed the cap', () => {
  assert.equal(validateBeforeSubmit({ ...ok, budget: { ...ok.budget, spent: 8 } }, 2, NOW).ok, true);
  const v = validateBeforeSubmit({ ...ok, budget: { ...ok.budget, spent: 8 } }, 3, NOW);
  assert.equal(v.ok, false); assert.ok(v.denies.includes('BUDGET_EXCEEDED'));
});
test('child identity is deterministic — a retry re-derives the same child (no duplicate)', () => {
  assert.equal(childKey(ok), childKey({ ...ok }));
  assert.notEqual(childKey(ok), childKey({ ...ok, parentAttempt: 2 }));
});
test('a result from another scope or child does not match the assignment', () => {
  assert.equal(resultMatchesAssignment(ok, { childKey: childKey(ok), scope: ok.scope }), true);
  assert.equal(resultMatchesAssignment(ok, { childKey: childKey(ok), scope: { ...ok.scope, projectId: 'OTHER' } }), false);
});
test('an unbound adapter refuses honestly (no fake ACK)', async () => {
  const a = unboundAdapter('manus', 'browser-bridge');
  assert.equal(a.bound, false);
  await assert.rejects(() => a.submit(ok, {}), /HELPER_NOT_BOUND/);
});
