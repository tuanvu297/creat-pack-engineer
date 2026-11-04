// Adversarial regressions for the delegation contract, from
// root's independent probes on 13f3362b (2026-11-03). Each case
// FAILED against the original module: negative/NaN spent,
// NaN/Infinity/negative nextCost, and the exact expiry instant
// were all accepted. The contract must fail closed on every
// non-finite, negative, or boundary value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAssignment, validateBeforeSubmit, type HelperAssignment } from '../src/platform/helper-delegation.js';

const NOW = Date.parse('2026-11-03T05:00:00Z');
const base: HelperAssignment = { parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: '59a8e025-5779-4dc5-8f25-4d07c941471c',
  parentAttempt: 1, subtaskKey: 'extract', helperId: 'grok',
  scope: { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' },
  sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
  budget: { unit: 'provider_credits', cap: 10, spent: 0, enforcement: 'runtime', hard: true }, actualCostBounded: true,
  expiresAtMs: NOW + 600_000, replyTarget: 'CHATGPT_ASSISTANT_CONTROL_PLANE',
  equipment: { pinnedSource: { ref: 'doc:fixture-input', digest: 'a'.repeat(64) },
    surface: { kind: 'api', model: 'fixture-model', authBinding: 'fixture:binding' },
    skillRef: 'skill:fixture', criteria: ['output addresses the pinned source'], rework: { maxAttempts: 1 } } };
const withBudget = (b: Partial<HelperAssignment['budget']>) => ({ ...base, budget: { ...base.budget, ...b } });

test('negative spent is denied', () => {
  assert.equal(validateAssignment(withBudget({ spent: -100 }), NOW).ok, false);
});
test('NaN spent is denied', () => {
  assert.equal(validateAssignment(withBudget({ spent: NaN }), NOW).ok, false);
});
test('infinite or negative cap is denied', () => {
  assert.equal(validateAssignment(withBudget({ cap: Infinity }), NOW).ok, false);
  assert.equal(validateAssignment(withBudget({ cap: -1 }), NOW).ok, false);
});
test('NaN nextCost is denied at the pre-submit fence', () => {
  assert.equal(validateBeforeSubmit(base, NaN, NOW).ok, false);
});
test('infinite nextCost is denied at the pre-submit fence', () => {
  assert.equal(validateBeforeSubmit(base, Infinity, NOW).ok, false);
});
test('negative nextCost is denied at the pre-submit fence', () => {
  assert.equal(validateBeforeSubmit(base, -5, NOW).ok, false);
});
test('the exact expiry instant is denied (strict deadline)', () => {
  assert.equal(validateAssignment(base, base.expiresAtMs).ok, false);
  assert.equal(validateAssignment(base, base.expiresAtMs - 1).ok, true);
});
test('a hard budget is denied when actual per-call cost is unbounded on a non-provider-enforced surface', () => {
  // Manus shape: provider-metered actuals, no provider budget
  // parameter, prompt-only targets. A runtime preflight estimate
  // cannot bound the actual debit, so hard-budget is unsafe.
  const manus = { ...base, helperId: 'manus' as const, actualCostBounded: false,
    budget: { ...base.budget, enforcement: 'runtime' as const } };
  const v = validateAssignment(manus, NOW);
  assert.equal(v.ok, false);
  assert.ok(v.denies.includes('HARD_BUDGET_UNENFORCED'));
});
