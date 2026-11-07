// Daemon lane wiring for helper delegation (D-057, R1):
// wraps a lane's connector adapter so that helper_delegation
// child tasks claimed by the worker engine are executed by
// the delegation host loop instead of the connector. The
// engine claims the child exactly like any other task (the
// child's required capabilities are the parent's, so the
// parent worker's own lane wins it); this wrapper intercepts
// execute / check_status / collect_result / cancel for those
// tasks only and passes everything else through untouched.
//
// Per-task honesty:
//  - The assignment is rebuilt from the child's persisted
//    payload and verified against its pinned binding before
//    anything runs (assignmentFromChildPayload).
//  - The helper adapter is built from the process env at
//    execution time. An unbound or mismatched adapter fails
//    the task closed (HELPER_NOT_BOUND / mismatch code,
//    non-retryable): no begin, no provider call. This module
//    never claims a helper is connected - it only runs the
//    delegation when the pinned adapter actually binds.
//  - Delegation outcomes map onto the engine contract:
//    RECORDED settles the task SUCCEEDED with the verified
//    envelope in the output; IN_FLIGHT / SUBMIT_UNCERTAIN /
//    SUBMIT_RECORD_FAILED settle FAILED non-retryable at the
//    engine level - the child's single queue-level retry can
//    only re-arm a FAILED_RETRYABLE receipt inside begin,
//    never replay an uncertain effect.
//  - Outcomes live in-process, keyed by the delegation
//    handle. A worker restart between execute and collect
//    loses the handle: check_status then fails closed with
//    HELPER_OUTCOME_UNKNOWN rather than asking the connector
//    about a foreign id or re-executing the delegation. The
//    durable queue records (submission binding, recorded
//    result) are unaffected and stay readable by the hosts.
//  - Self-requeue (root QA 2026-11-06 round 4): a child whose
//    provider submission failed RETRYABLE carries a durable
//    FAILED_RETRYABLE receipt, but the queue's generic
//    allocator excludes the failed worker (failed_workers)
//    from re-claiming - and a helper child is pinned to its
//    parent worker, so no other worker can ever take it.
//    The lane therefore reconciles its own children on every
//    health cycle (the dispatcher calls health before every
//    tick): requeueRetryableHelperChildren clears THIS
//    worker's exclusion for a child only when every fence
//    holds - the persisted receipt is FAILED_RETRYABLE and
//    retryable, the receipt's attempt is the child's current
//    (terminal) attempt, the child is back in RETRY with no
//    live lease, and the child's binding verifies against
//    its job's idempotency key. IN_FLIGHT children (an
//    uncertain submission stays IN_FLIGHT with no receipt)
//    and FAILED_TERMINAL children are NEVER requeued. No
//    operator action is involved; a restart loses nothing
//    because the receipt, not process memory, drives this.
import type { Pool } from 'pg';
import type { Principal } from './auth.js';
import type { ProjectScope } from './scope.js';
import { ProjectPool } from './scoped-pool.js';
import type { ClaimedTask, ExecutionResult, WorkerAdapter } from '../types.js';
import { ConnectorError } from '../adapters.js';
import { assignmentFromChildPayload, executeClaimedHelperChild, type HelperChildOutcome } from './helper-executor.js';
import { assertAdapterMatchesAssignment, helperAdapterFromEnv } from './helper-providers.js';
import { childKey, type HelperAdapter, type HelperId } from './helper-delegation.js';
import type { SubmissionFailureReceipt } from './helper-queue.js';

export interface HelperLaneDeps {
  pool: Pool;
  scope: ProjectScope;
  // The lane's worker principal (the delegating parent).
  parent: Principal;
  // Adapter factory seam (tests inject adapters without
  // provider credentials); production builds from the env.
  adapterFor?: (helperId: HelperId) => HelperAdapter;
}

const HANDLE_PREFIX = 'helper:';

export interface HelperRequeue {
  childTaskId: string;
  // The terminal attempt whose retryable receipt authorized
  // the requeue; the next claim runs under failedAttempt + 1.
  failedAttempt: number;
  code: string;
}

// Conditional reconcile/requeue for this lane's own helper
// children (see the module header). One locked transaction
// over the candidate rows; every candidate is re-verified in
// JS against its persisted binding before its exclusion is
// cleared, and clearing removes ONLY this worker's entry -
// other workers' exclusions on the same row are untouched.
// Returns what was requeued (empty when nothing qualified).
export async function requeueRetryableHelperChildren(pool: Pool, scope: ProjectScope,
  parentWorkerId: string, limit = 8): Promise<HelperRequeue[]> {
  if (!parentWorkerId) return [];
  const sp = new ProjectPool(pool, scope, 'helper-lane').asPool();
  const client = await sp.connect();
  try {
    await client.query('BEGIN');
    const dbNowMs = new Date((await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now).getTime();
    const rows = (await client.query(
      `SELECT t.task_id, t.attempt, t.payload, j.idempotency_key AS job_key
       FROM agy_tasks t JOIN agy_jobs j USING(job_id)
       WHERE t.task_type='helper_delegation' AND t.status='RETRY'
         AND t.claimed_by IS NULL
         AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= clock_timestamp())
         AND t.payload->>'submission_state'='FAILED_RETRYABLE'
         AND $1 = ANY(t.failed_workers)
       ORDER BY t.updated_at LIMIT $2 FOR UPDATE OF t SKIP LOCKED`,
      [parentWorkerId, limit])).rows;
    const done: HelperRequeue[] = [];
    for (const row of rows) {
      const p: any = row.payload ?? {};
      const receipt = p.submission_failure as SubmissionFailureReceipt | undefined;
      // The receipt must be the durable record of the child's
      // CURRENT attempt: that attempt is terminal (its lease
      // is gone, the task sits in RETRY) and a strictly later
      // claim attempt is what re-arms the submission inside
      // beginHelperSubmission - never this one.
      if (!receipt || receipt.retryable !== true || Number(receipt.attempt) !== Number(row.attempt)) continue;
      // Idempotency fence: the persisted payload must still
      // verify as the exact child its job key names. A
      // tampered or drifted binding is skipped, never
      // requeued on trust.
      let a;
      try { a = assignmentFromChildPayload(scope, parentWorkerId, p); } catch { continue; }
      if (String(row.job_key) !== childKey(a)) continue;
      await client.query(
        `UPDATE agy_tasks SET failed_workers=array_remove(failed_workers,$2),
           payload=payload || jsonb_build_object('last_requeue',
             jsonb_build_object('by',$2::text,'from_attempt',$3::int,'at_ms',$4::bigint)),
           updated_at=now() WHERE task_id=$1`,
        [row.task_id, parentWorkerId, Number(row.attempt), dbNowMs]);
      done.push({ childTaskId: String(row.task_id), failedAttempt: Number(row.attempt),
        code: String(receipt.code ?? '') });
    }
    await client.query('COMMIT');
    return done;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export function withHelperDelegation(inner: WorkerAdapter, deps: HelperLaneDeps): WorkerAdapter {
  const outcomes = new Map<string, HelperChildOutcome>();
  const adapterFor = deps.adapterFor ?? ((helperId: HelperId) => helperAdapterFromEnv(helperId, process.env));
  const isHelperTask = (task: ClaimedTask) => task.taskType === 'helper_delegation';
  const isHandle = (externalId: string) => externalId.startsWith(HANDLE_PREFIX);

  const failed = (code: string): ExecutionResult =>
    ({ state: 'FAILED', error: { code, message: code, retryable: false } });

  const wrapper: WorkerAdapter = {
    name: inner.name,
    capabilities: inner.capabilities,
    runtimeProfile: inner.runtimeProfile,
    // The dispatcher calls health before every tick: first
    // reconcile this lane's retryable-failed helper children
    // (fail-soft - a reconcile error never blocks the lane;
    // the next cycle retries), then report the connector's
    // own health unchanged.
    health: async () => {
      try {
        await requeueRetryableHelperChildren(deps.pool, deps.scope, deps.parent.workerId ?? '');
      } catch { /* fail-soft: requeue is retried on the next cycle */ }
      return inner.health();
    },
    async execute(task: ClaimedTask, signal: AbortSignal) {
      if (!isHelperTask(task)) return inner.execute(task, signal);
      if (!deps.parent.workerId) throw new ConnectorError('PARENT_WORKER_REQUIRED', false);
      // Rebuild + verify the assignment from the persisted
      // child payload. Binding failures are plain Errors with
      // stable codes; surface them non-retryable.
      let a;
      try {
        a = assignmentFromChildPayload(deps.scope, deps.parent.workerId, task.payload ?? {});
      } catch (e: any) {
        const code = String(e?.message ?? 'CHILD_BINDING_INVALID').split(':')[0];
        throw new ConnectorError(/^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'CHILD_BINDING_INVALID', false);
      }
      const adapter = adapterFor(a.helperId);
      try {
        assertAdapterMatchesAssignment(a, adapter);
      } catch (e: any) {
        const code = String(e?.message ?? 'HELPER_NOT_BOUND').split(':')[0];
        throw new ConnectorError(/^[A-Z][A-Z0-9_]*$/.test(code) ? code : 'HELPER_NOT_BOUND', false);
      }
      const input = (task.payload as any)?.helper_input;
      if (input === undefined) throw new ConnectorError('HELPER_INPUT_MISSING', false);
      const outcome = await executeClaimedHelperChild(
        { pool: deps.pool, scope: deps.scope, parent: deps.parent },
        { a, childTaskId: task.taskId, leaseToken: task.leaseToken,
          attempt: task.attempt, adapter, input, expectedCost: task.estimatedCost });
      const externalId = `${HANDLE_PREFIX}${task.taskId}`;
      outcomes.set(externalId, outcome);
      return { externalId };
    },
    async check_status(externalId: string) {
      if (!isHandle(externalId)) return inner.check_status(externalId);
      const outcome = outcomes.get(externalId);
      if (!outcome) return failed('HELPER_OUTCOME_UNKNOWN');
      return outcome.status === 'RECORDED' ? { state: 'SUCCEEDED' } : failed(outcome.status);
    },
    async collect_result(externalId: string) {
      if (!isHandle(externalId)) return inner.collect_result(externalId);
      const outcome = outcomes.get(externalId);
      if (!outcome) return failed('HELPER_OUTCOME_UNKNOWN');
      if (outcome.status !== 'RECORDED') return failed(outcome.status);
      const env = outcome.envelope;
      const costKnown = Number.isFinite(env.costUnits);
      return {
        state: 'SUCCEEDED',
        externalOperationId: outcome.externalRef || env.externalRef || externalId,
        quotaUnits: costKnown ? env.costUnits : undefined,
        costAmount: null,
        output: {
          delegation_outcome: 'RECORDED',
          child_task_id: outcome.childTaskId,
          helper_id: env.helperId,
          content_digest: env.digest,
          cost_known: costKnown,
          cost_units: costKnown ? env.costUnits : null,
          already_recorded: outcome.alreadyRecorded,
          payload: env.payload,
        },
      };
    },
    async cancel(externalId: string) {
      // A delegation in flight is never cancelled through the
      // connector contract: the persisted begin/binding state
      // is the reconciliation record.
      if (isHandle(externalId)) return;
      return inner.cancel(externalId);
    },
  };
  if (inner.usage) {
    const innerUsage = inner.usage.bind(inner);
    wrapper.usage = async (externalId: string) => isHandle(externalId) ? {} : innerUsage(externalId);
  }
  return wrapper;
}
