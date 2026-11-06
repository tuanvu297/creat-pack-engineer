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
import { type HelperAssignment, type HelperAdapter, type HelperId, type HelperResultEnvelope } from './helper-delegation.js';
import { createDelegatedChild, beginHelperSubmission, recordHelperSubmission,
  readVerifiedHelperResult, recordHelperResult, type ChildSpec, type HelperResultReader } from './helper-queue.js';
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
  | { status: 'SUBMIT_RECORD_FAILED'; helperId: HelperId; childTaskId: string; externalRef: string; error: string };

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

  // 3. Create the child on the canonical queue and claim it
  // through the host surface.
  const child = await createDelegatedChild(pool, scope, parent, system, a, req.spec);
  const claim = await deps.claimChild(child.childTaskId);

  // 4. Begin: exactly one caller wins NEW. A child already
  // SUBMITTED reconciles through the persisted binding; a
  // child IN_FLIGHT is an uncertain earlier submission and is
  // NEVER resubmitted from here.
  const begun = await beginHelperSubmission(pool, scope, parent, child.childTaskId, claim.leaseToken, claim.attempt);
  if (begun.state === 'IN_FLIGHT') return { status: 'IN_FLIGHT', helperId: a.helperId, childTaskId: child.childTaskId };

  if (begun.state === 'NEW') {
    // 5. Submit once, then record the ref under the same
    // lease/attempt fence. A provider-side uncertainty is an
    // outcome: the begin stays IN_FLIGHT for reconciliation.
    let externalRef: string;
    try {
      externalRef = (await adapter.submit(a, req.input)).externalRef;
    } catch (e: any) {
      if (String(e?.code ?? e?.message ?? '').includes('SUBMISSION_UNCERTAIN'))
        return { status: 'SUBMIT_UNCERTAIN', helperId: a.helperId, childTaskId: child.childTaskId, error: String(e?.message ?? e) };
      throw e;
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

  // 6. Read + verify strictly through the persisted binding,
  // then durably record against the child's live lease.
  const envelope = await readVerifiedHelperResult(pool, scope, parent, a, asReader(adapter));
  const recorded = await recordHelperResult(pool, scope, parent, a, envelope, claim.leaseToken, claim.attempt);
  return { status: 'RECORDED', helperId: a.helperId, childTaskId: child.childTaskId,
    externalRef: envelope.externalRef ?? '', envelope, alreadyRecorded: recorded.alreadyRecorded };
}
