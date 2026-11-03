// Unit tests (fake pool, NO Postgres) for the scoped-pool
// transaction classifier: caller transaction statements must
// be honoured in all their documented spellings, and
// savepoint statements must never be auto-wrapped away.
import test from "node:test";
import assert from "node:assert/strict";
import { ProjectPool, classifyTx } from "../src/platform/scoped-pool.js";

test('classifyTx: BEGIN variants, COMMIT/ROLLBACK ends, ROLLBACK TO and SAVEPOINT are in-tx statements', () => {
  for (const sql of ['BEGIN', 'BEGIN;', 'begin', '  BEGIN  ', 'BEGIN ISOLATION LEVEL SERIALIZABLE', 'BEGIN TRANSACTION', 'START TRANSACTION'])
    assert.equal(classifyTx(sql), 'BEGIN', sql);
  for (const sql of ['COMMIT', 'COMMIT;', 'ROLLBACK', 'ROLLBACK;'])
    assert.equal(classifyTx(sql), 'END', sql);
  assert.equal(classifyTx('ROLLBACK TO SAVEPOINT s1'), 'TX_STATEMENT');
  assert.equal(classifyTx('SAVEPOINT s1'), 'TX_STATEMENT');
  assert.equal(classifyTx('RELEASE SAVEPOINT s1'), 'TX_STATEMENT');
  assert.equal(classifyTx('SELECT 1'), 'STATEMENT');
  assert.equal(classifyTx('UPDATE t SET x=1'), 'STATEMENT');
});

test('scoped pool honours BEGIN ISOLATION LEVEL ... : no wrapper BEGIN, no early COMMIT', async () => {
  const issued: string[] = [];
  const fakeClient: any = {
    query: async (sql: string) => { issued.push(sql); return { rows: [], rowCount: 0 }; },
    release: () => {},
  };
  const fakePool: any = { connect: async () => fakeClient };
  const pp = new ProjectPool(fakePool, { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'P' }, 'test');
  const client = await pp.connect();
  await (client as any).query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  await (client as any).query('SELECT 1');
  await (client as any).query('SAVEPOINT s1');
  await (client as any).query('ROLLBACK TO SAVEPOINT s1');
  await (client as any).query('COMMIT;');
  const begins = issued.filter(q => /^\s*BEGIN/i.test(q));
  assert.equal(begins.length, 1, `exactly the caller's BEGIN, got: ${JSON.stringify(issued)}`);
  assert.ok(issued[0].includes('ISOLATION LEVEL SERIALIZABLE'), 'the caller BEGIN (with its isolation) is what reached the server');
  assert.equal(issued.filter(q => /^\s*COMMIT/i.test(q)).length, 1, 'no wrapper COMMIT before the caller COMMIT');
  // A savepoint outside a transaction is refused, not auto-wrapped away.
  const client2 = await pp.connect();
  await assert.rejects(() => (client2 as any).query('SAVEPOINT lone'), /TX_REQUIRED/);
});
