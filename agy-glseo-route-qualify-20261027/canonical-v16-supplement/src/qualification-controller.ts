import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ProjectPool } from "./scoped-pool.js";
import { type ProjectScope } from "./scope.js";
import { ProjectService } from "./service.js";
import { PostgresStore } from "../postgres-store.js";
import type { Principal } from "./auth.js";

// Qualification provisioning controller (candidate) — the missing
// executable lifecycle for the G2 window, reduced to one-shot
// prepare + monitor + guarded cleanup. Feasibility finding it is
// built on (verified by reading the pin): the DEPLOYED service
// (src/temporal/server.ts) exposes mission actions, worker routes
// and callback routes only — it constructs no ProjectService and
// has no /jobs route, and nothing anywhere in the service applies
// the qualification registry SQL or rolls the window back. The
// only existing executable provisioning entrypoint is the
// predeploy src/hosted/provision-cli.ts → provisionStaging(): it
// re-reads migrations/ sorted, SHA-tracks them, applies new ones
// (012 included, once the file is in migrations/) and grants the
// runtime role — under the BOOTSTRAP connection, which never
// leaves the predeploy environment. This controller covers the
// DATA lifecycle from inside the canonical service, under the
// service's existing runtime DATABASE_URL role (provision grants
// that role SELECT/INSERT/UPDATE on all tables; scoped tables are
// RLS-bound to the fixed scope below). No new service, queue,
// credential, or operator token.
//
// Lifecycle (D1–D3 as accepted; E1–E3 revisions on top):
//   ONE-SHOT GRANT, TRANSACTIONAL (E1). All controllers for this
//   scope — any run id — serialize on ONE advisory transaction
//   lock keyed by the fixed scope (not by run id: two different
//   run ids racing from an empty scope now produce exactly one
//   owner, and the loser reads the winner's marker and blocks).
//   The grant marker {run_id, expires_at, granted_at, phase} is
//   written with the registry + transition in a SINGLE
//   transaction (phase 'PREPARING'); the job is created next
//   (conflict-idempotent); a second short transaction then flips
//   the marker to 'GRANTED' after revalidating marker + job +
//   task count under the same lock. A crash therefore leaves
//   either nothing, or a durable PREPARING grant, or a GRANTED
//   window. PREPARING recovery (F3) is VALIDATE-ONLY: because
//   phase A is atomic, a persisted PREPARING state has one exact
//   shape (project ACTIVE, connector enabled, worker READY with
//   quota 1); the recovering controller resumes only the missing
//   job + phase flip and rewrites NO registry state — any
//   deviation from that shape is a later owner change and BLOCKS
//   with zero writes. A GRANTED marker whose job is missing
//   fails closed (BLOCKED) instead of being silently repaired,
//   and a monitor NEVER rewrites project/worker state — an owner
//   pause after the grant stands (D1).
//   ABSOLUTE CUTOFF (E2, F2). The deadline is re-checked INSIDE
//   the prepare transaction after the lock is acquired (with the
//   database wall clock, read in its own statement), again
//   before job creation, inside the job-creation transaction
//   itself (start + pre-commit fences in PostgresStore.createJob),
//   and again inside the flip transaction; a prepare that
//   crosses the cutoff while waiting grants nothing and falls
//   through to cleanup. Worker leases are fenced the same way at
//   the store level: every deadline check reads clock_timestamp()
//   in a statement that runs only after the locks the mutation
//   needs are held — a single-statement clock predicate, and a
//   clock read inside the locking SELECT's target list, both
//   bind BEFORE a lock wait and do not fence anything (proven
//   against PostgreSQL 18; see PostgresStore.heartbeat).
//   RUN OWNERSHIP, FAIL-CLOSED (D2). Before granting, any
//   persisted history this run does not own — a previous run's
//   marker, any job whose idempotency key is not this run's, a
//   run job without exactly one task, or a worker already holding
//   quota without this run's grant — BLOCKS the controller
//   (needs_owner_repair). (A worker that is merely READY from an
//   early arrival holds no cap and is presence, not a grant.)
//   GUARDED CLEANUP, CANONICAL ACCOUNTING (E3). Past the
//   deadline, cleanup runs under the same scope lock: it fences
//   on the grant marker (a foreign-owned scope is never touched),
//   forces the run's active leases into the past in one
//   transaction together with connector-disable + worker OFFLINE
//   + project PAUSED, then hands the leases to the engine's own
//   reclaimExpired() — the canonical expiry path that locks task
//   rows, settles HELD reservations to EXPIRED under their state
//   guard, transitions tasks (BLOCKED for this run's
//   maxRetry-0 task, so nothing stays runnable), and releases
//   capacity through the canonical trigger. A concurrent result
//   and cleanup therefore serialize on the task row: whichever
//   settles first wins, and the other observes the terminal
//   state. The QUALIFICATION_LEASE_NEUTRALIZED event is written
//   under the SAME scope lock as every other phase, behind a
//   durable NOT EXISTS guard, with the run-ownership fence
//   re-checked before each phase — so concurrent, repeated, or
//   crash-resumed cleanups emit it exactly once and never touch
//   a scope that changed hands (F4).
//   CAPS ARE THE OWNER'S NUMBERS, EXACTLY (D3): project
//   resource_policy quotaCap = 1, worker quota_remaining = 1,
//   quota_reserve = 0 — the one task's estimate.
//
// Hard bounds, unchanged: DEFAULT DISABLED (all of
// AGY_QUALIFICATION_ENABLED=true, AGY_STAGE_ONLY=true, an
// owner-issued run id, an ABSOLUTE owner deadline, and
// AGY_QUALIFICATION_CAP_ONLY_APPROVED=true must hold); scope,
// project, mission, worker, adapter, connector and reply target
// are FIXED CONSTANTS; every statement is scope-WHERE'd or keyed
// to the one qualification worker_id, so business rows are
// unreachable. Any failure stops the controller BLOCKED with
// needs_owner_repair instead of looping.

export const QUALIFICATION_SCOPE: ProjectScope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_QUALIFICATION' };
export const QUALIFICATION_MISSION = 'GL_QUALIFICATION';
export const QUALIFICATION_WORKER_ID = 'MUSE-QUAL-WORKER';
const QUAL_CONNECTOR_ID = 'muse-qual-x';
const QUAL_ADAPTER = 'muse-qual';
const QUAL_REPLY_TARGET = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const QUAL_PERMISSIONS = ['read', 'analyze', 'planning', 'qa'];
const QUAL_RESOURCE_POLICY = { maxConcurrentTasks: 1, quotaCap: 1, spendCap: 0, reservation: 0 };
const QUAL_WORKER_METADATA = {
  bindings: { missions: [QUALIFICATION_MISSION], task_types: ['planning'], reply_targets: [QUAL_REPLY_TARGET] },
  qualification: 'UNVERIFIED', evidence: 'none', external_namespace_only: true,
};
// ONE coordination key for the whole scope, independent of run
// id. It is DERIVED from the scope triple — not hard-coded — so
// the worker surface derives the identical key from its request
// scope and its arrival takes the same lock (L1): one
// coordinator lock shared by prepare, cleanup and arrival.
const SCOPE_LOCK_KEY = `agy:scope:${QUALIFICATION_SCOPE.tenantId}/${QUALIFICATION_SCOPE.workspaceId}/${QUALIFICATION_SCOPE.projectId}`;

export interface QualificationConfig {
  enabled: boolean;
  runId?: string;
  expiresAtMs?: number;
  intervalMs?: number;
}

export type QualificationState = 'DISABLED' | 'RUNNING' | 'ACTIVE' | 'STOPPED' | 'ROLLED_BACK' | 'BLOCKED';

interface RunMarker { run_id: string; expires_at: string; granted_at: string; phase: 'PREPARING' | 'GRANTED' }

type Querier = { query: (sql: string, params?: unknown[]) => Promise<any> };

export function parseQualificationConfig(env: Record<string, string | undefined>): { config: QualificationConfig; reason?: string } {
  if (env.AGY_QUALIFICATION_ENABLED !== 'true') return { config: { enabled: false }, reason: 'NOT_ENABLED' };
  if (env.AGY_STAGE_ONLY !== 'true') return { config: { enabled: false }, reason: 'STAGE_ONLY_REQUIRED' };
  const runId = (env.AGY_QUALIFICATION_RUN_ID ?? '').trim();
  if (!runId) return { config: { enabled: false }, reason: 'RUN_ID_REQUIRED' };
  const expiresRaw = (env.AGY_QUALIFICATION_EXPIRES_AT ?? '').trim();
  if (!expiresRaw) return { config: { enabled: false }, reason: 'EXPIRES_AT_REQUIRED' };
  const expiresAtMs = Date.parse(expiresRaw);
  if (!Number.isFinite(expiresAtMs)) return { config: { enabled: false }, reason: 'EXPIRES_AT_INVALID' };
  if (env.AGY_QUALIFICATION_CAP_ONLY_APPROVED !== 'true') return { config: { enabled: false }, reason: 'CAP_ONLY_APPROVAL_REQUIRED' };
  const num = (v: string | undefined, dflt: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : dflt; };
  return { config: { enabled: true, runId, expiresAtMs, intervalMs: num(env.AGY_QUALIFICATION_INTERVAL_MS, 30_000) } };
}

export function createQualificationController(raw: Pool, opts: {
  config: QualificationConfig;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}) {
  const cfg = opts.config;
  const log = opts.log ?? ((event: string, detail?: Record<string, unknown>) =>
    console.log(JSON.stringify({ event, ...(detail ?? {}) })));
  let state: QualificationState = 'DISABLED';
  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  let blockReason: string | undefined;
  // In-process server-side identity for ProjectService scope checks.
  // It is a scope object, not a credential: no token exists or moves.
  const principal: Principal = { subject: 'qualification-controller', role: 'operator', scopes: [QUALIFICATION_SCOPE] };
  const scopedPool = () => new ProjectPool(raw, QUALIFICATION_SCOPE, 'qualification-controller').asPool();
  const expiresIso = () => new Date(cfg.expiresAtMs ?? 0).toISOString();
  const pastDeadline = () => Date.now() > (cfg.expiresAtMs ?? 0);

  // One scoped transaction under the fixed scope advisory lock.
  // Every controller for this scope — any run id, prepare or
  // cleanup — serializes here; the lock is transaction-scoped, so
  // a crash releases it with the transaction.
  async function withScopeTx<T>(fn: (client: PoolClient) => Promise<T>, takeLock = true): Promise<T> {
    const client = await new ProjectPool(raw, QUALIFICATION_SCOPE, 'qualification-controller').connect();
    try {
      await client.query('BEGIN');
      // takeLock=false is for cleanup's phases 1/3 only: cleanup
      // already holds this same key at SESSION level on its own
      // connection for the whole cleanup (L1), and a second
      // session asking for it would block on the first.
      if (takeLock) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [SCOPE_LOCK_KEY]);
      const r = await fn(client as unknown as PoolClient);
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  async function readProject(q: Querier) {
    // The scoped pool's RLS makes only the qualification row visible.
    return (await q.query(`SELECT policies, status FROM agy_projects`)).rows[0];
  }
  async function readProjectLocked(q: Querier) {
    // The same read, but locking: cleanup phase 1 takes the
    // project row lock FIRST, before any write (L1). Arrival's
    // transaction also takes the project row first
    // (project → connector → worker), so the two always contend
    // on one identical first lock and can never form the cycle
    // this ordering previously allowed — arrival holding the
    // project row while waiting on the connector, cleanup
    // holding connector/worker while its final project UPDATE
    // waited on arrival — which PostgreSQL resolves by aborting
    // ONE side, possibly cleanup itself (its controller would
    // then stop BLOCKED with cleanup unfinished). Lock ORDER,
    // not victim selection, is what removes the cycle.
    // The lock mode is FOR NO KEY UPDATE, matching arrival:
    // every scoped child table carries a composite FK to
    // agy_projects (migration 004), so canonical transactions
    // (workerResult, reclaimExpired) INSERT children needing a
    // KEY SHARE on this parent row — compatible with NO KEY
    // UPDATE, conflicting with FOR UPDATE. Qualification never
    // changes project key columns, and NO KEY UPDATE still
    // excludes every non-key writer (owner pause/policy writes
    // included), so the ownership check below reads a locked
    // row exactly as before.
    return (await q.query(`SELECT policies, status FROM agy_projects FOR NO KEY UPDATE`)).rows[0];
  }
  const markerOf = (proj: any): RunMarker | null =>
    (proj?.policies && typeof proj.policies === 'object' && proj.policies.qualificationRun) || null;
  async function findRunJob(q: Querier) {
    return (await q.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [cfg.runId])).rows[0];
  }

  // R1 — sanitized evidence snapshot (READ-ONLY). ControlPlane
  // has no executable readback into D049: the callback lookup
  // route needs the server-side operator token (which never
  // leaves the server), the worker readback is the worker
  // reporting on itself with its own token and carries no
  // receipt/reservation/checkpoint rows, and /health carries no
  // run evidence. So the controller — which already logs its
  // lifecycle to stdout, a channel ControlPlane reads via
  // Railway logs — additionally emits ONE whitelist-only
  // snapshot line per state change of the run's evidence tuple:
  // after the grant, whenever the observed tuple changes while
  // ACTIVE, and once after cleanup completes (the post-deadline
  // read below is a pure SELECT, deliberately unfenced like
  // readback). Only this run's job/task are read (the job is
  // found by the run's idempotency key; the scope's RLS binds
  // every read to the qualification project — no business
  // project is ever touched). Secrets are never emitted: the
  // lease is represented only by a truncated SHA-256
  // fingerprint, and the reservation by the fingerprint of its
  // id (the reservation id IS the lease token in the canonical
  // store, so it is hashed the same way). Result/customer
  // payloads, freeform error text and credentials are excluded
  // by construction — the tuple is built field by field. The
  // snapshot states facts only; it never asserts a verdict.
  const fpOf = (secret: unknown): string | null =>
    typeof secret === 'string' && secret
      ? createHash('sha256').update(secret).digest('hex').slice(0, 16)
      : null;
  let lastEvidenceKey: string | null = null;
  async function readEvidence(): Promise<Record<string, unknown> | null> {
    const pool = scopedPool();
    const proj = await readProject(pool);
    const marker = markerOf(proj);
    if (!marker || marker.run_id !== cfg.runId) return null;
    const job = (await pool.query(
      `SELECT job_id, status FROM agy_jobs WHERE idempotency_key=$1`, [cfg.runId])).rows[0] ?? null;
    let task: any = null; let taskCount = 0;
    let reservation: Record<string, unknown> | null = null;
    let checkpoint: Record<string, unknown> | null = null;
    let callback: Record<string, unknown> | null = null;
    let receipt: Record<string, unknown> | null = null;
    const byType: Record<string, number> = {}; let eventTotal = 0;
    if (job) {
      taskCount = await countTasks(pool, job.job_id);
      task = (await pool.query(
        `SELECT task_id, status, attempt, lease_token FROM agy_tasks
          WHERE job_id=$1 ORDER BY created_at, task_id LIMIT 1`, [job.job_id])).rows[0] ?? null;
    }
    if (task) {
      const res = (await pool.query(
        `SELECT reservation_id, state FROM agy_resource_reservations
          WHERE task_id=$1 ORDER BY reservation_id LIMIT 1`, [task.task_id])).rows[0];
      if (res) reservation = { state: res.state, fp: fpOf(res.reservation_id) };
      const cp = (await pool.query(
        `SELECT version, context_digest FROM agy_checkpoints
          WHERE task_id=$1 ORDER BY version DESC LIMIT 1`, [task.task_id])).rows[0];
      if (cp) checkpoint = { version: Number(cp.version), context_digest: cp.context_digest };
      const cb = (await pool.query(
        `SELECT callback_id, status, attempt, content_digest FROM agy_worker_callbacks
          WHERE task_id=$1 ORDER BY created_at DESC, callback_id LIMIT 1`, [task.task_id])).rows[0];
      if (cb) {
        callback = { callback_id: cb.callback_id, status: cb.status,
          attempt: Number(cb.attempt), content_digest: cb.content_digest };
        const rc = (await pool.query(
          `SELECT callback_id, effect_count, received_at, content_digest
             FROM agy_callback_receipts WHERE callback_id=$1`, [cb.callback_id])).rows[0];
        if (rc) receipt = { callback_id: rc.callback_id, effect_count: Number(rc.effect_count),
          received_at: rc.received_at, content_digest: rc.content_digest };
      }
      for (const e of (await pool.query(
        `SELECT event_type, count(*)::int AS n FROM agy_task_events
          WHERE task_id=$1 GROUP BY event_type ORDER BY event_type`, [task.task_id])).rows) {
        byType[String(e.event_type)] = Number(e.n); eventTotal += Number(e.n);
      }
    }
    const worker = (await pool.query(
      `SELECT status, active_count, quota_remaining FROM agy_workers WHERE worker_id=$1`,
      [QUALIFICATION_WORKER_ID])).rows[0];
    return {
      run_id: cfg.runId,
      scope: 'gl/legacy-workspace/GL_QUALIFICATION',
      worker_id: QUALIFICATION_WORKER_ID,
      marker_phase: marker.phase ?? null,
      project_status: proj?.status ?? null,
      job: job ? { job_id: job.job_id, status: job.status } : null,
      task_count: taskCount,
      task: task ? { task_id: task.task_id, status: task.status,
        attempt: Number(task.attempt), lease_fp: fpOf(task.lease_token) } : null,
      reservation, checkpoint, callback, receipt,
      events: { total: eventTotal, by_type: byType },
      capacity: worker ? { worker_status: worker.status, active_count: Number(worker.active_count),
        quota_remaining: worker.quota_remaining === null ? null : Number(worker.quota_remaining) } : null,
    };
  }
  async function emitEvidence(reason: 'GRANTED' | 'STATE_CHANGE' | 'ROLLED_BACK'): Promise<void> {
    try {
      const snap = await readEvidence();
      if (!snap) return;
      const key = JSON.stringify(snap);
      if (reason === 'STATE_CHANGE' && key === lastEvidenceKey) return;
      lastEvidenceKey = key;
      log('QUALIFICATION_EVIDENCE_SNAPSHOT', { reason, ...snap });
    } catch { /* observational only: a failed evidence read never blocks the run */ }
  }
  async function countTasks(q: Querier, jobId: string): Promise<number> {
    return (await q.query(`SELECT count(*)::int AS n FROM agy_tasks WHERE job_id=$1`, [jobId])).rows[0].n;
  }

  async function insertWorker(q: Querier): Promise<void> {
    await q.query(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES($1,$2,ARRAY['planning'],'OFFLINE',1,'{"spendCap":0,"quotaCap":null}',null,0,false,$3) ON CONFLICT (worker_id) DO NOTHING`,
      [QUALIFICATION_WORKER_ID, QUAL_ADAPTER, JSON.stringify(QUAL_WORKER_METADATA)]);
  }
  async function insertConnector(q: Querier): Promise<void> {
    await q.query(`INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
      VALUES($1,$2,$3,$4,$5,ARRAY['planning'],'local','vault:custom.agy-worker',true,$6) ON CONFLICT DO NOTHING`,
      [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId,
       QUAL_CONNECTOR_ID, QUAL_ADAPTER, QUAL_PERMISSIONS]);
  }
  async function transition(q: Querier): Promise<void> {
    // Cap-only window transition, CAS-shaped: quota is filled ONLY
    // from NULL (the dormant/rolled-back state). A consumed cap (0)
    // or an existing cap (1) is never rewritten by this statement,
    // so no path here can refill the owner's cap after a claim.
    await q.query(`UPDATE agy_workers SET status='READY', quota_remaining=1, quota_reserve=0
      WHERE worker_id=$1 AND quota_remaining IS NULL`, [QUALIFICATION_WORKER_ID]);
  }

  async function ensureJob(): Promise<void> {
    const service = new ProjectService(raw, QUALIFICATION_SCOPE, principal);
    await service.execute('/jobs', 'POST', {
      idempotency_key: cfg.runId, objective: `GL qualification run ${cfg.runId}`, pass_threshold: 0,
      deadline_ms: cfg.expiresAtMs,
      tasks: [{ name: 'qualification', idempotencyKey: `${cfg.runId}-task`,
        taskType: 'planning', requiredCapabilities: ['planning'], requiredPermissions: ['planning'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 10,
        payload: { mission_id: QUALIFICATION_MISSION, target_worker_id: QUALIFICATION_WORKER_ID, callback_target: QUAL_REPLY_TARGET } }],
    });
  }

  // Transaction-wide deadline fence (H1): thrown inside a
  // prepare transaction when its FINAL clock read — taken after
  // every write is staged, immediately before the transaction
  // would commit — shows the cutoff has passed. withScopeTx
  // rolls the whole transaction back, so no grant write, marker
  // flip, lease, or counter can commit late even when a write
  // waited on a row or trigger lock across the deadline.
  // prepareOnce maps it to 'EXPIRED'. Cleanup deliberately has
  // NO such fence: it runs BECAUSE the deadline passed.
  const DEADLINE_CROSSED = 'QUALIFICATION_DEADLINE_CROSSED';
  async function fenceBeforeCommit(client: PoolClient): Promise<void> {
    const now = (await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now;
    if (new Date(now).getTime() >= (cfg.expiresAtMs ?? 0)) throw new Error(DEADLINE_CROSSED);
  }

  // Returns 'GRANTED' | 'ALREADY' | 'BLOCKED' | 'EXPIRED'.
  async function prepareOnce(): Promise<string> {
    // Phase A — registry + marker(PREPARING) + transition, ONE
    // transaction under the scope lock, deadline re-checked after
    // the lock is held (E2: the lock wait itself may cross it),
    // and fenced again immediately before commit (H1).
    let phaseA: string;
    try {
      phaseA = await withScopeTx(async (client) => {
      if (pastDeadline()) return 'EXPIRED';
      const proj = await readProject(client);
      const marker = markerOf(proj);
      if (marker && marker.run_id !== cfg.runId) { blockReason = 'PREVIOUS_RUN_GRANT_PRESENT'; return 'BLOCKED'; }
      if (marker && marker.expires_at !== expiresIso()) { blockReason = 'RUN_ID_REUSED_WITH_DIFFERENT_DEADLINE'; return 'BLOCKED'; }
      if (marker?.phase === 'GRANTED') {
        // Monitor path — with revalidation (E1): a GRANTED grant
        // whose job vanished is an inconsistency, not a repair job.
        const job = await findRunJob(client);
        if (!job) { blockReason = 'GRANT_JOB_MISSING'; return 'BLOCKED'; }
        if ((await countTasks(client, job.job_id)) !== 1) { blockReason = 'RUN_JOB_TASK_COUNT_INVALID'; return 'BLOCKED'; }
        return 'ALREADY';
      }
      // Fail closed on history this run does not own (D2).
      const jobs = (await client.query(`SELECT job_id, idempotency_key FROM agy_jobs ORDER BY created_at`)).rows;
      if (jobs.some((j: any) => j.idempotency_key !== cfg.runId)) { blockReason = 'FOREIGN_JOB_IN_SCOPE'; return 'BLOCKED'; }
      if (jobs.length > 1) { blockReason = 'MULTIPLE_JOBS_FOR_RUN'; return 'BLOCKED'; }
      if (jobs.length === 1 && (await countTasks(client, jobs[0].job_id)) !== 1) { blockReason = 'RUN_JOB_TASK_COUNT_INVALID'; return 'BLOCKED'; }
      if (marker) {
        // PREPARING recovery (F3): phase A is atomic, so a durable
        // PREPARING marker means registry + transition ALREADY
        // committed together. Recovery therefore validates the
        // persisted state and resumes ONLY the missing job/phase —
        // it never rewrites project status/permissions/policy,
        // connector, or worker state, because any deviation from
        // the exact post-phase-A shape (project ACTIVE, connector
        // enabled, worker READY with the granted quota 1) can only
        // be a later owner change, and owner changes stand:
        // anything else BLOCKS with zero writes.
        if (proj.status !== 'ACTIVE') { blockReason = 'PREPARING_OWNER_INTERVENED'; return 'BLOCKED'; }
        const worker = (await client.query(`SELECT status, quota_remaining FROM agy_workers WHERE worker_id=$1`, [QUALIFICATION_WORKER_ID])).rows[0];
        if (!worker || worker.status !== 'READY' || Number(worker.quota_remaining) !== 1) { blockReason = 'PREPARING_OWNER_INTERVENED'; return 'BLOCKED'; }
        const conn = (await client.query(`SELECT enabled FROM agy_connectors WHERE connector_id=$1`, [QUAL_CONNECTOR_ID])).rows[0];
        if (!conn || !conn.enabled) { blockReason = 'PREPARING_OWNER_INTERVENED'; return 'BLOCKED'; }
        return 'PREPARED';
      }
      const worker = (await client.query(`SELECT quota_remaining FROM agy_workers WHERE worker_id=$1`, [QUALIFICATION_WORKER_ID])).rows[0];
      if (worker && worker.quota_remaining !== null) { blockReason = 'WORKER_CAP_WITHOUT_GRANT'; return 'BLOCKED'; }
      // Real-clock fence inside the transaction, after every read
      // and lock wait, immediately before the grant writes: the
      // database wall clock (clock_timestamp), not the
      // transaction-start time and not a pre-lock JS check (F2).
      const dbNow = (await client.query(`SELECT clock_timestamp() AS now`)).rows[0].now;
      if (new Date(dbNow).getTime() >= (cfg.expiresAtMs ?? 0)) return 'EXPIRED';
      const grant: RunMarker = { run_id: cfg.runId!, expires_at: expiresIso(),
        granted_at: new Date().toISOString(), phase: 'PREPARING' };
      await client.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref)
        VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING`,
        [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId]);
      await client.query(`UPDATE agy_projects SET status='ACTIVE', priority=10, permissions=$4, resource_policy=$5,
          policies = COALESCE(policies,'{}'::jsonb) || $6::jsonb
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,
        [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId,
         QUAL_PERMISSIONS, JSON.stringify(QUAL_RESOURCE_POLICY), JSON.stringify({ qualificationRun: grant })]);
      await insertConnector(client);
      await insertWorker(client);
      await transition(client);
      // Final fence (H1): the writes above may have waited on row
      // or trigger locks across the cutoff; if the clock read
      // taken now — after all of them — shows it passed, the
      // whole grant rolls back instead of committing late.
      await fenceBeforeCommit(client);
      return 'PREPARED';
      });
    } catch (e: any) {
      if (e?.message === DEADLINE_CROSSED) return 'EXPIRED';
      throw e;
    }
    if (phaseA !== 'PREPARED') return phaseA;
    // Phase B — the run's one job (conflict-idempotent). A second
    // deadline check: phase A + the lock wait may have crossed it;
    // creating a job after the cutoff is exactly what E2 forbids.
    // (The PREPARING marker stays durable; cleanup owns the scope
    // from here and the job simply never exists.)
    if (pastDeadline()) return 'EXPIRED';
    try {
      await ensureJob();
    } catch (e: any) {
      // The store fences job creation at its own transaction
      // (start + pre-commit clock checks): a creation that crossed
      // the deadline was rolled back there, so the run simply
      // expires — the PREPARING marker stays durable and cleanup
      // owns the scope (F2).
      if (e?.message === 'JOB_CREATION_DEADLINE_EXCEEDED') return 'EXPIRED';
      throw e;
    }
    // Phase C — flip PREPARING → GRANTED in a second locked
    // transaction, revalidating marker + job + deadline (E1/E2),
    // with the same final fence as phase A (H1): the flip UPDATE
    // itself may wait on the project row across the cutoff.
    try {
      return await withScopeTx(async (client) => {
        if (pastDeadline()) return 'EXPIRED';
        const marker = markerOf(await readProject(client));
        if (!marker || marker.run_id !== cfg.runId) { blockReason = 'GRANT_MARKER_LOST'; return 'BLOCKED'; }
        if (marker.phase === 'GRANTED') return 'ALREADY';
        const job = await findRunJob(client);
        if (!job) { blockReason = 'GRANT_JOB_MISSING'; return 'BLOCKED'; }
        if ((await countTasks(client, job.job_id)) !== 1) { blockReason = 'RUN_JOB_TASK_COUNT_INVALID'; return 'BLOCKED'; }
        const granted: RunMarker = { ...marker, phase: 'GRANTED' };
        await client.query(`UPDATE agy_projects SET policies = COALESCE(policies,'{}'::jsonb) || $4::jsonb
          WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,
          [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId,
           JSON.stringify({ qualificationRun: granted })]);
        await fenceBeforeCommit(client);
        log('QUALIFICATION_GRANTED', { runId: cfg.runId, expiresAt: expiresIso(), scope: 'gl/legacy-workspace/GL_QUALIFICATION', workerId: QUALIFICATION_WORKER_ID });
        return 'GRANTED';
      });
    } catch (e: any) {
      if (e?.message === DEADLINE_CROSSED) return 'EXPIRED';
      throw e;
    }
  }

  // Guarded cleanup past the deadline. Returns 'DONE' | 'FOREIGN'.
  async function cleanup(): Promise<string> {
    // The WHOLE cleanup — all three phases — runs under the
    // scope coordination lock, held at SESSION level on a
    // dedicated connection for the cleanup's duration (L1).
    // Phase 2's canonical reclaimExpired opens its OWN
    // transaction, so no transaction-level lock taken inside
    // phases 1/3 can cover it; and arrival takes the same key
    // (transaction-level, as its first statement), so arrival
    // can never be mid-transaction while any cleanup phase
    // runs. Without this, arrival could hold the project row
    // and queue on the worker row while reclaim held every
    // worker row and its health insert queued behind arrival's
    // pending lock — a deadlock PostgreSQL resolves only by
    // aborting one side (a cleanup victim would leave this
    // controller BLOCKED with cleanup unfinished, its timer
    // stopped). Phases 1/3 run their withScopeTx WITHOUT
    // re-taking the lock (takeLock=false): this session already
    // holds it, and another session asking for the same key
    // would block on it. Concurrent cleanups and prepares still
    // serialize on the same key, exactly as before — the lock
    // simply spans the whole cleanup now. Cleanup remains
    // deliberately unfenced by the deadline throughout: it runs
    // BECAUSE the deadline passed.
    const lockClient = await scopedPool().connect();
    try {
      await lockClient.query(`SELECT pg_advisory_lock(hashtext($1))`, [SCOPE_LOCK_KEY]);
      return await cleanupLocked();
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [SCOPE_LOCK_KEY]).catch(() => {});
      lockClient.release();
    }
  }

  async function cleanupLocked(): Promise<string> {
    // Phase 1 — one locked transaction: ownership fence, lease
    // force-expiry, dormant state. The FIRST row lock taken is
    // the project row (readProjectLocked), before the task,
    // connector and worker writes — the same first row lock
    // arrival takes (L1), so even at row level the two
    // transactions contend on one identical first lock.
    // Forcing the lease into the past
    // (rather than settling anything here) hands the lease to the
    // canonical path below: a concurrent result either already
    // settled the task (its status no longer matches, so the force
    // is a no-op) or will read an expired lease under its row lock.
    const phase1 = await withScopeTx(async (client) => {
      const marker = markerOf(await readProjectLocked(client));
      if (marker && marker.run_id !== cfg.runId) return { kind: 'FOREIGN' as const, candidates: [] as string[] };
      const job = await findRunJob(client);
      let candidates: string[] = [];
      if (job) {
        candidates = (await client.query(
          `SELECT task_id FROM agy_tasks WHERE job_id=$1 AND status IN ('CLAIMED','RUNNING')`, [job.job_id])).rows.map((r: any) => r.task_id);
        if (candidates.length) {
          await client.query(
            `UPDATE agy_tasks SET lease_expires_at = LEAST(lease_expires_at, now() - interval '1 second')
             WHERE job_id=$1 AND status IN ('CLAIMED','RUNNING') AND lease_token IS NOT NULL`, [job.job_id]);
        }
      }
      await client.query(`UPDATE agy_connectors SET enabled=false
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND connector_id=$4`,
        [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId, QUAL_CONNECTOR_ID]);
      await client.query(`UPDATE agy_workers SET status='OFFLINE', quota_remaining=null WHERE worker_id=$1`,
        [QUALIFICATION_WORKER_ID]);
      await client.query(`UPDATE agy_projects SET status='PAUSED', priority=0
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,
        [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId]);
      return { kind: 'DONE' as const, candidates };
    }, false);
    if (phase1.kind === 'FOREIGN') return 'FOREIGN';
    // Ownership is re-verified before EVERY later phase (F4): the
    // marker is re-read, and a scope that changed hands after
    // phase 1 is never settled or written by this run.
    const preMarker = markerOf(await readProject(scopedPool()));
    if (preMarker && preMarker.run_id !== cfg.runId) return 'FOREIGN';
    // Phase 2 — canonical expiry accounting (the engine's own
    // reclaimExpired: task row locks, HELD→EXPIRED reservation
    // settle under its state guard, task transition, capacity
    // release trigger, job aggregation). Exactly-once by the
    // store's own fences; a repeated pass changes nothing.
    const store = new PostgresStore(scopedPool(), QUALIFICATION_SCOPE);
    await store.reclaimExpired();
    // Phase 3 — the neutralization event, exactly once. The write
    // runs under the SAME fixed scope lock as every other phase
    // (F4): concurrent cleanups serialize here, so the durable
    // NOT EXISTS guard below is now race-free rather than merely
    // optimistic, and a crash-resumed cleanup backfills the event
    // if — and only if — it is still missing. The ownership fence
    // is re-checked inside the lock before any insert.
    const phase3 = await withScopeTx(async (client) => {
      const marker = markerOf(await readProject(client));
      if (marker && marker.run_id !== cfg.runId) return 'FOREIGN';
      const job = await findRunJob(client);
      if (job) {
        const rows = (await client.query(
          `SELECT task_id, status FROM agy_tasks WHERE job_id=$1
             AND status IN ('BLOCKED','RETRY') AND error->>'code'='LEASE_EXPIRED'`, [job.job_id])).rows;
        for (const t of rows) {
          await client.query(
            `INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail)
             SELECT $1,$2,'QUALIFICATION_LEASE_NEUTRALIZED',$3,$4,$5
             WHERE NOT EXISTS (SELECT 1 FROM agy_task_events WHERE task_id=$2 AND event_type='QUALIFICATION_LEASE_NEUTRALIZED')`,
            [job.job_id, t.task_id, t.status, QUALIFICATION_WORKER_ID, JSON.stringify({ run_id: cfg.runId })]);
        }
      }
      return 'DONE';
    }, false);
    return phase3 === 'FOREIGN' ? 'FOREIGN' : 'DONE';
  }

  async function doCleanup(): Promise<void> {
    const r = await cleanup();
    if (timer) { clearInterval(timer); timer = undefined; }
    if (r === 'FOREIGN') {
      state = 'BLOCKED';
      log('QUALIFICATION_CONTROLLER_BLOCKED', { runId: cfg.runId, needs_owner_repair: true, reason: 'SCOPE_OWNED_BY_ANOTHER_RUN' });
    } else {
      state = 'ROLLED_BACK';
      log('QUALIFICATION_ROLLED_BACK', { runId: cfg.runId });
      // Final evidence snapshot (R1): read AFTER cleanup, past
      // the deadline on purpose — a pure scoped SELECT, so the
      // rolled-back state (capacity, settlement, neutralization
      // event count) stays observable. A FOREIGN scope is never
      // snapshotted: its rows are another run's.
      await emitEvidence('ROLLED_BACK');
    }
  }

  async function tick(): Promise<void> {
    if (ticking || state === 'DISABLED' || state === 'BLOCKED' || state === 'ROLLED_BACK') return;
    ticking = true;
    try {
      if (pastDeadline()) { await doCleanup(); return; }
      const r = await prepareOnce();
      if (r === 'EXPIRED') { await doCleanup(); return; }
      if (r === 'BLOCKED') {
        state = 'BLOCKED';
        if (timer) { clearInterval(timer); timer = undefined; }
        log('QUALIFICATION_CONTROLLER_BLOCKED', { runId: cfg.runId, needs_owner_repair: true, reason: blockReason });
        return;
      }
      // R1 evidence: one snapshot at the grant, then one per
      // observed change of the run's evidence tuple while
      // ACTIVE (emitEvidence dedupes unchanged tuples itself).
      if (r === 'PREPARED' || r === 'GRANTED') await emitEvidence('GRANTED');
      else if (r === 'ALREADY') await emitEvidence('STATE_CHANGE');
      state = 'ACTIVE';
    } catch (e: any) {
      state = 'BLOCKED';
      if (timer) { clearInterval(timer); timer = undefined; }
      log('QUALIFICATION_CONTROLLER_BLOCKED', { runId: cfg.runId, needs_owner_repair: true,
        error: String(e?.message ?? e).slice(0, 200) });
    } finally { ticking = false; }
  }

  function start(): QualificationState {
    if (!cfg.enabled || !cfg.runId || !cfg.expiresAtMs) { state = 'DISABLED'; return state; }
    if (state === 'RUNNING' || state === 'ACTIVE') return state;
    state = 'RUNNING';
    log('QUALIFICATION_CONTROLLER_STARTED', { runId: cfg.runId, expiresAt: expiresIso() });
    void tick();
    timer = setInterval(() => { void tick(); }, Math.max(25, cfg.intervalMs ?? 30_000));
    timer.unref?.();
    return state;
  }

  function stop(): QualificationState {
    if (timer) { clearInterval(timer); timer = undefined; }
    if (state === 'RUNNING' || state === 'ACTIVE') state = 'STOPPED';
    return state;
  }

  return { start, stop, tick, state: () => state };
}
