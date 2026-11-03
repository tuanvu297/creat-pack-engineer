// OAuth 2.1 authorization-server provider for the AGY MCP
// facade (candidate v0.3), implemented against the OFFICIAL MCP
// SDK's OAuthServerProvider interface - the SDK's own router
// serves /authorize, /token, /revoke and the RFC 8414 / RFC 9728
// metadata, and its token handler performs the S256 PKCE
// verification (skipLocalPkceValidation stays false). This
// module supplies only the AGY-specific logic:
//
//  - Clients are PRE-REGISTERED by configuration (no dynamic
//    registration method is implemented, so the SDK's register
//    endpoint stays closed). Each client binds: an exact
//    redirect-URI allowlist, a scope ceiling, and an AGY
//    subject (the authenticated identity its tokens act as -
//    a worker or read identity with its own runtime-side
//    restrictions, never a shared operator identity).
//  - Authorization requires the resource OWNER in person: the
//    SDK authorize handler lands in authorize(), which renders
//    a consent page; the code is minted only by
//    handleConsentDecision() after the owner enters the
//    operator approval secret (timing-safe compared, never
//    logged) and approves the exact client/scopes/resource.
//    The consent form carries an HMAC-signed, expiring blob so
//    the decision cannot be forged or altered in transit.
//  - Codes are single-use (5 min), refresh tokens rotate
//    (30 d) inside a family, access tokens live 1 h. A replayed
//    code or a reused (rotated) refresh token revokes the WHOLE
//    family - theft detection, not a retry path.
//  - Every token is audience-bound to the one configured MCP
//    resource URL; verifyAccessToken rejects anything minted
//    for another resource.
//  - Secrets at rest are hashes only (see oauth-store.mjs);
//    the client secrets in configuration are compared by the
//    SDK's client-auth middleware and are never logged here.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { sha256hex } from './oauth-store.mjs';
import { InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const SUPPORTED_SCOPES = ['agy.read'];
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
const CONSENT_TTL_MS = 10 * 60_000;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const newToken = () => b64u(randomBytes(32));
const timingEq = (a, b) => {
  const ba = Buffer.from(String(a ?? '')); const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createAgyOAuthProvider({ store, clients, operatorSecret, signingSecret, resourceUrl, dynamicRegistration, now = Date.now }) {
  if (!store) throw new Error('oauth: store required');
  if (!operatorSecret || !signingSecret) throw new Error('oauth: operatorSecret and signingSecret are required');
  if (!resourceUrl) throw new Error('oauth: resourceUrl required');
  const byId = new Map();
  for (const c of clients ?? []) {
    if (!c.client_id || !c.client_secret || !c.subject) throw new Error('oauth: every client needs client_id, client_secret and subject');
    if (!Array.isArray(c.redirect_uris)) throw new Error(`oauth: client ${c.client_id} needs a redirect_uris array (possibly empty)`);
    // An EMPTY redirect_uris list is legitimate: the client is
    // INERT (every authorize is denied) until the exact redirect
    // URI is captured from a real connect attempt and registered
    // - the supported bootstrap flow in the deploy runbook.
    for (const s of c.scopes ?? []) if (!SUPPORTED_SCOPES.includes(s)) throw new Error(`oauth: client ${c.client_id} requests unsupported scope ${s}`);
    byId.set(c.client_id, c);
  }
  const signBlob = (obj) => {
    const payload = b64u(Buffer.from(JSON.stringify(obj)));
    const mac = createHmac('sha256', signingSecret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  };
  const readBlob = (blob) => {
    const [payload, mac] = String(blob ?? '').split('.');
    if (!payload || !mac) return null;
    const want = createHmac('sha256', signingSecret).update(payload).digest('base64url');
    if (!timingEq(mac, want)) return null;
    try { const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return obj.exp > now() ? obj : null; }
    catch { return null; }
  };

  const provider = {
    get clientsStore() {
      return {
        async getClient(clientId) {
          const c = byId.get(clientId);
          if (!c) return undefined;
          return { client_id: c.client_id, client_secret: c.client_secret, client_name: c.client_name ?? c.client_id,
            redirect_uris: c.redirect_uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
            scope: (c.scopes ?? []).join(' '), token_endpoint_auth_method: 'client_secret_post' };
        },
        // Dynamic Client Registration exists because Gemini's
        // discovery REQUIRES a registration_endpoint in the
        // metadata (Google Connected Apps OAuth guide, read
        // 2026-11-03) - the SDK advertises the endpoint only
        // when this method exists. SUPPORTED STATE: manual
        // registration by configuration is the only supported
        // path; this method REFUSES unless the deployment
        // explicitly enabled DCR, and even then registrations
        // are runtime-only (held in this process's map, NOT
        // persisted - they vanish on restart, and their tokens
        // then fail client-existence verification). It is
        // GATED, not open:
        // registration is refused unless the deployment enabled
        // it (dynamicRegistration), every redirect URI is one of
        // Google's documented oauth-redirect hosts (/r/ or /a/
        // paths), and scopes stay within the supported ceiling.
        // Dynamically registered clients bind to the configured
        // dynamic subject with persistent (non-rotating) refresh,
        // as Google's persistent-linking guidance requires.
        async registerClient(clientInfo) {
          if (!dynamicRegistration?.enabled || !dynamicRegistration.subject)
            throw new InvalidClientMetadataError('dynamic registration is disabled on this server');
          const GOOGLE_REDIRECT_HOSTS = ['oauth-redirect.googleusercontent.com',
            'oauth-redirect-sandbox.googleusercontent.com', 'oauth-redirect-test.googleusercontent.com'];
          for (const uri of clientInfo.redirect_uris ?? []) {
            let u; try { u = new URL(uri); } catch { throw new InvalidClientMetadataError('invalid redirect_uri'); }
            if (u.protocol !== 'https:' || !GOOGLE_REDIRECT_HOSTS.includes(u.hostname)
              || !(u.pathname.startsWith('/r/') || u.pathname.startsWith('/a/')))
              throw new InvalidClientMetadataError('redirect_uri is not a documented Google oauth-redirect URI');
          }
          const scopes = clientInfo.scope ? String(clientInfo.scope).split(' ').filter(Boolean) : ['agy.read'];
          if (scopes.some((s) => !SUPPORTED_SCOPES.includes(s)))
            throw new InvalidClientMetadataError('requested scope exceeds the supported ceiling');
          byId.set(clientInfo.client_id, { client_id: clientInfo.client_id, client_secret: clientInfo.client_secret,
            client_name: clientInfo.client_name, redirect_uris: clientInfo.redirect_uris, scopes,
            subject: dynamicRegistration.subject, refresh_mode: 'persistent', dynamic: true });
          return clientInfo;
        },
      };
    },

    async authorize(client, params, res) {
      const scopes = params.scopes?.length ? params.scopes : [...(client.scope ? String(client.scope).split(' ') : [])];
      const cfg = byId.get(client.client_id);
      const badScope = scopes.find((s) => !SUPPORTED_SCOPES.includes(s) || !(cfg?.scopes ?? []).includes(s));
      if (!cfg || badScope) {
        res.status(400).type('html').send(`<!doctype html><title>Authorization denied</title><h1>Authorization denied</h1><p>Unknown client or scope not allowed for this client.</p>`);
        return;
      }
      const blob = signBlob({ client_id: client.client_id, redirect_uri: params.redirectUri, state: params.state ?? null,
        code_challenge: params.codeChallenge, scopes, resource: params.resource?.toString() ?? resourceUrl, exp: now() + CONSENT_TTL_MS });
      res.status(200).type('html').send(`<!doctype html><title>AGY MCP - owner consent</title>
<h1>Connect a client to the AGY MCP facade</h1>
<p>Client: <b>${esc(client.client_name ?? client.client_id)}</b> (${esc(client.client_id)})<br>
Scopes requested: <b>${esc(scopes.join(' '))}</b><br>Resource: <b>${esc(params.resource?.toString() ?? resourceUrl)}</b></p>
<p>This facade is READ-ONLY in this candidate. Approving mints a single-use authorization code for the identity <b>${esc(cfg.subject)}</b>.</p>
<form method="POST" action="/oauth/consent-decision">
<input type="hidden" name="blob" value="${esc(blob)}">
<label>Operator approval secret <input type="password" name="operator_secret" autocomplete="off" required></label>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</form>`);
    },

    // POST /oauth/consent-decision (mounted by the app, not the
    // SDK router): the owner's in-person decision.
    async handleConsentDecision(req, res) {
      const body = req.body ?? {};
      const blob = readBlob(body.blob);
      if (!blob) { res.status(400).type('html').send('<!doctype html><h1>Consent expired or invalid</h1>'); return; }
      const back = new URL(blob.redirect_uri);
      if (body.decision !== 'approve') {
        back.searchParams.set('error', 'access_denied');
        if (blob.state) back.searchParams.set('state', blob.state);
        res.redirect(302, back.toString()); return;
      }
      if (!timingEq(body.operator_secret, operatorSecret)) {
        res.status(403).type('html').send('<!doctype html><h1>Operator approval failed</h1><p>No code was issued.</p>'); return;
      }
      const cfg = byId.get(blob.client_id);
      if (!cfg || !cfg.redirect_uris.includes(blob.redirect_uri)) {
        res.status(400).type('html').send('<!doctype html><h1>Client or redirect not registered</h1>'); return;
      }
      const code = newToken();
      const familyId = b64u(randomBytes(16));
      await store.putCode({ codeHash: sha256hex(code), clientId: blob.client_id, redirectUri: blob.redirect_uri,
        codeChallenge: blob.code_challenge, scopes: blob.scopes, resource: blob.resource, subject: cfg.subject,
        familyId, expiresAt: now() + CODE_TTL_MS, used: false });
      back.searchParams.set('code', code);
      if (blob.state) back.searchParams.set('state', blob.state);
      res.redirect(302, back.toString());
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const rec = await store.getCode(sha256hex(authorizationCode));
      if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= now())
        throw new InvalidGrantError('authorization code unknown, mismatched or expired');
      return rec.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
      const rec = await store.consumeCode(sha256hex(authorizationCode));
      if (rec && await store.isFamilyRevoked(rec.familyId)) throw new InvalidGrantError('authorization family was revoked');
      if (!rec) {
        // Replay detection: a consumed code presented again
        // revokes everything it ever minted.
        const tomb = await store.getCode(sha256hex(authorizationCode));
        if (tomb?.familyId) await store.revokeFamily(tomb.familyId);
        throw new InvalidGrantError('authorization code already used or unknown');
      }
      if (rec.clientId !== client.client_id) throw new InvalidGrantError('authorization code was issued to another client');
      if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
      if (rec.expiresAt <= now()) throw new InvalidGrantError('authorization code expired');
      if (resource && resource.toString() !== rec.resource) throw new InvalidGrantError('resource does not match the authorization request');
      if (rec.resource !== resourceUrl) throw new InvalidGrantError('authorization code was minted for another resource');
      return mintPair(rec);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const oldHash = sha256hex(refreshToken);
      const rec = await store.getRefresh(oldHash);
      if (!rec || rec.clientId !== client.client_id || rec.expiresAt <= now() || rec.revoked)
        throw new InvalidGrantError('refresh token unknown, mismatched, revoked or expired');
      if (await store.isFamilyRevoked(rec.familyId)) throw new InvalidGrantError('token family was revoked');
      // O1: the client must STILL exist with the SAME binding -
      // a removed or re-bound client cannot mint new access.
      const cur = byId.get(rec.clientId);
      if (!cur) throw new InvalidGrantError('client is no longer registered');
      if (rec.subject !== cur.subject) throw new InvalidGrantError('client subject binding changed; re-authorize');
      if (rec.scopes.some((s) => !(cur.scopes ?? []).includes(s))) throw new InvalidGrantError('token scopes exceed the client current ceiling');
      if (rec.rotatedTo) {   // reuse of a rotated token = theft signal
        await store.revokeFamily(rec.familyId);
        throw new InvalidGrantError('refresh token reuse detected; family revoked');
      }
      if (resource && resource.toString() !== rec.resource) throw new InvalidGrantError('resource mismatch');
      // Persistent linking (Google's guidance for Connected
      // Apps): clients configured refresh_mode 'persistent' keep
      // the SAME refresh token; only its expiry extends. No
      // rotation, no reuse detection - a documented platform
      // requirement that trades rotation for link stability.
      if (byId.get(rec.clientId)?.refresh_mode === 'persistent') {
        const grantedP = scopes?.length ? scopes : rec.scopes;
        if (grantedP.some((s) => !rec.scopes.includes(s))) throw new InvalidScopeError('scope escalation is not allowed');
        await store.extendRefresh(oldHash, now() + REFRESH_TTL_MS);
        const accessP = newToken();
        await store.putAccess({ tokenHash: sha256hex(accessP), clientId: rec.clientId, subject: rec.subject,
          scopes: grantedP, resource: rec.resource, familyId: rec.familyId, expiresAt: now() + ACCESS_TTL_MS, revoked: false });
        return { access_token: accessP, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken, scope: grantedP.join(' ') };
      }
      const granted = scopes?.length ? scopes : rec.scopes;
      if (granted.some((s) => !rec.scopes.includes(s))) throw new InvalidScopeError('scope escalation is not allowed');
      const access = newToken(); const refresh = newToken();
      let rotated;
      try {
        rotated = await store.rotateRefresh(oldHash, { tokenHash: sha256hex(refresh), clientId: rec.clientId,
          subject: rec.subject, scopes: granted, resource: rec.resource, familyId: rec.familyId, expiresAt: now() + REFRESH_TTL_MS, revoked: false });
      } catch (e) {
        if (e?.code === 'FAMILY_REVOKED' || e?.message === 'FAMILY_REVOKED') throw new InvalidGrantError('token family was revoked during rotation');
        throw e;
      }
      if (!rotated) { await store.revokeFamily(rec.familyId); throw new InvalidGrantError('refresh token rotation race; family revoked'); }
      await store.putAccess({ tokenHash: sha256hex(access), clientId: rec.clientId, subject: rec.subject,
        scopes: granted, resource: rec.resource, familyId: rec.familyId, expiresAt: now() + ACCESS_TTL_MS, revoked: false });
      return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: granted.join(' ') };
    },

    async verifyAccessToken(token) {
      const rec = await store.getAccess(sha256hex(token));
      if (!rec || rec.revoked || rec.expiresAt <= now()) throw new InvalidTokenError('access token unknown, revoked or expired');
      if (await store.isFamilyRevoked(rec.familyId)) throw new InvalidTokenError('token family was revoked');
      if (rec.resource !== resourceUrl) throw new InvalidTokenError('access token was minted for another resource (audience)');
      // O1 (root QA): a token must not outlive its client's
      // registration. Removing the client from configuration +
      // restart revokes its tokens HERE - the store is shared
      // and persistent, the registry is current config. A
      // narrowed scope ceiling or a changed subject binding
      // also invalidates outstanding tokens.
      const cur = byId.get(rec.clientId);
      if (!cur) throw new InvalidTokenError('client is no longer registered');
      if (rec.subject !== cur.subject) throw new InvalidTokenError('client subject binding changed');
      if (rec.scopes.some((s) => !(cur.scopes ?? []).includes(s))) throw new InvalidTokenError('token scopes exceed the client current ceiling');
      return { token, clientId: rec.clientId, scopes: rec.scopes, expiresAt: Math.floor(rec.expiresAt / 1000),
        resource: new URL(rec.resource), extra: { subject: rec.subject } };
    },

    async revokeToken(client, request) {
      const h = sha256hex(request.token);
      const asRefresh = await store.getRefresh(h);
      if (asRefresh && asRefresh.clientId === client.client_id) { await store.revokeFamily(asRefresh.familyId); return; }
      const asAccess = await store.getAccess(h);
      if (asAccess && asAccess.clientId === client.client_id) await store.revokeToken(h);
    },
  };

  async function mintPair(rec) {
    const access = newToken(); const refresh = newToken();
    try {
      await store.putAccess({ tokenHash: sha256hex(access), clientId: rec.clientId, subject: rec.subject,
        scopes: rec.scopes, resource: rec.resource, familyId: rec.familyId, expiresAt: now() + ACCESS_TTL_MS, revoked: false });
      await store.putRefresh({ tokenHash: sha256hex(refresh), clientId: rec.clientId, subject: rec.subject,
        scopes: rec.scopes, resource: rec.resource, familyId: rec.familyId, expiresAt: now() + REFRESH_TTL_MS, revoked: false });
    } catch (e) {
      // A revocation landed mid-issuance (root QA O2): the
      // store's tombstone kept the family un-mintable; the
      // durable answer is a grant error, never a usable pair.
      if (e?.code === 'FAMILY_REVOKED' || e?.message === 'FAMILY_REVOKED') throw new InvalidGrantError('token family was revoked during issuance');
      throw e;
    }
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: rec.scopes.join(' ') };
  }

  return provider;
}
