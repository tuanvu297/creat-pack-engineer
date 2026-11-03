// Resource-aware routing decision path (candidate, 2026-11-03, v2).
//
// Turns the D3/D4 contracts (work breakdown + action journal +
// resource-aware routing) into a runnable, pure decision function.
// Inputs and outputs are plain versioned JSON records (the "brain
// interface"), so the state survives a model or host replacement.
// The module never dispatches anything itself and never reports a
// completion it did not observe: every task ends in exactly one
// explicit outcome — ASSIGN, TEACH_THEN_ASSIGN, REPAIR,
// RESOURCE_WAIT, or RECONCILE_FIRST.
//
// Routing unit = (provider, worker, account, MODEL/MODE, task
// class). Models are observed, never assumed: a provider's tiers
// differ in task-class eligibility and tool support, share the
// account pool, and may ALSO carry model-specific caps. A native
// "automatic" mode is an ordinary observed mode named as observed
// (e.g. 'native-auto') — never a fabricated underlying version.
//
// Metric definitions (single, precise):
// - meanCreditsPerAccepted: MEASURED credits per ACCEPTED output
//   for (worker, model, class), retries and rework ALREADY
//   included. It is never divided by firstPassRate again.
// - firstPassRate: quality signal only — the share of first
//   attempts accepted without rework. It gates direct assignment;
//   it is not a cost divisor.
// - expectedTotalCredits for an ASSIGN = meanCreditsPerAccepted
//   when measured, else the task's own estimatedCredits (labelled
//   an estimate), else UNKNOWN (null) — and an unknown cost is
//   never a funded assignment: it needs a bounded calibration
//   budget (task.calibrationBudgetCredits) or it waits.
// - quotaKind distinguishes account API credits from subscription
//   chat quota; the two are never summed or substituted.
//
// Freshness: every account and model snapshot carries
// snapshotAtMs; a missing or stale snapshot (older than
// ctx.maxSnapshotAgeMs) is not evidence and cannot ground an
// eligible decision.

export const ROUTING_DECISION_VERSION = 2;

export interface RoutingTaskInput {
  taskId: string;
  taskClass: string;
  requiredScope: string;
  /** Pre-measurement estimate; null = unknown. */
  estimatedCredits: number | null;
  /** Bounded budget for calibrating an unknown-cost task. */
  calibrationBudgetCredits?: number | null;
  dependsOn?: string[];
  resultDestination: string;
}

export type QuotaKind = 'api_credits' | 'subscription' | 'unknown';

export interface AccountState {
  accountId: string;
  /** null = UNKNOWN (never treated as zero or as infinite). */
  creditsRemaining: number | null;
  reserveCredits: number;
  quotaKind?: QuotaKind;
  /** When this snapshot was observed; missing = unverifiable. */
  snapshotAtMs?: number;
}

export interface ClassPerformance {
  firstPassRate: number; // 0..1, measured quality signal
  meanCreditsPerAccepted: number | null; // measured, rework included
  meanLatencyMs?: number | null;
  samples: number;
}

export interface ModelOption {
  /** Observed model/mode name, exactly as the provider shows it. */
  modelId: string;
  /** Task classes this model/mode is observed to support. */
  taskClasses: string[];
  /** Observed tool support for this mode, when known. */
  toolSupport?: string[];
  /** Model-specific remaining cap; null = no separate cap OR unknown — see capKnown. */
  creditsRemaining: number | null;
  /** true when creditsRemaining is a real separate cap (vs none). */
  capKnown?: boolean;
  availability?: 'available' | 'unavailable' | 'unknown';
  snapshotAtMs?: number;
  performance?: Record<string, ClassPerformance>;
}

export interface WorkerCandidate {
  workerId: string;
  provider: string;
  /** Capacity pool. Models/workers on one account SHARE its credits. */
  accountId: string;
  callable: boolean;
  scopes: string[];
  taskClasses: string[];
  /** Observed models/modes. Absent = one implicit worker-default unit. */
  models?: ModelOption[];
  performance?: Record<string, ClassPerformance>;
  blockedReason?: string;
}

export interface JournalEntry {
  ts: string;
  taskId: string;
  action: string;
  actor: string;
  detail?: Record<string, unknown>;
}

export type RoutingDecision =
  | { kind: 'ASSIGN'; taskId: string; workerId: string; modelId: string; accountId: string; quotaKind: QuotaKind; expectedTotalCredits: number; costBasis: 'measured' | 'estimated'; rationale: string[] }
  | { kind: 'TEACH_THEN_ASSIGN'; taskId: string; workerId: string; modelId: string; accountId: string; calibrationBudgetCredits: number | null; teachPlan: string[]; rationale: string[] }
  | { kind: 'REPAIR'; taskId: string; repair: string; rationale: string[] }
  | { kind: 'RESOURCE_WAIT'; taskId: string; waitFor: string; rationale: string[] }
  | { kind: 'RECONCILE_FIRST'; taskId: string; operationId: string; rationale: string[] };

export interface RoutingContext {
  accounts: AccountState[];
  reviewAccountId: string;
  reviewCostCredits: number;
  /** Reviewer's own model cap when the reviewer is a specific model; null = UNKNOWN cap. */
  reviewModelCapCredits?: number | null;
  journal: JournalEntry[];
  minFirstPassRate?: number;
  nowMs?: number;
  maxSnapshotAgeMs?: number;
}

const DEFAULT_MIN_FIRST_PASS = 0.5;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 15 * 60_000;
const TEACH_PLAN = [
  'baseline: run one bounded task of this class unmodified; journal credits, latency, first-pass result',
  'teach: supply the source material and worked examples behind every baseline miss',
  'corrected rerun of the SAME task; journal the delta',
  'unseen transfer task of the same class; only a pass here updates the measured first-pass rate',
];

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonNeg = (v: unknown): v is number => isNum(v) && (v as number) >= 0;

function validateInputs(task: RoutingTaskInput, workers: WorkerCandidate[], ctx: RoutingContext): string[] {
  const issues: string[] = [];
  if (task.estimatedCredits != null && !isNonNeg(task.estimatedCredits)) issues.push(`task.estimatedCredits invalid: ${task.estimatedCredits}`);
  if (task.calibrationBudgetCredits != null && !(isNum(task.calibrationBudgetCredits) && task.calibrationBudgetCredits > 0)) issues.push(`task.calibrationBudgetCredits invalid: ${task.calibrationBudgetCredits}`);
  if (!isNonNeg(ctx.reviewCostCredits)) issues.push(`reviewCostCredits invalid: ${ctx.reviewCostCredits}`);
  if (ctx.reviewModelCapCredits != null && ctx.reviewModelCapCredits !== undefined && !isNonNeg(ctx.reviewModelCapCredits)) issues.push(`reviewModelCapCredits invalid: ${ctx.reviewModelCapCredits}`);
  for (const a of ctx.accounts) {
    if (a.creditsRemaining != null && !isNonNeg(a.creditsRemaining)) issues.push(`account ${a.accountId} creditsRemaining invalid: ${a.creditsRemaining}`);
    if (!isNonNeg(a.reserveCredits)) issues.push(`account ${a.accountId} reserveCredits invalid: ${a.reserveCredits}`);
    if (a.snapshotAtMs !== undefined && !isNonNeg(a.snapshotAtMs)) issues.push(`account ${a.accountId} snapshotAtMs invalid`);
  }
  const checkPerf = (owner: string, perf?: Record<string, ClassPerformance>) => {
    for (const [cls, p] of Object.entries(perf ?? {})) {
      if (!isNum(p.firstPassRate) || p.firstPassRate < 0 || p.firstPassRate > 1) issues.push(`${owner} performance.${cls}.firstPassRate invalid: ${p.firstPassRate}`);
      if (p.meanCreditsPerAccepted != null && !isNonNeg(p.meanCreditsPerAccepted)) issues.push(`${owner} performance.${cls}.meanCreditsPerAccepted invalid`);
      if (!Number.isInteger(p.samples) || p.samples < 0) issues.push(`${owner} performance.${cls}.samples invalid: ${p.samples}`);
    }
  };
  for (const w of workers) {
    checkPerf(w.workerId, w.performance);
    for (const m of w.models ?? []) {
      if (m.creditsRemaining != null && !isNonNeg(m.creditsRemaining)) issues.push(`model ${w.workerId}/${m.modelId} creditsRemaining invalid`);
      checkPerf(`${w.workerId}/${m.modelId}`, m.performance);
    }
  }
  return issues;
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

interface Unit {
  w: WorkerCandidate;
  modelId: string;
  perf?: ClassPerformance;
  availability: 'available' | 'unavailable' | 'unknown';
  modelCap: number | null; // null = no separate known cap
  expected: number | null;
  costBasis: 'measured' | 'estimated' | 'unknown';
}

export function decideRouting(task: RoutingTaskInput, workers: WorkerCandidate[], ctx: RoutingContext): RoutingDecision {
  const rationale: string[] = [];
  const now = ctx.nowMs ?? Date.now();
  const maxAge = ctx.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS;
  const minFirstPass = ctx.minFirstPassRate ?? DEFAULT_MIN_FIRST_PASS;
  const fresh = (snapshotAtMs?: number) => snapshotAtMs !== undefined && isNonNeg(snapshotAtMs) && now - snapshotAtMs <= maxAge;

  // 0. Validation before interpretation: invalid amounts are a
  //    repair of the input record, never a decision input.
  const issues = validateInputs(task, workers, ctx);
  if (issues.length) return { kind: 'REPAIR', taskId: task.taskId, repair: `fix invalid routing inputs: ${issues.join('; ')}`, rationale: issues };

  // 1. A retained uncertain operation is reconciled, never retried.
  const uncertainOp = hasUncertainOperation(task.taskId, ctx.journal);
  if (uncertainOp) return { kind: 'RECONCILE_FIRST', taskId: task.taskId, operationId: uncertainOp,
    rationale: [`journal holds OPERATION_UNCERTAIN ${uncertainOp} with no reconciliation record`] };

  // 2. Dependencies must be ACCEPTED in the journal, not just done.
  for (const dep of task.dependsOn ?? []) {
    if (!ctx.journal.some((e) => e.taskId === dep && e.action === 'RESULT_ACCEPTED')) {
      return { kind: 'RESOURCE_WAIT', taskId: task.taskId, waitFor: `dependency ${dep} accepted`,
        rationale: [`dependency ${dep} has no RESULT_ACCEPTED journal entry`] };
    }
  }

  // 3. Reviewer capacity is verified BEFORE any assignment: the
  //    reviewer account snapshot must exist, be fresh, have a known
  //    balance covering the review cost, and — when the reviewer is
  //    a specific model — a known model cap covering it too.
  const accountOf = new Map(ctx.accounts.map((a) => [a.accountId, a]));
  const reviewAccount = accountOf.get(ctx.reviewAccountId);
  if (!reviewAccount) return { kind: 'REPAIR', taskId: task.taskId,
    repair: `supply an account snapshot for reviewer account ${ctx.reviewAccountId}`,
    rationale: ['acceptance capacity cannot be verified without the reviewer account snapshot'] };
  if (!fresh(reviewAccount.snapshotAtMs)) return { kind: 'RESOURCE_WAIT', taskId: task.taskId,
    waitFor: `a fresh snapshot of reviewer account ${ctx.reviewAccountId}`, rationale: ['reviewer account snapshot is stale or undated'] };
  if (reviewAccount.creditsRemaining == null) return { kind: 'RESOURCE_WAIT', taskId: task.taskId,
    waitFor: `a quota reading for reviewer account ${ctx.reviewAccountId}`, rationale: ['reviewer balance UNKNOWN — acceptance capacity unverifiable'] };
  if (reviewAccount.creditsRemaining - reviewAccount.reserveCredits < ctx.reviewCostCredits) {
    return { kind: 'RESOURCE_WAIT', taskId: task.taskId, waitFor: `review capacity on account ${ctx.reviewAccountId}`,
      rationale: [`review headroom below the ${ctx.reviewCostCredits}-credit review cost; output could not be accepted`] };
  }
  if (ctx.reviewModelCapCredits === null) return { kind: 'RESOURCE_WAIT', taskId: task.taskId,
    waitFor: 'a reading of the reviewer model cap', rationale: ['reviewer model capacity UNKNOWN'] };
  if (ctx.reviewModelCapCredits !== undefined && ctx.reviewModelCapCredits < ctx.reviewCostCredits) {
    return { kind: 'RESOURCE_WAIT', taskId: task.taskId, waitFor: 'reviewer model capacity',
      rationale: [`reviewer model cap ${ctx.reviewModelCapCredits} below the ${ctx.reviewCostCredits}-credit review cost`] };
  }

  // 4. Hard gates: authorized scope + worker-level class support +
  //    callable route. Quality and price never resurrect a failure.
  const fit = workers.filter((w) => w.scopes.includes(task.requiredScope) && w.taskClasses.includes(task.taskClass));
  if (!fit.length) return { kind: 'REPAIR', taskId: task.taskId,
    repair: `no authorized worker supports class ${task.taskClass} in scope ${task.requiredScope}`,
    rationale: ['zero candidates pass scope+class gates'] };
  const callable = fit.filter((w) => w.callable);
  if (!callable.length) { const w = fit[0];
    return { kind: 'REPAIR', taskId: task.taskId, repair: `make ${w.workerId} callable: ${w.blockedReason ?? 'route not connected'}`,
      rationale: [`${fit.length} candidate(s) fit scope+class but none is callable`] }; }

  // 5. Expand to (worker, model) units with observed eligibility.
  const units: Unit[] = [];
  for (const w of callable) {
    const models: ModelOption[] = w.models ?? [{ modelId: '(worker-default)', taskClasses: w.taskClasses,
      creditsRemaining: null, availability: 'available', snapshotAtMs: undefined, performance: w.performance }];
    for (const m of models) {
      if (!m.taskClasses.includes(task.taskClass)) { rationale.push(`${w.workerId}/${m.modelId}: model does not support class ${task.taskClass}`); continue; }
      const modelFresh = m.snapshotAtMs === undefined ? w.models === undefined : fresh(m.snapshotAtMs);
      const availability = m.availability ?? 'available';
      units.push({ w, modelId: m.modelId,
        perf: m.performance?.[task.taskClass] ?? (w.models === undefined ? w.performance?.[task.taskClass] : undefined),
        availability: !modelFresh && w.models !== undefined ? 'unknown' : availability,
        modelCap: m.capKnown && m.creditsRemaining != null ? m.creditsRemaining : null,
        expected: null, costBasis: 'unknown' });
    }
  }
  if (!units.length) return { kind: 'REPAIR', taskId: task.taskId,
    repair: `no eligible model/mode supports class ${task.taskClass} on any callable in-scope worker`,
    rationale };

  // 6. Cost + capacity per unit. Account pool is shared; a known
  //    model cap binds additionally. UNKNOWN pool ≠ affordable.
  type Scored = Unit & { account: AccountState; headroom: number | null };
  const scored: Scored[] = [];
  for (const u of units) {
    const account = accountOf.get(u.w.accountId);
    if (!account) { rationale.push(`${u.w.workerId}: account ${u.w.accountId} has no state record`); continue; }
    if (!fresh(account.snapshotAtMs)) { rationale.push(`${u.w.workerId}: account ${u.w.accountId} snapshot stale or undated`); continue; }
    const measured = u.perf && u.perf.samples > 0 && u.perf.meanCreditsPerAccepted != null;
    u.expected = measured ? u.perf!.meanCreditsPerAccepted! : task.estimatedCredits;
    u.costBasis = measured ? 'measured' : task.estimatedCredits != null ? 'estimated' : 'unknown';
    let headroom: number | null = null;
    if (account.creditsRemaining != null) {
      headroom = account.creditsRemaining - account.reserveCredits
        - (u.w.accountId === ctx.reviewAccountId ? ctx.reviewCostCredits : 0);
      if (u.modelCap != null) headroom = Math.min(headroom, u.modelCap);
    }
    scored.push({ ...u, account, headroom });
  }
  if (!scored.length) return { kind: 'RESOURCE_WAIT', taskId: task.taskId,
    waitFor: 'a fresh account snapshot for at least one eligible unit', rationale };

  const affordableKnown = scored.filter((s) => s.expected != null && s.headroom != null && s.headroom >= s.expected);

  // 7. Direct ASSIGN: known cost, verified capacity, observed
  //    availability, measured quality at/above the gate.
  const assignable = affordableKnown.filter((s) => s.availability === 'available'
    && s.perf && s.perf.samples > 0 && s.perf.firstPassRate >= minFirstPass);
  if (assignable.length) {
    const best = [...assignable].sort((a, b) => (a.expected! - b.expected!)
      || ((a.perf!.meanLatencyMs ?? Number.POSITIVE_INFINITY) - (b.perf!.meanLatencyMs ?? Number.POSITIVE_INFINITY)))[0];
    return { kind: 'ASSIGN', taskId: task.taskId, workerId: best.w.workerId, modelId: best.modelId,
      accountId: best.w.accountId, quotaKind: best.account.quotaKind ?? 'unknown',
      expectedTotalCredits: best.expected!, costBasis: best.costBasis,
      rationale: [...rationale, `${best.w.workerId}/${best.modelId} callable, in-scope, measured first-pass ${best.perf!.firstPassRate.toFixed(2)}, expected total ${best.expected} credits (${best.costBasis}, rework included) on account ${best.w.accountId} (${best.account.quotaKind ?? 'unknown'} quota)`] };
  }

  // 8. TEACH_THEN_ASSIGN: (a) quality calibration with a known,
  //    affordable cost as its bound; (b) unknown-cost calibration
  //    ONLY under the task's bounded calibration budget.
  const qualityTeach = affordableKnown.filter((s) => s.availability !== 'unavailable');
  if (qualityTeach.length) {
    const best = [...qualityTeach].sort((a, b) => a.expected! - b.expected!)[0];
    return { kind: 'TEACH_THEN_ASSIGN', taskId: task.taskId, workerId: best.w.workerId, modelId: best.modelId,
      accountId: best.w.accountId, calibrationBudgetCredits: best.expected, teachPlan: TEACH_PLAN,
      rationale: [...rationale, best.perf && best.perf.samples > 0
        ? `${best.w.workerId}/${best.modelId} measured first-pass ${best.perf.firstPassRate.toFixed(2)} < ${minFirstPass} for ${task.taskClass}; calibrate before production assignment`
        : `${best.w.workerId}/${best.modelId} is unmeasured for ${task.taskClass}; calibrate before trusting expected totals`] };
  }
  const budget = task.calibrationBudgetCredits ?? null;
  if (budget != null) {
    const budgetOk = scored.filter((s) => s.availability !== 'unavailable' && s.headroom != null && s.headroom >= budget);
    if (budgetOk.length) {
      const best = budgetOk[0];
      return { kind: 'TEACH_THEN_ASSIGN', taskId: task.taskId, workerId: best.w.workerId, modelId: best.modelId,
        accountId: best.w.accountId, calibrationBudgetCredits: budget, teachPlan: TEACH_PLAN,
        rationale: [...rationale, `cost of ${task.taskClass} on ${best.w.workerId}/${best.modelId} is UNKNOWN; calibration bounded at ${budget} credits`] };
    }
  }

  // 9. Otherwise wait — naming the actual binding constraint.
  const anyKnownPool = scored.some((s) => s.headroom != null);
  if (!anyKnownPool) return { kind: 'RESOURCE_WAIT', taskId: task.taskId,
    waitFor: 'a quota/credits reading for an eligible unit account', rationale: [...rationale, 'every eligible unit account has UNKNOWN credits'] };
  if (scored.every((s) => s.expected == null)) return { kind: 'RESOURCE_WAIT', taskId: task.taskId,
    waitFor: `a bounded calibration budget for unknown-cost class ${task.taskClass}`, rationale };
  return { kind: 'RESOURCE_WAIT', taskId: task.taskId,
    waitFor: 'sufficient credits (account pool and model caps, incl. shared review charge and reserve) for an eligible unit',
    rationale: [...rationale, 'no eligible unit covers its expected total within the verified pools'] };
}

/** Append-only journal write: returns a NEW array; entries are never edited or removed. */
export function appendJournal(journal: JournalEntry[], entry: JournalEntry): JournalEntry[] {
  return [...journal, entry];
}

/**
 * Plan a whole work breakdown in dependency order, carrying a
 * RESERVATION LEDGER across the plan: every ASSIGN reserves its
 * expected total on the executor account (and on the model cap
 * when one binds), every TEACH_THEN_ASSIGN reserves its
 * calibration budget, and every assignment reserves the review
 * cost on the reviewer account (and reviewer model cap). Later
 * tasks therefore see the pools as earlier decisions left them —
 * a shared account is never double-spent by role or task name.
 */
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

  const accounts = ctx.accounts.map((a) => ({ ...a }));
  const accountOf = new Map(accounts.map((a) => [a.accountId, a]));
  const modelCaps = new Map<string, number>(); // "workerId/modelId" -> remaining cap
  let reviewModelCap = ctx.reviewModelCapCredits;
  const decisions: RoutingDecision[] = [];

  for (const t of ordered) {
    const adjustedWorkers = workers.map((w) => !w.models ? w : ({
      ...w, models: w.models.map((m) => {
        const key = `${w.workerId}/${m.modelId}`;
        return modelCaps.has(key) ? { ...m, creditsRemaining: modelCaps.get(key)! } : m;
      }),
    }));
    const d = decideRouting(t, adjustedWorkers, { ...ctx, accounts, reviewModelCapCredits: reviewModelCap });
    decisions.push(d);
    const reserveOn = (accountId: string, amount: number | null) => {
      const a = accountOf.get(accountId);
      if (a && a.creditsRemaining != null && amount != null) a.creditsRemaining -= amount;
    };
    if (d.kind === 'ASSIGN') {
      reserveOn(d.accountId, d.expectedTotalCredits);
      reserveOn(ctx.reviewAccountId, ctx.reviewCostCredits);
      if (reviewModelCap != null && reviewModelCap !== undefined) reviewModelCap -= ctx.reviewCostCredits;
      const w = workers.find((x) => x.workerId === d.workerId);
      const m = w?.models?.find((x) => x.modelId === d.modelId);
      if (m?.capKnown && m.creditsRemaining != null) {
        const key = `${d.workerId}/${d.modelId}`;
        modelCaps.set(key, (modelCaps.get(key) ?? m.creditsRemaining) - d.expectedTotalCredits);
      }
    } else if (d.kind === 'TEACH_THEN_ASSIGN') {
      reserveOn(d.accountId, d.calibrationBudgetCredits);
      reserveOn(ctx.reviewAccountId, ctx.reviewCostCredits);
      if (reviewModelCap != null && reviewModelCap !== undefined) reviewModelCap -= ctx.reviewCostCredits;
    }
  }
  return decisions;
}
