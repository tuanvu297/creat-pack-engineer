// PG proof for the OAuth store (root QA O2): the family
// revocation tombstone holds against a REAL Postgres, including
// the concurrent issuance race. Local test database only
// (AGY_TEST_DATABASE_URL); labelled as such - this is NOT a
// live/hosted proof. The race is driven by pausing the guarded
// refresh INSERT mid-flight while revokeFamily commits.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createPgOAuthStore, sha256hex } from "../oauth-store.mjs";

test('pg oauth store: tombstone wins the issuance race; codes are single-use',
{ skip: !process.env.AGY_TEST_DATABASE_URL, timeout: 120000 }, async () => {
  const { Pool } = await import('pg');
  const schema = `agy_oauth_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL });
  const pool = new Pool({ connectionString: process.env.AGY_TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const ddl = await readFile(new URL('../migrations/001_oauth_store.sql', import.meta.url), 'utf8');
    await pool.query(ddl);
    const q = (sql, params) => pool.query(sql, params);
    const store = createPgOAuthStore(q);
    const F = 'fam-pg-1';
    const codeRec = { codeHash: sha256hex('c1'), clientId: 'cl', redirectUri: 'https://oauth-redirect.googleusercontent.com/r/p',
      codeChallenge: 'ch', scopes: ['agy.read'], resource: 'https://h/mcp', subject: 'W1', familyId: F, expiresAt: Date.now() + 300_000 };
    await store.putCode(codeRec);
    assert.ok(await store.consumeCode(codeRec.codeHash), 'first consume succeeds');
    assert.equal(await store.consumeCode(codeRec.codeHash), null, 'second consume is refused (single-use)');
    const tok = (h, kind) => ({ tokenHash: h, clientId: 'cl', subject: 'W1', scopes: ['agy.read'],
      resource: 'https://h/mcp', familyId: F, expiresAt: Date.now() + 3_600_000, revoked: false });
    await store.putAccess(tok('a1'));
    assert.ok(await store.getAccess('a1'));

    // Race: pause the guarded refresh INSERT, revoke, resume.
    let release; const gate = new Promise((r) => { release = r; });
    let entered = false;
    const gatedQ = async (sql, params) => {
      if (sql.includes('agy_oauth_tokens') && sql.includes("'refresh'")) { entered = true; await gate; }
      return q(sql, params);
    };
    const racing = createPgOAuthStore(gatedQ);
    const attempt = racing.putRefresh(tok('r1')).then(() => 'inserted', (e) => e.code ?? e.message);
    for (let i = 0; i < 200 && !entered; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(entered, 'refresh insert is in flight');
    await store.revokeFamily(F);
    release();
    const outcome = await attempt;
    const row = await store.getRefresh('r1');
    assert.ok(outcome === 'FAMILY_REVOKED' || (row && row.revoked === true),
      `the raced refresh is either refused or revoked (outcome=${outcome}, row=${JSON.stringify(row)})`);
    assert.ok(!row || row.revoked === true, 'no live refresh survives the revocation');
    assert.equal(await store.isFamilyRevoked(F), true);
    // And after revocation, issuance into the family is refused outright.
    await assert.rejects(() => store.putAccess(tok('a2')), /FAMILY_REVOKED/);
    await assert.rejects(() => store.putRefresh(tok('r2')), /FAMILY_REVOKED/);
    const acc = await store.getAccess('a1');
    assert.equal(acc.revoked, true, 'pre-existing access was marked revoked');
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
