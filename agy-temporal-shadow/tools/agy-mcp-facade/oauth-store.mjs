// OAuth store for the AGY MCP facade (candidate v0.3.1).
//
// Everything secret-shaped is stored HASHED (sha256): codes,
// access tokens, refresh tokens. The store interface is async
// and deliberately tiny so the in-memory implementation (tests
// and explicit dev mode) and the Postgres implementation
// (deploy; migrations/001_oauth_store.sql) are interchangeable.
//
// Security semantics the provider relies on:
//  - consumeCode is ATOMIC and single-use; consumed codes leave
//    a tombstone carrying their token family so a REPLAYED code
//    can be detected and its whole family revoked.
//  - FAMILY REVOCATION IS A DURABLE TOMBSTONE (root QA O2):
//    every family is born at putCode in a families registry.
//    revokeFamily sets the family's revoked flag AND marks its
//    existing tokens. putAccess / putRefresh / rotateRefresh
//    CHECK the tombstone inside the same store operation that
//    writes - in Postgres the guarded INSERT takes the family
//    row lock (SELECT ... FOR UPDATE in a CTE), so a revocation
//    racing an issuance either lands first (the insert then
//    writes nothing and throws FAMILY_REVOKED) or waits for the
//    insert and then marks the just-written token revoked. A
//    token can never be minted into a revoked family.
//  - refresh tokens rotate inside a family; presenting an
//    already-rotated refresh token is treated as theft and the
//    provider revokes the family.
import { createHash } from 'node:crypto';

export const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
export const familyRevokedError = () => { const e = new Error('FAMILY_REVOKED'); e.code = 'FAMILY_REVOKED'; return e; };

export class InMemoryOAuthStore {
  constructor() {
    this.codes = new Map();        // codeHash -> record
    this.access = new Map();       // tokenHash -> record
    this.refresh = new Map();      // tokenHash -> record
    this.families = new Map();     // familyId -> { revoked }
  }
  #family(id) { if (!this.families.has(id)) this.families.set(id, { revoked: false }); return this.families.get(id); }
  async isFamilyRevoked(familyId) { return this.families.get(familyId)?.revoked === true; }
  async putCode(rec) { this.#family(rec.familyId); this.codes.set(rec.codeHash, { ...rec }); }
  async getCode(codeHash) { return this.codes.get(codeHash) ?? null; }
  async consumeCode(codeHash) {
    const rec = this.codes.get(codeHash);
    if (!rec || rec.used) return null;
    rec.used = true;               // tombstone kept for replay detection
    return rec;
  }
  async putAccess(rec) {
    if (this.#family(rec.familyId).revoked) throw familyRevokedError();
    this.access.set(rec.tokenHash, { ...rec });
  }
  async getAccess(tokenHash) { return this.access.get(tokenHash) ?? null; }
  async putRefresh(rec) {
    if (this.#family(rec.familyId).revoked) throw familyRevokedError();
    this.refresh.set(rec.tokenHash, { ...rec });
  }
  async getRefresh(tokenHash) { return this.refresh.get(tokenHash) ?? null; }
  async rotateRefresh(oldHash, newRec) {
    if (this.#family(newRec.familyId).revoked) throw familyRevokedError();
    const old = this.refresh.get(oldHash);
    if (!old || old.revoked || old.rotatedTo) return null;
    old.rotatedTo = newRec.tokenHash;
    this.refresh.set(newRec.tokenHash, { ...newRec });
    return old;
  }
  async extendRefresh(tokenHash, expiresAt) {
    const rec = this.refresh.get(tokenHash);
    if (rec) rec.expiresAt = expiresAt;
  }
  async revokeFamily(familyId) {
    this.#family(familyId).revoked = true;
    for (const m of [this.access, this.refresh])
      for (const rec of m.values()) if (rec.familyId === familyId) rec.revoked = true;
  }
  async revokeToken(tokenHash) {
    const a = this.access.get(tokenHash); if (a) a.revoked = true;
    const r = this.refresh.get(tokenHash); if (r) r.revoked = true;
  }
}

// Postgres-backed store. `query` is an injected
// (sql, params) => Promise<{rows}> function wired by the
// entrypoint to the `pg` pool (a declared, locked dependency -
// see package.json / package-lock.json). Table DDL lives in
// migrations/001_oauth_store.sql (applied at deploy, never by
// this code).
const mapCode = (r) => r && ({ codeHash: r.code_hash, clientId: r.client_id, redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge, scopes: r.scopes, resource: r.resource, subject: r.subject,
  familyId: r.family_id, expiresAt: new Date(r.expires_at).getTime(), used: r.used });
const mapToken = (r) => r && ({ tokenHash: r.token_hash, clientId: r.client_id, subject: r.subject,
  scopes: r.scopes, resource: r.resource, familyId: r.family_id,
  expiresAt: new Date(r.expires_at).getTime(), revoked: r.revoked, rotatedTo: r.rotated_to ?? undefined });


export function createPgOAuthStore(query, opts = {}) {
  // Dedicated schema (release requirement): every table
  // reference is qualified, so the facade can never bleed into
  // the database's default `public` schema regardless of the
  // connection's search_path.
  const schema = opts.schema ?? 'agy_oauth';
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('oauth store: invalid schema name');
  const T = (n) => `${schema}.${n}`;
  const one = async (sql, params) => (await query(sql, params)).rows[0] ?? null;
  // Guarded token insert: the CTE locks the family row FOR
  // UPDATE and the INSERT only proceeds while the family is
  // unrevoked (see the header note on the revocation race).
  const guardedInsert = (kind) => `
    WITH f AS (SELECT 1 FROM ${T('agy_oauth_families')} WHERE family_id=$6 AND revoked=false FOR UPDATE)
    INSERT INTO ${T('agy_oauth_tokens')}(token_hash, kind, client_id, subject, scopes, resource, family_id, expires_at)
    SELECT $1, '${kind}', $2, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM f) RETURNING token_hash`;
  const putToken = (kind) => async (rec) => {
    const row = await one(guardedInsert(kind),
      [rec.tokenHash, rec.clientId, rec.subject, rec.scopes, rec.resource, rec.familyId, new Date(rec.expiresAt)]);
    if (!row) throw familyRevokedError();
  };
  return {
    async isFamilyRevoked(familyId) {
      const r = await one(`SELECT revoked FROM ${T('agy_oauth_families')} WHERE family_id=$1`, [familyId]);
      return r?.revoked === true;
    },
    async putCode(rec) {
      await query(`INSERT INTO ${T('agy_oauth_families')}(family_id) VALUES($1) ON CONFLICT (family_id) DO NOTHING`, [rec.familyId]);
      await query(`INSERT INTO ${T('agy_oauth_codes')}(code_hash, client_id, redirect_uri, code_challenge, scopes, resource, subject, family_id, expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [rec.codeHash, rec.clientId, rec.redirectUri, rec.codeChallenge, rec.scopes, rec.resource, rec.subject, rec.familyId, new Date(rec.expiresAt)]);
    },
    async getCode(codeHash) { return mapCode(await one(`SELECT * FROM ${T('agy_oauth_codes')} WHERE code_hash=$1`, [codeHash])); },
    async consumeCode(codeHash) {
      // Single-use enforced by the conditional UPDATE itself.
      return mapCode(await one(`UPDATE ${T('agy_oauth_codes')} SET used=true WHERE code_hash=$1 AND used=false RETURNING *`, [codeHash]));
    },
    putAccess: putToken('access'),
    async getAccess(tokenHash) { return mapToken(await one(`SELECT * FROM ${T('agy_oauth_tokens')} WHERE token_hash=$1 AND kind='access'`, [tokenHash])); },
    putRefresh: putToken('refresh'),
    async getRefresh(tokenHash) { return mapToken(await one(`SELECT * FROM ${T('agy_oauth_tokens')} WHERE token_hash=$1 AND kind='refresh'`, [tokenHash])); },
    async rotateRefresh(oldHash, newRec) {
      if (await this.isFamilyRevoked(newRec.familyId)) throw familyRevokedError();
      const old = await one(`UPDATE ${T('agy_oauth_tokens')} SET rotated_to=$2 WHERE token_hash=$1 AND kind='refresh' AND revoked=false AND rotated_to IS NULL RETURNING *`, [oldHash, newRec.tokenHash]);
      if (!old) return null;
      await this.putRefresh(newRec);   // tombstone-guarded; may throw FAMILY_REVOKED on a race
      return mapToken(old);
    },
    async extendRefresh(tokenHash, expiresAt) { await query(`UPDATE ${T('agy_oauth_tokens')} SET expires_at=$2 WHERE token_hash=$1 AND kind='refresh'`, [tokenHash, new Date(expiresAt)]); },
    async revokeFamily(familyId) {
      await query(`INSERT INTO ${T('agy_oauth_families')}(family_id, revoked) VALUES($1, true)
        ON CONFLICT (family_id) DO UPDATE SET revoked=true`, [familyId]);
      await query(`UPDATE ${T('agy_oauth_tokens')} SET revoked=true WHERE family_id=$1`, [familyId]);
    },
    async revokeToken(tokenHash) { await query(`UPDATE ${T('agy_oauth_tokens')} SET revoked=true WHERE token_hash=$1`, [tokenHash]); },
  };
}
