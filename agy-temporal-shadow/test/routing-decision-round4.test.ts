// Round-4 regression tests — five execution repros against
// routing-decision v2 (886cbbd1) plus the budget-unit and
// unknown-availability semantics. Failing-first by design.
import test from "node:test";
import assert from "node:assert/strict";
import { decideRouting, planWorkBreakdown,
  type RoutingTaskInput, type WorkerCandidate, type RoutingContext } from "../src/platform/routing-decision.js";

const NOW = Date.parse('2026-11-03T01:00:00Z');
const FRESH = { snapshotAtMs: NOW - 60_000 };
const acct = (over: Record<string, unknown> = {}) => ({ accountId: 'acct-a', creditsRemaining: 100, reserveCredits: 0, unit: 'credit', ...FRESH, ...over });
const review = { accountId: 'acct-review', creditsRemaining: 100, reserveCredits: 0, unit: 'credit', ...FRESH };
const ctx = (over: Partial<RoutingContext> = {}): RoutingContext => ({
  accounts: [acct(), review], reviewAccountId: 'acct-review', reviewCostCredits: 1, journal: [], nowMs: NOW, ...over });
const task = (over: Partial<RoutingTaskInput> = {}): RoutingTaskInput => ({
  taskId: 't1', taskClass: 'research', requiredScope: 's', estimatedCredits: 3, estimateUnit: 'credit',
  resultDestination: 'mailbox:MB-1', ...over });
const modelWorker = (models: any[], over: Partial<WorkerCandidate> = {}): WorkerCandidate => ({
  workerId: 'W-1', provider: 'prov', accountId: 'acct-a', callable: true, scopes: ['s'],
  taskClasses: ['research'], models, ...over });
const goodModel = (over: Record<string, unknown> = {}) => ({
  modelId: 'pro', taskClasses: ['research'], creditsRemaining: null, availability: 'available', snapshotAtMs: NOW - 1000,
  performance: { research: { firstPassRate: 0.9, meanCreditsPerAccepted: 3, samples: 10 } }, ...over });

test("R4-1: requiredTools is a hard gate — a model with empty toolSupport cannot take a browser task", () => {
  const w = modelWorker([goodModel({ toolSupport: [] })]);
  const d = decideRouting(task({ requiredTools: ['browser'] }), [w], ctx());
  assert.notEqual(d.kind, 'ASSIGN');
  assert.equal(d.kind, 'REPAIR');
  const w2 = modelWorker([goodModel({ toolSupport: ['browser', 'search'] })]);
  const d2 = decideRouting(task({ requiredTools: ['browser'] }), [w2], ctx());
  assert.equal(d2.kind, 'ASSIGN');
});

test("R4-1b: UNKNOWN tool support prepares a teaching plan that requires verification — and the planner reserves nothing for it", () => {
  const w = modelWorker([goodModel({ toolSupport: undefined })]);
  const d = decideRouting(task({ requiredTools: ['browser'] }), [w], ctx());
  assert.equal(d.kind, 'TEACH_THEN_ASSIGN');
  if (d.kind === 'TEACH_THEN_ASSIGN') assert.ok((d.pendingVerification ?? []).some((v) => v.includes('browser')));
  // Planner must not reserve for an unverified teach: a following
  // normal task still sees the full account.
  const plan = planWorkBreakdown([task({ taskId: 'u1', requiredTools: ['browser'] }), task({ taskId: 'u2' })],
    [modelWorker([goodModel({})])], ctx({ accounts: [acct({ creditsRemaining: 4 }), review] }));
  assert.equal(plan[1].kind, 'ASSIGN', 'unverified teach reserved nothing, so the 3-credit task still fits the 4-credit account');
});

test("R4-2: capKnown with a null balance is an UNKNOWN cap — the unit waits for a reading, never assigns as if uncapped", () => {
  const w = modelWorker([goodModel({ capKnown: true, creditsRemaining: null })]);
  const d = decideRouting(task(), [w], ctx());
  assert.notEqual(d.kind, 'ASSIGN');
  assert.equal(d.kind, 'RESOURCE_WAIT');
});

test("R4-3: TEACH reserves the model cap too — two low-first-pass tasks against a 3-credit model cap teach at most once", () => {
  const w = modelWorker([goodModel({ capKnown: true, creditsRemaining: 3,
    performance: { research: { firstPassRate: 0.2, meanCreditsPerAccepted: 3, samples: 10 } } })]);
  const plan = planWorkBreakdown([task({ taskId: 'a' }), task({ taskId: 'b' })], [w], ctx());
  assert.equal(plan[0].kind, 'TEACH_THEN_ASSIGN');
  assert.notEqual(plan[1].kind, 'TEACH_THEN_ASSIGN');
  assert.equal(plan[1].kind, 'RESOURCE_WAIT');
});

test("R4-4: two role workerIds sharing one model pool cannot double-spend it — the pool is keyed by provider+account+pool, not workerId", () => {
  const mk = (workerId: string) => modelWorker([goodModel({ capKnown: true, creditsRemaining: 3 })], { workerId });
  const plan = planWorkBreakdown([task({ taskId: 'a' }), task({ taskId: 'b' })], [mk('W-exec'), mk('W-role2')], ctx());
  assert.equal(plan[0].kind, 'ASSIGN');
  assert.notEqual(plan[1].kind, 'ASSIGN');
  assert.equal(plan[1].kind, 'RESOURCE_WAIT');
});

test("R4-4b: inconsistent cap snapshots for the same shared pool are a repair, not a silent pick", () => {
  const mk = (workerId: string, cap: number) => modelWorker([goodModel({ capKnown: true, creditsRemaining: cap })], { workerId });
  const plan = planWorkBreakdown([task({ taskId: 'a' })], [mk('W-exec', 3), mk('W-role2', 5)], ctx());
  assert.equal(plan[0].kind, 'REPAIR');
});

test("R4-5: a snapshot from the future is not fresh — beyond a small clock skew it is rejected", () => {
  const future = { snapshotAtMs: NOW + 24 * 3600_000 };
  const d = decideRouting(task(), [modelWorker([goodModel({})])],
    ctx({ accounts: [acct({ ...future }), review] }));
  assert.notEqual(d.kind, 'ASSIGN');
  const near = decideRouting(task(), [modelWorker([goodModel({})])],
    ctx({ accounts: [acct({ snapshotAtMs: NOW + 30_000 }), review] }));
  assert.equal(near.kind, 'ASSIGN', 'a 30s future timestamp inside the skew allowance still counts as fresh');
});

test("R4-6: budget units must match the pool — an api_credit estimate cannot spend a subscription_message pool, and an unnamed-unit pool funds nothing", () => {
  const unmeasured: WorkerCandidate = { workerId: 'W-U', provider: 'prov', accountId: 'acct-a', callable: true,
    scopes: ['s'], taskClasses: ['research'] };
  const mismatch = decideRouting(task(), [unmeasured],
    ctx({ accounts: [acct({ unit: 'subscription_message' }), review] }));
  assert.notEqual(mismatch.kind, 'ASSIGN');
  const unnamed = decideRouting(task(), [modelWorker([goodModel({})])],
    ctx({ accounts: [acct({ unit: undefined }), review] }));
  assert.notEqual(unnamed.kind, 'ASSIGN');
  const matched = decideRouting(task(), [unmeasured], ctx());
  assert.equal(matched.kind, 'TEACH_THEN_ASSIGN', 'matching-unit estimate with an unmeasured worker is a bounded teach, still not a blind assign');
});

test("R4-7: unknown availability prepares a plan but is not executable — TEACH carries pendingVerification and the planner reserves nothing", () => {
  const w = modelWorker([goodModel({ availability: 'unknown' })]);
  const d = decideRouting(task(), [w], ctx());
  assert.equal(d.kind, 'TEACH_THEN_ASSIGN');
  if (d.kind === 'TEACH_THEN_ASSIGN') assert.ok((d.pendingVerification ?? []).includes('availability'));
  // The planner-side non-reservation for pendingVerification of any
  // source is covered by R4-1b's plan assertion.
});

test("R4-8: a hard budget routes only where the ceiling is enforced — prompt-level targets are not ceilings", () => {
  const hard = task({ hardBudget: true });
  // Prompt-only enforcement (e.g. a browser bridge whose prompt
  // states a target): never ASSIGN, never TEACH — resource wait.
  const promptOnly = ctx({ accounts: [acct({ budgetEnforcement: 'prompt_only' }), review] });
  assert.equal(decideRouting(hard, [modelWorker([goodModel({})])], promptOnly).kind, 'RESOURCE_WAIT');
  const teachPool = ctx({ accounts: [acct({ budgetEnforcement: 'prompt_only' }), review] });
  const lowFp = modelWorker([goodModel({ performance: { research: { firstPassRate: 0.2, meanCreditsPerAccepted: 3, samples: 10 } } })]);
  assert.equal(decideRouting(hard, [lowFp], teachPool).kind, 'RESOURCE_WAIT',
    'even a teaching budget is not labelled hard on an instruction-only pool');
  // Provider-enforced pool: normal routing, decision records it.
  const enforced = ctx({ accounts: [acct({ budgetEnforcement: 'provider' }), review] });
  const ok = decideRouting(hard, [modelWorker([goodModel({})])], enforced);
  assert.equal(ok.kind, 'ASSIGN');
  if (ok.kind === 'ASSIGN') assert.equal(ok.budgetEnforced, true);
  // Soft budget on a prompt-only pool still routes, but the TEACH
  // decision must carry budgetEnforced: false — never implied hard.
  const soft = decideRouting(task(), [lowFp], teachPool);
  assert.equal(soft.kind, 'TEACH_THEN_ASSIGN');
  if (soft.kind === 'TEACH_THEN_ASSIGN') assert.equal(soft.budgetEnforced, false);
});

test("R4-9: an unnamed estimate is a validation repair — caller estimates must be denominated", () => {
  const d = decideRouting(task({ estimateUnit: undefined }), [modelWorker([goodModel({})])], ctx());
  assert.equal(d.kind, 'REPAIR');
});
