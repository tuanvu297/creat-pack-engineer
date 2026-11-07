// Round-3 regression tests for the routing decision path — each
// test reproduces a concrete defect found by independent execution
// of bb9c4493 (failing-first: all of these fail on that commit).
import test from "node:test";
import assert from "node:assert/strict";
import { decideRouting, planWorkBreakdown,
  type RoutingTaskInput, type WorkerCandidate, type RoutingContext } from "../src/platform/routing-decision.js";

const NOW = Date.parse('2026-11-02T16:00:00Z');
const fresh = { snapshotAtMs: NOW - 60_000 };
const reviewRich = { accountId: 'acct-review', creditsRemaining: 100, reserveCredits: 0, unit: 'credit', ...fresh };
const measured = (over: Partial<WorkerCandidate> = {}): WorkerCandidate => ({
  workerId: 'W-1', provider: 'test', accountId: 'acct-a', callable: true, scopes: ['s'], taskClasses: ['research'],
  performance: { research: { firstPassRate: 1, meanCreditsPerAccepted: 3, samples: 10 } }, ...over });
const task = (over: Partial<RoutingTaskInput> = {}): RoutingTaskInput => ({
  taskId: 't1', taskClass: 'research', requiredScope: 's', estimatedCredits: 3, estimateUnit: 'credit',
  resultDestination: 'mailbox:MB-1', ...over });
const ctx = (over: Partial<RoutingContext> = {}): RoutingContext => ({
  accounts: [{ accountId: 'acct-a', creditsRemaining: 5, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich],
  reviewAccountId: 'acct-review', reviewCostCredits: 1, journal: [], nowMs: NOW, ...over });

test("R3-1: planWorkBreakdown reserves execution + review across the whole plan — two 3-credit tasks on a 5-credit account: only the first assigns", () => {
  const t1 = task({ taskId: 't1' });
  const t2 = task({ taskId: 't2' });
  const decisions = planWorkBreakdown([t1, t2], [measured()], ctx());
  assert.equal(decisions[0].kind, 'ASSIGN');
  assert.notEqual(decisions[1].kind, 'ASSIGN', 'second task must not double-spend the shared account');
  assert.equal(decisions[1].kind, 'RESOURCE_WAIT');
});

test("R3-2: unknown cost (no estimate, unmeasured mean) is never a funded ASSIGN", () => {
  const w = measured({ performance: { research: { firstPassRate: 1, meanCreditsPerAccepted: null, samples: 10 } } });
  const d = decideRouting(task({ estimatedCredits: null }), [w],
    ctx({ accounts: [{ accountId: 'acct-a', creditsRemaining: 100, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich] }));
  assert.notEqual(d.kind, 'ASSIGN', 'unknown cost must require a bounded calibration budget');
  assert.equal(d.kind, 'RESOURCE_WAIT');
});

test("R3-2b: unknown cost WITH a bounded calibration budget yields TEACH_THEN_ASSIGN carrying that budget", () => {
  const w = measured({ performance: { research: { firstPassRate: 1, meanCreditsPerAccepted: null, samples: 10 } } });
  const d = decideRouting(task({ estimatedCredits: null, calibrationBudgetCredits: 4 }), [w],
    ctx({ accounts: [{ accountId: 'acct-a', creditsRemaining: 100, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich] }));
  assert.equal(d.kind, 'TEACH_THEN_ASSIGN');
  if (d.kind === 'TEACH_THEN_ASSIGN') assert.equal(d.calibrationBudgetCredits, 4);
});

test("R3-3: a missing reviewer account snapshot blocks assignment (acceptance capacity unverifiable)", () => {
  const d = decideRouting(task(), [measured()], ctx({ accounts: [{ accountId: 'acct-a', creditsRemaining: 50, reserveCredits: 0, unit: 'credit', ...fresh }] }));
  assert.notEqual(d.kind, 'ASSIGN');
  assert.equal(d.kind, 'REPAIR');
});

test("R3-3b: an UNKNOWN reviewer balance is a resource wait, not an assignment", () => {
  const d = decideRouting(task(), [measured()], ctx({ accounts: [
    { accountId: 'acct-a', creditsRemaining: 50, reserveCredits: 0, unit: 'credit', ...fresh },
    { accountId: 'acct-review', creditsRemaining: null, reserveCredits: 0, unit: 'credit', ...fresh }] }));
  assert.equal(d.kind, 'RESOURCE_WAIT');
});

test("R3-4: meanCreditsPerAccepted already includes rework — expected total is 4 at rate 0.5, affordable on 6", () => {
  const w = measured({ performance: { research: { firstPassRate: 0.5, meanCreditsPerAccepted: 4, samples: 8 } } });
  const d = decideRouting(task({ estimatedCredits: null }), [w],
    ctx({ accounts: [{ accountId: 'acct-a', creditsRemaining: 6, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich] }));
  assert.equal(d.kind, 'ASSIGN');
  if (d.kind === 'ASSIGN') assert.equal(d.expectedTotalCredits, 4, 'no second division by firstPassRate');
});

test("R3-5: invalid amounts (negative credits, NaN estimate, rate above 1) produce a repair, never an assignment", () => {
  const bad1 = decideRouting(task(), [measured()], ctx({ accounts: [
    { accountId: 'acct-a', creditsRemaining: -5, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich] }));
  assert.equal(bad1.kind, 'REPAIR');
  const bad2 = decideRouting(task({ estimatedCredits: Number.NaN }), [measured()], ctx());
  assert.equal(bad2.kind, 'REPAIR');
  const bad3 = decideRouting(task(), [measured({ performance: { research: { firstPassRate: 1.5, meanCreditsPerAccepted: 3, samples: 3 } } })], ctx());
  assert.equal(bad3.kind, 'REPAIR');
});

test("M1: model eligibility is task-specific — research routes to the model that supports it, never the cheaper tier that cannot", () => {
  const w: WorkerCandidate = { workerId: 'W-MULTI', provider: 'multi', accountId: 'acct-a', callable: true,
    scopes: ['s'], taskClasses: ['research', 'extraction'],
    models: [
      { modelId: 'lite', taskClasses: ['extraction'], creditsRemaining: null, availability: 'available', snapshotAtMs: NOW - 1000,
        performance: { extraction: { firstPassRate: 1, meanCreditsPerAccepted: 1, samples: 20 } } },
      { modelId: 'pro', taskClasses: ['research'], creditsRemaining: null, availability: 'available', snapshotAtMs: NOW - 1000,
        performance: { research: { firstPassRate: 0.9, meanCreditsPerAccepted: 5, samples: 12 } } },
    ] };
  const d = decideRouting(task(), [w], ctx({ accounts: [{ accountId: 'acct-a', creditsRemaining: 50, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich] }));
  assert.equal(d.kind, 'ASSIGN');
  if (d.kind === 'ASSIGN') assert.equal(d.modelId, 'pro');
});

test("M2: a model-specific cap binds even when the shared account is rich", () => {
  const w: WorkerCandidate = { workerId: 'W-CAP', provider: 'multi', accountId: 'acct-a', callable: true,
    scopes: ['s'], taskClasses: ['research'],
    models: [{ modelId: 'capped', taskClasses: ['research'], creditsRemaining: 2, capKnown: true, availability: 'available',
      snapshotAtMs: NOW - 1000, performance: { research: { firstPassRate: 1, meanCreditsPerAccepted: 3, samples: 9 } } }] };
  const d = decideRouting(task(), [w], ctx({ accounts: [{ accountId: 'acct-a', creditsRemaining: 500, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich] }));
  assert.notEqual(d.kind, 'ASSIGN');
  assert.equal(d.kind, 'RESOURCE_WAIT');
});

test("M3: unknown model availability is calibration-only, and a stale model snapshot makes availability unknown", () => {
  const mk = (availability: 'unknown' | 'available', snapshotAtMs: number): WorkerCandidate => ({
    workerId: 'W-UNK', provider: 'multi', accountId: 'acct-a', callable: true, scopes: ['s'], taskClasses: ['research'],
    models: [{ modelId: 'mystery', taskClasses: ['research'], creditsRemaining: null, availability, snapshotAtMs,
      performance: { research: { firstPassRate: 0.95, meanCreditsPerAccepted: 3, samples: 9 } } }] });
  const richCtx = ctx({ accounts: [{ accountId: 'acct-a', creditsRemaining: 100, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich] });
  const d1 = decideRouting(task(), [mk('unknown', NOW - 1000)], richCtx);
  assert.notEqual(d1.kind, 'ASSIGN');
  assert.equal(d1.kind, 'TEACH_THEN_ASSIGN');
  const d2 = decideRouting(task(), [mk('available', NOW - 60 * 60_000)], richCtx);
  assert.notEqual(d2.kind, 'ASSIGN', 'stale model snapshot downgrades availability to unknown');
});

test("M4: reviewer model capacity is verified — UNKNOWN cap waits, insufficient cap waits, sufficient proceeds", () => {
  const richCtx = (cap: number | null | undefined) => ctx({
    accounts: [{ accountId: 'acct-a', creditsRemaining: 100, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich], reviewModelCapCredits: cap });
  assert.equal(decideRouting(task(), [measured()], richCtx(null)).kind, 'RESOURCE_WAIT');
  assert.equal(decideRouting(task(), [measured()], richCtx(0)).kind, 'RESOURCE_WAIT');
  assert.equal(decideRouting(task(), [measured()], richCtx(5)).kind, 'ASSIGN');
});

test("M5: a native automatic mode is an ordinary observed mode — assignable on its own measured record, no fabricated version", () => {
  const w: WorkerCandidate = { workerId: 'W-AUTO', provider: 'multi', accountId: 'acct-a', callable: true,
    scopes: ['s'], taskClasses: ['research'],
    models: [{ modelId: 'native-auto', taskClasses: ['research'], creditsRemaining: null, availability: 'available',
      snapshotAtMs: NOW - 1000, performance: { research: { firstPassRate: 0.9, meanCreditsPerAccepted: 4, samples: 7 } } }] };
  const d = decideRouting(task(), [w], ctx({ accounts: [{ accountId: 'acct-a', creditsRemaining: 50, reserveCredits: 0, unit: 'credit', ...fresh }, reviewRich] }));
  assert.equal(d.kind, 'ASSIGN');
  if (d.kind === 'ASSIGN') assert.equal(d.modelId, 'native-auto');
});

test("M6: quota kind is carried on the decision — subscription quota is never reported as API credits", () => {
  const sub = { accountId: 'acct-a', creditsRemaining: 50, reserveCredits: 0, unit: 'credit', quotaKind: 'subscription' as const, ...fresh };
  const d = decideRouting(task(), [measured()], ctx({ accounts: [sub, reviewRich] }));
  assert.equal(d.kind, 'ASSIGN');
  if (d.kind === 'ASSIGN') assert.equal(d.quotaKind, 'subscription');
});

test("R3-6: a stale resource snapshot is not treated as eligible", () => {
  const stale = { snapshotAtMs: NOW - 60 * 60_000 };
  const d = decideRouting(task(), [measured()], ctx({ accounts: [
    { accountId: 'acct-a', creditsRemaining: 50, reserveCredits: 0, unit: 'credit', ...stale }, reviewRich],
    maxSnapshotAgeMs: 15 * 60_000 }));
  assert.notEqual(d.kind, 'ASSIGN');
  assert.equal(d.kind, 'RESOURCE_WAIT');
});
