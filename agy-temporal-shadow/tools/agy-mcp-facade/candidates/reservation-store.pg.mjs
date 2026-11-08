import { randomUUID } from 'node:crypto';

// Inject a pg.Pool; the module deliberately owns no connection string or key.
// The DB role needs only USAGE on agy_dispatch and SELECT/INSERT on its table.
export function createPgReservationStore(pool) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PG_POOL_REQUIRED');

  async function lookup({ identityId, runId, idempotencyKey, bindingDigest }) {
    if (typeof bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(bindingDigest))
      throw new Error('BINDING_DIGEST_REQUIRED');
    const result = await pool.query(
      `SELECT operation_id::text AS operation_id, task_id, attempt_id, binding_digest
         FROM agy_dispatch.reservations
        WHERE identity_id = $1 AND run_id = $2 AND idempotency_key = $3`,
      [identityId, runId, idempotencyKey]);
    const row = result.rows[0] ?? null;
    if (row && row.binding_digest !== bindingDigest) throw new Error('RESERVATION_BINDING_CONFLICT');
    return row;
  }

  async function reserve(input) {
    const { identityId, runId, taskId, attemptId, idempotencyKey, bindingDigest,
      nonce, rateLimit, rateWindowMs } = input;
    const client = await pool.connect();
    let wrote = false;
    let committing = false;
    try {
      await client.query('BEGIN');
      // This lock serializes all reservations within one identity/run, including
      // rate checks. A hash collision can only reduce concurrency, not admit work.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [identityId, runId]);
      const prior = await client.query(
        `SELECT operation_id::text AS operation_id, task_id, attempt_id, binding_digest
           FROM agy_dispatch.reservations
          WHERE identity_id = $1 AND run_id = $2 AND idempotency_key = $3 FOR UPDATE`,
        [identityId, runId, idempotencyKey]);
      if (prior.rows.length) {
        const row = prior.rows[0];
        if (row.task_id !== taskId || row.attempt_id !== attemptId || row.binding_digest !== bindingDigest)
          throw new Error('RESERVATION_BINDING_CONFLICT');
        await client.query('COMMIT');
        return { status: 'EXISTING', operationId: row.operation_id, taskId: row.task_id, bindingDigest: row.binding_digest };
      }
      const nonceUsed = await client.query(
        `SELECT 1 FROM agy_dispatch.reservations
          WHERE identity_id = $1 AND run_id = $2 AND nonce = $3 LIMIT 1`,
        [identityId, runId, nonce]);
      if (nonceUsed.rows.length) throw new Error('NONCE_REPLAY');
      const count = await client.query(
        `SELECT count(*)::int AS n FROM agy_dispatch.reservations
          WHERE identity_id = $1 AND run_id = $2
            AND created_at >= clock_timestamp() - ($3::bigint * interval '1 millisecond')`,
        [identityId, runId, rateWindowMs]);
      if (count.rows[0].n >= rateLimit) throw new Error('RATE_LIMITED');
      const operationId = randomUUID();
      await client.query(
        `INSERT INTO agy_dispatch.reservations
           (operation_id, identity_id, run_id, task_id, attempt_id, idempotency_key, binding_digest, nonce)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
        [operationId, identityId, runId, taskId, attemptId, idempotencyKey, bindingDigest, nonce]);
      wrote = true;
      committing = true;
      await client.query('COMMIT');
      committing = false;
      return { status: 'NEW', operationId, taskId, bindingDigest };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      if (wrote || committing) {
        const uncertain = new Error('RESERVATION_UNCERTAIN');
        uncertain.cause = error;
        throw uncertain;
      }
      throw error;
    } finally {
      client.release();
    }
  }

  return { reserve, lookup };
}

