// OAuth store for the AGY MCP facade (candidate v0.3).
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
//  - refresh tokens rotate inside a family; presenting an
//    already-rotated refresh token is treated as theft and the
//    provider revokes the family.
import { createHash } from 'node:crypto';

export const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');

export class InMemoryOAuthStore {
  constructor() {
    this.codes = new Map();        // codeHash -> record
    this.access = new Map();       // tokenHash -> record
    this.refresh = new Map();      // tokenHash -> record
  }
  async putCode(rec) { this.codes.set(rec.codeHash, { ...rec }); }
  async getCode(codeHash) { return this.codes.get(codeHash) ?? null; }
  async consumeCode(codeHash) {
    const rec = this.codes.get(codeHash);
    if (!rec || rec.used) return null;
    rec.used = true;               // tombstone kept for replay detection
    return rec;
  }
  async putAccess(rec) { this.access.set(rec.tokenHash, { ...rec }); }
  async getAccess(tokenHash) { return this.access.get(tokenHash) ?? null; }
  async putRefresh(rec) { this.refresh.set(rec.tokenHash, { ...rec }); }
  async getRefresh(tokenHash) { return this.refresh.get(tokenHash) ?? null; }
  async rotateRefresh(oldHash, newRec) {
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
    for (const m of [this.access, this.refresh])
      for (const rec of m.values()) if (rec.familyId === familyId) rec.revoked = true;
  }
  async revokeToken(tokenHash) {
    const a = this.access.get(tokenHash); if (a) a.revoked = true;
    const r = this.refresh.get(tokenHash); if (r) r.revoked = true;
  }
}

// Postgres-backed store. `query` is an injected
// (sql, params) => Promise<{rows}> function so this module does
// not hard-depend on the `pg` package: the deploy entrypoint
// wires the runtime's pool. Table DDL lives in
// migrations/001_oauth_store.sql (applied at deploy, never by
// this code).
const mapCode = (r) => r && ({ codeHash: r.code_hash, clientId: r.client_id, redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge, scopes: r.scopes, resource: r.resource, subject: r.subject,
  familyId: r.family_id, expiresAt: new Date(r.expires_at).getTime(), used: r.used });
const mapToken = (r) => r && ({ tokenHash: r.token_hash, clientId: r.client_id, subject: r.subject,
  scopes: r.scopes, resource: r.resource, familyId: r.family_id,
  expiresAt: new Date(r.expires_at).getTime(), revoked: r.revoked, rotatedTo: r.rotated_to ?? undefined });

export function createPgOAuthStore(query) {
  const one = async (sql, params) => (await query(sql, params)).rows[0] ?? null;
  return {
    async putCode(rec) {
      await query(`INSERT INTO agy_oauth_codes(code_hash, client_id, redirect_uri, code_challenge, scopes, resource, subject, family_id, expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [rec.codeHash, rec.clientId, rec.redirectUri, rec.codeChallenge, rec.scopes, rec.resource, rec.subject, rec.familyId, new Date(rec.expiresAt)]);
    },
    async getCode(codeHash) { return mapCode(await one(`SELECT * FROM agy_oauth_codes WHERE code_hash=$1`, [codeHash])); },
    async consumeCode(codeHash) {
      // Single-use enforced by the conditional UPDATE itself.
      return mapCode(await one(`UPDATE agy_oauth_codes SET used=true WHERE code_hash=$1 AND used=false RETURNING *`, [codeHash]));
    },
    async putAccess(rec) {
      await query(`INSERT INTO agy_oauth_tokens(token_hash, kind, client_id, subject, scopes, resource, family_id, expires_at)
        VALUES($1,'access',$2,$3,$4,$5,$6,$7)`, [rec.tokenHash, rec.clientId, rec.subject, rec.scopes, rec.resource, rec.familyId, new Date(rec.expiresAt)]);
    },
    async getAccess(tokenHash) { return mapToken(await one(`SELECT * FROM agy_oauth_tokens WHERE token_hash=$1 AND kind='access'`, [tokenHash])); },
    async putRefresh(rec) {
      await query(`INSERT INTO agy_oauth_tokens(token_hash, kind, client_id, subject, scopes, resource, family_id, expires_at)
        VALUES($1,'refresh',$2,$3,$4,$5,$6,$7)`, [rec.tokenHash, rec.clientId, rec.subject, rec.scopes, rec.resource, rec.familyId, new Date(rec.expiresAt)]);
    },
    async getRefresh(tokenHash) { return mapToken(await one(`SELECT * FROM agy_oauth_tokens WHERE token_hash=$1 AND kind='refresh'`, [tokenHash])); },
    async rotateRefresh(oldHash, newRec) {
      const old = await one(`UPDATE agy_oauth_tokens SET rotated_to=$2 WHERE token_hash=$1 AND kind='refresh' AND revoked=false AND rotated_to IS NULL RETURNING *`, [oldHash, newRec.tokenHash]);
      if (!old) return null;
      await this.putRefresh(newRec);
      return mapToken(old);
    },
    async extendRefresh(tokenHash, expiresAt) { await query(`UPDATE agy_oauth_tokens SET expires_at=$2 WHERE token_hash=$1 AND kind='refresh'`, [tokenHash, new Date(expiresAt)]); },
    async revokeFamily(familyId) { await query(`UPDATE agy_oauth_tokens SET revoked=true WHERE family_id=$1`, [familyId]); },
    async revokeToken(tokenHash) { await query(`UPDATE agy_oauth_tokens SET revoked=true WHERE token_hash=$1`, [tokenHash]); },
  };
}
