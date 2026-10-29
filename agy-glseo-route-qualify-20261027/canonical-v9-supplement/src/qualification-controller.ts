import type { Pool } from "pg";
import { ProjectPool } from "./scoped-pool.js";
import { type ProjectScope } from "./scope.js";
import { ProjectService } from "./service.js";
import type { Principal } from "./auth.js";

// Qualification provisioning controller (candidate) — the missing
// executable lifecycle for the G2 window. Feasibility finding it is
// built on (verified by reading the pin): the DEPLOYED service
// (src/temporal/server.ts) exposes mission actions, worker routes
// and callback routes only — it constructs no ProjectService and has
// no /jobs route, and nothing anywhere in the service applies the
// qualification registry SQL or rolls the window back. The only
// existing executable provisioning entrypoint is the predeploy
// src/hosted/provision-cli.ts → provisionStaging(): it re-reads
// migrations/ sorted, SHA-tracks them, applies new ones (012
// included, once the file is in migrations/) and grants the runtime
// role — under the BOOTSTRAP connection, which never leaves the
// predeploy environment. This controller covers the DATA lifecycle
// (registry rows, window transition, the one job, rollback) from
// inside the canonical service, under the service's existing
// runtime DATABASE_URL role (provision grants that role
// SELECT/INSERT/UPDATE on all tables; scoped tables are RLS-bound
// to the fixed scope below). No new service, queue, credential, or
// operator token: the controller is server-side code acting in the
// fixed qualification scope only.
//
// Hard bounds, by construction:
//   * DEFAULT DISABLED. Every gate must hold: AGY_QUALIFICATION_ENABLED
//     =true, AGY_STAGE_ONLY=true (stage-only, same convention as
//     provision), an owner-issued run id, an ABSOLUTE owner deadline,
//     and the owner's cap-only policy approval as an explicit flag
//     (AGY_QUALIFICATION_CAP_ONLY_APPROVED=true) — without the flag
//     the controller refuses to start; nothing is seeded implicitly.
//   * Scope, project, mission, worker, adapter, connector and reply
//     target are FIXED CONSTANTS, not configuration. The controller
//     cannot touch any other project or worker; every statement is
//     scope-WHERE'd or keyed to the one qualification worker_id, so
//     business rows are unreachable from it.
//   * Exactly ONE job with exactly ONE task per run: the job's
//     idempotency_key IS the run id, and createJob is
//     conflict-idempotent — restarts and repeated ticks can never
//     create a second job or task.
//   * Lifecycle is derived from the database on every tick (no
//     in-memory progress), so a restart resumes exactly where the
//     rows say it is. Past the deadline the controller performs the
//     rollback itself (worker OFFLINE + quota NULL, project PAUSED
//     + priority 0; evidence rows preserved) and stops. If any step
//     fails — e.g. the runtime role cannot apply a registry row —
//     the controller stops BLOCKED with needs_owner_repair instead
//     of looping or half-applying silently.

export const QUALIFICATION_SCOPE: ProjectScope = { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GL_QUALIFICATION' };
export const QUALIFICATION_MISSION = 'GL_QUALIFICATION';
export const QUALIFICATION_WORKER_ID = 'MUSE-QUAL-WORKER';
const QUAL_CONNECTOR_ID = 'muse-qual-x';
const QUAL_ADAPTER = 'muse-qual';
const QUAL_REPLY_TARGET = 'CHATGPT_ASSISTANT_CONTROL_PLANE';
const QUAL_PERMISSIONS = ['read', 'analyze', 'planning', 'qa'];
const QUAL_RESOURCE_POLICY = { maxConcurrentTasks: 1, quotaCap: 100, spendCap: 0, reservation: 0 };
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
  // In-process server-side identity for ProjectService scope checks.
  // It is a scope object, not a credential: no token exists or moves.
  const principal: Principal = { subject: 'qualification-controller', role: 'operator', scopes: [QUALIFICATION_SCOPE] };
  const scopedPool = () => new ProjectPool(raw, QUALIFICATION_SCOPE, 'qualification-controller').asPool();

  async function ensureRegistry(p: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<void> {
    await p.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref)
      VALUES($1,$2,$3,'GL Qualification','owner-registry','owner-registry') ON CONFLICT DO NOTHING`,
      [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId]);
    await p.query(`UPDATE agy_projects SET status='ACTIVE', priority=10, permissions=$4, resource_policy=$5
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,
      [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId,
       QUAL_PERMISSIONS, JSON.stringify(QUAL_RESOURCE_POLICY)]);
    await p.query(`INSERT INTO agy_connectors(tenant_id,workspace_id,project_id,connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions)
      VALUES($1,$2,$3,$4,$5,ARRAY['planning'],'local','vault:custom.agy-worker',true,$6) ON CONFLICT DO NOTHING`,
      [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId,
       QUAL_CONNECTOR_ID, QUAL_ADAPTER, QUAL_PERMISSIONS]);
    await p.query(`INSERT INTO agy_workers(worker_id,adapter,capabilities,status,max_concurrency,resource_profile,quota_remaining,quota_reserve,central_brain,metadata)
      VALUES($1,$2,ARRAY['planning'],'OFFLINE',1,'{"spendCap":0,"quotaCap":null}',null,0,false,$3) ON CONFLICT (worker_id) DO NOTHING`,
      [QUALIFICATION_WORKER_ID, QUAL_ADAPTER, JSON.stringify(QUAL_WORKER_METADATA)]);
  }

  async function transition(p: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<void> {
    // Cap-only window transition: quota_remaining = the one task's
    // estimate (1) and quota_reserve = 0 (the scheduler hard-gate
    // requires remaining − estimate ≥ reserve). This runs ONLY
    // because the owner's cap-only approval flag was set.
    await p.query(`UPDATE agy_workers SET status='READY', quota_remaining=1, quota_reserve=0 WHERE worker_id=$1`,
      [QUALIFICATION_WORKER_ID]);
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

  async function rollback(p: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<void> {
    await p.query(`UPDATE agy_workers SET status='OFFLINE', quota_remaining=null WHERE worker_id=$1`,
      [QUALIFICATION_WORKER_ID]);
    await p.query(`UPDATE agy_projects SET status='PAUSED', priority=0
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,
      [QUALIFICATION_SCOPE.tenantId, QUALIFICATION_SCOPE.workspaceId, QUALIFICATION_SCOPE.projectId]);
  }

  async function tick(): Promise<void> {
    if (ticking || state === 'DISABLED' || state === 'BLOCKED' || state === 'ROLLED_BACK') return;
    ticking = true;
    try {
      const p = scopedPool();
      if (Date.now() > (cfg.expiresAtMs ?? 0)) {
        // Past the owner's absolute deadline: automatic rollback,
        // whether or not this process ever provisioned anything.
        // Idempotent and scope-fixed; evidence rows are preserved.
        await rollback(p);
        state = 'ROLLED_BACK';
        if (timer) { clearInterval(timer); timer = undefined; }
        log('QUALIFICATION_ROLLED_BACK', { runId: cfg.runId });
        return;
      }
      await ensureRegistry(p);
      await transition(p);
      await ensureJob();
      if (state !== 'ACTIVE') log('QUALIFICATION_ACTIVE', { runId: cfg.runId, scope: 'gl/legacy-workspace/GL_QUALIFICATION', workerId: QUALIFICATION_WORKER_ID });
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
    log('QUALIFICATION_CONTROLLER_STARTED', { runId: cfg.runId, expiresAt: new Date(cfg.expiresAtMs).toISOString() });
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
