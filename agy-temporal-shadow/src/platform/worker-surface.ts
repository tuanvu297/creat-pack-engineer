import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { authorize, type Principal } from './auth.js';
import { ProjectPool } from './scoped-pool.js';
import { validateScope, type ProjectScope } from './scope.js';
import { PostgresStore } from '../postgres-store.js';
import { workerGatePasses, bindingsComplete, type WorkerGate } from './worker-gate.js';
import { createDelegatedChild } from './helper-queue.js';
import type { HelperAssignment } from './helper-delegation.js';
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
export type WorkerAction = 'arrive' | 'recover' | 'claim' | 'ack' | 'heartbeat' | 'checkpoint' | 'result' | 'readback' | 'delegate';
const ACTIONS: WorkerAction[] = ['arrive', 'recover', 'claim', 'ack', 'heartbeat', 'checkpoint', 'result', 'readback', 'delegate'];

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
  // Resolver for the system (operator) principal that job
  // creation runs under for the 'delegate' action. Workers never
  // create jobs directly, and this module never fabricates a
  // principal: when the resolver returns nothing, delegate
  // answers DELEGATION_NOT_CONFIGURED. server.ts wires it to the
  // already configured operator identity from AGY_IDENTITIES_JSON.
  delegationSystemPrincipal?: (scope: ProjectScope) => Principal | undefined;
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

    // Single-task admission (candidate, 2026-11-03): a control-plane
    // record in the worker's metadata that narrows claiming to ONE
    // pinned task in ONE scope until an absolute expiry. Shape:
    // { task_id, mission_id, task_type, scope:{tenant_id,workspace_id,
    // project_id}, expires_at, presence_ttl_seconds? }. It is read
    // fresh on every arrive/claim; nothing here creates or extends it.
    interface Admission { task_id: string; mission_id: string; task_type: string;
      scope: { tenant_id: string; workspace_id: string; project_id: string };
      expires_at: string; presence_ttl_seconds?: number }
    const admissionOf = async (): Promise<{ admission: Admission | null; status: string | null; heartbeatAt: string | null }> => {
      const row = (await pool.query('SELECT metadata, status, heartbeat_at FROM agy_workers WHERE worker_id=$1', [workerId])).rows[0];
      const a = row?.metadata?.admission;
      const valid = a && typeof a === 'object' && typeof a.task_id === 'string' && typeof a.mission_id === 'string'
        && typeof a.task_type === 'string' && typeof a.expires_at === 'string'
        && a.scope && a.scope.tenant_id === scope.tenantId && a.scope.workspace_id === scope.workspaceId && a.scope.project_id === scope.projectId;
      return { admission: valid ? a as Admission : null, status: row?.status ?? null,
        heartbeatAt: row?.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null };
    };

    if (act === 'arrive') {
      // Admission arrival (candidate, 2026-11-03): when the control
      // plane has placed a single-task admission for THIS scope on the
      // worker, arrival is a presence stamp under that admission —
      // bindings must be complete, the worker must already be READY
      // (arrival never sets status), and the admission must be live.
      // No admission for this scope -> the qualification arrival
      // below governs, unchanged.
      {
        const { admission, status } = await admissionOf();
        if (admission) {
          if (Date.now() > new Date(admission.expires_at).getTime()) throw new Error('ADMISSION_EXPIRED');
          const b = await bindingsOf();
          if (!b || !bindingsComplete(b)) throw new Error('ARRIVAL_NOT_GRANTED');
          if (status !== 'READY') throw new Error('ARRIVAL_NOT_GRANTED');
          await pool.query('UPDATE agy_workers SET heartbeat_at=now(), updated_at=now() WHERE worker_id=$1', [workerId]);
          return { status: 'ARRIVED', via: 'ADMISSION', task_id: admission.task_id,
            mission_id: admission.mission_id, expires_at: admission.expires_at };
        }
      }
      // Worker arrival / presence (candidate; F1 opt-in, H2
      // atomic): the authenticated worker — identity from its
      // token, never from the body — announces itself. Arrival is
      // a QUALIFICATION opt-in, not a general presence endpoint,
      // and validation + mutation happen in ONE scoped
      // transaction (H2): the project row, the scope's connectors
      // of the worker's adapter kind, and the worker row are
      // locked in the controller's own order (project →
      // connector → worker), the wall clock is read AFTER those
      // locks, and every gate is evaluated on the LOCKED rows —
      // an owner pause/offline or a cleanup that lands while
      // arrival waits is seen by arrival, never overwritten by
      // it. A final clock fence runs after the write, before
      // commit (H1): a crossing rolls the whole arrival back.
      // The gates:
      //  - the project must carry a live grant marker
      //    (policies.qualificationRun, phase GRANTED, expires_at
      //    after the post-lock clock read) — business scopes have
      //    no marker and are refused, so arrival can never
      //    rewrite a business worker's profile;
      //  - the project must be ACTIVE (an owner pause, or the
      //    PAUSED state cleanup leaves, refuses arrival);
      //  - the scope must have an ENABLED connector of the
      //    worker's own adapter kind (cleanup disables it);
      //  - the worker must already hold COMPLETE provisioned
      //    bindings, and must already BE in the granted state:
      //    status READY as set by the controller's grant. Arrival
      //    never SETS status — an owner-OFFLINE worker stays
      //    OFFLINE and is refused; READY is the controller's
      //    decision, never arrival's.
      // On success arrival stamps heartbeat_at and projects the
      // project's OWN permissions + resource-policy quotaCap into
      // the profile (allocation requires both). Measured fields
      // stay DEFAULT_NOT_MEASURED; quota, metadata and bindings
      // are never touched. There is no register action and no
      // self-provisioning (Q1 rule).
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Shared scope coordination lock (L1), taken FIRST:
        // the same key the qualification controller derives from
        // the scope triple for its prepare/cleanup transactions
        // (cleanup holds it at session level across ALL its
        // phases, including phase 2's canonical reclaim, whose
        // worker-row locks and health-insert key-share can
        // otherwise queue behind arrival's pending worker lock
        // and deadlock with it). Serializing arrival against
        // the coordinator removes that cycle by construction —
        // no reliance on PostgreSQL victim selection. Scopes
        // without a coordinator never contend for their derived
        // key, so business arrivals are unaffected.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`,
          [`agy:scope:${scope.tenantId}/${scope.workspaceId}/${scope.projectId}`]);
        const refuse = async (code: string): Promise<never> => {
          await client.query('ROLLBACK');
          throw new Error(code);
        };
        // The project row is locked FOR NO KEY UPDATE, never
        // FOR UPDATE (L1 lock discipline): every scoped child
        // table carries a composite FK to agy_projects
        // (migration 004), so a canonical transaction holding
        // worker/task rows (workerResult, reclaimExpired)
        // INSERTs children that need a KEY SHARE on this parent
        // row — KEY SHARE is compatible with NO KEY UPDATE but
        // conflicts with FOR UPDATE. Qualification never changes
        // project key columns, and NO KEY UPDATE still excludes
        // every writer of the non-key fields (owner pause/policy
        // UPDATEs, the controller's own writes take the same
        // mode), so the gates below still evaluate a locked row.
        const proj = (await client.query('SELECT permissions, resource_policy, status, policies FROM agy_projects FOR NO KEY UPDATE')).rows[0];
        if (!proj) return await refuse('PROJECT_NOT_FOUND');
        const shell = (await client.query('SELECT adapter FROM agy_workers WHERE worker_id=$1', [workerId])).rows[0];
        if (!shell) return await refuse('WORKER_NOT_PROVISIONED');
        const connectors = (await client.query(
          `SELECT enabled FROM agy_connectors WHERE kind=$1 FOR UPDATE`, [shell.adapter])).rows;
        // Same discipline for the worker row (FK-referenced by
        // agy_project_worker_health, reservations and others):
        // NO KEY UPDATE excludes every non-key writer (cleanup,
        // reclaim's registry lock, settlement) while staying
        // compatible with child-insert KEY SHAREs.
        const existing = (await client.query(
          'SELECT status, metadata FROM agy_workers WHERE worker_id=$1 FOR NO KEY UPDATE', [workerId])).rows[0];
        if (!existing) return await refuse('WORKER_NOT_PROVISIONED');
        const nowMs = new Date((await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now).getTime();
        const marker = (proj.policies && typeof proj.policies === 'object') ? (proj.policies as any).qualificationRun : null;
        if (!marker || marker.phase !== 'GRANTED' || !(Date.parse(marker.expires_at) > nowMs))
          return await refuse('ARRIVAL_NOT_GRANTED');
        if (proj.status !== 'ACTIVE') return await refuse('ARRIVAL_NOT_GRANTED');
        const bindings = (existing.metadata && typeof existing.metadata === 'object') ? (existing.metadata as any).bindings : null;
        if (!bindingsComplete(bindings)) return await refuse('ARRIVAL_NOT_GRANTED');
        if (!connectors.some((c: any) => c.enabled)) return await refuse('ARRIVAL_NOT_GRANTED');
        if (existing.status !== 'READY') return await refuse('ARRIVAL_REFUSED');
        const permissions = Array.isArray(proj.permissions) ? proj.permissions : [];
        const quotaCap = typeof proj.resource_policy?.quotaCap === 'number' ? proj.resource_policy.quotaCap : null;
        await client.query(`UPDATE agy_workers SET heartbeat_at=now(),
          resource_profile = resource_profile || $2::jsonb, updated_at=now() WHERE worker_id=$1`,
          [workerId, JSON.stringify({ permissions, quotaCap })]);
        const finalMs = new Date((await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now).getTime();
        if (finalMs >= Date.parse(marker.expires_at)) return await refuse('ARRIVAL_NOT_GRANTED');
        await client.query('COMMIT');
        return { status: 'READY', worker_id: workerId };
      } catch (e) {
        await (client as any).query('ROLLBACK').catch(() => {});
        throw e;
      } finally { (client as any).release(); }
    }

    if (act === 'recover') {
      // Lost-claim recovery (candidate, F5): read-only reconcile
      // for a worker whose claim RESPONSE was lost in transport.
      // The worker names the owner-issued run id (operational
      // knowledge from its assignment, not a secret); the surface
      // returns the worker's OWN live lease for that run's job in
      // THIS scope — the exact same lease_token and attempt the
      // original claim issued. Nothing is granted, created, or
      // extended: no new lease, no new attempt, no new reservation
      // (the lease token IS the reservation id). A foreign task is
      // unreachable (the job read is RLS-scoped to this project
      // and the task must be claimed_by THIS worker); a run this
      // worker holds nothing under answers NO_ACTIVE_LEASE with
      // no task data at all. An expired lease fails closed
      // (LEASE_EXPIRED) — recovery never revives it.
      const runId = String(body?.run_id ?? '');
      if (!runId) throw new Error('RUN_ID_REQUIRED');
      const job = (await pool.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [runId])).rows[0];
      if (!job) return { status: 'NOT_FOUND' };
      const row = (await pool.query(
        `SELECT task_id, lease_token, attempt, lease_expires_at FROM agy_tasks
          WHERE job_id=$1 AND claimed_by=$2 AND status IN ('CLAIMED','RUNNING')
          ORDER BY attempt DESC LIMIT 1`, [job.job_id, workerId])).rows[0];
      if (!row) return { status: 'NO_ACTIVE_LEASE' };
      if (!row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= Date.now())
        throw new Error('LEASE_EXPIRED');
      return { status: 'RECOVERED',
        task: { taskId: row.task_id, leaseToken: row.lease_token, attempt: Number(row.attempt) },
        lease_expires_at: row.lease_expires_at };
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
      // Admission narrowing (candidate, 2026-11-03): with a live
      // admission for this scope, the gate narrows to the admission's
      // mission and task type, pins the single task, and requires a
      // fresh arrival (presence) inside the admission's TTL. Expiry
      // denies here AND inside workerGatePasses (evaluated again in
      // the claim transaction), so the grant dies at expires_at even
      // if no cleanup ever runs.
      {
        const { admission, status, heartbeatAt } = await admissionOf();
        if (admission) {
          const expiresMs = new Date(admission.expires_at).getTime();
          if (Date.now() > expiresMs) return { status: 'DENIED', reason: 'ADMISSION_EXPIRED',
            note: 'The single-task admission for this scope has expired. No task was claimed, attempted, or reserved.' };
          const ttlMs = (admission.presence_ttl_seconds ?? 300) * 1000;
          const fresh = status === 'READY' && heartbeatAt !== null && (Date.now() - new Date(heartbeatAt).getTime()) <= ttlMs;
          if (!fresh) return { status: 'DENIED', reason: 'ADMISSION_PRESENCE_REQUIRED',
            note: 'This admission requires a same-session arrival (presence) immediately before claiming. No task was claimed, attempted, or reserved.' };
          gate.missions = [admission.mission_id];
          gate.taskTypes = [admission.task_type];
          gate.admission = { taskId: admission.task_id, expiresAtMs: expiresMs, nowMs: Date.now() };
        }
      }
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

    if (act === 'delegate') {
      // Helper delegation (D-057): the calling worker stays the
      // parent of record. Identity and scope come from the
      // authenticated principal and the request scope - body
      // copies are overwritten, never trusted (BODY_SCOPE_OVERRIDE
      // above already rejects scope keys). The parent lease token
      // is required as possession proof and verified against the
      // persisted parent row inside createDelegatedChild.
      const systemPrincipal = opts?.delegationSystemPrincipal?.(scope);
      if (!systemPrincipal) return { status: 'DENIED', reason: 'DELEGATION_NOT_CONFIGURED' };
      const a = body?.assignment;
      if (!a || typeof a !== 'object') return { status: 'DENIED', reason: 'ASSIGNMENT_REQUIRED' };
      if (typeof body?.parentLeaseToken !== 'string' || !body.parentLeaseToken) {
        return { status: 'DENIED', reason: 'PARENT_LEASE_TOKEN_REQUIRED' };
      }
      const assignment: HelperAssignment = { ...a, parentWorkerId: workerId,
        scope: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId } };
      try {
        const r = await createDelegatedChild(raw, scope, principal, systemPrincipal, assignment, {
          estimatedQuota: Number(body?.spec?.estimatedQuota ?? 1),
          estimatedCost: Number(body?.spec?.estimatedCost ?? 0),
          requiredCapabilities: Array.isArray(body?.spec?.requiredCapabilities) ? body.spec.requiredCapabilities : [],
          parentLeaseToken: body.parentLeaseToken,
        });
        return { status: r.created ? 'CREATED' : 'EXISTS', ...r };
      } catch (e: any) {
        return { status: 'DENIED', reason: String(e?.message ?? e) };
      }
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
      const ackCapMs = opts?.leaseDeadlineMs?.(scope);
      const ok = await store.transition(taskId, leaseToken, ['CLAIMED'], 'RUNNING', { workerId }, ackCapMs);
      if (!ok) throw new Error(ackCapMs !== undefined && Date.now() >= ackCapMs ? 'LEASE_EXPIRED' : 'ACK_DENIED');
      return { status: 'RUNNING', task_id: taskId, attempt };
    }
    if (act === 'heartbeat') {
      const hbCapMs = opts?.leaseDeadlineMs?.(scope);
      // Label check only; the authoritative enforcement is inside
      // store.heartbeat: it locks the task row, reads the database
      // wall clock in a separate statement, and only then writes
      // a LEAST-capped expiry — so a lock wait or a
      // last-fraction-second call can never push the lease past
      // the deadline (QA findings E2/F2).
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
        const version = await store.saveCheckpoint({ ...row, taskId, leaseToken, payload: row.payload } as any, externalId, reg.adapter, payload, workerId, attempt, opts?.leaseDeadlineMs?.(scope));
        return { status: 'CHECKPOINTED', task_id: taskId, external_id: externalId, version, attempt };
      } catch (e: any) {
        if (e?.message === 'CHECKPOINT_CONFLICT' || e?.message === 'ATTEMPT_DENIED' || e?.message === 'LEASE_EXPIRED') throw e;
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
      contentDigest, target, quotaUnits: body?.quota_units, costAmount: body?.cost_amount,
      deadlineMs: opts?.leaseDeadlineMs?.(scope) });
    return { ...out, next: 'QA is a separate reviewer action; callback delivery is performed by the control-plane dispatcher and is not implied by this submission.' };
  };
}
