// Admission gate regressions (AGY Gemini admission candidate,
// 2026-11-03). workerGatePasses with a single-task admission:
// the pinned HELLO passes; the old video task, an expired window,
// and the old massage mission all deny. Without an admission the
// gate's semantics are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workerGatePasses, type WorkerGate } from '../src/platform/worker-gate.js';

const HELLO = '59a8e025-5779-4dc5-8f25-4d07c941471c';
const VIDEO = '7148c402-a605-41ef-bcc6-9802d46b4660';
const NOW = Date.parse('2026-11-03T04:00:00Z');
const base: WorkerGate = { workerId: 'GEMINI-SEO-WORKER',
  missions: ['GEMINI_UI_STAGING'], taskTypes: ['hello'], replyTargets: ['CHATGPT_ASSISTANT_CONTROL_PLANE'],
  admission: { taskId: HELLO, expiresAtMs: NOW + 600_000, nowMs: NOW } };
const helloSpec = { taskType: 'hello', taskId: HELLO,
  payload: { mission_id: 'GEMINI_UI_STAGING', target_worker_id: 'GEMINI-SEO-WORKER', callback_target: 'CHATGPT_ASSISTANT_CONTROL_PLANE' } };

test('the pinned HELLO task passes under a live admission', () => {
  assert.equal(workerGatePasses(base, helloSpec), true);
});

test('the old video task is denied under the HELLO admission (task pin)', () => {
  assert.equal(workerGatePasses(base, { ...helloSpec, taskType: 'video_preview', taskId: VIDEO }), false);
});

test('an expired admission denies even the pinned task', () => {
  const g = { ...base, admission: { taskId: HELLO, expiresAtMs: NOW - 1, nowMs: NOW } };
  assert.equal(workerGatePasses(g, helloSpec), false);
});

test('the old massage mission is denied when missions are narrowed to the admission mission', () => {
  // The surface narrows gate.missions to [admission.mission_id]; a
  // payload for the other bound mission must not pass.
  assert.equal(workerGatePasses(base, { ...helloSpec,
    payload: { ...helloSpec.payload, mission_id: 'AGY_MASSAGE_CRAFT_30S' } }), false);
});

test('a different task of the same type and mission is denied (pin is per-task)', () => {
  assert.equal(workerGatePasses(base, { ...helloSpec, taskId: '123e4567-e89b-12d3-a456-426614174000' }), false);
});

test('without an admission the gate keeps its original semantics', () => {
  const g: WorkerGate = { workerId: 'GEMINI-SEO-WORKER', missions: ['GEMINI_UI_STAGING', 'AGY_MASSAGE_CRAFT_30S'],
    taskTypes: ['hello', 'video_preview'], replyTargets: ['CHATGPT_ASSISTANT_CONTROL_PLANE'] };
  assert.equal(workerGatePasses(g, { ...helloSpec, taskId: 'anything' }), true);
  assert.equal(workerGatePasses(g, { taskType: 'video_preview', taskId: VIDEO,
    payload: { mission_id: 'AGY_MASSAGE_CRAFT_30S', target_worker_id: 'GEMINI-SEO-WORKER', callback_target: 'CHATGPT_ASSISTANT_CONTROL_PLANE' } }), true);
});
