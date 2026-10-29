import type { Pool } from 'pg';
import { ProjectPool } from './scoped-pool.js';
import { validateScope, type ProjectScope } from './scope.js';
import { authorize, type Principal } from './auth.js';
import { digestOf, stableStringify, isDigestHex } from './digest.js';

// Callback receiver — the canonical host side of the delivery protocol
// (candidate, AGY-GLSEO-ROUTE-QUALIFY-20261027; hardened per QA U1).
// Wired into the gateway as:
//   POST /v1/callbacks/tenants/:t/workspaces/:w/projects/:p/receive
//   GET  /v1/callbacks/tenants/:t/workspaces/:w/projects/:p/receive/:id
// behind the existing bearer authentication.
//
// Authorization (U1): a role label is not scope authority. Both
// handlers require an operator / platform-admin principal AND
// authorize(principal, scope, 'write' | 'read') against the scope in
// the path — an operator provisioned for project A gets 403 on project
// B's path and writes zero rows.
//
// Tuple validation (U1, V1): a receipt is issued only for a callback
// that exists in the immutable canonical outbox (agy_worker_callbacks)
// with EXACTLY matching task_id, attempt, worker_id and target; the
// digest must be 64-hex and equal BOTH the outbox content_digest AND
// a fresh recomputation over the outbox payload; the body's payload
// must be canonically identical to the outbox payload. This canonical
// check runs on EVERY delivery, first and replay alike — the
// existing-receipt fast path never bypasses it, so a mutated payload
// under a known id/digest conflicts instead of being accepted. A
// fabricated tuple gets no receipt.
//
// Idempotency: agy_callback_receipts is keyed by callback_id; the
// effect (the persisted receipt) happens once — replays return the
// original receipt with effect_count still 1.
//
// Scope note: this receipt proves the canonical host recorded the
// callback durably. It does NOT prove native ingestion by the
// ChatGPT client; that remains a separate, unproven gate.
export function createCallbackReceiver(raw: Pool) {
  const guard = (principal: Principal, scope: ProjectScope, action: 'read' | 'write') => {
    if (principal.role !== 'operator' && principal.role !== 'platform-admin') throw new Error('ACTION_DENIED');
    authorize(principal, scope, action);
  };
  const tupleOf = (r: any) => ({ task_id: String(r.task_id), attempt: Number(r.attempt),
    worker_id: r.worker_id ?? null, target: r.target ?? null, content_digest: String(r.content_digest) });
  const sameTuple = (a: any, b: any) => a.task_id === b.task_id && a.attempt === b.attempt
    && a.worker_id === b.worker_id && a.target === b.target && a.content_digest === b.content_digest;
  return {
    async receive(principal: Principal, scope: ProjectScope, body: any) {
      validateScope(scope); guard(principal, scope, 'write');
      const callbackId = String(body?.callback_id ?? '');
      const taskId = String(body?.task_id ?? '');
      if (!/^[a-f0-9-]{36}$/.test(callbackId) || !/^[a-f0-9-]{36}$/.test(taskId)) throw new Error('CALLBACK_ID_REQUIRED');
      if (!isDigestHex(body?.content_digest)) throw new Error('CALLBACK_DIGEST_INVALID');
      if (!Number.isInteger(body?.attempt) || Number(body.attempt) < 1) throw new Error('CALLBACK_TUPLE_INVALID');
      if (typeof body?.worker_id !== 'string' || !body.worker_id || typeof body?.target !== 'string' || !body.target) throw new Error('CALLBACK_TUPLE_INVALID');
      const claimed = tupleOf(body);
      const pool = new ProjectPool(raw, scope, principal.subject).asPool();
      // Canonical validation runs on EVERY delivery — first AND replay
      // (V1): the tuple must match the immutable outbox row, the digest
      // must recompute from the outbox payload itself, and the body's
      // payload must be canonically identical to the outbox payload.
      // The existing-receipt fast path below may only decide
      // duplicate-vs-conflict AFTER this check, so a mutated payload
      // under a known callback_id/digest is a conflict, never an
      // acceptance.
      const outbox = (await pool.query(`SELECT * FROM agy_worker_callbacks WHERE callback_id=$1`, [callbackId])).rows[0];
      if (!outbox) throw new Error('CALLBACK_NOT_FOUND');
      if (!sameTuple(tupleOf(outbox), claimed)) throw new Error('CALLBACK_TUPLE_CONFLICT');
      if (digestOf(outbox.payload) !== outbox.content_digest) throw new Error('CALLBACK_DIGEST_CONFLICT');
      if (stableStringify(body?.payload ?? null) !== stableStringify(outbox.payload)) throw new Error('CALLBACK_TUPLE_CONFLICT');
      // Replay path: an existing receipt decides duplicates/conflicts.
      const existing = (await pool.query(`SELECT * FROM agy_callback_receipts WHERE callback_id=$1`, [callbackId])).rows[0];
      if (existing) {
        if (!sameTuple(tupleOf(existing), claimed)) throw new Error('CALLBACK_TUPLE_CONFLICT');
        return { accepted: true, idempotency_key: callbackId, task_id: taskId, attempt: claimed.attempt,
          content_digest: claimed.content_digest,
          received_at: existing.received_at, effect_count: Number(existing.effect_count), duplicate: true };
      }
      const inserted = await pool.query(
        `INSERT INTO agy_callback_receipts(callback_id,task_id,attempt,worker_id,target,content_digest)
         VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (callback_id) DO NOTHING RETURNING received_at`,
        [callbackId, taskId, claimed.attempt, claimed.worker_id, claimed.target, claimed.content_digest]);
      if (inserted.rowCount) {
        return { accepted: true, idempotency_key: callbackId, task_id: taskId, attempt: claimed.attempt,
          content_digest: claimed.content_digest,
          received_at: inserted.rows[0].received_at, effect_count: 1, duplicate: false };
      }
      const raced = (await pool.query(`SELECT * FROM agy_callback_receipts WHERE callback_id=$1`, [callbackId])).rows[0];
      if (!raced || !sameTuple(tupleOf(raced), claimed)) throw new Error('CALLBACK_TUPLE_CONFLICT');
      return { accepted: true, idempotency_key: callbackId, task_id: taskId, attempt: claimed.attempt,
        content_digest: claimed.content_digest,
        received_at: raced.received_at, effect_count: Number(raced.effect_count), duplicate: true };
    },
    async lookup(principal: Principal, scope: ProjectScope, callbackId: string) {
      validateScope(scope); guard(principal, scope, 'read');
      if (!/^[a-f0-9-]{36}$/.test(callbackId)) throw new Error('CALLBACK_ID_REQUIRED');
      const pool = new ProjectPool(raw, scope, principal.subject).asPool();
      const row = (await pool.query(`SELECT * FROM agy_callback_receipts WHERE callback_id=$1`, [callbackId])).rows[0];
      if (!row) return { found: false };
      // Full receipt identity for reconciliation — never digest-only.
      return { found: true, callback_id: row.callback_id, task_id: row.task_id, attempt: Number(row.attempt),
        worker_id: row.worker_id, target: row.target, content_digest: row.content_digest,
        received_at: row.received_at, effect_count: Number(row.effect_count) };
    },
  };
}
