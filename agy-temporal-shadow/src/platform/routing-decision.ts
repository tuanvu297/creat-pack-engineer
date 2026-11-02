// Resource-aware routing decision path (candidate, 2026-11-02).
//
// Turns the D3/D4 contracts (work breakdown + action journal +
// resource-aware routing) into a runnable, pure decision function.
// The function is deliberately free of I/O: its inputs and outputs
// are plain versioned JSON records (the "brain interface"), so the
// state — task list, worker/account snapshots, and the append-only
// action journal — survives a model or host replacement unchanged.
// Persisting the journal and executing an ASSIGN decision remain
// the caller's job (worker surface / mailbox); this module never
// dispatches anything itself and never reports a completion it did
// not observe: every task ends in exactly one explicit outcome —
// ASSIGN, TEACH_THEN_ASSIGN, REPAIR (an actionable fix), 
// RESOURCE_WAIT (a named missing resource), or RECONCILE_FIRST
// (a retained uncertain operation must be reconciled, never
// re-dispatched).

export const ROUTING_DECISION_VERSION = 1;

export interface RoutingTaskInput {
  taskId: string;
  taskClass: string;
  requiredScope: string;
  /** Rough pre-measurement estimate; null = unknown. */
  estimatedCredits: number | null;
  dependsOn?: string[];
  resultDestination: string;
}

export interface AccountState {
  accountId: string;
  /** null = UNKNOWN (never treated as zero or as infinite). */
  creditsRemaining: number | null;
  /** Credits that must stay untouched (other runs, safety floor). */
  reserveCredits: number;
}

export interface ClassPerformance {
  firstPassRate: number; // 0..1, measured
  meanCreditsPerAccepted: number | null; // measured; null = unmeasured cost
  samples: number;
}

export interface WorkerCandidate {
  workerId: string;
  /** Capacity pool. Roles/workers on one account SHARE its credits. */
  accountId: string;
  /** An authenticated route to this worker exists right now. */
  callable: boolean;
  scopes: string[];
  taskClasses: string[];
  performance?: Record<string, ClassPerformance>;
  /** Why it is not callable, when known (drives REPAIR outcomes). */
  blockedReason?: string;
}

export interface JournalEntry {
  ts: string;
  taskId: string;
  action: string; // e.g. ASSIGNED, RESULT_ACCEPTED, OPERATION_UNCERTAIN, OPERATION_RECONCILED
  actor: string;
  detail?: Record<string, unknown>;
}

export type RoutingDecision =
  | { kind: 'ASSIGN'; taskId: string; workerId: string; accountId: string; expectedTotalCredits: number | null; rationale: string[] }
  | { kind: 'TEACH_THEN_ASSIGN'; taskId: string; workerId: string; accountId: string; teachPlan: string[]; rationale: string[] }
  | { kind: 'REPAIR'; taskId: string; repair: string; rationale: string[] }
  | { kind: 'RESOURCE_WAIT'; taskId: string; waitFor: string; rationale: string[] }
  | { kind: 'RECONCILE_FIRST'; taskId: string; operationId: string; rationale: string[] };

export interface RoutingContext {
  accounts: AccountState[];
  /** Account that must retain capacity to review/accept outputs. */
  reviewAccountId: string;
  reviewCostCredits: number;
  journal: JournalEntry[];
  /** Minimum measured first-pass rate for a direct ASSIGN. */
  minFirstPassRate?: number;
}

const DEFAULT_MIN_FIRST_PASS = 0.5;

function expectedTotal(worker: WorkerCandidate, task: RoutingTaskInput): number | null {
  const perf = worker.performance?.[task.taskClass];
  if (perf && perf.meanCreditsPerAccepted != null && perf.firstPassRate > 0) {
    // Expected cost per ACCEPTED output, retries included.
    return perf.meanCreditsPerAccepted / perf.firstPassRate;
  }
  return task.estimatedCredits;
}

function hasUncertainOperation(taskId: string, journal: JournalEntry[]): string | null {
  const uncertain = journal.filter((e) => e.taskId === taskId && e.action === 'OPERATION_UNCERTAIN');
  if (!uncertain.length) return null;
  const reconciled = new Set(journal.filter((e) => e.taskId === taskId && e.action === 'OPERATION_RECONCILED')
    .map((e) => String(e.detail?.operationId ?? '')));
  for (const e of uncertain) {
    const opId = String(e.detail?.operationId ?? '');
    if (!reconciled.has(opId)) return opId;
  }
  return null;
}

export function decideRouting(task: RoutingTaskInput, workers: WorkerCandidate[], ctx: RoutingContext): RoutingDecision {
  const rationale: string[] = [];
  const minFirstPass = ctx.minFirstPassRate ?? DEFAULT_MIN_FIRST_PASS;

  // 0. A retained uncertain operation is reconciled, never retried.
  const uncertainOp = hasUncertainOperation(task.taskId, ctx.journal);
  if (uncertainOp) {
    return { kind: 'RECONCILE_FIRST', taskId: task.taskId, operationId: uncertainOp,
      rationale: [`journal holds OPERATION_UNCERTAIN ${uncertainOp} with no reconciliation record`] };
  }

  // 1. Dependencies must be ACCEPTED in the journal, not just done.
  for (const dep of task.dependsOn ?? []) {
    const accepted = ctx.journal.some((e) => e.taskId === dep && e.action === 'RESULT_ACCEPTED');
    if (!accepted) {
      return { kind: 'RESOURCE_WAIT', taskId: task.taskId, waitFor: `dependency ${dep} accepted`,
        rationale: [`dependency ${dep} has no RESULT_ACCEPTED journal entry`] };
    }
  }

  // 2. Filter hard gates first: callable route, authorized scope,
  //    supported task class. Quality and price never resurrect a
  //    candidate that fails a gate.
  const fit = workers.filter((w) => w.scopes.includes(task.requiredScope) && w.taskClasses.includes(task.taskClass));
  if (!fit.length) {
    return { kind: 'REPAIR', taskId: task.taskId,
      repair: `no authorized worker supports class ${task.taskClass} in scope ${task.requiredScope}`,
      rationale: ['zero candidates pass scope+class gates'] };
  }
  const callable = fit.filter((w) => w.callable);
  if (!callable.length) {
    const w = fit[0];
    return { kind: 'REPAIR', taskId: task.taskId,
      repair: `make ${w.workerId} callable: ${w.blockedReason ?? 'route not connected'}`,
      rationale: [`${fit.length} candidate(s) fit scope+class but none is callable`] };
  }

  // 3. Capacity is accounted PER ACCOUNT, shared across every role
  //    and worker on it — never summed per role name. The review
  //    capacity is charged against the same pool when the reviewer
  //    shares the executor's account.
  const accountOf = new Map(ctx.accounts.map((a) => [a.accountId, a]));
  const reviewAccount = accountOf.get(ctx.reviewAccountId);
  type Scored = { w: WorkerCandidate; expected: number | null; account: AccountState; headroom: number | null };
  const scored: Scored[] = [];
  for (const w of callable) {
    const account = accountOf.get(w.accountId);
    if (!account) { rationale.push(`${w.workerId}: account ${w.accountId} has no state record`); continue; }
    const expected = expectedTotal(w, task);
    const headroom = account.creditsRemaining == null ? null
      : account.creditsRemaining - account.reserveCredits
        - (w.accountId === ctx.reviewAccountId ? ctx.reviewCostCredits : 0);
    scored.push({ w, expected, account, headroom });
  }
  if (!scored.length) {
    return { kind: 'REPAIR', taskId: task.taskId, repair: 'supply account state for at least one callable candidate',
      rationale };
  }

  // 4. UNKNOWN quota is a wait, not a guess — unless another
  //    candidate's account is known and sufficient.
  const known = scored.filter((s) => s.account.creditsRemaining != null);
  if (!known.length) {
    return { kind: 'RESOURCE_WAIT', taskId: task.taskId, waitFor: 'a quota/credits reading for a callable candidate account',
      rationale: [...rationale, 'every callable candidate account has UNKNOWN credits'] };
  }
  // Review capacity exhausted on its own account blocks acceptance
  // of ANY new work, whoever executes it.
  if (reviewAccount && reviewAccount.creditsRemaining != null
      && reviewAccount.creditsRemaining - reviewAccount.reserveCredits < ctx.reviewCostCredits) {
    return { kind: 'RESOURCE_WAIT', taskId: task.taskId, waitFor: `review capacity on account ${ctx.reviewAccountId}`,
      rationale: [...rationale, `review account headroom is below the ${ctx.reviewCostCredits}-credit review cost; output could not be accepted`] };
  }
  const affordable = known.filter((s) => s.expected == null || (s.headroom != null && s.headroom >= s.expected));
  if (!affordable.length) {
    return { kind: 'RESOURCE_WAIT', taskId: task.taskId, waitFor: 'sufficient credits on a callable candidate account (expected total incl. retries + shared-account review charge + reserve)',
      rationale: [...rationale, 'no known-quota account covers the expected total for this task'] };
  }

  // 5. Rank by expected TOTAL credits per accepted output. A
  //    measured-but-weak candidate is a teaching candidate, not a
  //    rejection, when it is the best affordable option.
  const ranked = [...affordable].sort((a, b) => (a.expected ?? Number.POSITIVE_INFINITY) - (b.expected ?? Number.POSITIVE_INFINITY));
  const best = ranked[0];
  const perf = best.w.performance?.[task.taskClass];
  const measured = !!perf && perf.samples > 0;
  if (!measured || (perf && perf.firstPassRate < minFirstPass)) {
    return { kind: 'TEACH_THEN_ASSIGN', taskId: task.taskId, workerId: best.w.workerId, accountId: best.w.accountId,
      teachPlan: [
        'baseline: run one bounded task of this class unmodified; journal credits, latency, first-pass result',
        'teach: supply the source material and worked examples behind every baseline miss',
        'corrected rerun of the SAME task; journal the delta',
        'unseen transfer task of the same class; only a pass here updates the measured first-pass rate',
      ],
      rationale: [...rationale, measured
        ? `${best.w.workerId} measured first-pass ${(perf!.firstPassRate).toFixed(2)} < ${minFirstPass} for ${task.taskClass}; calibrate before production assignment`
        : `${best.w.workerId} is unmeasured for ${task.taskClass}; calibrate before trusting expected totals`] };
  }
  return { kind: 'ASSIGN', taskId: task.taskId, workerId: best.w.workerId, accountId: best.w.accountId,
    expectedTotalCredits: best.expected,
    rationale: [...rationale, `${best.w.workerId} is callable, in-scope, measured first-pass ${perf!.firstPassRate.toFixed(2)}, expected total ${best.expected} credits on account ${best.w.accountId}`] };
}

/** Append-only journal write: returns a NEW array; entries are never edited or removed. */
export function appendJournal(journal: JournalEntry[], entry: JournalEntry): JournalEntry[] {
  return [...journal, entry];
}

/** Plan a whole work breakdown: decide each task in dependency order. */
export function planWorkBreakdown(tasks: RoutingTaskInput[], workers: WorkerCandidate[], ctx: RoutingContext): RoutingDecision[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const ordered: RoutingTaskInput[] = [];
  const seen = new Set<string>();
  const visit = (t: RoutingTaskInput) => {
    if (seen.has(t.taskId)) return;
    seen.add(t.taskId);
    for (const dep of t.dependsOn ?? []) { const d = byId.get(dep); if (d) visit(d); }
    ordered.push(t);
  };
  tasks.forEach(visit);
  return ordered.map((t) => decideRouting(t, workers, ctx));
}
