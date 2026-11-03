// Primary-worker -> helper delegation contract (AGY D-057,
// 2026-11-03). Runs ON the existing canonical queue: a helper
// subtask is a child of exactly one parent task/attempt, claimed
// and settled through the same PostgresStore leases — there is
// no parallel queue and no shadow dispatch. This module is the
// pure contract + adapter surface: it validates an assignment
// before any helper is touched, derives the child idempotency
// identity, and defines the result envelope the parent must
// validate before integration. Adapters bind a helper's OWN
// supported surface (browser bridge preferred); an unbound
// adapter refuses — it never fakes an ACK or a native binding.
//
// Roles (D-057): primary workers (Claude, Muse, Gemini) own
// the main output and validate/integrate; helpers (Manus, Grok)
// are subordinate support for reading/extraction/browser/input
// preparation. No permanent do/QA split: the same contract
// serves execution and peer-QA assignments.

export type HelperId = 'manus' | 'grok';
export type BudgetEnforcement = 'provider' | 'runtime' | 'prompt_only' | 'unknown';

export interface HelperAssignment {
  // Parent identity: exactly one authenticated primary worker,
  // one parent task, one attempt.
  parentWorkerId: string;
  parentTaskId: string;
  parentAttempt: number;
  // Child identity: derived, never free-chosen (see childKey).
  subtaskKey: string;
  helperId: HelperId;
  // Scope fence: the child lives in the parent's exact scope.
  scope: { tenantId: string; workspaceId: string; projectId: string };
  // Allowlists: the helper may touch only these.
  sourceAllowlist: string[];
  toolAllowlist: string[];
  // Budget fence: cap in a NAMED unit, with an enforcement class.
  budget: { unit: string; cap: number; spent: number; enforcement: BudgetEnforcement; hard: boolean };
  // Lease fence: absolute expiry; a dead parent cannot extend it.
  expiresAtMs: number;
  // Immutable reply routing: the parent's own reply target.
  replyTarget: string;
}

export type DenyCode =
  | 'PARENT_REQUIRED' | 'CROSS_SCOPE' | 'EXPIRED' | 'HELPER_NOT_ALLOWED'
  | 'ALLOWLIST_EMPTY' | 'BUDGET_UNKNOWN' | 'BUDGET_EXCEEDED'
  | 'HARD_BUDGET_UNENFORCED' | 'REPLY_TARGET_REQUIRED' | 'ATTEMPT_INVALID';

export interface Validation { ok: boolean; denies: DenyCode[] }

// The child idempotency identity: one parent task + one attempt
// + one subtask key maps to exactly one child, forever. A retry
// re-derives the same key and reconciles instead of duplicating.
export function childKey(a: Pick<HelperAssignment, 'parentTaskId' | 'parentAttempt' | 'subtaskKey' | 'helperId'>): string {
  return `helper:${a.helperId}:${a.parentTaskId}:${a.parentAttempt}:${a.subtaskKey}`;
}

export function validateAssignment(a: HelperAssignment, nowMs: number): Validation {
  const denies: DenyCode[] = [];
  if (!a.parentWorkerId || !a.parentTaskId) denies.push('PARENT_REQUIRED');
  if (!Number.isInteger(a.parentAttempt) || a.parentAttempt < 1) denies.push('ATTEMPT_INVALID');
  if (a.helperId !== 'manus' && a.helperId !== 'grok') denies.push('HELPER_NOT_ALLOWED');
  if (!a.scope?.tenantId || !a.scope?.workspaceId || !a.scope?.projectId) denies.push('CROSS_SCOPE');
  if (!(nowMs <= a.expiresAtMs)) denies.push('EXPIRED');
  if (!a.sourceAllowlist?.length || !a.toolAllowlist?.length) denies.push('ALLOWLIST_EMPTY');
  if (!a.replyTarget) denies.push('REPLY_TARGET_REQUIRED');
  // Resource authority must be KNOWN: an unnamed unit, a null or
  // non-finite cap, or unknown enforcement never funds a child.
  if (!a.budget?.unit || !Number.isFinite(a.budget?.cap) || a.budget.cap < 0 || a.budget.enforcement === 'unknown')
    denies.push('BUDGET_UNKNOWN');
  else {
    if (a.budget.spent > a.budget.cap) denies.push('BUDGET_EXCEEDED');
    // The Manus lesson, encoded: a hard budget on a prompt-only
    // surface is not a budget. Hard budgets require provider or
    // RUNTIME enforcement — the runtime fence being this
    // contract's own pre-submit check (validateBeforeSubmit),
    // evaluated by the parent before EVERY helper submission.
    if (a.budget.hard && a.budget.enforcement === 'prompt_only') denies.push('HARD_BUDGET_UNENFORCED');
  }
  return { ok: denies.length === 0, denies };
}

// Cross-scope guard for result return: a child result is only
// acceptable for the exact parent/scope it was derived under.
export function resultMatchesAssignment(a: HelperAssignment, r: { childKey: string; scope: { tenantId: string; workspaceId: string; projectId: string } }): boolean {
  return r.childKey === childKey(a)
    && r.scope.tenantId === a.scope.tenantId
    && r.scope.workspaceId === a.scope.workspaceId
    && r.scope.projectId === a.scope.projectId;
}

// Pre-submit runtime fence: the parent calls this before EVERY
// helper submission under the assignment. When it denies, the
// submission does not happen — this is what makes a 'runtime'
// enforcement claim true rather than aspirational.
export function validateBeforeSubmit(a: HelperAssignment, nextCost: number, nowMs: number): Validation {
  const base = validateAssignment(a, nowMs);
  const denies = [...base.denies];
  if (Number.isFinite(nextCost) && a.budget.spent + nextCost > a.budget.cap && !denies.includes('BUDGET_EXCEEDED'))
    denies.push('BUDGET_EXCEEDED');
  return { ok: denies.length === 0, denies };
}

export interface HelperResultEnvelope {
  childKey: string;
  helperId: HelperId;
  externalRef: string | null;   // the helper surface's own task ref
  digest: string;                // content digest of the result payload
  payload: unknown;              // durable result, parent validates
  costUnits: number;             // actuals, in the assignment's unit
}

// Adapter surface: one implementation per helper, bound to that
// helper's OWN supported tools. `bound=false` adapters refuse
// submission with NOT_BOUND — the honest state until the
// connection for that surface is made and verified. No adapter
// may copy credentials or impersonate the helper's session.
export interface HelperAdapter {
  helperId: HelperId;
  surface: string;               // e.g. 'browser-bridge' | 'api'
  bound: boolean;
  submit(a: HelperAssignment, input: unknown): Promise<{ externalRef: string }>;
  readResult(externalRef: string): Promise<HelperResultEnvelope>;
}

export function unboundAdapter(helperId: HelperId, surface: string): HelperAdapter {
  const refuse = async (): Promise<never> => { throw new Error('HELPER_NOT_BOUND'); };
  return { helperId, surface, bound: false, submit: refuse, readResult: refuse };
}
