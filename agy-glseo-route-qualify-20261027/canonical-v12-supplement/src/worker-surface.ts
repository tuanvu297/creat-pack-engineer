import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { authorize, type Principal } from './auth.js';
import { ProjectPool } from './scoped-pool.js';
import { validateScope, type ProjectScope } from './scope.js';
import { PostgresStore } from '../postgres-store.js';
import { workerGatePasses, bindingsComplete, type WorkerGate } from './worker-gate.js';
import { stableStringify, digestOf } from './digest.js';

// Bounded worker namespace for external personal workers — v3
// (candidate for AGY-GLSEO-ROUTE-QUALIFY-20261027; supersedes the v2
// surface after independent QA findings S1–S3; the browser surface in
// worker-ui.ts dispatches here, and worker-callbacks.ts is the delivery
// side of the outbox this surface writes).
//
// Canonical machinery is reused: platform identities (auth.ts), project
// scopes (scope.ts), the RLS-scoped ProjectPool, PostgresStore
// leases/allocation/reservations, the capacity-release trigger, and
// agy_task_events as the receipt ledger. The only schema addition is
// candidate migration 012 (agy_worker_callbacks). No new queue, no
// shadow RPC.
//
// v3 bindings (fail-closed):
//  - Identity: execute actions require role 'worker' + principal.workerId;
//    the acting worker is ALWAYS principal.workerId.
//  - Claim (S1): the routing gate runs INSIDE PostgresStore.claim's
//    transaction, filtering the dispatch demand before selection — a
//    forbidden task (payload.auto_dispatch=false, targeted at another
//    worker, mission/type/reply outside the worker's bindings) is never
//    claimed, attempted, or reserved. There is no claim-then-reject.
//    A worker with NO provisioned bindings (or no task_types binding)
//    is denied outright: missing bindings never mean "unrestricted".
//  - Task binding: every lease action verifies the immutable tuple
//    (task_id, claimed_by = workerId, lease_token, attempt) — attempt is
//    REQUIRED — and the store calls are themselves worker-bound
//    (transition patch.workerId, saveCheckpoint's locked-row check,
//    heartbeat's built-in claimed_by check, workerResult's row lock).
//  - Checkpoint (S3): PostgresStore.saveCheckpoint locks the task row
//    and validates lease/status/worker/attempt BEFORE any replay lookup,
//    so a stale or completed lease is never answered with a version;
//    the real payload is digested and persisted.
//  - Result (S2): PostgresStore.workerResult is ONE transaction under
//    the task row lock: binding check, RUNNING required (never
//    auto-acked from CLAIMED), task->QA + QA receipt + event receipt +
//    callback outbox + reservation settlement commit or roll back
//    together. Identical replay returns the recorded callback exactly
//    once; different content under the same attempt conflicts.
//  - Readback: a worker reads only tasks it participates in (current
//    claimant, event actor, or callback owner). Operator/reviewer
//    principals keep their canonical read access.
export type WorkerAction = 'arrive' | 'claim' | 'ack' | 'heartbeat' | 'checkpoint' | 'result' | 'readback';
const ACTIONS: WorkerAction[] = ['arrive', 'claim', 'ack', 'heartbeat', 'checkpoint', 'result', 'readback'];

const clampLease = (v: unknown) => Math.max(30, Math.min(Number.isFinite(Number(v)) ? Number(v) : 120, 900));
const stable = stableStringify;

interface Bindings { missions?: string[]; task_types?: string[]; reply_targets?: string[] }

export function createWorkerSurface(raw: Pool, opts?: {
  // Optional per-scope lease deadline (epoch ms). When it returns a
  // value for the claim/heartbeat scope, the deadline is passed
  // into the store, which enforces it authoritatively inside the
  // mutation transaction: re-checked after the registry lock is
  // held, and lease expiry is LEAST-capped at the deadline — so no
  // lease can outlive it, even across lock waits, last-fraction
  // heartbeats, or a service outage at the deadline. ack,
  // checkpoint, and result need no extra wiring: their store
  // paths already validate lease_expires_at under the task row
  // lock, and a capped lease makes that check a deadline check.
  // The qualification controller's owner deadline is wired through
  // this in server.ts; scopes without a deadline are untouched.
  leaseDeadlineMs?: (scope: ProjectScope) => number | undefined;
}) {
  return async function workerSurface(principal: Principal, scope: ProjectScope, action: string, body: any = {}): Promise<any> {
    if (!ACTIONS.includes(action as WorkerAction)) throw new Error('UNKNOWN_WORKER_ACTION');
    const act = action as WorkerAction;
    validateScope(scope);
    authorize(principal, scope, act === 'readback' ? 'read' : 'execute');
    if (act !== 'readback' && !principal.workerId) throw new Error('WORKER_IDENTITY_REQUIRED');
    for (const key of ['tenant_id', 'workspace_id', 'project_id', 'tenantId', 'workspaceId', 'projectId', 'worker_id', 'workerId', 'claimed_by']) {
      if (key in (body ?? {})) throw new Error('BODY_SCOPE_OVERRIDE_DENIED');
    }
    const pool = new ProjectPool(raw, scope, principal.subject).asPool();
    const store = new PostgresStore(pool, scope);
    const workerId = principal.workerId as string;

    const loadTask = async (taskId: string) =>
      (await pool.query('SELECT task_id,job_id,status,attempt,claimed_by,lease_token,lease_expires_at,payload,task_type,result,checkpoint FROM agy_tasks WHERE task_id=$1', [taskId])).rows[0];

    const attemptOf = (): number => {
      if (body?.attempt === undefined || body?.attempt === null || body?.attempt === '') throw new Error('ATTEMPT_REQUIRED');
      return Number(body.attempt);
    };

    // The immutable task binding: (task, claimant, lease token, attempt).
    const verifyBinding = async (taskId: string, leaseToken: string, attempt: number) => {
      const row = await loadTask(taskId);
      if (!row) throw new Error('TASK_NOT_FOUND');
      if (row.claimed_by !== workerId) throw new Error('WORKER_BINDING_DENIED');
      if (String(row.lease_token) !== leaseToken) throw new Error('LEASE_DENIED');
      if (Number(attempt) !== Number(row.attempt)) throw new Error('ATTEMPT_DENIED');
      if (row.status !== 'QA' && row.lease_expires_at && new Date(row.lease_expires_at).getTime() <= Date.now()) throw new Error('LEASE_EXPIRED');
      return row;
    };

    const bindingsOf = async (): Promise<Bindings | null> => {
      const row = (await pool.query('SELECT metadata FROM agy_workers WHERE worker_id=$1', [workerId])).rows[0];
      const b = row?.metadata?.bindings;
      return (b && typeof b === 'object') ? b as Bindings : null;
    };

    if (act === 'arrive') {
      // Worker arrival / presence (candidate): the authenticated
      // worker — identity from its token, never from the body —
      // announces itself in a scope its identity is provisioned
      // for. This is the ONLY presence entrypoint: there is no
      // surface register, and an unprovisioned worker is refused
      // (no self-provisioning, per the Q1 rule). Arrival supplies
      // exactly what provisioning already decided and nothing
      // else: the project's OWN permissions and the project's OWN
      // resource-policy quotaCap are projected into the worker's
      // profile (allocation requires both), and presence is
      // stamped. Measured profile fields (passRate, errorRate, …)
      // are NOT touched — they stay at the engine's
      // DEFAULT_NOT_MEASURED values; quota_remaining/quota_reserve
      // are NOT touched either (the cap grant belongs to the
      // owner/controller, never to arrival), and neither is
      // metadata (bindings are control-plane provisioning).
      // Arrival cannot open a window by itself: it does not
      // activate a project, enable a connector, create a job, or
      // grant quota.
      const proj = (await pool.query('SELECT permissions, resource_policy FROM agy_projects')).rows[0];
      if (!proj) throw new Error('PROJECT_NOT_FOUND');
      const existing = (await pool.query('SELECT worker_id FROM agy_workers WHERE worker_id=$1', [workerId])).rows[0];
      if (!existing) throw new Error('WORKER_NOT_PROVISIONED');
      const permissions = Array.isArray(proj.permissions) ? proj.permissions : [];
      const quotaCap = typeof proj.resource_policy?.quotaCap === 'number' ? proj.resource_policy.quotaCap : null;
      await pool.query(`UPDATE agy_workers SET status='READY', heartbeat_at=now(),
        resource_profile = resource_profile || $2::jsonb, updated_at=now() WHERE worker_id=$1`,
        [workerId, JSON.stringify({ permissions, quotaCap })]);
      return { status: 'READY', worker_id: workerId };
    }

    if (act === 'claim') {
      const bindings = await bindingsOf();
      if (!bindings) {
        return { status: 'DENIED', reason: 'WORKER_BINDINGS_MISSING',
          note: 'The control plane has not provisioned bindings for this worker; missing bindings never mean unrestricted access. No task was claimed, attempted, or reserved.' };
      }
      if (!bindingsComplete(bindings)) {
        return { status: 'DENIED', reason: 'WORKER_BINDINGS_INVALID',
          note: 'Provisioned bindings are incomplete or malformed: the qualification namespace requires non-empty missions, task_types AND reply_targets lists. No task was claimed, attempted, or reserved.' };
      }
      const gate: WorkerGate = { workerId, missions: bindings.missions,
        taskTypes: bindings.task_types, replyTargets: bindings.reply_targets };
      const claimCapMs = opts?.leaseDeadlineMs?.(scope);
      if (claimCapMs !== undefined && Date.now() >= claimCapMs) return { status: 'EMPTY' };
      // The absolute deadline is enforced authoritatively inside
      // the claim transaction (re-checked after the registry lock;
      // lease expiry LEAST-capped at the deadline) — not by
      // relative-second math here, which a lock wait could push
      // past the cutoff (QA finding E2).
      const task = await store.claim({ workerId, leaseSeconds: clampLease(body?.lease_seconds), gate,
        ...(claimCapMs !== undefined ? { deadlineMs: claimCapMs } : {}) } as any);
      if (!task) return { status: 'EMPTY' };
      // Defence in depth: the same predicate already filtered demand
      // inside the claim transaction, so this cannot trip unless the
      // store changes underneath this surface.
      if (!workerGatePasses(gate, task as any)) throw new Error('CLAIM_GATE_INCONSISTENCY');
      return { status: 'LEASED', task };
    }

    if (act === 'readback') {
      const taskId = String(body?.task_id ?? '');
      if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new Error('TASK_ID_REQUIRED');
      const row = await loadTask(taskId);
      if (!row) throw new Error('TASK_NOT_FOUND');
      if (principal.role === 'worker') {
        const ev = await pool.query('SELECT 1 FROM agy_task_events WHERE task_id=$1 AND worker_id=$2 LIMIT 1', [taskId, workerId]);
        const cbk = await pool.query('SELECT 1 FROM agy_worker_callbacks WHERE task_id=$1 AND worker_id=$2 LIMIT 1', [taskId, workerId]);
        const participates = row.claimed_by === workerId || (ev.rowCount ?? 0) > 0 || (cbk.rowCount ?? 0) > 0;
        if (!participates) throw new Error('READBACK_DENIED');
      }
      const cb = (await pool.query('SELECT callback_id,target,status,content_digest,created_at,delivered_at FROM agy_worker_callbacks WHERE task_id=$1 ORDER BY created_at DESC LIMIT 1', [taskId])).rows[0];
      return { task: { task_id: row.task_id, job_id: row.job_id, status: row.status, attempt: row.attempt, claimed_by: row.claimed_by, result: row.result },
        callback: cb ?? null,
        callback_semantics: 'PENDING means recorded in the outbox only; DELIVERED is set by the control-plane dispatcher (worker-callbacks.ts) after actual delivery, with a CALLBACK_DELIVERED receipt in agy_task_events. QA acceptance is a separate state.' };
    }

    const taskId = String(body?.task_id ?? '');
    const leaseToken = String(body?.lease_token ?? '');
    if (!/^[a-f0-9-]{36}$/.test(taskId) || !/^[a-f0-9-]{36}$/.test(leaseToken)) throw new Error('LEASE_IDENTITY_REQUIRED');
    const attempt = attemptOf();
    const row = await verifyBinding(taskId, leaseToken, attempt);

    if (act === 'ack') {
      const ok = await store.transition(taskId, leaseToken, ['CLAIMED'], 'RUNNING', { workerId });
      if (!ok) throw new Error('ACK_DENIED');
      return { status: 'RUNNING', task_id: taskId, attempt };
    }
    if (act === 'heartbeat') {
      const hbCapMs = opts?.leaseDeadlineMs?.(scope);
      // Label check only; the authoritative enforcement is inside
      // the heartbeat UPDATE (deadline condition + LEAST-capped
      // expiry), so a lock wait or a last-fraction-second call can
      // never push the lease past the deadline (QA finding E2).
      if (hbCapMs !== undefined && Date.now() >= hbCapMs) throw new Error('LEASE_EXPIRED');
      const ok = await store.heartbeat(taskId, workerId, leaseToken, clampLease(body?.lease_seconds), hbCapMs);
      if (!ok) throw new Error(hbCapMs !== undefined && Date.now() >= hbCapMs ? 'LEASE_EXPIRED' : 'LEASE_DENIED');
      return { status: 'HEARTBEAT', task_id: taskId, attempt };
    }
    if (act === 'checkpoint') {
      const externalId = String(body?.external_id ?? '');
      if (!externalId) throw new Error('EXTERNAL_ID_REQUIRED');
      const reg = (await pool.query('SELECT adapter FROM agy_workers WHERE worker_id=$1', [workerId])).rows[0];
      if (!reg) throw new Error('WORKER_NOT_REGISTERED');
      const payload = (body?.state && typeof body.state === 'object') ? body.state : (body?.payload && typeof body.payload === 'object' ? body.payload : undefined);
      try {
        const version = await store.saveCheckpoint({ ...row, taskId, leaseToken, payload: row.payload } as any, externalId, reg.adapter, payload, workerId, attempt);
        return { status: 'CHECKPOINTED', task_id: taskId, external_id: externalId, version, attempt };
      } catch (e: any) {
        if (e?.message === 'CHECKPOINT_CONFLICT' || e?.message === 'ATTEMPT_DENIED') throw e;
        throw new Error('CHECKPOINT_DENIED');
      }
    }
    // result — one atomic store transaction (see workerResult).
    const result = body?.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('RESULT_REQUIRED');
    const evidence = body?.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !String(evidence.external_operation_id ?? '')) {
      throw new Error('EVIDENCE_REQUIRED');
    }
    const contentDigest = digestOf({ result, evidence });
    // The reply target is immutable task scope, provisioned in the task
    // payload and matched at claim time — never defaulted here.
    const target = String(row.payload?.callback_target ?? '');
    if (!target) throw new Error('REPLY_TARGET_MISSING');
    const out = await store.workerResult({ taskId, workerId, leaseToken, attempt, result, evidence,
      contentDigest, target, quotaUnits: body?.quota_units, costAmount: body?.cost_amount });
    return { ...out, next: 'QA is a separate reviewer action; callback delivery is performed by the control-plane dispatcher and is not implied by this submission.' };
  };
}
