import type { Pool } from "pg";
import { validateScope, type ProjectScope } from "./scope.js";
import { authorize, type Principal } from "./auth.js";
import { createCallbackReceiver } from "./worker-callback-receiver.js";
import {
  dispatchWorkerCallbacks, reconcileWorkerCallbacks, recoverStaleCallbackIntents,
  type CallbackLookup, type CallbackTransport,
} from "./worker-callbacks.js";

// Runtime callback DRIVER (candidate, A2) — the missing caller that
// turns the dispatch/reconcile helpers into a running part of the
// canonical service. Design rules:
//   * DEFAULT DISABLED. It starts only when explicitly enabled AND a
//     single explicit project scope AND a mission allowlist are
//     configured. There is no broad mode.
//   * Bounded: at most `limit` (default 1, hard-capped at 5) callbacks
//     per pass, a fixed interval, and an ABSOLUTE owner-approved
//     deadline (expiresAt + runId, from env) after which the driver
//     stops itself (EXPIRED) and never restarts on its own. A restart
//     re-reads the same deadline — the window can never renew. A
//     local timebox may only shorten it further. If a pass blocks a
//     callback (auth/route/budget), the driver stops in state BLOCKED
//     with needs_owner_repair instead of polling.
//   * Recovery first: every pass sweeps stale SENDING intents to
//     UNKNOWN before anything is sent, and reconcile runs before new
//     dispatch — a restart never resends blind.
//   * Mission allowlist: every helper call is mission-filtered, so the
//     driver can only ever touch callbacks of the allowlisted mission
//     inside the one configured project.
//   * Credentials: the driver acts as the EXISTING control-plane
//     operator identity, in-process on the server. The default
//     transport/lookup call the co-located receiver directly — no
//     token is sent anywhere, and no operator credential is ever
//     handed to a worker (Claude/Gemini authenticate separately with
//     their own worker identities). No new queue, service, or secret.

export interface CallbackDriverConfig {
  enabled: boolean;
  scope?: ProjectScope;
  missionId?: string;
  // Absolute, owner-approved deadline (B2). The window NEVER renews:
  // a restart re-reads the same expiresAtMs and expires against it.
  // runId binds every log line and pass to the owner's approved run;
  // a new run requires a new owner-issued runId + deadline.
  expiresAtMs?: number;
  runId?: string;
  intervalMs?: number;
  timeboxMs?: number;
  limit?: number;
  timeoutMs?: number;
}

export type CallbackDriverState = 'DISABLED' | 'RUNNING' | 'STOPPED' | 'EXPIRED' | 'NO_OPERATOR' | 'BLOCKED';

export function parseCallbackDriverConfig(env: Record<string, string | undefined>): { config: CallbackDriverConfig; reason?: string } {
  if (env.AGY_CALLBACK_DRIVER_ENABLED !== 'true') return { config: { enabled: false }, reason: 'NOT_ENABLED' };
  const rawScope = env.AGY_CALLBACK_DRIVER_SCOPE ?? '';
  const parts = rawScope.split(':');
  if (parts.length !== 3 || parts.some((p) => !p)) return { config: { enabled: false }, reason: 'SCOPE_REQUIRED' };
  const missionId = (env.AGY_CALLBACK_DRIVER_MISSION ?? '').trim();
  if (!missionId) return { config: { enabled: false }, reason: 'MISSION_REQUIRED' };
  const scope = { tenantId: parts[0], workspaceId: parts[1], projectId: parts[2] };
  try { validateScope(scope); } catch { return { config: { enabled: false }, reason: 'SCOPE_INVALID' }; }
  const expiresRaw = (env.AGY_CALLBACK_DRIVER_EXPIRES_AT ?? '').trim();
  if (!expiresRaw) return { config: { enabled: false }, reason: 'EXPIRES_AT_REQUIRED' };
  const expiresAtMs = Date.parse(expiresRaw);
  if (!Number.isFinite(expiresAtMs)) return { config: { enabled: false }, reason: 'EXPIRES_AT_INVALID' };
  const runId = (env.AGY_CALLBACK_DRIVER_RUN_ID ?? '').trim();
  if (!runId) return { config: { enabled: false }, reason: 'RUN_ID_REQUIRED' };
  const num = (v: string | undefined, dflt: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : dflt; };
  return { config: { enabled: true, scope, missionId, expiresAtMs, runId,
    intervalMs: num(env.AGY_CALLBACK_DRIVER_INTERVAL_MS, 30_000),
    timeboxMs: num(env.AGY_CALLBACK_DRIVER_TIMEBOX_MS, 3_600_000),
    limit: Math.max(1, Math.min(num(env.AGY_CALLBACK_DRIVER_LIMIT, 1), 5)),
    timeoutMs: num(env.AGY_CALLBACK_DRIVER_TIMEOUT_MS, 10_000) } };
}

// The driver may only act as an existing operator (or platform-admin)
// whose scopes cover the configured project. Returns undefined when no
// such identity exists — the driver then refuses to run.
export function findCallbackOperator(identities: Principal[], scope: ProjectScope): Principal | undefined {
  return identities.find((i) => {
    if (i.role !== 'operator' && i.role !== 'platform-admin') return false;
    try { authorize(i, scope, 'write'); return true; } catch { return false; }
  });
}

export function createWorkerCallbackDriver(raw: Pool, opts: {
  config: CallbackDriverConfig;
  operator?: Principal;
  transport?: CallbackTransport;
  lookup?: CallbackLookup;
  log?: (event: string, detail?: Record<string, unknown>) => void;
}) {
  const cfg = opts.config;
  const log = opts.log ?? ((event: string, detail?: Record<string, unknown>) =>
    console.log(JSON.stringify({ event, ...(detail ?? {}) })));
  let state: CallbackDriverState = 'DISABLED';
  let timer: NodeJS.Timeout | undefined;
  let startedAt = 0;
  let ticking = false;

  const scope = cfg.scope;
  const receiver = createCallbackReceiver(raw);
  const transport: CallbackTransport = opts.transport ?? (async (intent) => {
    if (!opts.operator || !scope) throw new Error('DRIVER_NO_OPERATOR');
    return receiver.receive(opts.operator, scope, intent as unknown as Record<string, unknown>);
  });
  const lookup: CallbackLookup = opts.lookup ?? (async (expect) => {
    if (!opts.operator || !scope) throw new Error('DRIVER_NO_OPERATOR');
    return receiver.lookup(opts.operator, scope, expect.callback_id);
  });

  // The effective deadline is the EARLIER of the absolute owner
  // deadline and the local timebox — a restart can only ever shorten
  // the remaining window, never extend it (B2).
  const deadline = () => Math.min(cfg.expiresAtMs ?? Number.POSITIVE_INFINITY,
    startedAt + (cfg.timeboxMs ?? 3_600_000));

  async function tick(): Promise<void> {
    if (state !== 'RUNNING' || ticking || !scope || !cfg.missionId) return;
    const remaining = deadline() - Date.now();
    if (remaining <= 0) {
      stop(); state = 'EXPIRED';
      log('CALLBACK_DRIVER_EXPIRED', { mission: cfg.missionId, runId: cfg.runId });
      return;
    }
    ticking = true;
    try {
      const actor = opts.operator?.subject ?? 'callback-driver';
      await recoverStaleCallbackIntents(raw, scope, { actor, missionId: cfg.missionId });
      await reconcileWorkerCallbacks(raw, scope, lookup, { actor, limit: cfg.limit ?? 1, missionId: cfg.missionId });
      // A pass never runs past the deadline: its send timeout is
      // bounded by the time actually left in the window.
      const r = await dispatchWorkerCallbacks(raw, scope, transport,
        { actor, limit: cfg.limit ?? 1, timeoutMs: Math.max(50, Math.min(cfg.timeoutMs ?? 10_000, remaining)), missionId: cfg.missionId });
      if (r.blocked.length) {
        // Blocked delivery = owner repair needed (B3). The driver
        // stops and reports; it does not poll no-op passes.
        stop(); state = 'BLOCKED';
        log('CALLBACK_DRIVER_BLOCKED', { mission: cfg.missionId, runId: cfg.runId,
          needs_owner_repair: true, blocked: r.blocked });
        return;
      }
      if (r.delivered || r.unknown || r.failed) log('CALLBACK_DRIVER_PASS', { delivered: r.delivered, unknown: r.unknown, failed: r.failed, mission: cfg.missionId, runId: cfg.runId });
    } catch (e: any) {
      log('CALLBACK_DRIVER_PASS_ERROR', { error: String(e?.message ?? e).slice(0, 200), runId: cfg.runId });
    } finally { ticking = false; }
  }

  function start(): CallbackDriverState {
    if (!cfg.enabled || !scope || !cfg.missionId) { state = 'DISABLED'; return state; }
    if (!cfg.expiresAtMs || !cfg.runId) { state = 'DISABLED'; log('CALLBACK_DRIVER_CONFIG_INCOMPLETE', { mission: cfg.missionId, reason: 'EXPIRES_AT_AND_RUN_ID_REQUIRED' }); return state; }
    if ((cfg.timeboxMs ?? 3_600_000) <= 0 || cfg.expiresAtMs <= Date.now()) { state = 'EXPIRED'; log('CALLBACK_DRIVER_EXPIRED', { mission: cfg.missionId, runId: cfg.runId }); return state; }
    if (!opts.operator) { state = 'NO_OPERATOR'; log('CALLBACK_DRIVER_NO_OPERATOR', { mission: cfg.missionId }); return state; }
    if (state === 'RUNNING') return state;
    startedAt = Date.now();
    state = 'RUNNING';
    log('CALLBACK_DRIVER_STARTED', { scope: `${scope.tenantId}/${scope.workspaceId}/${scope.projectId}`,
      mission: cfg.missionId, runId: cfg.runId, limit: cfg.limit ?? 1, expiresAt: new Date(cfg.expiresAtMs).toISOString() });
    void tick();
    timer = setInterval(() => { void tick(); }, Math.max(25, cfg.intervalMs ?? 30_000));
    timer.unref?.();
    return state;
  }

  function stop(): CallbackDriverState {
    if (timer) { clearInterval(timer); timer = undefined; }
    if (state === 'RUNNING') { state = 'STOPPED'; log('CALLBACK_DRIVER_STOPPED', {}); }
    return state;
  }

  return { start, stop, tick, state: () => state };
}
