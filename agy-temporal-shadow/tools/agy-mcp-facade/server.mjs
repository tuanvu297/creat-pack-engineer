// AGY MCP facade — entrypoint (candidate v0.3, NOT INSTALLED).
//
// Modes (AGY_AUTH_MODE):
//  - 'bearer' (default; v0.2 behaviour): static inbound bearer
//    AGY_FACADE_INBOUND_TOKEN. Requires AGY_UPSTREAM_URL,
//    AGY_UPSTREAM_TOKEN, AGY_FACADE_ALLOWED_SCOPES.
//  - 'oauth': the facade becomes an OAuth 2.1 authorization
//    server + resource server on the official MCP SDK (see
//    oauth-provider.mjs). Additionally requires:
//      AGY_PUBLIC_BASE_URL     https issuer / base URL
//      AGY_OAUTH_CLIENTS_JSON  pre-registered clients (array of
//                              {client_id, client_secret,
//                              client_name, redirect_uris,
//                              scopes, subject}) - provisioned
//                              at deploy, never committed
//      AGY_MCP_OPERATOR_TOKEN  owner approval secret for the
//                              consent page
//      AGY_OAUTH_SIGNING_SECRET  HMAC key for consent blobs
//      AGY_OAUTH_STORE         'pg' (deploy) or 'memory'
//                              (dev/test ONLY - tokens do not
//                              survive a restart)
//      AGY_OAUTH_DATABASE_URL  for 'pg' (defaults to
//                              DATABASE_URL); the `pg` package
//                              is a deploy-time dependency
// The facade refuses to start when any required variable for
// the selected mode is missing. Nothing here is deployed.
import { createFacadeApp } from './app.mjs';

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const mode = env.AGY_AUTH_MODE ?? 'bearer';
const upstreamUrl = env.AGY_UPSTREAM_URL ?? '';
const upstreamToken = env.AGY_UPSTREAM_TOKEN ?? '';
const allowedScopes = (env.AGY_FACADE_ALLOWED_SCOPES ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function die(msg) { console.error(`agy-mcp-facade: ${msg}; refusing to start.`); process.exit(2); }

if (!upstreamUrl || !upstreamToken || !allowedScopes.length)
  die('AGY_UPSTREAM_URL, AGY_UPSTREAM_TOKEN and a non-empty AGY_FACADE_ALLOWED_SCOPES are required in every mode');

if (mode === 'bearer') {
  const inboundToken = env.AGY_FACADE_INBOUND_TOKEN ?? '';
  if (!inboundToken) die('AGY_FACADE_INBOUND_TOKEN is required in bearer mode');
  createFacadeApp({ authMode: 'bearer', inboundToken, upstreamUrl, upstreamToken, allowedScopes })
    .listen(PORT, () => console.log(`agy-mcp-facade listening on :${PORT} (candidate; bearer mode; scopes: ${allowedScopes.join(' ')})`));
} else if (mode === 'oauth') {
  const [{ createAgyOAuthProvider }, { InMemoryOAuthStore, createPgOAuthStore }] = await Promise.all([
    import('./oauth-provider.mjs'), import('./oauth-store.mjs')]);
  const publicBaseUrl = env.AGY_PUBLIC_BASE_URL ?? '';
  const operatorSecret = env.AGY_MCP_OPERATOR_TOKEN ?? '';
  const signingSecret = env.AGY_OAUTH_SIGNING_SECRET ?? '';
  if (!publicBaseUrl.startsWith('https://')) die('AGY_PUBLIC_BASE_URL (https) is required in oauth mode');
  if (!operatorSecret || !signingSecret) die('AGY_MCP_OPERATOR_TOKEN and AGY_OAUTH_SIGNING_SECRET are required in oauth mode');
  let clients;
  try { clients = JSON.parse(env.AGY_OAUTH_CLIENTS_JSON ?? ''); } catch { die('AGY_OAUTH_CLIENTS_JSON must be valid JSON'); }
  if (!Array.isArray(clients) || !clients.length) die('AGY_OAUTH_CLIENTS_JSON must register at least one client');
  let store;
  const storeKind = env.AGY_OAUTH_STORE ?? '';
  if (storeKind === 'memory') {
    console.warn('agy-mcp-facade: AGY_OAUTH_STORE=memory - OAuth state will NOT survive a restart (dev/test only).');
    store = new InMemoryOAuthStore();
  } else if (storeKind === 'pg') {
    let pg;
    try { pg = await import('pg'); } catch { die("AGY_OAUTH_STORE=pg requires the declared 'pg' dependency (install from the lockfile)"); }
    const pool = new pg.Pool({ connectionString: env.AGY_OAUTH_DATABASE_URL ?? env.DATABASE_URL });
    store = createPgOAuthStore((sql, params) => pool.query(sql, params));
  } else die("AGY_OAUTH_STORE must be 'pg' (deploy) or 'memory' (dev/test)");
  for (const c of clients) if (Array.isArray(c.redirect_uris) && !c.redirect_uris.length)
    console.warn(`agy-mcp-facade: client ${c.client_id} has NO redirect URIs - it is INERT until the exact redirect is captured and registered (capture flow).`);
  const resourceUrl = new URL('/mcp', publicBaseUrl).toString();
  const dynamicRegistration = env.AGY_OAUTH_DYNAMIC_REGISTRATION === 'on' && env.AGY_OAUTH_DYNAMIC_SUBJECT
    ? { enabled: true, subject: env.AGY_OAUTH_DYNAMIC_SUBJECT } : undefined;
  if (dynamicRegistration) console.warn('agy-mcp-facade: dynamic client registration ENABLED (Google-redirect allowlist gate, subject ' + env.AGY_OAUTH_DYNAMIC_SUBJECT + ').');
  const oauthProvider = createAgyOAuthProvider({ store, clients, operatorSecret, signingSecret, resourceUrl, dynamicRegistration });
  createFacadeApp({ authMode: 'oauth', publicBaseUrl, oauthProvider, upstreamUrl, upstreamToken, allowedScopes })
    .listen(PORT, () => console.log(`agy-mcp-facade listening on :${PORT} (candidate; OAUTH mode; resource: ${resourceUrl}; scopes: ${allowedScopes.join(' ')})`));
} else {
  die(`unknown AGY_AUTH_MODE '${mode}'`);
}
