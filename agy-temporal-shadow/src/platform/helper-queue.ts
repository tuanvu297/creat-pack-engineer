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
import { childKey, validateAssignment, type HelperAssignment, type HelperResultEnvelope } from './helper-delegation.js';
import type { Principal } from './auth.js';
import type { ProjectScope } from './scope.js';

const scoped = (pool: Pool, scope: ProjectScope) => new ProjectPool(pool, scope, 'helper-queue').asPool();

export interface ChildSpec { estimatedQuota: number; estimatedCost: number; requiredCapabilities: string[] }

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
  const v = validateAssignment(a, Date.now());
  if (!v.ok) throw new Error(`ASSIGNMENT_DENIED:${v.denies.join(',')}`);
  const key = childKey(a);
  const sp = scoped(pool, scope);
  // Authenticated parent verification against the persisted row
  // comes FIRST — even the idempotent reconcile below may only
  // answer a caller who actually owns the parent lease,
  // otherwise any worker could attach to another's child by
  // re-deriving its key.
  const parent = (await sp.query(
    `SELECT claimed_by, attempt, status, lease_expires_at, payload FROM agy_tasks WHERE task_id=$1`, [a.parentTaskId])).rows[0];
  if (!parent) throw new Error('PARENT_NOT_FOUND');
  if (parent.claimed_by !== principal.workerId) throw new Error('PARENT_NOT_OWNER');
  if (Number(parent.attempt) !== a.parentAttempt) throw new Error('PARENT_ATTEMPT_MISMATCH');
  if (!['CLAIMED', 'RUNNING'].includes(parent.status)) throw new Error('PARENT_NOT_ACTIVE');
  if (!parent.lease_expires_at || new Date(parent.lease_expires_at).getTime() <= Date.now()) throw new Error('PARENT_LEASE_EXPIRED');
  const mission = parent.payload?.mission_id;
  if (typeof mission !== 'string' || !mission) throw new Error('PARENT_MISSION_MISSING');
  // Idempotent reconcile: an existing child under this key is
  // THE child — return it, never create a second.
  const existing = (await sp.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [key])).rows[0];
  if (existing) {
    const t = (await sp.query(`SELECT task_id FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [existing.job_id])).rows[0];
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
    return { childJobId: job.jobId, childTaskId: t.task_id, childKey: key, created: true };
  } catch (e: any) {
    // A concurrent create won the unique key: reconcile to it.
    const row = (await sp.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [key])).rows[0];
    if (row) {
      const t = (await sp.query(`SELECT task_id FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [row.job_id])).rows[0];
      return { childJobId: row.job_id, childTaskId: t.task_id, childKey: key, created: false };
    }
    throw e;
  }
}

export type SubmissionState = { state: 'NEW' | 'IN_FLIGHT' | 'SUBMITTED'; externalRef: string | null };

// Atomic submission fence: exactly one caller flips the child
// from no-submission to IN_FLIGHT under its live parent lease;
// everyone else observes the recorded state and reconciles.
export async function beginHelperSubmission(pool: Pool, scope: ProjectScope, principal: Principal,
  childTaskId: string, leaseToken: string, attempt: number): Promise<SubmissionState> {
  const sp = scoped(pool, scope);
  const row = (await sp.query(`SELECT payload, claimed_by, lease_token, attempt, status FROM agy_tasks WHERE task_id=$1`, [childTaskId])).rows[0];
  if (!row) throw new Error('CHILD_NOT_FOUND');
  if (row.claimed_by !== principal.workerId) throw new Error('PARENT_NOT_OWNER');
  if (String(row.lease_token) !== leaseToken || Number(row.attempt) !== attempt) throw new Error('LEASE_DENIED');
  if (!['CLAIMED', 'RUNNING'].includes(row.status)) throw new Error('CHILD_NOT_ACTIVE');
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
  const sp = scoped(pool, scope);
  const upd = await sp.query(
    `UPDATE agy_tasks SET payload=payload || jsonb_build_object('submission_ref', $5::text, 'submission_state', 'SUBMITTED'), updated_at=now()
      WHERE task_id=$1 AND claimed_by=$2 AND lease_token=$3 AND attempt=$4 AND payload->>'submission_state'='IN_FLIGHT'`,
    [childTaskId, principal.workerId, leaseToken, attempt, externalRef]);
  if ((upd.rowCount ?? 0) === 0) throw new Error('SUBMISSION_RECORD_DENIED');
}

export async function verifyHelperResult(pool: Pool, scope: ProjectScope, a: HelperAssignment,
  env: HelperResultEnvelope): Promise<{ verified: true }> {
  if (env.childKey !== childKey(a)) throw new Error('RESULT_CHILD_MISMATCH');
  if (env.helperId !== a.helperId) throw new Error('RESULT_HELPER_MISMATCH');
  if (digestOf(env.payload) !== env.digest) throw new Error('RESULT_DIGEST_MISMATCH');
  const sp = scoped(pool, scope);
  const key = childKey(a);
  const job = (await sp.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [key])).rows[0];
  if (!job) throw new Error('CHILD_NOT_FOUND');
  const t = (await sp.query(`SELECT payload FROM agy_tasks WHERE job_id=$1 ORDER BY created_at LIMIT 1`, [job.job_id])).rows[0];
  const p = t?.payload ?? {};
  // Persisted ownership and reply routing are immutable: if the
  // stored child no longer names this parent and reply target,
  // the result is not integrable under this assignment.
  if (p.parent_task_id !== a.parentTaskId || Number(p.parent_attempt) !== a.parentAttempt
    || p.callback_target !== a.replyTarget || p.child_key !== key || p.helper_id !== a.helperId)
    throw new Error('RESULT_BINDING_MISMATCH');
  return { verified: true };
}
