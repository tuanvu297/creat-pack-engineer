import type { Pool } from "pg";
import { ProjectPool } from "./scoped-pool.js";
import { type ProjectScope } from "./scope.js";
import { ProjectService } from "./service.js";
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
// Lifecycle (revised per QA findings D1–D3 on the v9 draft, which
// re-applied the whole registry every tick):
//   D1 ONE-SHOT GRANT. The prepare runs at most once per
//      (run id, deadline): a session advisory lock keyed by the
//      run id serializes concurrent controllers, and a grant
//      marker {run_id, expires_at, granted_at} is written into the
//      qualification project's policies in the step that opens the
//      window. After the marker matches this run, ticks are
//      MONITOR-ONLY — they never re-apply the registry, never
//      refill quota, and never re-enable a project or worker the
//      owner has since paused or offlined. The worker transition
//      itself is CAS-shaped: quota is filled only from NULL, so
//      even a repeated transition cannot refill a consumed cap.
//      The only completion a monitor may perform is creating the
//      run's job when a crash between the marker write and the
//      job creation left it absent — job creation is
//      conflict-idempotent and touches no counters.
//   D2 RUN OWNERSHIP, FAIL-CLOSED. Before granting, the
//      controller checks the persisted state: a previous run's
//      grant marker, ANY job whose idempotency key is not this
//      run's, more than this run's one job / one task, or a
//      qualification worker left READY (or holding quota) without
//      this run's grant — each blocks the controller (BLOCKED +
//      needs_owner_repair) instead of opening a second window on
//      top of history it does not own. A new run therefore needs
//      the owner to clear the scope first; that is the exact
//      dependency, stated rather than papered over.
//      Cleanup past the deadline NEUTRALIZES the run's known
//      active lease: lease_expires_at is forced into the past and
//      the HELD reservation is settled to EXPIRED under its
//      state='HELD' guard (the store's own exactly-once pattern),
//      with a QUALIFICATION_LEASE_NEUTRALIZED event written only
//      when a row actually changed — a second cleanup changes
//      nothing. The qualification connector is disabled in the
//      same pass. Project PAUSED + worker OFFLINE alone would NOT
//      be sufficient: the worker surface fences mutations on the
//      lease, not on project/worker status. Complementing this,
//      the worker surface caps claim/heartbeat lease seconds for
//      this scope at the owner deadline (wired in server.ts), so
//      no lease issued inside the window can outlive it even if
//      the service is down at the deadline and returns later.
//   D3 CAPS ARE THE OWNER'S NUMBERS, EXACTLY. Project
//      resource_policy quotaCap = 1, worker quota_remaining = 1,
//      quota_reserve = 0 — the one task's estimate. (v9 shipped
//      quotaCap 100 in the resource policy; corrected here, in
//      the registry SQL, the fixtures, and the plan.)
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

export interface QualificationConfig {
  enabled: boolean;
  runId?: string;
  expiresAtMs?: number;
  intervalMs?: number;
}

export type QualificationState = 'DISABLED' | 'RUNNING' | 'ACTIVE' | 'STOPPED' | 'ROLLED_BACK' | 'BLOCKED';

interface RunMarker { run_id: string; expires_at: string; granted_at: string }

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

  async function readProject(p: { query: (sql: string, params?: unknown[]) => Promise<any> }) {
    // The scoped pool's RLS makes only the qualification row visible.
    return (await p.query(`SELECT policies, status FROM agy_projects`)).rows[0];
  }
  const markerOf = (proj: any): RunMarker | null =>
    (proj?.policies && typeof proj.policies === 'object' && proj.policies.qualificationRun) || null;
  async function findRunJob(p: { query: (sql: string, params?: unknown[]) => Promise<any> }) {
    return (await p.query(`SELECT job_id FROM agy_jobs WHERE idempotency_key=$1`, [cfg.runId])).rows[0];
  }

  async function insertWorker(p: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<void> {
    await p.query(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES($1,$2,ARRAY['planning'],'OFFLINE',1,'{"spendCap":0,"quotaCap":null}',null,0,false,$3) ON CONFLICT (worker_id) DO NOTHING`,
      [QUALIFICATION_WORKER_ID, QUAL_ADAPTER, JSON.stringify(QUAL_WORKER_METADATA)]);
  }
  async function insertConnector(p: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<void> {
    await p.query(`INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
      VALUES($1,$2,$3,$4,$5,ARRAY['planning'],'local','vault:custom.agy-worker',true,$6) ON CONFLICT DO NOTHING`,
      [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId,
       QUAL_CONNECTOR_ID, QUAL_ADAPTER, QUAL_PERMISSIONS]);
  }

  async function transition(p: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<void> {
    // Cap-only window transition, CAS-shaped: quota is filled ONLY
    // from NULL (the dormant/rolled-back state). A consumed cap (0)
    // or an existing cap (1) is never rewritten by this statement,
    // so no path here can refill the owner's cap after a claim.
    await p.query(`UPDATE agy_workers SET status='READY', quota_remaining=1, quota_reserve=0
      WHERE worker_id=$1 AND quota_remaining IS NULL`, [QUALIFICATION_WORKER_ID]);
  }

  async function ensureJob(): Promise<void> {
    const service = new ProjectService(raw, QUALIFICATION_SCOPE, principal);
    await service.execute('/jobs', 'POST', {
      idempotency_key: cfg.runId, objective: `GL qualification run ${cfg.runId}`, pass_threshold: 0,
      tasks: [{ name: 'qualification', idempotencyKey: `${cfg.runId}-task`,
        taskType: 'planning', requiredCapabilities: ['planning'], requiredPermissions: ['planning'],
        permissionGranted: true, safetyApproved: true, estimatedQuota: 1, estimatedCost: 0, maxRetry: 0, priority: 10,
        payload: { mission_id: QUALIFICATION_MISSION, target_worker_id: QUALIFICATION_WORKER_ID, callback_target: QUAL_REPLY_TARGET } }],
    });
  }

  // Returns 'GRANTED' | 'ALREADY' | 'BLOCKED' (blockReason set).
  async function prepareOnce(p: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<string> {
    const client = await raw.connect();
    try {
      // Serialize concurrent controllers for this run: a second
      // instance waits here, then observes the durable marker and
      // becomes a monitor — it never re-applies the grant.
      await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [`agy:qualification:${cfg.runId}`]);
      const proj = await readProject(p);
      const marker = markerOf(proj);
      if (marker && marker.run_id === cfg.runId) {
        if (marker.expires_at !== expiresIso()) { blockReason = 'RUN_ID_REUSED_WITH_DIFFERENT_DEADLINE'; return 'BLOCKED'; }
        // Grant already durable → MONITOR. Complete only pieces a
        // crash mid-prepare left ABSENT (never overwrite state):
        const worker = (await p.query(`SELECT worker_id FROM agy_workers WHERE worker_id=$1`, [QUALIFICATION_WORKER_ID])).rows[0];
        if (!worker) { await insertWorker(p); await transition(p); }
        const conn = (await p.query(`SELECT connector_id FROM agy_connectors WHERE connector_id=$1`, [QUAL_CONNECTOR_ID])).rows[0];
        if (!conn) await insertConnector(p);
        if (!(await findRunJob(p))) await ensureJob();
        return 'ALREADY';
      }
      if (marker) { blockReason = 'PREVIOUS_RUN_GRANT_PRESENT'; return 'BLOCKED'; }
      // D2 preflight — fail closed on history this run does not own.
      const jobs = (await p.query(`SELECT job_id, idempotency_key FROM agy_jobs ORDER BY created_at`)).rows;
      if (jobs.some((j: any) => j.idempotency_key !== cfg.runId)) { blockReason = 'FOREIGN_JOB_IN_SCOPE'; return 'BLOCKED'; }
      if (jobs.length > 1) { blockReason = 'MULTIPLE_JOBS_FOR_RUN'; return 'BLOCKED'; }
      if (jobs.length === 1) {
        const n = (await p.query(`SELECT count(*)::int AS n FROM agy_tasks WHERE job_id=$1`, [jobs[0].job_id])).rows[0].n;
        if (n !== 1) { blockReason = 'RUN_JOB_TASK_COUNT_INVALID'; return 'BLOCKED'; }
      }
      const worker = (await p.query(`SELECT status, quota_remaining FROM agy_workers WHERE worker_id=$1`, [QUALIFICATION_WORKER_ID])).rows[0];
      if (worker && (worker.status === 'READY' || worker.quota_remaining !== null)) {
        blockReason = 'WORKER_ACTIVE_WITHOUT_GRANT'; return 'BLOCKED';
      }
      // The one-shot grant: registry rows, the grant marker, the
      // cap-only transition, and the run's one job.
      const grant: RunMarker = { run_id: cfg.runId!, expires_at: expiresIso(), granted_at: new Date().toISOString() };
      await p.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref)
        VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING`,
        [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId]);
      await p.query(`UPDATE agy_projects SET status='ACTIVE', priority=10, permissions=$4, resource_policy=$5,
          policies = COALESCE(policies,'{}'::jsonb) || $6::jsonb
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,
        [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId,
         QUAL_PERMISSIONS, JSON.stringify(QUAL_RESOURCE_POLICY), JSON.stringify({ qualificationRun: grant })]);
      await insertConnector(p);
      await insertWorker(p);
      await transition(p);
      if (!jobs.length) await ensureJob();
      log('QUALIFICATION_GRANTED', { runId: cfg.runId, expiresAt: expiresIso(), scope: 'gl/legacy-workspace/GL_QUALIFICATION', workerId: QUALIFICATION_WORKER_ID });
      return 'GRANTED';
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`agy:qualification:${cfg.runId}`]).catch(() => {});
      client.release();
    }
  }

  // Guarded cleanup past the deadline. Returns 'DONE' | 'FOREIGN'.
  async function cleanup(p: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<string> {
    const proj = await readProject(p);
    const marker = markerOf(proj);
    if (marker && marker.run_id !== cfg.runId) return 'FOREIGN';
    // Neutralize THIS run's known active lease(s): force the lease
    // into the past and settle the HELD reservation to EXPIRED
    // under its state guard — each row changes at most once, and
    // the event is written only when a row actually changed, so a
    // repeated cleanup is a no-op. Evidence rows are preserved.
    const job = await findRunJob(p);
    if (job) {
      const tasks = (await p.query(
        `SELECT task_id, status, lease_token FROM agy_tasks WHERE job_id=$1 AND status IN ('CLAIMED','RUNNING')`, [job.job_id])).rows;
      for (const t of tasks) {
        if (!t.lease_token) continue;
        const upd = await p.query(
          `UPDATE agy_tasks SET lease_expires_at = now() - interval '1 second' WHERE task_id=$1
             AND status IN ('CLAIMED','RUNNING')
             AND (lease_expires_at IS NULL OR lease_expires_at > now() - interval '1 second')`, [t.task_id]);
        const res = await p.query(
          `UPDATE agy_resource_reservations SET state='EXPIRED' WHERE reservation_id=$1 AND state='HELD'`, [t.lease_token]);
        if ((upd.rowCount ?? 0) > 0 || (res.rowCount ?? 0) > 0) {
          await p.query(
            `INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'QUALIFICATION_LEASE_NEUTRALIZED',$3,$4,$5)`,
            [job.job_id, t.task_id, t.status, QUALIFICATION_WORKER_ID, JSON.stringify({ run_id: cfg.runId })]);
        }
      }
    }
    await p.query(`UPDATE agy_connectors SET enabled=false
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND connector_id=$4`,
      [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId, QUAL_CONNECTOR_ID]);
    await p.query(`UPDATE agy_workers SET status='OFFLINE', quota_remaining=null WHERE worker_id=$1`,
      [QUALIFICATION_WORKER_ID]);
    await p.query(`UPDATE agy_projects SET status='PAUSED', priority=0
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,
      [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId]);
    return 'DONE';
  }

  async function tick(): Promise<void> {
    if (ticking || state === 'DISABLED' || state === 'BLOCKED' || state === 'ROLLED_BACK') return;
    ticking = true;
    try {
      const p = scopedPool();
      if (Date.now() > (cfg.expiresAtMs ?? 0)) {
        const r = await cleanup(p);
        if (timer) { clearInterval(timer); timer = undefined; }
        if (r === 'FOREIGN') {
          state = 'BLOCKED';
          log('QUALIFICATION_CONTROLLER_BLOCKED', { runId: cfg.runId, needs_owner_repair: true, reason: 'SCOPE_OWNED_BY_ANOTHER_RUN' });
        } else {
          state = 'ROLLED_BACK';
          log('QUALIFICATION_ROLLED_BACK', { runId: cfg.runId });
        }
        return;
      }
      const r = await prepareOnce(p);
      if (r === 'BLOCKED') {
        state = 'BLOCKED';
        if (timer) { clearInterval(timer); timer = undefined; }
        log('QUALIFICATION_CONTROLLER_BLOCKED', { runId: cfg.runId, needs_owner_repair: true, reason: blockReason });
        return;
      }
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
