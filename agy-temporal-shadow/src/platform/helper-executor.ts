// Helper executor host loop (D-057, 2026-11-05): the wiring
// that turns the helper contract into a running delegation.
// Until this module existed, routeHelper / createDelegatedChild
// / begin / record / read / recordResult were library calls
// with no host: Manus and Grok were contract-bound helpers,
// not agents running under a primary worker. This loop is
// that host. It is deliberately thin - every safety property
// lives in the layers it composes, and it adds none of its
// own shortcuts:
//
//   route (pure, fail-closed) -> build the equipped assignment
//   for the chosen helper -> equipment/adapter guard -> create
//   the child on the canonical queue (parent fence inside the
//   creation transaction) -> claim the child through the host's
//   own surface -> begin (exactly one NEW; SUBMITTED reconciles,
//   IN_FLIGHT never resubmits) -> adapter submit -> record the
//   submission -> read the result ONLY through the persisted
//   queue binding -> verify -> durably record the result
//   against the child's live lease/attempt.
//
// The loop never calls a provider on an unbound or mismatched
// adapter, never resubmits an uncertain submission, and never
// swallows a fence denial: fence errors propagate to the host,
// whose retry policy they are. Provider-call uncertainty is
// reported as a first-class outcome, not retried inline.
import type { Pool } from 'pg';
import type { Principal } from './auth.js';
import type { ProjectScope } from './scope.js';
import { validateBeforeSubmit, type HelperAssignment, type HelperAdapter, type HelperId, type HelperResultEnvelope } from './helper-delegation.js';
import { createDelegatedChild, beginHelperSubmission, recordHelperSubmission, recordHelperSubmissionFailure,
  readVerifiedHelperResult, recordHelperResult, assertChildBinding, type ChildSpec, type HelperResultReader,
  type SubmissionFailureReceipt } from './helper-queue.js';
import { routeHelper, type HelperCandidate, type RouteDenial } from './helper-routing.js';
import { assertAdapterMatchesAssignment, PROVIDER_BUDGET_POSTURE } from './helper-providers.js';

export interface HelperExecutorDeps {
  pool: Pool;
  scope: ProjectScope;
  // The primary worker delegating the subtask.
  parent: Principal;
  // The runtime's operator identity for job creation (the
  // worker can never create queue jobs directly).
  system: Principal;
  // One adapter per helper the host can run. Absent or
  // unbound adapters simply make that helper ineligible.
  adapters: Partial<Record<HelperId, HelperAdapter>>;
  // The host's claim path for a freshly created child (its
  // worker surface). Returns the child's live lease fence.
  claimChild: (childTaskId: string) => Promise<{ leaseToken: string; attempt: number }>;
}

export interface HelperDelegationRequest {
  // The equipped assignment for a candidate helper. Routing
  // chooses the helper FIRST (equipment pins are per-helper:
  // model + auth binding), so the assignment is built for the
  // winner, never guessed before the decision.
  buildAssignment: (helperId: HelperId) => HelperAssignment;
  requiredCapabilities: string[];
  surfaceKind: string;
  budget: { cap: number; spent: number; hard: boolean };
  // Caller-measured routing telemetry per helper: capabilities
  // offered for routing, balance, fit, expected cost. Unknown
  // stays unknown - routing fails closed on it under hard caps.
  telemetry: Partial<Record<HelperId, {
    capabilities: string[];
    balance: { known: boolean; units?: number };
    fitScore?: number;
    expectedCost?: number;
  }>>;
  spec: ChildSpec;
  input: unknown;
}

export type HelperDelegationOutcome =
  | { status: 'RECORDED'; helperId: HelperId; childTaskId: string; externalRef: string;
      envelope: HelperResultEnvelope; alreadyRecorded: boolean }
  | { status: 'ROUTING_DENIED'; denial: RouteDenial }
  | { status: 'IN_FLIGHT'; helperId: HelperId; childTaskId: string }
  | { status: 'SUBMIT_UNCERTAIN'; helperId: HelperId; childTaskId: string; error: string }
  | { status: 'SUBMIT_RECORD_FAILED'; helperId: HelperId; childTaskId: string; externalRef: string; error: string }
  | { status: 'SUBMIT_FAILED'; helperId: HelperId; childTaskId: string; failure: SubmissionFailureReceipt };

// Build the routing candidates from the host's adapters plus
// caller telemetry. Enforcement posture comes from the
// provider facts stated in helper-providers, never from the
// caller, so a caller cannot talk a prompt-only provider into
// a hard-budget route.
export function buildCandidates(deps: HelperExecutorDeps, req: HelperDelegationRequest): HelperCandidate[] {
  const out: HelperCandidate[] = [];
  for (const helperId of ['manus', 'grok'] as HelperId[]) {
    const adapter = deps.adapters[helperId];
    const t = req.telemetry[helperId];
    if (!adapter && !t) continue;
    const posture = PROVIDER_BUDGET_POSTURE[helperId];
    out.push({
      helperId,
      bound: adapter?.bound ?? false,
      surfaces: adapter ? [adapter.surface] : [],
      capabilities: t?.capabilities ?? [],
      fitScore: t?.fitScore,
      balance: t?.balance ?? { known: false },
      enforcement: posture.enforcement,
      actualCostBounded: posture.actualCostBounded,
      expectedCost: t?.expectedCost,
    });
  }
  return out;
}

// Adapt a HelperAdapter to the queue's result-reader boundary:
// adapters with a binding-aware readResultFor (Manus/Grok) use
// it directly; a generic adapter falls back to readResult,
// and the queue's verification stays authoritative either way.
function asReader(adapter: HelperAdapter): HelperResultReader {
  const anyAdapter = adapter as HelperAdapter & Partial<HelperResultReader>;
  if (typeof anyAdapter.readResultFor === 'function') {
    return { readResultFor: (a, ref, binding) => anyAdapter.readResultFor!(a, ref, binding) };
  }
  return { readResultFor: async (_a, ref) => adapter.readResult(ref) };
}

export async function runHelperDelegation(deps: HelperExecutorDeps,
  req: HelperDelegationRequest): Promise<HelperDelegationOutcome> {
  const { pool, scope, parent, system } = deps;
  // 1. Route. A denial is an outcome, not an error: nothing is
  // created and no provider is called.
  const decision = routeHelper(
    { requiredCapabilities: req.requiredCapabilities, surfaceKind: req.surfaceKind, budget: req.budget },
    buildCandidates(deps, req));
  if ('denied' in decision) return { status: 'ROUTING_DENIED', denial: decision };

  // 2. Build the winner's equipped assignment and prove the
  // adapter IS the pinned surface before any queue write or
  // provider call.
  const a = req.buildAssignment(decision.helperId);
  if (a.helperId !== decision.helperId) throw new Error('ASSIGNMENT_HELPER_MISMATCH');
  const adapter = deps.adapters[a.helperId];
  if (!adapter) throw new Error('ADAPTER_MISSING');
  assertAdapterMatchesAssignment(a, adapter);

  // 3. Create the child on the canonical queue (the delegation
  // input rides in the spec so the persisted child is
  // self-describing for any claiming host) and claim it through
  // the host surface.
  const child = await createDelegatedChild(pool, scope, parent, system, a,
    { ...req.spec, input: req.spec.input ?? req.input });
  const claim = await deps.claimChild(child.childTaskId);

  // 4-6. Begin / submit / record / read / record-result: the
  // claimed-child tail, shared with the daemon lane adapter.
  return executeClaimedHelperChild({ pool, scope, parent },
    { a, childTaskId: child.childTaskId, leaseToken: claim.leaseToken,
      attempt: claim.attempt, adapter, input: req.input, expectedCost: req.spec.estimatedCost });
}

export type HelperChildOutcome = Extract<HelperDelegationOutcome,
  { status: 'RECORDED' } | { status: 'IN_FLIGHT' } | { status: 'SUBMIT_UNCERTAIN' }
  | { status: 'SUBMIT_RECORD_FAILED' } | { status: 'SUBMIT_FAILED' }>;

// The adapters' provider errors are ProviderCallError with
// the classification in .kind (helper-providers) - NOT .code,
// and the human message does not reliably contain the kind
// string (root QA P1 2026-11-06: the previous .code/message
// probe missed real SUBMISSION_UNCERTAIN errors entirely).
// .kind is authoritative; .code is only a fallback for
// foreign errors thrown by non-provider adapters.
export function submitErrorKind(e: any): string {
  return String(e?.kind ?? e?.code ?? '');
}

// Classify a submit error by what the ADAPTER can prove
// about the provider side (root QA 2026-11-06). Only errors
// the adapter raises for a definitive non-acceptance may
// move a child out of IN_FLIGHT: INVALID / INPUT_TOO_LARGE
// are raised before or as a provider rejection of the
// request itself, UNAUTHENTICATED / PERMISSION / NOT_FOUND
// are definitive rejections - nothing was created, and the
// failure is terminal for this child. RATE_LIMITED is a
// refusal BEFORE acceptance - nothing was created, but a
// later attempt may submit. Everything else (SUBMISSION_
// UNCERTAIN, PROVIDER_ERROR, unknown kinds, raw throws) is
// treated as UNCERTAIN: the submission may exist, the child
// stays IN_FLIGHT, and reconciliation goes through the
// persisted binding - never a resubmit, never a receipt.
export function classifySubmitError(e: any): 'UNCERTAIN' | 'TERMINAL' | 'RETRYABLE' {
  const kind = submitErrorKind(e);
  if (kind === 'RATE_LIMITED') return 'RETRYABLE';
  if (['INVALID', 'INPUT_TOO_LARGE', 'UNAUTHENTICATED', 'PERMISSION', 'NOT_FOUND'].includes(kind)) return 'TERMINAL';
  return 'UNCERTAIN';
}

// The claimed-child tail of a delegation: the child already
// exists on the canonical queue and the caller holds its live
// lease (the executor claimed it through the host surface; the
// worker daemon claimed it through the engine). Everything
// from here is identical for both hosts - same fences, same
// exactly-once begin, same binding-only read, same durable
// record against the child's live lease/attempt.
export async function executeClaimedHelperChild(
  deps: { pool: Pool; scope: ProjectScope; parent: Principal },
  args: { a: HelperAssignment; childTaskId: string; leaseToken: string; attempt: number;
    adapter: HelperAdapter; input: unknown; expectedCost?: number }): Promise<HelperChildOutcome> {
  const { pool, scope, parent } = deps;
  const { a, adapter } = args;
  const child = { childTaskId: args.childTaskId };
  const claim = { leaseToken: args.leaseToken, attempt: args.attempt };

  // Record a definitive non-acceptance durably and report it
  // as an outcome. If the receipt itself cannot be recorded,
  // the child is still IN_FLIGHT - report UNCERTAIN (the
  // conservative truth) rather than claiming a failure state
  // the queue does not hold.
  const failDurably = async (code: string, retryable: boolean, cause?: any): Promise<HelperChildOutcome> => {
    try {
      const failure = await recordHelperSubmissionFailure(pool, scope, parent,
        child.childTaskId, claim.leaseToken, claim.attempt, { code, retryable });
      return { status: 'SUBMIT_FAILED', helperId: a.helperId, childTaskId: child.childTaskId, failure };
    } catch (receiptError: any) {
      return { status: 'SUBMIT_UNCERTAIN', helperId: a.helperId, childTaskId: child.childTaskId,
        error: `submit failed (${code}) and its failure receipt could not be recorded: ${String(receiptError?.message ?? receiptError)}; cause: ${String(cause?.message ?? cause ?? '')}` };
    }
  };

  // Begin: exactly one caller wins NEW. A child already
  // SUBMITTED reconciles through the persisted binding; a
  // child IN_FLIGHT is an uncertain earlier submission and is
  // NEVER resubmitted from here; a child holding a durable
  // failure receipt reports that receipt - a terminal failure
  // is never resubmitted by any later run, and a retryable
  // failure re-arms only inside begin, under a strictly
  // later claim attempt.
  const begun = await beginHelperSubmission(pool, scope, parent, child.childTaskId, claim.leaseToken, claim.attempt);
  if (begun.state === 'IN_FLIGHT') return { status: 'IN_FLIGHT', helperId: a.helperId, childTaskId: child.childTaskId };
  if (begun.state === 'FAILED_TERMINAL' || begun.state === 'FAILED_RETRYABLE')
    return { status: 'SUBMIT_FAILED', helperId: a.helperId, childTaskId: child.childTaskId, failure: begun.failure };

  if (begun.state === 'NEW') {
    // Pre-submit fence (root QA 2026-11-06): the assignment
    // is re-validated with the estimated cost of THIS
    // submission immediately before the provider call -
    // budgets move and assignments expire between child
    // creation and submission. A denial is a definitive
    // non-submission: it takes the durable terminal receipt,
    // never an IN_FLIGHT wedge, and the provider is not
    // called.
    const fence = validateBeforeSubmit(a, args.expectedCost ?? Number.NaN, Date.now());
    if (!fence.ok) return failDurably(`PRESUBMIT_DENIED:${fence.denies.join(',')}`, false);
    // Submit once, then record the ref under the same
    // lease/attempt fence. A provider-side uncertainty is an
    // outcome: the begin stays IN_FLIGHT for reconciliation.
    let externalRef: string;
    try {
      externalRef = (await adapter.submit(a, args.input)).externalRef;
    } catch (e: any) {
      const cls = classifySubmitError(e);
      if (cls === 'UNCERTAIN')
        return { status: 'SUBMIT_UNCERTAIN', helperId: a.helperId, childTaskId: child.childTaskId, error: String(e?.message ?? e) };
      // The adapter proved nothing was accepted: record the
      // failure durably (terminal, or retryable for a later
      // claim attempt) instead of wedging the child.
      return failDurably(submitErrorKind(e) || 'PROVIDER_REJECTED', cls === 'RETRYABLE', e);
    }
    try {
      await recordHelperSubmission(pool, scope, parent, child.childTaskId, claim.leaseToken, claim.attempt, externalRef);
    } catch (e: any) {
      // The provider HAS the submission; only the queue record
      // failed. Surface the ref so the host can reconcile -
      // resubmitting from here would double-submit.
      return { status: 'SUBMIT_RECORD_FAILED', helperId: a.helperId, childTaskId: child.childTaskId,
        externalRef, error: String(e?.message ?? e) };
    }
  }

  // Read + verify strictly through the persisted binding,
  // then durably record against the child's live lease.
  const envelope = await readVerifiedHelperResult(pool, scope, parent, a, asReader(adapter));
  const recorded = await recordHelperResult(pool, scope, parent, a, envelope, claim.leaseToken, claim.attempt);
  return { status: 'RECORDED', helperId: a.helperId, childTaskId: child.childTaskId,
    externalRef: envelope.externalRef ?? '', envelope, alreadyRecorded: recorded.alreadyRecorded };
}

// Rebuild the equipped assignment from a persisted child
// payload (the daemon path: the child was created earlier,
// possibly by another host, and claimed by the engine). The
// reconstruction is verified against the child's own pinned
// binding (parent, attempt, helper, reply target, equipment
// digest) before anything trusts it - a tampered or foreign
// payload fails here, before any begin or provider call.
export function assignmentFromChildPayload(scope: ProjectScope, parentWorkerId: string,
  payload: Record<string, unknown>): HelperAssignment {
  const p: any = payload ?? {};
  const a: HelperAssignment = {
    parentTaskId: String(p.parent_task_id ?? ''),
    parentAttempt: Number(p.parent_attempt),
    parentWorkerId,
    subtaskKey: String(p.subtask_key ?? ''),
    helperId: p.helper_id as HelperId,
    scope,
    equipment: p.equipment,
    replyTarget: String(p.callback_target ?? ''),
    budget: p.budget ?? undefined,
    sourceAllowlist: Array.isArray(p.source_allowlist) ? p.source_allowlist : [],
    toolAllowlist: Array.isArray(p.tool_allowlist) ? p.tool_allowlist : [],
    expiresAtMs: Number(p.expires_at_ms),
  };
  assertChildBinding(p, a, String(p.child_key ?? ''));
  return a;
}
