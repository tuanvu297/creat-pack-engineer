export function workerTransport(env = process.env): 'LEGACY'|'GATEWAY_SHADOW' {
  const mode = env.AGY_WORKER_TRANSPORT ?? 'LEGACY';
  if (mode !== 'LEGACY' && mode !== 'GATEWAY_SHADOW') throw new Error('INVALID_WORKER_TRANSPORT');
  return mode;
}

export function privateUrl(value: string|undefined): string {
  let url: URL;
  try { url = new URL(value ?? ''); } catch { throw new Error('PRIVATE_HTTP_URL_REQUIRED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || !(/^[a-z0-9-]+\.railway\.internal$/.test(url.hostname) ||
        ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) throw new Error('PRIVATE_HTTP_URL_REQUIRED');
  return url.origin;
}

function integer(value: string|undefined, fallback: number, min: number, max: number) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('INVALID_GATEWAY_LIMIT');
  return n;
}

export function gatewayConfig(env = process.env) {
  if (workerTransport(env) !== 'GATEWAY_SHADOW' || env.AGY_STAGE_ONLY !== 'true' ||
      env.AGY_STATE_MODE !== 'SHADOW_STAGING' || env.AGY_CANONICAL_AUTHORITY !== 'EXISTING_POSTGRES_D049' ||
      (env.AGY_ORCHESTRATION_MODE ?? 'LEGACY') !== 'LEGACY') throw new Error('GATEWAY_STAGING_ONLY');
  if (Object.entries(env).some(([k,v]) => v && (k === 'DATABASE_URL' || k.startsWith('SUPABASE_'))))
    throw new Error('WORKER_DATABASE_CREDENTIALS_DENIED');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(env.AGY_WORKER_ID ?? '')) throw new Error('WORKER_ID_REQUIRED');
  if (!env.AGY_GATEWAY_STATE_DIR) throw new Error('DURABLE_STATE_DIR_REQUIRED');
  const leaseSeconds = integer(env.AGY_GATEWAY_LEASE_SECONDS, 120, 30, 900);
  const timeoutMs = integer(env.AGY_GATEWAY_TIMEOUT_MS, 5000, 100, 10000);
  const heartbeatMs = integer(env.AGY_RUNTIME_HEARTBEAT_MS, 5000, 20, 10000);
  if (heartbeatMs + timeoutMs >= leaseSeconds * 1000 / 2) throw new Error('INVALID_GATEWAY_LIMIT');
  return { url: privateUrl(env.AGY_GATEWAY_URL), workerId: env.AGY_WORKER_ID!,
    stateDir: env.AGY_GATEWAY_STATE_DIR, leaseSeconds, timeoutMs, heartbeatMs,
    pollMs: integer(env.AGY_RUNTIME_POLL_MS, 1000, 20, 60000) };
}
export type GatewayConfig = ReturnType<typeof gatewayConfig>;
