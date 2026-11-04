// Pure routing tests (helper-routing.ts): capability/quality
// gate first, budget compatibility second, measured fit third.
// No I/O anywhere in the module under test.
import test from "node:test";
import assert from "node:assert/strict";
import { routeHelper, type HelperCandidate } from "../src/platform/helper-routing.js";

const manus: HelperCandidate = { helperId: 'manus', bound: true, surfaces: ['api', 'browser-bridge'],
  capabilities: ['text', 'web-research', 'extraction'], fitScore: 0.8,
  balance: { known: true, units: 500 }, enforcement: 'prompt_only', actualCostBounded: false, expectedCost: 15 };
const grok: HelperCandidate = { helperId: 'grok', bound: true, surfaces: ['api'],
  capabilities: ['text', 'reasoning'], fitScore: 0.6,
  balance: { known: true, units: 3 }, enforcement: 'runtime', actualCostBounded: true, expectedCost: 0.01 };
const soft = { requiredCapabilities: ['text'], surfaceKind: 'api', budget: { cap: 100, spent: 0, hard: false } };

test('routing: capability gate beats fit - a helper missing the capability never wins', () => {
  const d: any = routeHelper({ ...soft, requiredCapabilities: ['web-research'] }, [grok, manus]);
  assert.equal(d.helperId, 'manus');
  const none: any = routeHelper({ ...soft, requiredCapabilities: ['video'] }, [grok, manus]);
  assert.ok(Array.isArray(none.denied) && none.denied.length === 2, 'both denied with reasons');
  assert.ok(none.denied.every((x: any) => x.reasons.some((r: string) => r.startsWith('CAPABILITY_MISSING'))));
});

test('routing: highest measured fit wins among eligible; unbound is out', () => {
  const d: any = routeHelper(soft, [{ ...manus, bound: false }, grok]);
  assert.equal(d.helperId, 'grok');
  const d2: any = routeHelper(soft, [grok, manus]);
  assert.equal(d2.helperId, 'manus', 'fit 0.8 beats 0.6');
  assert.equal(d2.fitMeasured, true);
});

test('routing: hard budget denies prompt_only/unbounded and unknown balance; bounded+known passes', () => {
  const hard = { ...soft, budget: { cap: 100, spent: 0, hard: true } };
  const d: any = routeHelper(hard, [manus, grok]);
  assert.equal(d.helperId, 'grok', 'manus prompt_only+unbounded is out under a hard cap');
  const unknown = { ...grok, balance: { known: false } };
  const none: any = routeHelper(hard, [manus, unknown]);
  assert.ok(none.denied?.some((x: any) => x.helperId === 'grok' && x.reasons.includes('BALANCE_UNKNOWN_HARD_BUDGET')),
    'unknown balance cannot fund a hard-capped attempt');
});

test('routing: known balance must cover the expected cost', () => {
  const poor = { ...manus, balance: { known: true, units: 5 }, expectedCost: 15 };
  const none: any = routeHelper(soft, [poor]);
  assert.ok(none.denied?.[0].reasons.includes('BALANCE_INSUFFICIENT'));
  const d: any = routeHelper({ ...soft, budget: { cap: 10, spent: 0, hard: false } }, [manus]);
  assert.ok(d.denied?.[0].reasons.includes('BALANCE_INSUFFICIENT'), 'assignment cap room also bounds, not just balance');
});

test('routing: surface the assignment cannot pin is ineligible; ties break on cost then id', () => {
  const d: any = routeHelper({ ...soft, surfaceKind: 'browser-bridge' }, [grok, manus]);
  assert.equal(d.helperId, 'manus', 'grok offers no browser-bridge surface');
  const tie = [{ ...grok, fitScore: 0.5, expectedCost: 2 }, { ...manus, fitScore: 0.5, expectedCost: 1, balance: { known: true, units: 500 } }];
  const d2: any = routeHelper(soft, tie as any);
  assert.equal(d2.helperId, 'manus', 'equal fit -> lower expected cost wins');
});
