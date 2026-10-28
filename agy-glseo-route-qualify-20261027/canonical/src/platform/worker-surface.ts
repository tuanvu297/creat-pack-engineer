import type { Pool } from 'pg';
import { authorize, type Principal } from './auth.js';
import { ProjectPool } from './scoped-pool.js';
import { validateScope, type ProjectScope } from './scope.js';
import { PostgresStore } from '../postgres-store.js';

// Bounded worker namespace for external personal workers (candidate for
// AGY-GLSEO-ROUTE-QUALIFY-20261027). This surface reuses the canonical
// EXISTING_POSTGRES_D049 machinery unchanged: platform identities
// (auth.ts), project scopes (scope.ts), the RLS-scoped ProjectPool, and
// PostgresStore leases/allocation/reservations. It creates no queue, no
// table and no new authority; the Temporal mission surface (D-049) is not
// touched by this module.
//
// Identity binding: execute actions require a Principal with role 'worker'
// AND a workerId. The claimed worker is always principal.workerId — a
// request body can never name a different worker. Allocation inside
// PostgresStore.claim decides which task (if any) this worker receives;
// project permissions, budgets, failed-worker exclusions and checkpoint
// adapter continuity all keep their canonical semantics.
export type WorkerAction = 'claim' | 'ack' | 'heartbeat' | 'checkpoint' | 'result' | 'readback';

const clampLease = (v: unknown) => Math.max(30, Math.min(Number.isFinite(Number(v)) ? Number(v) : 120, 900));

export function createWorkerSurface(raw: Pool) {
  return async function workerSurface(principal: Principal, scope: ProjectScope, action: WorkerAction, body: any = {}): Promise<any> {
    validateScope(scope);
    authorize(principal, scope, action === 'readback' ? 'read' : 'execute');
    if (action !== 'readback' && !principal.workerId) throw new Error('WORKER_IDENTITY_REQUIRED');
    for (const key of ['tenant_id', 'workspace_id', 'project_id', 'tenantId', 'workspaceId', 'projectId', 'worker_id', 'workerId', 'claimed_by']) {
      if (key in (body ?? {})) throw new Error('BODY_SCOPE_OVERRIDE_DENIED');
    }
    const pool = new ProjectPool(raw, scope, principal.subject).asPool();
    const store = new PostgresStore(pool, scope);
    const workerId = principal.workerId as string;

    if (action === 'claim') {
      const task = await store.claim({ workerId, leaseSeconds: clampLease(body?.lease_seconds) } as any);
      if (!task) return { status: 'EMPTY' };
      return { status: 'LEASED', task };
    }
    if (action === 'readback') {
      const taskId = String(body?.task_id ?? '');
      if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new Error('TASK_ID_REQUIRED');
      const row = (await pool.query('SELECT task_id,job_id,status,attempt,claimed_by,lease_expires_at,result,checkpoint,updated_at FROM agy_tasks WHERE task_id=$1', [taskId])).rows[0];
      if (!row) throw new Error('TASK_NOT_FOUND');
      return { task: row, semantics: 'Canonical task row readback; QA is a separate state and is never implied by a result submission.' };
    }
    const taskId = String(body?.task_id ?? '');
    const leaseToken = String(body?.lease_token ?? '');
    if (!/^[a-f0-9-]{36}$/.test(taskId) || !/^[a-f0-9-]{36}$/.test(leaseToken)) throw new Error('LEASE_IDENTITY_REQUIRED');
    if (action === 'ack') {
      const ok = await store.transition(taskId, leaseToken, ['CLAIMED'], 'RUNNING');
      if (!ok) throw new Error('ACK_DENIED');
      return { status: 'RUNNING', task_id: taskId };
    }
    if (action === 'heartbeat') {
      const ok = await store.heartbeat(taskId, workerId, leaseToken, clampLease(body?.lease_seconds));
      if (!ok) throw new Error('LEASE_DENIED');
      return { status: 'HEARTBEAT', task_id: taskId };
    }
    if (action === 'checkpoint') {
      const externalId = String(body?.external_id ?? '');
      if (!externalId) throw new Error('EXTERNAL_ID_REQUIRED');
      // The adapter name is read from the canonical worker registry, never
      // from the request: checkpoint continuity binds to the registered
      // adapter exactly as PostgresStore.saveCheckpoint enforces it.
      const reg = (await pool.query('SELECT adapter FROM agy_workers WHERE worker_id=$1', [workerId])).rows[0];
      if (!reg) throw new Error('WORKER_NOT_REGISTERED');
      try {
        const version = await store.saveCheckpoint({ taskId, leaseToken } as any, externalId, reg.adapter);
        return { status: 'CHECKPOINTED', task_id: taskId, external_id: externalId, version };
      } catch { throw new Error('CHECKPOINT_DENIED'); }
    }
    // result: canonical completion is a lease-fenced transition into QA.
    // The result payload is stored on the task row; QA verdicts remain a
    // separate reviewer action on the existing surfaces.
    const result = body?.result;
    if (!result || typeof result !== 'object') throw new Error('RESULT_REQUIRED');
    if (body?.evidence !== undefined && (typeof body.evidence !== 'object' || body.evidence === null)) throw new Error('EVIDENCE_INVALID');
    await store.transition(taskId, leaseToken, ['CLAIMED'], 'RUNNING');
    const done = await store.transition(taskId, leaseToken, ['RUNNING'], 'QA', { result: { ...result, evidence: body?.evidence ?? null } });
    if (!done) throw new Error('RESULT_DENIED');
    const row = (await pool.query('SELECT task_id,status,attempt,result,updated_at FROM agy_tasks WHERE task_id=$1', [taskId])).rows[0];
    return { status: 'RESULT_SUBMITTED', task: row, next: 'QA is a separate reviewer action; this submission does not imply acceptance.' };
  };
}
