// Equipment contract tests (D-057 equip rule): every pin is
// fail-closed, the equipment digest is identity, and the
// adapter surface guard refuses any adapter that would run a
// different surface/model/auth binding than the assignment
// pins. Mock fetch only - no provider is contacted.
import test from "node:test";
import assert from "node:assert/strict";
import { validateAssignment, equipmentDigest, unboundAdapter, type HelperAssignment } from "../src/platform/helper-delegation.js";
import { manusAdapter, grokAdapter, assertAdapterMatchesAssignment, type FetchLike } from "../src/platform/helper-providers.js";
import { digestOf } from "../src/platform/digest.js";

const NOW = Date.now();
const eq = { pinnedSource: { ref: 'doc:input-1', digest: digestOf({ text: 'source' }) },
  surface: { kind: 'api', model: 'manus-api-v2', authBinding: 'manus:x-manus-api-key' },
  skillRef: 'skill:extract-dates', criteria: ['every date in the source appears in the output'], rework: { maxAttempts: 1 } };
const a: HelperAssignment = { parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: 'p1', parentAttempt: 1,
  subtaskKey: 's1', helperId: 'manus', scope: { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' },
  sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
  budget: { unit: 'provider_credits', cap: 100, spent: 0, enforcement: 'prompt_only', hard: false },
  expiresAtMs: NOW + 600_000, replyTarget: 'CHATGPT_ASSISTANT_CONTROL_PLANE', equipment: eq };
const noFetch: FetchLike = async () => { throw new Error('must not be called'); };

test('equipment: a fully pinned assignment validates; each missing pin denies by kind', () => {
  assert.equal(validateAssignment(a, NOW).ok, true);
  const denies = (over: any) => validateAssignment({ ...a, equipment: { ...eq, ...over } }, NOW).denies;
  assert.ok(denies({ pinnedSource: { ref: 'doc:x', digest: 'not-a-digest' } }).includes('SOURCE_UNPINNED'));
  assert.ok(denies({ pinnedSource: { ref: '', digest: eq.pinnedSource.digest } }).includes('SOURCE_UNPINNED'));
  assert.ok(denies({ surface: { kind: 'api', model: '', authBinding: 'x' } }).includes('SURFACE_UNPINNED'));
  assert.ok(denies({ skillRef: '' }).includes('SKILL_REQUIRED'));
  assert.ok(denies({ criteria: [] }).includes('CRITERIA_REQUIRED'));
  assert.ok(denies({ criteria: ['  '] }).includes('CRITERIA_REQUIRED'));
  assert.ok(denies({ rework: { maxAttempts: -1 } }).includes('REWORK_INVALID'));
  assert.ok(denies({ rework: { maxAttempts: 1.5 } }).includes('REWORK_INVALID'));
  assert.ok(validateAssignment({ ...a, equipment: undefined as any }, NOW).denies.includes('EQUIPMENT_REQUIRED'));
});

test('equipment: digest is stable for equal equipment and changes with any pin', () => {
  assert.equal(equipmentDigest(a), equipmentDigest({ ...a, equipment: JSON.parse(JSON.stringify(eq)) }));
  assert.notEqual(equipmentDigest(a), equipmentDigest({ ...a, equipment: { ...eq, criteria: ['different'] } }));
  assert.notEqual(equipmentDigest(a), equipmentDigest({ ...a, equipment: { ...eq, surface: { ...eq.surface, model: 'other' } } }));
});

test('surface guard: the adapter the assignment pins passes; every drift refuses', () => {
  const manus = manusAdapter({ apiKey: 'k', fetch: noFetch });
  assert.doesNotThrow(() => assertAdapterMatchesAssignment(a, manus));
  assert.throws(() => assertAdapterMatchesAssignment({ ...a, helperId: 'grok' }, manus), /SURFACE_HELPER_MISMATCH/);
  assert.throws(() => assertAdapterMatchesAssignment(a, unboundAdapter('manus', 'api')), /HELPER_NOT_BOUND/);
  assert.throws(() => assertAdapterMatchesAssignment(
    { ...a, equipment: { ...eq, surface: { ...eq.surface, kind: 'browser-bridge' } } }, manus), /SURFACE_KIND_MISMATCH/);
  assert.throws(() => assertAdapterMatchesAssignment(
    { ...a, equipment: { ...eq, surface: { ...eq.surface, model: 'manus-api-v9' } } }, manus), /SURFACE_MODEL_MISMATCH/);
  assert.throws(() => assertAdapterMatchesAssignment(
    { ...a, equipment: { ...eq, surface: { ...eq.surface, authBinding: 'manus:other-key' } } }, manus), /SURFACE_AUTH_MISMATCH/);
  const grokA: HelperAssignment = { ...a, helperId: 'grok',
    equipment: { ...eq, surface: { kind: 'api', model: 'grok-4.7', authBinding: 'xai:bearer' } } };
  assert.doesNotThrow(() => assertAdapterMatchesAssignment(grokA, grokAdapter({ apiKey: 'k', fetch: noFetch, model: 'grok-4.7' })));
  assert.throws(() => assertAdapterMatchesAssignment(grokA, grokAdapter({ apiKey: 'k', fetch: noFetch, model: 'grok-4.7-mini' })), /SURFACE_MODEL_MISMATCH/);
});
