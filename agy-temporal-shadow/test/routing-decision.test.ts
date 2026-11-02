// Unit tests for the resource-aware routing decision path
// (src/platform/routing-decision.ts) — one test per scenario the
// D3/D4 contracts name. Pure functions, synthetic fixtures; no I/O.
import test from "node:test";
import assert from "node:assert/strict";
import { decideRouting, planWorkBreakdown, appendJournal,
  type RoutingTaskInput, type WorkerCandidate, type RoutingContext, type JournalEntry } from "../src/platform/routing-decision.js";

const task: RoutingTaskInput = { taskId: 't1', taskClass: 'research', requiredScope: 'gl/research',
  estimatedCredits: 10, resultDestination: 'mailbox:MB-1' };
const rich = { accountId: 'acct-rich', creditsRemaining: 500, reserveCredits: 10 };
const reviewRich: RoutingContext = { accounts: [rich], reviewAccountId: 'acct-rich', reviewCostCredits: 4, journal: [] };

test("routing: high-skill worker on a low-credit account is assigned when the expected total fits", () => {
  const strong: WorkerCandidate = { workerId: 'W-STRONG', accountId: 'acct-low', callable: true,
    scopes: ['gl/research'], taskClasses: ['research'],
    performance: { research: { firstPassRate: 0.95, meanCreditsPerAccepted: 8, samples: 20 } } };
  const low = { accountId: 'acct-low', creditsRemaining: 20, reserveCredits: 5 };
  const d = decideRouting(task, [strong], { accounts: [low], reviewAccountId: 'acct-review', reviewCostCredits: 4, journal: [] });
  assert.equal(d.kind, 'ASSIGN');
  if (d.kind === 'ASSIGN') { assert.equal(d.workerId, 'W-STRONG'); assert.ok(d.expectedTotalCredits! < 9); }
});

test("routing: less-skilled worker with ample credits gets a teach/calibration path, not a rejection", () => {
  const weak: WorkerCandidate = { workerId: 'W-WEAK', accountId: 'acct-rich', callable: true,
    scopes: ['gl/research'], taskClasses: ['research'],
    performance: { research: { firstPassRate: 0.3, meanCreditsPerAccepted: 6, samples: 12 } } };
  const d = decideRouting(task, [weak], reviewRich);
  assert.equal(d.kind, 'TEACH_THEN_ASSIGN');
  if (d.kind === 'TEACH_THEN_ASSIGN') assert.equal(d.teachPlan.length, 4);
});

test("routing: UNKNOWN quota is a resource wait, never a guessed assignment", () => {
  const w: WorkerCandidate = { workerId: 'W-X', accountId: 'acct-unknown', callable: true,
    scopes: ['gl/research'], taskClasses: ['research'],
    performance: { research: { firstPassRate: 0.9, meanCreditsPerAccepted: 5, samples: 9 } } };
  const d = decideRouting(task, [w], { accounts: [{ accountId: 'acct-unknown', creditsRemaining: null, reserveCredits: 0 }],
    reviewAccountId: 'acct-review', reviewCostCredits: 4, journal: [] });
  assert.equal(d.kind, 'RESOURCE_WAIT');
});

test("routing: exhausted controller/review capacity blocks assignment even with a rich executor", () => {
  const exec: WorkerCandidate = { workerId: 'W-EXEC', accountId: 'acct-rich', callable: true,
    scopes: ['gl/research'], taskClasses: ['research'],
    performance: { research: { firstPassRate: 0.9, meanCreditsPerAccepted: 5, samples: 9 } } };
  const ctx: RoutingContext = { accounts: [rich, { accountId: 'acct-review', creditsRemaining: 2, reserveCredits: 0 }],
    reviewAccountId: 'acct-review', reviewCostCredits: 4, journal: [] };
  const d = decideRouting(task, [exec], ctx);
  assert.equal(d.kind, 'RESOURCE_WAIT');
  if (d.kind === 'RESOURCE_WAIT') assert.match(d.waitFor, /review capacity/);
});

test("routing: an alternate authorized worker is chosen when the primary is not callable", () => {
  const primary: WorkerCandidate = { workerId: 'W-PRIMARY', accountId: 'acct-rich', callable: false,
    scopes: ['gl/research'], taskClasses: ['research'], blockedReason: 'bindings unverified' };
  const alternate: WorkerCandidate = { workerId: 'W-ALT', accountId: 'acct-rich', callable: true,
    scopes: ['gl/research'], taskClasses: ['research'],
    performance: { research: { firstPassRate: 0.8, meanCreditsPerAccepted: 7, samples: 6 } } };
  const d = decideRouting(task, [primary, alternate], reviewRich);
  assert.equal(d.kind, 'ASSIGN');
  if (d.kind === 'ASSIGN') assert.equal(d.workerId, 'W-ALT');
});

test("routing: when NO fit worker is callable the outcome is an actionable repair, not a wait", () => {
  const primary: WorkerCandidate = { workerId: 'W-PRIMARY', accountId: 'acct-rich', callable: false,
    scopes: ['gl/research'], taskClasses: ['research'], blockedReason: 'bindings unverified' };
  const d = decideRouting(task, [primary], reviewRich);
  assert.equal(d.kind, 'REPAIR');
  if (d.kind === 'REPAIR') assert.match(d.repair, /W-PRIMARY/);
});

test("routing: a retained uncertain operation must be reconciled before any new dispatch", () => {
  const journal: JournalEntry[] = [{ ts: '2026-11-02T00:00:00Z', taskId: 't1', action: 'OPERATION_UNCERTAIN',
    actor: 'W-STRONG', detail: { operationId: 'op-77' } }];
  const w: WorkerCandidate = { workerId: 'W-STRONG', accountId: 'acct-rich', callable: true,
    scopes: ['gl/research'], taskClasses: ['research'],
    performance: { research: { firstPassRate: 0.95, meanCreditsPerAccepted: 8, samples: 20 } } };
  const d = decideRouting(task, [w], { ...reviewRich, journal });
  assert.equal(d.kind, 'RECONCILE_FIRST');
  // Once reconciled in the journal, routing proceeds normally.
  const journal2 = appendJournal(journal, { ts: '2026-11-02T01:00:00Z', taskId: 't1', action: 'OPERATION_RECONCILED',
    actor: 'controller', detail: { operationId: 'op-77' } });
  const d2 = decideRouting(task, [w], { ...reviewRich, journal: journal2 });
  assert.equal(d2.kind, 'ASSIGN');
  assert.equal(journal.length, 1, 'appendJournal never mutates the original journal');
});

test("routing: two roles on ONE shared account are charged against the same pool", () => {
  // Executor and reviewer share acct-shared (10 credits). The task
  // alone (8) and the review alone (4) each fit; together they do
  // not — the engine must not double-spend the pool by role name.
  const exec: WorkerCandidate = { workerId: 'W-EXEC', accountId: 'acct-shared', callable: true,
    scopes: ['gl/research'], taskClasses: ['research'],
    performance: { research: { firstPassRate: 1, meanCreditsPerAccepted: 8, samples: 5 } } };
  const ctx: RoutingContext = { accounts: [{ accountId: 'acct-shared', creditsRemaining: 10, reserveCredits: 0 }],
    reviewAccountId: 'acct-shared', reviewCostCredits: 4, journal: [] };
  const d = decideRouting(task, [exec], ctx);
  assert.equal(d.kind, 'RESOURCE_WAIT');
});

test("routing: work breakdown respects dependency acceptance and ordering", () => {
  const t2: RoutingTaskInput = { ...task, taskId: 't2', dependsOn: ['t1'] };
  const w: WorkerCandidate = { workerId: 'W-STRONG', accountId: 'acct-rich', callable: true,
    scopes: ['gl/research'], taskClasses: ['research'],
    performance: { research: { firstPassRate: 0.95, meanCreditsPerAccepted: 8, samples: 20 } } };
  const decisions = planWorkBreakdown([t2, task], [w], reviewRich);
  assert.equal(decisions[0].taskId, 't1', 'dependency is decided first');
  assert.equal(decisions[0].kind, 'ASSIGN');
  assert.equal(decisions[1].kind, 'RESOURCE_WAIT', 'dependent task waits for acceptance, never false-completes');
});
