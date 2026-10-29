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
//     per pass, a fixed interval, and a hard timebox after which the
//     driver stops itself (EXPIRED) and never restarts on its own.
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
  intervalMs?: number;
  timeboxMs?: number;
  limit?: number;
  timeoutMs?: number;
}

export type CallbackDriverState = 'DISABLED' | 'RUNNING' | 'STOPPED' | 'EXPIRED' | 'NO_OPERATOR';

export function parseCallbackDriverConfig(env: Record<string, string | undefined>): { config: CallbackDriverConfig; reason?: string } {
  if (env.AGY_CALLBACK_DRIVER_ENABLED !== 'true') return { config: { enabled: false }, reason: 'NOT_ENABLED' };
  const rawScope = env.AGY_CALLBACK_DRIVER_SCOPE ?? '';
  const parts = rawScope.split(':');
  if (parts.length !== 3 || parts.some((p) => !p)) return { config: { enabled: false }, reason: 'SCOPE_REQUIRED' };
  const missionId = (env.AGY_CALLBACK_DRIVER_MISSION ?? '').trim();
  if (!missionId) return { config: { enabled: false }, reason: 'MISSION_REQUIRED' };
  const scope = { tenantId: parts[0], workspaceId: parts[1], projectId: parts[2] };
  try { validateScope(scope); } catch { return { config: { enabled: false }, reason: 'SCOPE_INVALID' }; }
  const num = (v: string | undefined, dflt: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : dflt; };
  return { config: { enabled: true, scope, missionId,
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

  async function tick(): Promise<void> {
    if (state !== 'RUNNING' || ticking || !scope || !cfg.missionId) return;
    if (Date.now() - startedAt > (cfg.timeboxMs ?? 3_600_000)) {
      stop(); state = 'EXPIRED';
      log('CALLBACK_DRIVER_EXPIRED', { mission: cfg.missionId });
      return;
    }
    ticking = true;
    try {
      const actor = opts.operator?.subject ?? 'callback-driver';
      await recoverStaleCallbackIntents(raw, scope, { actor, missionId: cfg.missionId });
      await reconcileWorkerCallbacks(raw, scope, lookup, { actor, limit: cfg.limit ?? 1, missionId: cfg.missionId });
      const r = await dispatchWorkerCallbacks(raw, scope, transport,
        { actor, limit: cfg.limit ?? 1, timeoutMs: cfg.timeoutMs ?? 10_000, missionId: cfg.missionId });
      if (r.delivered || r.unknown || r.failed) log('CALLBACK_DRIVER_PASS', { ...r, mission: cfg.missionId });
    } catch (e: any) {
      log('CALLBACK_DRIVER_PASS_ERROR', { error: String(e?.message ?? e).slice(0, 200) });
    } finally { ticking = false; }
  }

  function start(): CallbackDriverState {
    if (!cfg.enabled || !scope || !cfg.missionId) { state = 'DISABLED'; return state; }
    if ((cfg.timeboxMs ?? 3_600_000) <= 0) { state = 'EXPIRED'; log('CALLBACK_DRIVER_EXPIRED', { mission: cfg.missionId }); return state; }
    if (!opts.operator) { state = 'NO_OPERATOR'; log('CALLBACK_DRIVER_NO_OPERATOR', { mission: cfg.missionId }); return state; }
    if (state === 'RUNNING') return state;
    startedAt = Date.now();
    state = 'RUNNING';
    log('CALLBACK_DRIVER_STARTED', { scope: `${scope.tenantId}/${scope.workspaceId}/${scope.projectId}`,
      mission: cfg.missionId, limit: cfg.limit ?? 1, timeboxMs: cfg.timeboxMs ?? 3_600_000 });
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
