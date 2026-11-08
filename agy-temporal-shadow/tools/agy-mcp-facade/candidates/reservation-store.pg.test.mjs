import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgReservationStore } from './reservation-store.pg.mjs';

function fakePool() {
  const rows = [];
  const state = { failCommit: false, rows };
  const client = {
    pending: [],
    async query(sql, args = []) {
      if (sql === 'BEGIN') { this.pending = []; return { rows: [] }; }
      if (sql === 'ROLLBACK') { this.pending = []; return { rows: [] }; }
      if (sql === 'COMMIT') {
        if (state.failCommit) throw new Error('CONNECTION_LOST_DURING_COMMIT');
        rows.push(...this.pending); this.pending = []; return { rows: [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT operation_id::text')) {
        const row = rows.find(r => r.identity_id === args[0] && r.run_id === args[1] && r.idempotency_key === args[2]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('AND nonce = $3')) return { rows: rows.some(r => r.identity_id === args[0] && r.run_id === args[1] && r.nonce === args[2]) ? [{ '?column?': 1 }] : [] };
      if (sql.includes('count(*)::int')) return { rows: [{ n: rows.filter(r => r.identity_id === args[0] && r.run_id === args[1]).length }] };
      if (sql.includes('INSERT INTO')) {
        this.pending.push({ operation_id: args[0], identity_id: args[1], run_id: args[2], task_id: args[3], attempt_id: args[4], idempotency_key: args[5], binding_digest: args[6], nonce: args[7] });
        return { rows: [] };
      }
      throw new Error(`UNHANDLED_SQL: ${sql}`);
    },
    release() {},
  };
  state.connect = async () => client;
  state.query = async (sql, args) => client.query(sql, args);
  return state;
}

const input = { identityId: 'worker-a', runId: 'run-a', taskId: 'task-a', attemptId: 'attempt-1',
  idempotencyKey: 'a'.repeat(64), bindingDigest: 'b'.repeat(64), nonce: 'c'.repeat(64),
  timestampMs: 100000, rateLimit: 2, rateWindowMs: 60000 };

test('reserves once and resolves the same operation from durable identity', async () => {
  const pool = fakePool(); const store = createPgReservationStore(pool);
  const first = await store.reserve(input);
  const second = await store.reserve(input);
  assert.equal(first.status, 'NEW');
  assert.equal(second.status, 'EXISTING');
  assert.equal(first.operationId, second.operationId);
  assert.equal(pool.rows.length, 1);
  assert.equal((await store.lookup(input)).binding_digest, input.bindingDigest);
});

test('changing the immutable binding under the same key is denied', async () => {
  const store = createPgReservationStore(fakePool());
  await store.reserve(input);
  await assert.rejects(store.reserve({ ...input, bindingDigest: 'd'.repeat(64) }), /RESERVATION_BINDING_CONFLICT/);
});

test('nonce replay and new-operation rate cap are denied', async () => {
  const store = createPgReservationStore(fakePool());
  await store.reserve(input);
  await assert.rejects(store.reserve({ ...input, taskId: 'task-b', idempotencyKey: 'd'.repeat(64) }), /NONCE_REPLAY/);
  await store.reserve({ ...input, taskId: 'task-b', idempotencyKey: 'd'.repeat(64), nonce: 'e'.repeat(64) });
  await assert.rejects(store.reserve({ ...input, taskId: 'task-c', idempotencyKey: 'f'.repeat(64), nonce: 'f'.repeat(64) }), /RATE_LIMITED/);
});

test('unknown COMMIT outcome requires reconciliation before retry', async () => {
  const pool = fakePool(); const store = createPgReservationStore(pool);
  pool.failCommit = true;
  await assert.rejects(store.reserve(input), /RESERVATION_UNCERTAIN/);
  assert.equal(await store.lookup(input), null);
});

