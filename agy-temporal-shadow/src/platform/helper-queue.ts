// Queue binding for the helper delegation contract (D-057,
// 2026-11-03). This is the layer that makes the contract's
// runtime claims true — helper-delegation.ts alone is pure
// validation and claims nothing at runtime.
//
// A delegated child is a FIRST-CLASS task on the existing
// canonical queue (same agy_jobs / agy_tasks / reservations as
// every other task; no parallel queue):
//  - createDelegatedChild verifies the AUTHENTICATED server
//    principal against the assignment AND against the persisted
//    parent row: the parent task must exist in this scope, be
//    claimed by this worker, at the stated attempt, under a
//    live lease. Wrong parent, reassigned parent, stale
//    attempt, expired lease, cross-scope — all denied before
//    anything is written.
//  - The child's job carries idempotency_key = childKey(...),
//    unique in the queue: creating twice (retry, crash, race)
//    returns the SAME child. Its payload pins parent_task_id,
//    parent_attempt, helper_id and the immutable reply_target.
//  - The resource reservation is the queue's own: when the
//    parent claims the child, PostgresStore.claim creates the
//    HELD reservation transactionally, exactly like any task.
//  - Submission to a helper surface is fenced by
//    beginHelperSubmission: an atomic state flip on the child
//    row. A retry after an uncertain submission finds the
//    recorded state/external ref and must reconcile
//    (readResult) instead of submitting twice. No provider is
//    called by this module, and none may be called on an
//    unbound adapter route.
//  - verifyHelperResult checks child identity, exact scope,
//    the persisted payload's owner/reply immutability, and the
//    result digest before the parent may integrate it.
import type { Pool } from 'pg';
import { ProjectPool } from './scoped-pool.js';
import { ProjectService } from './service.js';
import { digestOf } from './digest.js';
import { childKey, validateAssignment, type HelperAssignment, type HelperId, type HelperResultEnvelope } from './helper-delegation.js';
import type { Principal } from './auth.js';
import type { ProjectScope } from './scope.js';

const scoped = (pool: Pool, scope: ProjectScope) => new ProjectPool(pool, scope, 'helper-queue').asPool();

const badMoney = (n: unknown): boolean => typeof n !== 'number' || !Number.isFinite(n) || n < 0;

// The current-parent fence, shared by create / begin / record /
// verify: the persisted parent task must still be claimed by
// this worker, at the stated attempt, active, under a live
// lease - as it is NOW, not as it was when the assignment was
// minted. A result or submission that outlives its parent's
// lease belongs to a superseded attempt and is denied.
function checkParentRow(parent: any, workerId: string, attempt: number, leaseToken?: string): void {
  if (!parent) throw new Error('PARENT_NOT_FOUND');
  if (parent.claimed_by !== workerId) throw new Error('PARENT_NOT_OWNER');
  if (Number(parent.attempt) !== attempt) throw new Error('PARENT_ATTEMPT_MISMATCH');
  if (leaseToken !== undefined && String(parent.lease_token ?? '') !== leaseToken) throw new Error('PARENT_LEASE_DENIED');
  if (!['CLAIMED', 'RUNNING'].includes(parent.status)) throw new Error('PARENT_NOT_ACTIVE');
  if (!parent.lease_expires_at || new Date(parent.lease_expires_at).getTime() <= Date.now()) throw new Error('PARENT_LEASE_EXPIRED');
}

function assertChildBinding(p: any, a: HelperAssignment, key: string): void {
  if (p.parent_task_id !== a.parentTaskId || Number(p.parent_attempt) !== a.parentAttempt
    || p.callback_target !== a.replyTarget || p.child_key !== key || p.helper_id !== a.helperId)
    throw new Error('CHILD_BINDING_MISMATCH');
}

async function checkChildsParent(sp: Pool, childPayload: any, workerId: string): Promise<void> {
  const parentId = childPayload?.parent_task_id;
  if (typeof parentId !== 'string' || !parentId) throw new Error('PARENT_NOT_FOUND');
  const parent = (await sp.query(
    `SELECT claimed_by, attempt, status, lease_expires_at FROM agy_tasks WHERE task_id=$1`, [parentId])).rows[0];
  checkParentRow(parent, workerId, Number(childPayload.parent_attempt));
}

export interface ChildSpec { estimatedQuota: number; estimatedCost: number; requiredCapabilities: string[];
  /** Possession proof for the parent lease; verified against the
      persisted row when provided. The worker surface always
      provides it. */
  parentLeaseToken?: string }

// Two principals, by design: the WORKER principal is the
// authenticated parent making the delegation request (verified
// against the assignment and the persisted parent row); the
// SYSTEM principal is the runtime's own operator identity for
// this scope, supplied by the surface/server wiring, because
// job creation on the canonical queue is an operator action
// (ProjectService maps /jobs POST to 'write'). The worker can
// never create queue jobs directly, and this module never
// fabricates a system identity — the caller supplies it.
export async function createDelegatedChild(pool: Pool, scope: ProjectScope, principal: Principal, systemPrincipal: Principal,
  a: HelperAssignment, spec: ChildSpec): Promise<{ childJobId: string; childTaskId: string; childKey: string; created: boolean }> {
  if (principal.role !== 'worker' || !principal.workerId) throw new Error('PARENT_REQUIRED');
  if (principal.workerId !== a.parentWorkerId) throw new Error('PARENT_MISMATCH');
  if (systemPrincipal.role !== 'operator' && systemPrincipal.role !== 'platform-admin') throw new Error('SYSTEM_PRINCIPAL_REQUIRED');
  if (a.scope.tenantId !== scope.tenantId || a.scope.workspaceId !== scope.workspaceId || a.scope.projectId !== scope.projectId)
    throw new Error('CROSS_SCOPE');
  // Spec money fence (peer-QA): a negative or non-finite quota /
  // cost estimate would poison the queue's budget accounting
  // downstream - reject before any database work.
  if (badMoney(spec.estimatedQuota) || badMoney(spec.estimatedCost)) throw new Error('SPEC_INVALID');
  // And the estimate must fit the assignment budget's remaining
  // room: a child priced above the parent's cap would bypass
  // the budget the moment it is admitted (peer-QA F4).
  if (Number.isFinite(a.budget?.cap) && spec.estimatedCost > Math.max(0, a.budget.cap - (a.budget.spent ?? 0)))
    throw new Error('SPEC_EXCEEDS_BUDGET');
  const v = validateAssignment(a, Date.now());
  if (!v.ok) throw new Error(`ASSIGNMENT_DENIED:${v.denies.join(',')}`);
  const key = childKey(a);
  const sp = scoped(pool, scope);
  // Atomicity (peer-QA): the parent row is locked FOR UPDATE on
  // a dedicated client for the whole verify+create window, so
  // the parent cannot be reclaimed, re-attempted or expired
  // between the check and the create. The reconciled paths
  // RE-VERIFY the fence against the current row before trusting
  // a child created by a concurrent winner.
  const client: any = await (sp as any).connect();
  let txOpen = false;
  const parentSelect = `SELECT claimed_by, attempt, status, lease_expires_at, lease_token, payload FROM agy_tasks WHERE task_id=$1`;
  try {
    await client.query('BEGIN'); txOpen = true;
    const parent = (await client.query(`${parentSelect} FOR UPDATE`, [a.parentTaskId])).rows[0];
    checkParentRow(parent, principal.workerId, a.parentAttempt, spec.parentLeaseToken);
    const mission = parent.payload?.mission_id;
    if (typeof mission !== 'string' || !mission) throw new Error('PARENT_MISSION_MISSING');
    const existing = (await client.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [key])).rows[0];
    if (existing) {
      // The key alone does not prove the child is OURS: two
      // assignments differing only in reply target share a
      // childKey. Verify the persisted binding before returning
      // a pre-existing child (peer-QA F3).
      const bt = (await client.query(`SELECT payload FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [existing.job_id])).rows[0];
      assertChildBinding(bt?.payload ?? {}, a, key);
      const t = (await client.query(`SELECT task_id FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [existing.job_id])).rows[0];
      await client.query('COMMIT'); txOpen = false;
      return { childJobId: existing.job_id, childTaskId: t.task_id, childKey: key, created: false };
    }
    const service = new ProjectService(pool, scope, systemPrincipal);
    try {
      const job = await service.execute('/jobs', 'POST', { idempotency_key: key, objective: `helper:${a.helperId}:${a.subtaskKey}`,
        tasks: [{ name: key, idempotencyKey: `${key}:task`, taskType: 'helper_delegation',
          requiredCapabilities: spec.requiredCapabilities, requiredPermissions: ['read'],
          permissionGranted: true, safetyApproved: true,
          estimatedQuota: spec.estimatedQuota, estimatedCost: spec.estimatedCost, maxRetry: 0, priority: 50,
          payload: { mission_id: mission, target_worker_id: a.parentWorkerId, callback_target: a.replyTarget,
            parent_task_id: a.parentTaskId, parent_attempt: a.parentAttempt, child_key: key, helper_id: a.helperId } }] });
      const t = (await sp.query(`SELECT task_id FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [job.jobId])).rows[0];
      await client.query('COMMIT'); txOpen = false;
      return { childJobId: job.jobId, childTaskId: t.task_id, childKey: key, created: true };
    } catch (e: any) {
      if (txOpen) { await client.query('ROLLBACK').catch(() => {}); txOpen = false; }
      const row = (await sp.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [key])).rows[0];
      if (row) {
        // A concurrent create won the unique key while we
        // waited. Re-verify the parent fence against the
        // CURRENT row before returning its child.
        const now = (await sp.query(parentSelect, [a.parentTaskId])).rows[0];
        checkParentRow(now, principal.workerId, a.parentAttempt, spec.parentLeaseToken);
        const bt = (await sp.query(`SELECT payload FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [row.job_id])).rows[0];
        assertChildBinding(bt?.payload ?? {}, a, key);
        const t = (await sp.query(`SELECT task_id FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [row.job_id])).rows[0];
        return { childJobId: row.job_id, childTaskId: t.task_id, childKey: key, created: false };
      }
      throw e;
    }
  } catch (e) {
    if (txOpen) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export type SubmissionState = { state: 'NEW' | 'IN_FLIGHT' | 'SUBMITTED'; externalRef: string | null };

// Atomic submission fence: exactly one caller flips the child
// from no-submission to IN_FLIGHT under its live parent lease;
// everyone else observes the recorded state and reconciles.
export async function beginHelperSubmission(pool: Pool, scope: ProjectScope, principal: Principal,
  childTaskId: string, leaseToken: string, attempt: number): Promise<SubmissionState> {
  if (principal.role !== 'worker' || !principal.workerId) throw new Error('PARENT_REQUIRED');
  const sp = scoped(pool, scope);
  const row = (await sp.query(`SELECT payload, claimed_by, lease_token, attempt, status, lease_expires_at FROM agy_tasks WHERE task_id=$1`, [childTaskId])).rows[0];
  if (!row) throw new Error('CHILD_NOT_FOUND');
  if (row.claimed_by !== principal.workerId) throw new Error('PARENT_NOT_OWNER');
  if (String(row.lease_token) !== leaseToken || Number(row.attempt) !== attempt) throw new Error('LEASE_DENIED');
  if (!['CLAIMED', 'RUNNING'].includes(row.status)) throw new Error('CHILD_NOT_ACTIVE');
  if (!row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= Date.now()) throw new Error('LEASE_EXPIRED');
  await checkChildsParent(sp, row.payload, principal.workerId ?? '');
  const p = row.payload ?? {};
  if (p.submission_ref) return { state: 'SUBMITTED', externalRef: String(p.submission_ref) };
  if (p.submission_state === 'IN_FLIGHT') return { state: 'IN_FLIGHT', externalRef: null };
  const upd = await sp.query(
    `UPDATE agy_tasks SET payload=payload || '{"submission_state":"IN_FLIGHT"}'::jsonb, updated_at=now()
      WHERE task_id=$1 AND claimed_by=$2 AND lease_token=$3 AND attempt=$4
        AND NOT (payload ? 'submission_ref') AND coalesce(payload->>'submission_state','') <> 'IN_FLIGHT'`,
    [childTaskId, principal.workerId, leaseToken, attempt]);
  if ((upd.rowCount ?? 0) === 0) {
    const again = (await sp.query(`SELECT payload FROM agy_tasks WHERE task_id=$1`, [childTaskId])).rows[0];
    const ap = again?.payload ?? {};
    return ap.submission_ref ? { state: 'SUBMITTED', externalRef: String(ap.submission_ref) } : { state: 'IN_FLIGHT', externalRef: null };
  }
  return { state: 'NEW', externalRef: null };
}

export async function recordHelperSubmission(pool: Pool, scope: ProjectScope, principal: Principal,
  childTaskId: string, leaseToken: string, attempt: number, externalRef: string): Promise<void> {
  if (principal.role !== 'worker' || !principal.workerId) throw new Error('PARENT_REQUIRED');
  // An empty ref would wedge the child: begin() reads a falsy
  // submission_ref as "not submitted" while the state says
  // SUBMITTED (peer-QA F2). Refs are non-empty strings, always.
  if (typeof externalRef !== 'string' || !externalRef.trim()) throw new Error('SUBMISSION_REF_INVALID');
  const sp = scoped(pool, scope);
  const row = (await sp.query(`SELECT payload, claimed_by, status, lease_expires_at FROM agy_tasks WHERE task_id=$1`, [childTaskId])).rows[0];
  if (!row) throw new Error('CHILD_NOT_FOUND');
  if (row.claimed_by !== principal.workerId) throw new Error('PARENT_NOT_OWNER');
  if (!['CLAIMED', 'RUNNING'].includes(row.status)) throw new Error('CHILD_NOT_ACTIVE');
  if (!row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= Date.now()) throw new Error('LEASE_EXPIRED');
  await checkChildsParent(sp, row.payload, principal.workerId ?? '');
  const upd = await sp.query(
    `UPDATE agy_tasks SET payload=payload || jsonb_build_object('submission_ref', $5::text, 'submission_state', 'SUBMITTED'), updated_at=now()
      WHERE task_id=$1 AND claimed_by=$2 AND lease_token=$3 AND attempt=$4 AND payload->>'submission_state'='IN_FLIGHT'`,
    [childTaskId, principal.workerId, leaseToken, attempt, externalRef]);
  if ((upd.rowCount ?? 0) === 0) throw new Error('SUBMISSION_RECORD_DENIED');
}

// The queue/host boundary for result reads (root QA,
// 2026-11-03): the ONLY legitimate source of a submission
// binding is the persisted child row - never a caller-supplied
// ref and never an adapter's say-so. loadSubmissionBinding
// re-checks the immutable payload binding and requires a
// recorded submission ref; readVerifiedHelperResult then hands
// that binding to the adapter (which must echo-check the
// provider answer against it) and runs the full result
// verification, including the envelope's externalRef matching
// the persisted ref.
export interface PersistedChildBinding {
  childTaskId: string;
  childKey: string;
  helperId: HelperId;
  submissionRef: string;
  replyTarget: string;
}

export async function loadSubmissionBinding(pool: Pool, scope: ProjectScope,
  a: HelperAssignment): Promise<PersistedChildBinding> {
  const sp = scoped(pool, scope);
  const key = childKey(a);
  const job = (await sp.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [key])).rows[0];
  if (!job) throw new Error('CHILD_NOT_FOUND');
  const t = (await sp.query(`SELECT task_id, payload FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [job.job_id])).rows[0];
  const p = t?.payload ?? {};
  if (p.parent_task_id !== a.parentTaskId || Number(p.parent_attempt) !== a.parentAttempt
    || p.callback_target !== a.replyTarget || p.child_key !== key || p.helper_id !== a.helperId)
    throw new Error('RESULT_BINDING_MISMATCH');
  if (typeof p.submission_ref !== 'string' || !p.submission_ref) throw new Error('SUBMISSION_NOT_RECORDED');
  return { childTaskId: t.task_id, childKey: key, helperId: a.helperId,
    submissionRef: p.submission_ref, replyTarget: p.callback_target };
}

export interface HelperResultReader {
  readResultFor(a: HelperAssignment, externalRef: string,
    binding: { childKey: string; helperId: HelperId; submissionRef: string }): Promise<HelperResultEnvelope>;
}

export async function readVerifiedHelperResult(pool: Pool, scope: ProjectScope, principal: Principal, a: HelperAssignment,
  reader: HelperResultReader): Promise<HelperResultEnvelope> {
  const binding = await loadSubmissionBinding(pool, scope, a);
  const env = await reader.readResultFor(a, binding.submissionRef,
    { childKey: binding.childKey, helperId: binding.helperId, submissionRef: binding.submissionRef });
  if (env.externalRef !== binding.submissionRef) throw new Error('RESULT_REF_MISMATCH');
  await verifyHelperResult(pool, scope, principal, a, env);
  return env;
}

export async function verifyHelperResult(pool: Pool, scope: ProjectScope, principal: Principal, a: HelperAssignment,
  env: HelperResultEnvelope): Promise<{ verified: true }> {
  if (principal.role !== 'worker' || !principal.workerId) throw new Error('PARENT_REQUIRED');
  if (principal.workerId !== a.parentWorkerId) throw new Error('PARENT_MISMATCH');
  // Explicit result-type rejection (peer-QA): malformed
  // envelopes are denied by kind, never coerced. NaN costUnits
  // is the one sanctioned unknown (actuals unmeasurable); the
  // budget layer treats NaN as BUDGET_UNKNOWN and fails closed.
  // Infinities and negatives are invalid money, full stop.
  if (!env || typeof env !== 'object') throw new Error('RESULT_TYPE_INVALID');
  if (typeof env.childKey !== 'string' || typeof env.digest !== 'string') throw new Error('RESULT_TYPE_INVALID');
  if (env.helperId !== 'manus' && env.helperId !== 'grok') throw new Error('RESULT_TYPE_INVALID');
  if (env.externalRef !== null && typeof env.externalRef !== 'string') throw new Error('RESULT_TYPE_INVALID');
  if (env.payload === undefined) throw new Error('RESULT_PAYLOAD_INVALID');
  if (typeof env.costUnits !== 'number' || env.costUnits === Infinity || env.costUnits === -Infinity || env.costUnits < 0)
    throw new Error('RESULT_COST_INVALID');
  // A finite actual that exceeds the assignment budget's
  // remaining room is not integrable under this assignment
  // (peer-QA F1) - it belongs to a budget conversation, not a
  // silent accept.
  if (Number.isFinite(env.costUnits) && Number.isFinite(a.budget?.cap)
    && env.costUnits > Math.max(0, a.budget.cap - (a.budget.spent ?? 0)))
    throw new Error('RESULT_COST_EXCEEDS_BUDGET');
  if (env.childKey !== childKey(a)) throw new Error('RESULT_CHILD_MISMATCH');
  if (env.helperId !== a.helperId) throw new Error('RESULT_HELPER_MISMATCH');
  if (digestOf(env.payload) !== env.digest) throw new Error('RESULT_DIGEST_MISMATCH');
  const sp = scoped(pool, scope);
  // The parent must STILL be the live owner at this attempt:
  // integrating into a superseded attempt is provenance fraud.
  const parent = (await sp.query(
    `SELECT claimed_by, attempt, status, lease_expires_at FROM agy_tasks WHERE task_id=$1`, [a.parentTaskId])).rows[0];
  checkParentRow(parent, principal.workerId, a.parentAttempt);
  const key = childKey(a);
  const job = (await sp.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [key])).rows[0];
  if (!job) throw new Error('CHILD_NOT_FOUND');
  const t = (await sp.query(`SELECT payload, claimed_by FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [job.job_id])).rows[0];
  const p = t?.payload ?? {};
  // Persisted ownership and reply routing are immutable: if the
  // stored child no longer names this parent and reply target,
  // the result is not integrable under this assignment.
  if (p.parent_task_id !== a.parentTaskId || Number(p.parent_attempt) !== a.parentAttempt
    || p.callback_target !== a.replyTarget || p.child_key !== key || p.helper_id !== a.helperId)
    throw new Error('RESULT_BINDING_MISMATCH');
  if (t.claimed_by !== a.parentWorkerId) throw new Error('CHILD_NOT_CLAIMED_BY_PARENT');
  // The result must answer the EXACT recorded submission, in
  // the SUBMITTED state - not an in-flight guess, not another
  // operation's ref.
  if (p.submission_state !== 'SUBMITTED') throw new Error('SUBMISSION_STATE_MISMATCH');
  if (typeof p.submission_ref !== 'string' || env.externalRef !== p.submission_ref) throw new Error('RESULT_REF_MISMATCH');
  return { verified: true };
}
