// Primary-worker -> helper delegation contract (AGY D-057,
// 2026-11-03). This module is the PURE contract: it validates an
// assignment's shape and fences, derives the child idempotency
// identity, and defines the result envelope. It does NOT by
// itself create, claim, or settle anything — the binding to the
// existing canonical queue (authenticated parent principal,
// persisted child ownership, transactional reservation, result
// verification) lives in helper-queue.ts and is what makes the
// runtime claims true. Validation here is necessary, never
// sufficient. Adapters bind a helper's OWN supported surface
// (browser bridge preferred); an unbound adapter refuses — it
// never fakes an ACK or a native binding.
//
// Roles (D-057): primary workers (Claude, Muse, Gemini) own
// the main output and validate/integrate; helpers (Manus, Grok)
// are subordinate support for reading/extraction/browser/input
// preparation. No permanent do/QA split: the same contract
// serves execution and peer-QA assignments.

import { digestOf, isDigestHex } from './digest.js';

// The equipment identity of an assignment: two assignments
// that differ in equipment are different work, even when every
// identity field matches. The queue persists this digest in
// the child payload and binding-checks it on reuse and at
// result time, so a silent equipment swap under a reused
// childKey denies instead of passing as the same child.
export function equipmentDigest(a: Pick<HelperAssignment, 'equipment'>): string {
  return digestOf(a.equipment ?? null);
}

export type HelperId = 'manus' | 'grok';
export type BudgetEnforcement = 'provider' | 'runtime' | 'prompt_only' | 'unknown';

// Equipment block (D-057 equip rule, 2026-11-04): an assignment
// is not actionable until it pins WHAT the helper works on,
// WHICH surface/model/auth binding it must use, WHAT guidance
// it follows, HOW the parent will judge the output, and HOW
// MUCH rework is allowed. Allowlists say what the helper MAY
// touch; equipment says what this attempt IS. Missing or
// unpinned equipment is a deny, never a default.
export interface HelperEquipment {
  // The exact input the helper works on, content-pinned: a
  // reference plus the sha256 digest of its content (digestOf
  // form). A result answering different input is not this
  // assignment's result.
  pinnedSource: { ref: string; digest: string };
  // The actual surface the attempt must run on: its kind
  // ('api', 'browser-bridge', ...), the model/agent build the
  // provider will run, and the NAME of the credential binding
  // (never the credential itself). The executor refuses an
  // adapter whose declared descriptor differs (helper-providers
  // assertAdapterMatchesAssignment).
  surface: { kind: string; model: string; authBinding: string };
  // The skill the helper must follow, and optionally a worked
  // example of a passing output.
  skillRef: string;
  exampleRef?: string;
  // Action-level acceptance criteria the parent will check,
  // verbatim strings, at least one.
  criteria: string[];
  // Bounded rework for THIS assignment: how many helper
  // attempts the parent may run under it before the assignment
  // itself must be re-minted. 0 means the first attempt is the
  // only attempt.
  rework: { maxAttempts: number };
}

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
  // Whether the helper surface bounds the ACTUAL per-call cost
  // (fixed-price surface) as opposed to provider-metered actuals
  // a preflight estimate cannot bound (Manus). Required true for
  // any hard budget that is not provider-enforced; absent counts
  // as false (fail closed).
  actualCostBounded?: boolean;
  // Lease fence: absolute expiry; a dead parent cannot extend it.
  expiresAtMs: number;
  // Immutable reply routing: the parent's own reply target.
  replyTarget: string;
  // Equipment: pinned source, surface/model/auth, skill,
  // criteria, rework (see HelperEquipment). REQUIRED.
  equipment: HelperEquipment;
}

export type DenyCode =
  | 'PARENT_REQUIRED' | 'CROSS_SCOPE' | 'EXPIRED' | 'HELPER_NOT_ALLOWED'
  | 'ALLOWLIST_EMPTY' | 'BUDGET_UNKNOWN' | 'BUDGET_EXCEEDED'
  | 'HARD_BUDGET_UNENFORCED' | 'REPLY_TARGET_REQUIRED' | 'ATTEMPT_INVALID'
  | 'EQUIPMENT_REQUIRED' | 'SOURCE_UNPINNED' | 'SURFACE_UNPINNED'
  | 'SKILL_REQUIRED' | 'CRITERIA_REQUIRED' | 'REWORK_INVALID';

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
  // Strict deadline: the expiry instant itself is already dead.
  if (!Number.isFinite(a.expiresAtMs) || !(nowMs < a.expiresAtMs)) denies.push('EXPIRED');
  if (!a.sourceAllowlist?.length || !a.toolAllowlist?.length) denies.push('ALLOWLIST_EMPTY');
  if (!a.replyTarget) denies.push('REPLY_TARGET_REQUIRED');
  // Equipment fences (D-057 equip rule): every field that pins
  // the attempt must be present and well-formed; an unpinned
  // attempt is indistinguishable from an improvised one.
  const eq = a.equipment;
  if (!eq || typeof eq !== 'object') denies.push('EQUIPMENT_REQUIRED');
  else {
    if (!eq.pinnedSource?.ref || !isDigestHex(eq.pinnedSource?.digest)) denies.push('SOURCE_UNPINNED');
    if (!eq.surface?.kind || !eq.surface?.model || !eq.surface?.authBinding) denies.push('SURFACE_UNPINNED');
    if (!eq.skillRef) denies.push('SKILL_REQUIRED');
    if (!Array.isArray(eq.criteria) || !eq.criteria.length || eq.criteria.some((c) => typeof c !== 'string' || !c.trim()))
      denies.push('CRITERIA_REQUIRED');
    if (!Number.isInteger(eq.rework?.maxAttempts) || eq.rework.maxAttempts < 0) denies.push('REWORK_INVALID');
  }
  // Resource authority must be KNOWN and SANE: an unnamed unit,
  // a non-finite or negative cap, a non-finite or negative spent
  // (root probe: spent=-100 and NaN were accepted), or unknown
  // enforcement never funds a child. All checks fail closed.
  const b = a.budget;
  if (!b?.unit || !Number.isFinite(b?.cap) || b.cap < 0 || !Number.isFinite(b?.spent) || b.spent < 0 || b?.enforcement === 'unknown')
    denies.push('BUDGET_UNKNOWN');
  else {
    if (b.spent > b.cap) denies.push('BUDGET_EXCEEDED');
    // The Manus lesson, encoded twice. A hard budget on a
    // prompt-only surface is not a budget. AND a runtime
    // preflight fence bounds submission ESTIMATES only: when the
    // helper's ACTUAL per-call cost is provider-metered and
    // unbounded, no estimate check can make a hard cap true —
    // hard budgets then require provider enforcement with a
    // real provider-side cap, else they are denied.
    if (b.hard && b.enforcement === 'prompt_only') denies.push('HARD_BUDGET_UNENFORCED');
    else if (b.hard && b.enforcement !== 'provider' && a.actualCostBounded !== true) denies.push('HARD_BUDGET_UNENFORCED');
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
// submission does not happen. The fence bounds the ESTIMATED
// cost of submissions; per validateAssignment, that supports a
// hard-budget claim ONLY when actual per-call cost is bounded
// (or the provider enforces the cap). A non-finite or negative
// nextCost is itself a deny (root probe: NaN/Infinity/-5 were
// accepted).
export function validateBeforeSubmit(a: HelperAssignment, nextCost: number, nowMs: number): Validation {
  const base = validateAssignment(a, nowMs);
  const denies = [...base.denies];
  if (!Number.isFinite(nextCost) || nextCost < 0) { if (!denies.includes('BUDGET_UNKNOWN')) denies.push('BUDGET_UNKNOWN'); }
  else if (a.budget.spent + nextCost > a.budget.cap && !denies.includes('BUDGET_EXCEEDED'))
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
  // The adapter's own declared identity, compared against the
  // assignment's pinned equipment.surface before any submit:
  // the model/agent build it will actually run and the NAME of
  // the credential binding it uses (never the credential).
  // Absent on unbound adapters - which refuse anyway.
  descriptor?: { model: string; authBinding: string };
  submit(a: HelperAssignment, input: unknown): Promise<{ externalRef: string }>;
  readResult(externalRef: string): Promise<HelperResultEnvelope>;
}

export function unboundAdapter(helperId: HelperId, surface: string): HelperAdapter {
  const refuse = async (): Promise<never> => { throw new Error('HELPER_NOT_BOUND'); };
  return { helperId, surface, bound: false, submit: refuse, readResult: refuse };
}
