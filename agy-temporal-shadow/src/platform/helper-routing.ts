// Helper routing (AGY Operating Model v2.0 resource-first rule
// + D-057, 2026-11-04): choosing Manus vs Grok for a subtask is
// a MEASURED decision, never a fixed worker name and never a
// hard-coded provider-first rule. This module is PURE: it
// performs no I/O, calls no provider, and reads no credential.
// Callers supply the telemetry they actually hold; unknown
// quota/cost/health stays UNKNOWN here too - it is never
// guessed, and an unknown balance cannot fund a hard-capped
// attempt.
//
// Decision order (capability/quality FIRST, per the Operating
// Model; resource optimization only among what already passes):
//   1. Eligibility gate: helper is bound, offers a surface the
//      assignment's equipment can pin, and covers every
//      required capability.
//   2. Budget compatibility: a HARD budget requires provider
//      enforcement or bounded actuals (the same rule
//      validateAssignment encodes), and when the balance is
//      KNOWN it must cover the expected cost; when the cap is
//      hard and the balance is UNKNOWN the candidate is out.
//   3. Among the survivors: highest measured fit score for
//      this task kind; ties break on lower expected cost, then
//      on helper id for determinism.
// When nothing survives, the route DENIES with per-candidate
// reasons - the parent then re-scopes the assignment instead
// of silently falling back to an ineligible helper.
import type { BudgetEnforcement, HelperId } from './helper-delegation.js';

export interface HelperCandidate {
  helperId: HelperId;
  // The adapter for this helper is connected and verified.
  bound: boolean;
  // Surface kinds this helper can be pinned to ('api',
  // 'browser-bridge', ...), from its adapter descriptors.
  surfaces: string[];
  // Capabilities the helper genuinely offers for routing
  // (e.g. 'text', 'web-research', 'extraction', 'long-form').
  capabilities: string[];
  // Caller-measured fit for THIS task kind, 0..1, from prior
  // verified outcomes. Absent = unmeasured (scores 0 and is
  // reported as such; it is not an estimate of quality).
  fitScore?: number;
  // Balance telemetry in the assignment budget's unit. known
  // MUST be false when the caller has no current reading -
  // units are then meaningless and ignored.
  balance: { known: boolean; units?: number };
  enforcement: BudgetEnforcement;
  actualCostBounded: boolean;
  // Expected cost of this attempt in the budget unit, when the
  // caller can state one; absent = unknown.
  expectedCost?: number;
}

export interface RouteRequest {
  requiredCapabilities: string[];
  // The surface kind the assignment's equipment pins.
  surfaceKind: string;
  budget: { cap: number; spent: number; hard: boolean };
}

export interface RouteDecision {
  helperId: HelperId;
  fitScore: number;          // the winner's measured fit (0 when unmeasured)
  fitMeasured: boolean;
  reasons: string[];         // why the winner won, human-readable
}

export interface RouteDenial {
  denied: { helperId: HelperId; reasons: string[] }[];
}

export function routeHelper(req: RouteRequest, candidates: HelperCandidate[]): RouteDecision | RouteDenial {
  const denied: { helperId: HelperId; reasons: string[] }[] = [];
  const survivors: { c: HelperCandidate; fit: number; measured: boolean }[] = [];
  for (const c of candidates) {
    const reasons: string[] = [];
    if (!c.bound) reasons.push('NOT_BOUND');
    if (!c.surfaces.includes(req.surfaceKind)) reasons.push('SURFACE_NOT_OFFERED');
    for (const cap of req.requiredCapabilities) if (!c.capabilities.includes(cap)) reasons.push(`CAPABILITY_MISSING:${cap}`);
    // Budget compatibility mirrors validateAssignment's hard
    // budget rule so a routed assignment cannot be denied by
    // the contract it is routed for.
    if (req.budget.hard && c.enforcement === 'prompt_only') reasons.push('HARD_BUDGET_UNENFORCED');
    else if (req.budget.hard && c.enforcement !== 'provider' && !c.actualCostBounded) reasons.push('HARD_BUDGET_UNENFORCED');
    if (req.budget.hard && (c.expectedCost === undefined || !Number.isFinite(c.expectedCost) || c.expectedCost < 0))
      reasons.push('COST_UNKNOWN_HARD_BUDGET');
    if (c.balance.known) {
      const room = Math.max(0, req.budget.cap - req.budget.spent);
      const avail = Math.min(room, c.balance.units ?? 0);
      if (c.expectedCost !== undefined && c.expectedCost > avail) reasons.push('BALANCE_INSUFFICIENT');
    } else if (req.budget.hard) reasons.push('BALANCE_UNKNOWN_HARD_BUDGET');
    if (reasons.length) { denied.push({ helperId: c.helperId, reasons }); continue; }
    survivors.push({ c, fit: typeof c.fitScore === 'number' && Number.isFinite(c.fitScore) ? c.fitScore : 0,
      measured: typeof c.fitScore === 'number' && Number.isFinite(c.fitScore) });
  }
  if (!survivors.length) return { denied };
  survivors.sort((x, y) =>
    (y.fit - x.fit)
    || ((x.c.expectedCost ?? Number.POSITIVE_INFINITY) - (y.c.expectedCost ?? Number.POSITIVE_INFINITY))
    || x.c.helperId.localeCompare(y.c.helperId));
  const w = survivors[0];
  return {
    helperId: w.c.helperId,
    fitScore: w.fit,
    fitMeasured: w.measured,
    reasons: [
      `eligible: bound, surface ${req.surfaceKind} offered, capabilities cover [${req.requiredCapabilities.join(',')}]`,
      w.measured ? `highest measured fit ${w.fit}` : 'fit unmeasured for all eligible candidates; chosen by cost/id order',
      ...(denied.length ? [`denied: ${denied.map((d) => `${d.helperId}(${d.reasons.join(',')})`).join('; ')}`] : []),
    ],
  };
}


