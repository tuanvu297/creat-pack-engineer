import type { Pool } from 'pg';
import { ProjectPool } from './scoped-pool.js';
import { validateScope, type ProjectScope } from './scope.js';

// Control-plane callback delivery — v3 (candidate,
// AGY-GLSEO-ROUTE-QUALIFY-20261027; U2/U3 hardening over the T1 design).
//
// Delivery crosses an external boundary and a process boundary, so it
// is engineered for crashes, not asserted exactly-once:
//   1. INTENT (fenced, pre-network): the dispatcher moves the outbox
//      row PENDING -> SENDING in its own transaction, stamping
//      delivery_intent_at + delivery_attempts. The (status='SENDING',
//      delivery_intent_at) pair is the ownership fence: only the
//      dispatcher holding that exact fence may confirm or classify.
//      Because the state changes BEFORE any network call, a process
//      that dies after sending but before confirming leaves a SENDING
//      row — never a PENDING one — so no later pass can mistake it for
//      unsent work.
//   2. SEND: bounded by an AbortController timeout (the signal is
//      passed to the transport; a race bounds even non-cooperative
//      transports; the timer is always cleared). The HTTP adapter uses
//      redirect:'error' so a response can never carry the payload off
//      the exact allowlisted host.
//   3. CONFIRM: only a receipt validated against (callback_id,
//      content_digest, accepted=true) confirms DELIVERED (with the
//      CALLBACK_DELIVERED event, same transaction, fence-checked).
//   4. CLASSIFY: definite failures (receiver rejection, digest
//      conflict, connection refused — provably no effect for this
//      send) return the row to PENDING. Everything else — timeout,
//      5xx, lost response, void/mismatched receipt — moves it to
//      UNKNOWN. UNKNOWN is never auto-resent.
//   5. CRASH RECOVERY: recoverStaleCallbackIntents moves SENDING rows
//      whose intent is stale (>60 s) to UNKNOWN with an event; the
//      dispatcher runs it before selecting work. From UNKNOWN the only
//      paths are reconcileWorkerCallbacks (settles from the receiver
//      readback, validating the FULL receipt identity: callback_id,
//      task, attempt, digest — malformed/void/ambiguous readbacks hold
//      the row UNKNOWN) or the explicit, audited
//      releaseUnknownCallback.
// The receiver (worker-callback-receiver.ts) dedups on callback_id:
// its persisted receipt proves the canonical host recorded the
// callback. It does NOT prove native ingestion by the ChatGPT client —
// that is a separate gate, still unproven, and nothing here claims it.
// Until the receiver route is deployed on the hosted service, the live
// route stays BLOCKED_TRANSPORT.
export interface WorkerCallbackRow {
  callback_id: string; job_id: string; task_id: string; attempt: number;
  worker_id: string; target: string; payload: unknown; content_digest: string;
  tenant_id: string; workspace_id: string; project_id: string; created_at: string;
}
export interface CallbackIntent {
  callback_id: string; idempotency_key: string; job_id: string; task_id: string;
  attempt: number; worker_id: string; target: string; payload: unknown; content_digest: string;
  tenant_id: string; workspace_id: string; project_id: string;
}
export interface CallbackReceipt { accepted: true; idempotency_key: string; task_id?: string; attempt?: number; content_digest: string; received_at?: string }
export type CallbackTransport = (intent: CallbackIntent, signal?: AbortSignal) => Promise<CallbackReceipt | unknown>;
export interface CallbackExpectation { callback_id: string; task_id: string; attempt: number; content_digest: string }
export type CallbackLookup = (expect: CallbackExpectation) => Promise<{ found: boolean; callback_id?: string; task_id?: string; attempt?: number; content_digest?: string; received_at?: string }>;

export class CallbackOutcomeUnknown extends Error {}
// A definite failure ends the send without ambiguity. `blocked` marks
// the failures that must STOP at first occurrence (B3): auth and
// route blocks (401/403/404) and tuple conflicts (409) need owner
// repair, never a retry loop. Other definite failures are transient:
// they may retry at most twice after the original attempt, with the
// counter persisted in delivery_attempts.
export class CallbackDefiniteFailure extends Error {
  constructor(message: string, readonly blocked = false) { super(message); }
}
// A lookup-side auth/config block (C2): the readback route itself is
// unreachable for authorization/configuration reasons (401/403, a
// denied in-process guard, or a missing route). This is NOT a clean
// not-found and NOT a transient lookup failure — reconciliation must
// surface it as blocked/needs_owner_repair instead of retrying it on
// every interval.
export class CallbackLookupBlocked extends Error {}
const CALLBACK_CONFIG_BLOCK_RE = /ACTION_DENIED|PROJECT_SCOPE_DENIED|RECEIVER_LOOKUP_AUTH_|RECEIVER_LOOKUP_ROUTE_|RECEIVER_AUTH_OR_ROUTE_|CALLBACK_ROUTE_NOT_FOUND/;
export const isCallbackConfigBlock = (e: unknown): boolean =>
  e instanceof CallbackLookupBlocked || CALLBACK_CONFIG_BLOCK_RE.test(e instanceof Error ? e.message : String(e));

export const CALLBACK_INTENT_STALE_SECONDS = 60;

// Optional mission allowlist (A2): when set, only callbacks whose task
// carries payload.mission_id = missionId are eligible — the runtime
// driver uses it so a qualification run can never touch callbacks of
// any other mission, even inside the same project.
const missionClause = (missionId: string | undefined, paramIndex: number) =>
  missionId ? ` AND EXISTS(SELECT 1 FROM agy_tasks mt WHERE mt.task_id=agy_worker_callbacks.task_id AND mt.payload->>'mission_id'=$${paramIndex})` : '';

async function sweepStaleIntents(pool: { query: (sql: string, params?: unknown[]) => Promise<any> }, staleSeconds: number, missionId?: string): Promise<number> {
  const stale = (await pool.query(
    `SELECT * FROM agy_worker_callbacks WHERE status='SENDING'
       AND delivery_intent_at < now() - ($1 || ' seconds')::interval${missionClause(missionId, 2)} ORDER BY created_at`,
    missionId ? [String(staleSeconds), missionId] : [String(staleSeconds)])).rows;
  let swept = 0;
  for (const row of stale) {
    // Fence = still SENDING and still stale at update time (a live
    // dispatcher refreshing its intent makes the row fresh again and
    // this matches 0 rows). Exact timestamp equality is NOT used:
    // timestamptz microseconds do not survive a JS Date round-trip.
    const upd = await pool.query(
      `UPDATE agy_worker_callbacks SET status='UNKNOWN', last_error='INTENT_STALE_CRASH_RECOVERY'
        WHERE callback_id=$1 AND status='SENDING'
          AND delivery_intent_at < now() - ($2 || ' seconds')::interval`,
      [row.callback_id, String(staleSeconds)]);
    if (upd.rowCount) {
      await pool.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'CALLBACK_INTENT_STALE','QA',$3,$4)`,
        [row.job_id, row.task_id, row.worker_id, { callback_id: row.callback_id, attempt: Number(row.attempt),
          note: 'Dispatcher died or stalled after intent, before confirm. Held UNKNOWN: reconcile before any resend.' }]);
      swept++;
    }
  }
  return swept;
}

// Move stale SENDING rows (a dispatcher that died mid-delivery) to
// UNKNOWN. Exported for the control plane; the dispatcher also runs it
// at the start of every pass.
export async function recoverStaleCallbackIntents(raw: Pool, scope: ProjectScope,
  opts: { actor?: string; staleSeconds?: number; missionId?: string } = {}): Promise<{ swept: number }> {
  validateScope(scope);
  const pool = new ProjectPool(raw, scope, opts.actor ?? 'control-plane').asPool();
  return { swept: await sweepStaleIntents(pool, opts.staleSeconds ?? CALLBACK_INTENT_STALE_SECONDS, opts.missionId) };
}

// Persisted BLOCKED rows for a scope/mission (C2). A blocked row is a
// durable state, not a per-pass event: after a restart the dispatcher
// result alone would report blocked=[] for a row blocked by an
// earlier process, so callers (the runtime driver) read this list
// BEFORE any lookup or send and stop instead of polling no-ops.
export async function listBlockedWorkerCallbacks(raw: Pool, scope: ProjectScope,
  opts: { actor?: string; missionId?: string; limit?: number } = {}): Promise<{ callback_id: string; error: string }[]> {
  validateScope(scope);
  const pool = new ProjectPool(raw, scope, opts.actor ?? 'control-plane').asPool();
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));
  const rows = (await pool.query(
    `SELECT callback_id,last_error FROM agy_worker_callbacks WHERE status='BLOCKED'${missionClause(opts.missionId, 2)} ORDER BY created_at LIMIT $1`,
    opts.missionId ? [limit, opts.missionId] : [limit])).rows;
  return rows.map((r: any) => ({ callback_id: r.callback_id, error: String(r.last_error ?? 'BLOCKED').slice(0, 200) }));
}

export async function dispatchWorkerCallbacks(raw: Pool, scope: ProjectScope,
  transport: CallbackTransport, opts: { limit?: number; actor?: string; timeoutMs?: number; missionId?: string; deadlineMs?: number } = {})
  : Promise<{ delivered: number; failed: number; unknown: number; seen: number; swept: number; blocked: { callback_id: string; error: string }[]; expired: boolean }> {
  validateScope(scope);
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const timeoutMs = Math.max(50, Math.min(opts.timeoutMs ?? 10000, 30000));
  const pool = new ProjectPool(raw, scope, opts.actor ?? 'control-plane').asPool();
  const swept = await sweepStaleIntents(pool, CALLBACK_INTENT_STALE_SECONDS, opts.missionId);
  let delivered = 0, failed = 0, unknown = 0, seen = 0;
  let expired = false;
  const blocked: { callback_id: string; error: string }[] = [];
  const processed = new Set<string>();
  // Deadline discipline (C1): the absolute deadline is re-checked
  // before EVERY intent/network effect in the pass, and each send's
  // timeout is computed from the time actually remaining at that
  // moment — never from a remaining value captured before earlier
  // phases, and never clamped up past the window.
  const pastDeadline = () => opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs;
  for (let i = 0; i < limit; i++) {
    if (pastDeadline()) { expired = true; break; }
    const cand = (await pool.query(
      `SELECT * FROM agy_worker_callbacks WHERE status='PENDING'${missionClause(opts.missionId, 1)} ORDER BY created_at LIMIT 25`,
      opts.missionId ? [opts.missionId] : [])).rows
      .find((r: any) => !processed.has(r.callback_id));
    if (!cand) break;
    if (pastDeadline()) { expired = true; break; }
    processed.add(cand.callback_id); seen++;
    // 1. Fenced intent claim — the state leaves PENDING before network.
    const claim = await pool.query(
      `UPDATE agy_worker_callbacks SET status='SENDING', delivery_intent_at=now(), delivery_attempts=delivery_attempts+1
        WHERE callback_id=$1 AND status='PENDING' RETURNING delivery_intent_at`, [cand.callback_id]);
    if (!claim.rowCount) continue; // another dispatcher holds the fence
    const intentAt = claim.rows[0].delivery_intent_at;
    const intent: CallbackIntent = { callback_id: cand.callback_id, idempotency_key: cand.callback_id,
      job_id: cand.job_id, task_id: cand.task_id, attempt: Number(cand.attempt), worker_id: cand.worker_id,
      target: cand.target, payload: cand.payload, content_digest: cand.content_digest,
      tenant_id: cand.tenant_id, workspace_id: cand.workspace_id, project_id: cand.project_id };
    // 2. Bounded send: AbortController + race backstop, timer cleared.
    //    The timeout for THIS send is computed now, from the time
    //    actually remaining before the deadline (C1) — when a
    //    deadline is set there is no 50 ms floor that could push the
    //    send past the window, and an already-passed deadline means
    //    the transport is never invoked at all.
    let sendTimeoutMs = timeoutMs;
    let deadlineBeforeSend = false;
    if (opts.deadlineMs !== undefined) {
      const remainingNow = opts.deadlineMs - Date.now();
      if (remainingNow <= 0) deadlineBeforeSend = true;
      else sendTimeoutMs = Math.min(timeoutMs, remainingNow);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), sendTimeoutMs);
    let receipt: any; let sendError: Error | null = null;
    try {
      if (deadlineBeforeSend) {
        sendError = new CallbackOutcomeUnknown('DEADLINE_EXPIRED_BEFORE_SEND');
        expired = true;
      } else {
        receipt = await Promise.race([
          Promise.resolve().then(() => transport(intent, ctl.signal)),
          new Promise((_, reject) => ctl.signal.addEventListener('abort',
            () => reject(new CallbackOutcomeUnknown('TRANSPORT_TIMEOUT')), { once: true })),
        ]);
      }
    } catch (e: any) { sendError = e instanceof Error ? e : new Error(String(e)); }
    finally { clearTimeout(timer); }
    // Direct receipts are identity-checked in full (V2): a partial
    // receipt (missing task/attempt) never confirms delivery.
    const receiptValid = !sendError && receipt && typeof receipt === 'object'
      && receipt.accepted === true && receipt.idempotency_key === cand.callback_id
      && receipt.task_id === cand.task_id && Number(receipt.attempt) === Number(cand.attempt)
      && receipt.content_digest === cand.content_digest;
    // 3+4. Fenced confirm / classify.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query(`SELECT * FROM agy_worker_callbacks WHERE callback_id=$1 FOR UPDATE`, [cand.callback_id])).rows[0];
      const fenced = row && row.status === 'SENDING' && row.delivery_intent_at
        && new Date(row.delivery_intent_at).getTime() === new Date(intentAt).getTime();
      if (fenced) {
        if (receiptValid) {
          await client.query(`UPDATE agy_worker_callbacks SET status='DELIVERED', delivered_at=now(), last_error=NULL WHERE callback_id=$1`, [cand.callback_id]);
          await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'CALLBACK_DELIVERED','QA',$3,$4)`,
            [cand.job_id, cand.task_id, cand.worker_id, { callback_id: cand.callback_id, attempt: Number(cand.attempt), target: cand.target, receipt }]);
          delivered++;
        } else if (sendError instanceof CallbackDefiniteFailure) {
          // Retry policy (B3): auth/route blocks and tuple conflicts
          // stop at the FIRST occurrence; transient definite failures
          // retry at most twice after the original send. The counter
          // is delivery_attempts — persisted in the row, so a restart
          // never resets the budget. Exhaustion lands in BLOCKED with
          // needs_owner_repair; only an explicit owner release
          // (releaseBlockedCallback) makes the row sendable again.
          const attempts = Number(row.delivery_attempts);
          const mustBlock = sendError.blocked || attempts >= 3;
          if (mustBlock) {
            await client.query(`UPDATE agy_worker_callbacks SET status='BLOCKED', delivery_intent_at=NULL, last_error=$2 WHERE callback_id=$1`,
              [cand.callback_id, sendError.message.slice(0, 200)]);
            await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'CALLBACK_DELIVERY_BLOCKED','QA',$3,$4)`,
              [cand.job_id, cand.task_id, cand.worker_id, { callback_id: cand.callback_id, attempt: Number(cand.attempt), error: sendError.message.slice(0, 200),
                delivery_attempts: attempts, needs_owner_repair: true }]);
            blocked.push({ callback_id: cand.callback_id, error: sendError.message.slice(0, 200) });
          } else {
            await client.query(`UPDATE agy_worker_callbacks SET status='PENDING', delivery_intent_at=NULL, last_error=$2 WHERE callback_id=$1`,
              [cand.callback_id, sendError.message.slice(0, 200)]);
            await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'CALLBACK_DELIVERY_FAILED','QA',$3,$4)`,
              [cand.job_id, cand.task_id, cand.worker_id, { callback_id: cand.callback_id, attempt: Number(cand.attempt), error: sendError.message.slice(0, 200), delivery_attempts: attempts }]);
            failed++;
          }
        } else {
          const why = sendError ? sendError.message : 'RECEIPT_UNVALIDATED';
          await client.query(`UPDATE agy_worker_callbacks SET status='UNKNOWN', last_error=$2 WHERE callback_id=$1`,
            [cand.callback_id, String(why).slice(0, 200)]);
          await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'CALLBACK_DELIVERY_UNKNOWN','QA',$3,$4)`,
            [cand.job_id, cand.task_id, cand.worker_id, { callback_id: cand.callback_id, attempt: Number(cand.attempt), error: String(why).slice(0, 200),
              note: 'Outcome not validated. Never auto-resent: reconcile against the receiver readback or release explicitly.' }]);
          unknown++;
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  return { delivered, failed, unknown, seen, swept, blocked, expired };
}

// Settle UNKNOWN rows from the receiver readback, validating the FULL
// receipt identity (callback_id, task, attempt, digest). A malformed,
// void, or ambiguous readback holds the row UNKNOWN; a lookup failure
// is recorded distinctly from a clean not-found.
export async function reconcileWorkerCallbacks(raw: Pool, scope: ProjectScope,
  lookup: CallbackLookup, opts: { actor?: string; limit?: number; missionId?: string } = {})
  : Promise<{ reconciled: number; conflicts: number; not_found: number; lookup_failed: number; unvalidated: number; seen: number; blocked: { callback_id: string; error: string }[] }> {
  validateScope(scope);
  const pool = new ProjectPool(raw, scope, opts.actor ?? 'control-plane').asPool();
  const rows = (await pool.query(`SELECT * FROM agy_worker_callbacks WHERE status='UNKNOWN'${missionClause(opts.missionId, 2)} ORDER BY created_at LIMIT $1`,
    opts.missionId ? [Math.max(1, Math.min(opts.limit ?? 25, 100)), opts.missionId] : [Math.max(1, Math.min(opts.limit ?? 25, 100))])).rows;
  let reconciled = 0, conflicts = 0, notFound = 0, lookupFailed = 0, unvalidated = 0;
  const blocked: { callback_id: string; error: string }[] = [];
  for (const row of rows) {
    let stopAfterThisRow = false;
    let found: Awaited<ReturnType<CallbackLookup>> | null = null; let lookupError: Error | null = null;
    try {
      found = await lookup({ callback_id: row.callback_id, task_id: row.task_id,
        attempt: Number(row.attempt), content_digest: row.content_digest });
    } catch (e: any) { lookupError = e instanceof Error ? e : new Error(String(e)); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = (await client.query(`SELECT status FROM agy_worker_callbacks WHERE callback_id=$1 FOR UPDATE`, [row.callback_id])).rows[0];
      if (cur?.status === 'UNKNOWN') {
        const event = async (type: string, detail: Record<string, unknown>) => client.query(
          `INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,$3,'QA',$4,$5)`,
          [row.job_id, row.task_id, type, row.worker_id, detail]);
        if (lookupError) {
          if (isCallbackConfigBlock(lookupError)) {
            // Auth/config block (C2): NOT a transient lookup failure.
            // The row leaves the reconcile loop entirely (BLOCKED,
            // needs_owner_repair) and processing stops — the same
            // broken lookup would fail identically for every row and
            // on every interval.
            await client.query(`UPDATE agy_worker_callbacks SET status='BLOCKED', last_error=$2 WHERE callback_id=$1`,
              [row.callback_id, lookupError.message.slice(0, 200)]);
            await event('CALLBACK_RECONCILE_BLOCKED', { callback_id: row.callback_id, attempt: Number(row.attempt), error: lookupError.message.slice(0, 200), needs_owner_repair: true });
            blocked.push({ callback_id: row.callback_id, error: lookupError.message.slice(0, 200) });
            stopAfterThisRow = true;
          } else {
            await event('CALLBACK_RECONCILE_LOOKUP_FAILED', { callback_id: row.callback_id, attempt: Number(row.attempt), error: lookupError.message.slice(0, 200) });
            lookupFailed++;
          }
        } else if (found && found.found === true) {
          // FULL typed identity is required (V2): every field present
          // and correctly typed — a partial receipt holds the row
          // UNKNOWN, it never reconciles to DELIVERED.
          const identityOk = typeof found.callback_id === 'string' && found.callback_id === row.callback_id
            && typeof found.task_id === 'string' && found.task_id === row.task_id
            && Number.isInteger(found.attempt) && Number(found.attempt) === Number(row.attempt)
            && typeof found.content_digest === 'string' && found.content_digest.length > 0;
          if (!identityOk) {
            await event('CALLBACK_RECONCILE_UNVALIDATED', { callback_id: row.callback_id, attempt: Number(row.attempt), note: 'Readback identity incomplete or ambiguous; held UNKNOWN.' });
            unvalidated++;
          } else if (found.content_digest !== row.content_digest) {
            await event('CALLBACK_RECONCILE_CONFLICT', { callback_id: row.callback_id, attempt: Number(row.attempt), receiver_digest: found.content_digest });
            conflicts++;
          } else {
            await client.query(`UPDATE agy_worker_callbacks SET status='DELIVERED', delivered_at=COALESCE($2, now()), last_error=NULL WHERE callback_id=$1`,
              [row.callback_id, found.received_at ?? null]);
            await event('CALLBACK_RECONCILED', { callback_id: row.callback_id, attempt: Number(row.attempt), via: 'receiver_readback' });
            reconciled++;
          }
        } else if (found && found.found === false) {
          await event('CALLBACK_RECONCILE_NOT_FOUND', { callback_id: row.callback_id, attempt: Number(row.attempt) });
          notFound++;
        } else {
          await event('CALLBACK_RECONCILE_UNVALIDATED', { callback_id: row.callback_id, attempt: Number(row.attempt), note: 'Readback response malformed; held UNKNOWN.' });
          unvalidated++;
        }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    if (stopAfterThisRow) break;
  }
  return { reconciled, conflicts, not_found: notFound, lookup_failed: lookupFailed, unvalidated, seen: rows.length, blocked };
}

// The ONLY way back from UNKNOWN to PENDING: an explicit control-plane
// decision, recorded as an event. Returns false when the row is not
// UNKNOWN.
export async function releaseUnknownCallback(raw: Pool, scope: ProjectScope, callbackId: string,
  opts: { actor?: string } = {}): Promise<boolean> {
  validateScope(scope);
  const pool = new ProjectPool(raw, scope, opts.actor ?? 'control-plane').asPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT * FROM agy_worker_callbacks WHERE callback_id=$1 FOR UPDATE`, [callbackId])).rows[0];
    if (!row || row.status !== 'UNKNOWN') { await client.query('ROLLBACK'); return false; }
    await client.query(`UPDATE agy_worker_callbacks SET status='PENDING', delivery_intent_at=NULL, last_error=NULL WHERE callback_id=$1`, [callbackId]);
    await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'CALLBACK_RELEASED','QA',$3,$4)`,
      [row.job_id, row.task_id, row.worker_id, { callback_id: callbackId, attempt: Number(row.attempt), released_by: opts.actor ?? 'control-plane' }]);
    await client.query('COMMIT');
    return true;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// The ONLY way back from BLOCKED (B3): an explicit owner/control-plane
// decision after the underlying fault (auth, route, tuple, budget) is
// repaired. Resets the persisted retry counter and records the
// release. Returns false when the row is not BLOCKED.
export async function releaseBlockedCallback(raw: Pool, scope: ProjectScope, callbackId: string,
  opts: { actor?: string } = {}): Promise<boolean> {
  validateScope(scope);
  const pool = new ProjectPool(raw, scope, opts.actor ?? 'control-plane').asPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query(`SELECT * FROM agy_worker_callbacks WHERE callback_id=$1 FOR UPDATE`, [callbackId])).rows[0];
    if (!row || row.status !== 'BLOCKED') { await client.query('ROLLBACK'); return false; }
    await client.query(`UPDATE agy_worker_callbacks SET status='PENDING', delivery_intent_at=NULL, last_error=NULL, delivery_attempts=0 WHERE callback_id=$1`, [callbackId]);
    await client.query(`INSERT INTO agy_task_events(job_id,task_id,event_type,to_status,worker_id,detail) VALUES($1,$2,'CALLBACK_RELEASED','QA',$3,$4)`,
      [row.job_id, row.task_id, row.worker_id, { callback_id: callbackId, attempt: Number(row.attempt), released_by: opts.actor ?? 'control-plane', from: 'BLOCKED' }]);
    await client.query('COMMIT');
    return true;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// Real HTTP adapter to the canonical host's receiver route. The host
// must be on the exact allowlist (default: the canonical staging host);
// plain HTTP is accepted only for loopback (local tests). Requests use
// redirect:'error' and the dispatcher's abort signal.
export function callbackHttpTarget(baseUrl: string, allowHosts: string[]): URL {
  const url = new URL(baseUrl);
  if (!allowHosts.includes(url.host)) throw new Error('CALLBACK_HOST_NOT_ALLOWLISTED');
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !loopback) throw new Error('CALLBACK_HTTPS_REQUIRED');
  return url;
}

export function createHttpCallbackTransport(opts: { baseUrl: string; token: string; allowHosts?: string[] }): CallbackTransport {
  const allow = opts.allowHosts ?? ['agy-temporal-staging-staging.up.railway.app'];
  const base = callbackHttpTarget(opts.baseUrl, allow);
  return async (intent: CallbackIntent, signal?: AbortSignal) => {
    const path = `/v1/callbacks/tenants/${intent.tenant_id}/workspaces/${intent.workspace_id}/projects/${intent.project_id}/receive`;
    let res: Response;
    try {
      res = await fetch(new URL(path, base), { method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ callback_id: intent.callback_id, task_id: intent.task_id, attempt: intent.attempt,
          worker_id: intent.worker_id, target: intent.target, content_digest: intent.content_digest, payload: intent.payload }) });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new CallbackOutcomeUnknown('TRANSPORT_TIMEOUT');
      if (e?.cause?.code === 'ECONNREFUSED') throw new CallbackDefiniteFailure('RECEIVER_UNREACHABLE');
      throw new CallbackOutcomeUnknown('TRANSPORT_ERROR');
    }
    if (res.status === 409) throw new CallbackDefiniteFailure('RECEIVER_TUPLE_CONFLICT', true);
    if (res.status === 401 || res.status === 403 || res.status === 404)
      throw new CallbackDefiniteFailure(`RECEIVER_AUTH_OR_ROUTE_${res.status}`, true);
    if (res.status >= 400 && res.status < 500) throw new CallbackDefiniteFailure(`RECEIVER_REJECTED_${res.status}`);
    if (res.status >= 500) throw new CallbackOutcomeUnknown(`RECEIVER_${res.status}`);
    const body = await res.json().catch(() => null);
    return body as CallbackReceipt;
  };
}

export function createHttpCallbackLookup(opts: { baseUrl: string; token: string; allowHosts?: string[]; scope: ProjectScope; timeoutMs?: number }): CallbackLookup {
  const allow = opts.allowHosts ?? ['agy-temporal-staging-staging.up.railway.app'];
  const base = callbackHttpTarget(opts.baseUrl, allow);
  const s = opts.scope;
  const timeoutMs = Math.max(50, Math.min(opts.timeoutMs ?? 10000, 30000));
  return async (expect: CallbackExpectation) => {
    const path = `/v1/callbacks/tenants/${s.tenantId}/workspaces/${s.workspaceId}/projects/${s.projectId}/receive/${expect.callback_id}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // The abort timer covers the WHOLE exchange (V2): headers AND
      // body read/parse. Clearing it after the headers would let a
      // slow or never-ending body hang the reconcile forever.
      const res = await fetch(new URL(path, base), { redirect: 'error', signal: ctl.signal,
        headers: { authorization: `Bearer ${opts.token}` } });
      // Auth/config blocks are classified, never retried blind (C2).
      if (res.status === 401 || res.status === 403) throw new CallbackLookupBlocked(`RECEIVER_LOOKUP_AUTH_${res.status}`);
      if (res.status === 404) {
        // A CLEAN receipt-not-found is a 404 whose JSON body is the
        // receiver's own {found:false} — the gateway returns exactly
        // that shape for a missing receipt. Any other 404 (an error
        // body, no body) is a missing/broken ROUTE: a config block,
        // not a not-found.
        const body404 = await res.json().catch(() => null) as any;
        if (body404 && typeof body404 === 'object' && body404.found === false) return { found: false };
        throw new CallbackLookupBlocked('RECEIVER_LOOKUP_ROUTE_404');
      }
      if (!res.ok) throw new CallbackOutcomeUnknown(`RECEIVER_LOOKUP_${res.status}`);
      const body = await res.json().catch(() => null) as any;
      if (!body || typeof body !== 'object') throw new CallbackOutcomeUnknown('LOOKUP_MALFORMED');
      return body;
    } catch (e: any) {
      if (e instanceof CallbackLookupBlocked) throw e;
      if (e instanceof CallbackOutcomeUnknown) throw e;
      if (e?.name === 'AbortError') throw new CallbackOutcomeUnknown('LOOKUP_TIMEOUT');
      throw new CallbackOutcomeUnknown('LOOKUP_TRANSPORT_ERROR');
    } finally { clearTimeout(timer); }
  };
}
