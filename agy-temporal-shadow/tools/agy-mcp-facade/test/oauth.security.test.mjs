// Security regressions for root QA O1/O2 (2026-11-03), provider
// + in-memory store level. O1: a token must not outlive its
// client's registration (removal, subject change, scope
// narrowing) even over a shared persistent store. O2: a family
// revocation racing token issuance must win - durably.
import test from "node:test";
import assert from "node:assert/strict";
import { createAgyOAuthProvider } from "../oauth-provider.mjs";
import { InMemoryOAuthStore, sha256hex } from "../oauth-store.mjs";

const CLIENT = { client_id: 'test-client', client_secret: 's3cret', client_name: 'Test',
  redirect_uris: ['https://oauth-redirect.googleusercontent.com/r/p'], scopes: ['agy.read'],
  subject: 'WORKER-1', refresh_mode: 'rotate' };
const RESOURCE = 'http://127.0.0.1:9/mcp';
const mk = (store, clients) => createAgyOAuthProvider({ store, clients, operatorSecret: 'op',
  signingSecret: 'sig', resourceUrl: RESOURCE });
const seedCode = async (store, familyId) => {
  const code = `code-${familyId}`;
  await store.putCode({ codeHash: sha256hex(code), clientId: CLIENT.client_id, redirectUri: CLIENT.redirect_uris[0],
    codeChallenge: 'ch', scopes: ['agy.read'], resource: RESOURCE, subject: CLIENT.subject,
    familyId, expiresAt: Date.now() + 300_000, used: false });
  return code;
};
const fakeClient = { client_id: CLIENT.client_id };

test('O1: removing, re-binding or narrowing a client kills its outstanding tokens (shared store)', async () => {
  const store = new InMemoryOAuthStore();
  const p1 = mk(store, [CLIENT]);
  const code = await seedCode(store, 'fam-o1');
  const tokens = await p1.exchangeAuthorizationCode(fakeClient, code, undefined, CLIENT.redirect_uris[0], undefined);
  assert.ok(tokens.access_token);
  assert.equal((await p1.verifyAccessToken(tokens.access_token)).extra.subject, 'WORKER-1', 'baseline: token verifies');

  const removed = mk(store, []);
  await assert.rejects(() => removed.verifyAccessToken(tokens.access_token), /no longer registered/);
  await assert.rejects(() => removed.exchangeRefreshToken(fakeClient, tokens.refresh_token, undefined, undefined), /no longer registered/);

  const rebound = mk(store, [{ ...CLIENT, subject: 'WORKER-2' }]);
  await assert.rejects(() => rebound.verifyAccessToken(tokens.access_token), /subject binding changed/);

  const narrowed = mk(store, [{ ...CLIENT, scopes: [] }]);
  await assert.rejects(() => narrowed.verifyAccessToken(tokens.access_token), /current ceiling/);
});

test('O2: a revocation landing between putAccess and putRefresh leaves NO usable refresh (root repro)', async () => {
  const inner = new InMemoryOAuthStore();
  let release; const gate = new Promise((r) => { release = r; });
  let putRefreshEntered = false;
  // A plain delegating wrapper (a Proxy would break the store
  // class's private-method brand checks).
  const store = {
    isFamilyRevoked: (f) => inner.isFamilyRevoked(f),
    putCode: (r) => inner.putCode(r), getCode: (h) => inner.getCode(h), consumeCode: (h) => inner.consumeCode(h),
    putAccess: (r) => inner.putAccess(r), getAccess: (h) => inner.getAccess(h),
    putRefresh: async (rec) => { putRefreshEntered = true; await gate; return inner.putRefresh(rec); },
    getRefresh: (h) => inner.getRefresh(h), rotateRefresh: (o, n) => inner.rotateRefresh(o, n),
    extendRefresh: (h, e) => inner.extendRefresh(h, e),
    revokeFamily: (f) => inner.revokeFamily(f), revokeToken: (h) => inner.revokeToken(h),
  };
  const p = mk(store, [CLIENT]);
  const code = await seedCode(store, 'fam-race');
  const exchange = p.exchangeAuthorizationCode(fakeClient, code, undefined, CLIENT.redirect_uris[0], undefined);
  // Wait until issuance is blocked inside putRefresh, then revoke.
  for (let i = 0; i < 100 && !putRefreshEntered; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(putRefreshEntered, 'issuance reached the blocked putRefresh');
  await inner.revokeFamily('fam-race');
  release();
  await assert.rejects(() => exchange, /revoked/, 'issuance into a just-revoked family is a grant error, not a pair');
  const refreshRecs = [...inner.refresh.values()].filter((r) => r.familyId === 'fam-race');
  assert.ok(refreshRecs.every((r) => r.revoked === true), 'no live refresh record exists for the revoked family');
  const accessRecs = [...inner.access.values()].filter((r) => r.familyId === 'fam-race');
  assert.ok(accessRecs.every((r) => r.revoked === true), 'the first-written access record was revoked too');
  assert.equal(await inner.isFamilyRevoked('fam-race'), true);
});

test('O2b: revocation before exchange blocks minting entirely; revoke is durable for unknown families', async () => {
  const store = new InMemoryOAuthStore();
  const p = mk(store, [CLIENT]);
  const code = await seedCode(store, 'fam-pre');
  await store.revokeFamily('fam-pre');
  await assert.rejects(() => p.exchangeAuthorizationCode(fakeClient, code, undefined, CLIENT.redirect_uris[0], undefined), /revoked/);
  await store.revokeFamily('fam-never-existed');
  assert.equal(await store.isFamilyRevoked('fam-never-existed'), true, 'tombstone exists even with no tokens');
});
