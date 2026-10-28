// Auth/contract tests for agy-gateway.candidate.ts.
// Evidence class: LOCAL unit tests. The candidate module runs in-process with
// a stubbed Bun.env and a stubbed global fetch standing in for the Supabase
// PostgREST RPC endpoint. No live gateway was contacted.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const MUSE_TOKEN = 'muse-worker-token-for-tests';
const CONTROL_TOKEN = 'control-plane-token-for-tests';

(globalThis as any).Bun = {env: {
  SUPABASE_URL: 'http://127.0.0.1:9999',
  SUPABASE_SERVICE_ROLE_KEY: 'stub-service-key',
  AGY_GATEWAY_CALLERS_JSON: JSON.stringify([
    {worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'WORKER', token_sha256: sha256(MUSE_TOKEN)},
    {worker_id: 'AGY-CONTROL', provider: 'R11', role: 'CONTROL', token_sha256: sha256(CONTROL_TOKEN)},
  ]),
}};

let rpcCalls: {name: string; payload: any}[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  const payload = JSON.parse(init.body);
  const name = String(url).split('/rpc/')[1];
  rpcCalls.push({name, payload});
  const reply = name === 'agy_gateway_claim_rpc' ? {status: 'EMPTY'} : {status: 'PASS'};
  return {ok: true, status: 200, text: async () => JSON.stringify(reply)};
};

const gateway = (await import('../agy-gateway.candidate.ts')).default;

function req(path: string, opts: {token?: string; headers?: Record<string, string>; body?: unknown} = {}) {
  const headers: Record<string, string> = {...(opts.headers ?? {})};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://gateway.test${path}`, {
    method: 'POST', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}
const leaseHeaders = { 'x-agy-task-id': 'TSK-1', 'x-agy-attempt-id': 'ATT-1', 'x-agy-idempotency-key': 'K-1',
  'x-agy-trace-id': 'TR-1', 'x-agy-worker-id': 'MUSE-SEO-1', 'x-agy-lease-token': 'tok-uuid', 'x-agy-fence': '3' };

test('unauthenticated POST is rejected before any RPC is issued', async () => {
  rpcCalls = [];
  const res = await gateway.fetch(req('/tasks/claim', {body: {}}));
  assert.equal(res.status, 401);
  assert.equal((await res.json()).status, 'UNAUTHENTICATED');
  assert.equal(rpcCalls.length, 0);
});

test('a wrong bearer token is rejected', async () => {
  const res = await gateway.fetch(req('/tasks/claim', {token: 'not-a-real-token', body: {}}));
  assert.equal(res.status, 401);
});

test('claim identity comes from the token, never from the body', async () => {
  rpcCalls = [];
  const res = await gateway.fetch(req('/tasks/claim', {
    token: MUSE_TOKEN,
    body: {worker_id: 'GEMINI-SEO-1', provider: 'GEMINI', role: 'CONTROL', _caller: {worker_id: 'X', provider: 'R11', role: 'CONTROL'}},
  }));
  assert.equal(res.status, 200);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'agy_gateway_claim_rpc');
  assert.equal(rpcCalls[0].payload.p_payload.worker_id, 'MUSE-SEO-1');
  assert.equal(rpcCalls[0].payload.p_payload.provider, 'MUSE');
  assert.deepEqual(rpcCalls[0].payload.p_payload._caller, {worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'WORKER'});
});

test('a claim whose identity header disagrees with the token is refused', async () => {
  rpcCalls = [];
  const res = await gateway.fetch(req('/tasks/claim', {token: MUSE_TOKEN, headers: {'x-agy-worker-id': 'GEMINI-SEO-1'}, body: {}}));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).status, 'IDENTITY_MISMATCH');
  assert.equal(rpcCalls.length, 0);
});

test('task creation is control-plane only', async () => {
  const denied = await gateway.fetch(req('/tasks/create', {token: MUSE_TOKEN, body: {task_id: 'T-1'}}));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).status, 'FORBIDDEN_ROLE');
  rpcCalls = [];
  const allowed = await gateway.fetch(req('/tasks/create', {token: CONTROL_TOKEN, body: {task_id: 'T-1', mission_id: 'M-1'}}));
  assert.equal(allowed.status, 200);
  assert.equal(rpcCalls[0].payload.p_payload._caller.role, 'CONTROL');
});

test('a worker may register only itself, with its own provider', async () => {
  const other = await gateway.fetch(req('/workers/register', {token: MUSE_TOKEN, body: {worker_id: 'GEMINI-SEO-1', provider: 'GEMINI'}}));
  assert.equal(other.status, 403);
  const relabel = await gateway.fetch(req('/workers/register', {token: MUSE_TOKEN, body: {worker_id: 'MUSE-SEO-1', provider: 'GEMINI'}}));
  assert.equal(relabel.status, 403);
  rpcCalls = [];
  const self = await gateway.fetch(req('/workers/register', {token: MUSE_TOKEN, body: {worker_id: 'MUSE-SEO-1', capabilities: ['text']}}));
  assert.equal(self.status, 200);
  assert.equal(rpcCalls[0].payload.p_payload.provider, 'MUSE');
});

test('lease actions reject an identity header that is not the caller', async () => {
  rpcCalls = [];
  const res = await gateway.fetch(req('/ack', {token: MUSE_TOKEN, headers: {...leaseHeaders, 'x-agy-worker-id': 'GEMINI-SEO-1'}, body: {}}));
  assert.equal(res.status, 403);
  assert.equal(rpcCalls.length, 0);
});

test('callback requires the full lease header set and strips target/status from the body', async () => {
  const incomplete = await gateway.fetch(req('/callback', {token: MUSE_TOKEN,
    headers: {'x-agy-task-id': 'TSK-1', 'x-agy-attempt-id': 'ATT-1', 'x-agy-idempotency-key': 'K-1', 'x-agy-trace-id': 'TR-1'},
    body: {callback_id: 'CB-1'}}));
  assert.equal(incomplete.status, 400);

  rpcCalls = [];
  const res = await gateway.fetch(req('/callback', {token: MUSE_TOKEN, headers: leaseHeaders,
    body: {callback_id: 'CB-1', target: 'ATTACKER-CONTROLLED', callback_status: 'DELIVERED', evidence: {external_operation_id: 'op-1'}}}));
  assert.equal(res.status, 200);
  assert.equal(rpcCalls[0].name, 'agy_gateway_callback_rpc');
  const p = rpcCalls[0].payload.p_payload;
  assert.equal(p.target, undefined);
  assert.equal(p.callback_status, undefined);
  assert.equal(p.worker_id, 'MUSE-SEO-1');
  assert.equal(p.lease_token, 'tok-uuid');
  assert.equal(p.fence, 3);
});

test('health stays public and read-only', async () => {
  const res = await gateway.fetch(new Request('http://gateway.test/health', {method: 'GET'}));
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.canonical_authority, 'EXISTING_POSTGRES_D049');
});
