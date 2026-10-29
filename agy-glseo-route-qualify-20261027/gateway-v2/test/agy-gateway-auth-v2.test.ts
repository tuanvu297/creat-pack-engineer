// Auth/readback tests for agy-gateway.candidate-v2.ts.
// Evidence class: LOCAL unit tests; stubbed Bun.env + stubbed fetch.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const MUSE_TOKEN = 'muse-worker-token-v2';
const env: Record<string, string> = {
  SUPABASE_URL: 'http://127.0.0.1:9999',
  SUPABASE_SERVICE_ROLE_KEY: 'stub-service-key',
  AGY_GATEWAY_CALLERS_JSON: JSON.stringify([
    {worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'WORKER', token_sha256: sha256(MUSE_TOKEN)},
  ]),
};
(globalThis as any).Bun = {env};

let rpcCalls: {name: string; payload: any}[] = [];
(globalThis as any).fetch = async (url: string, init: any) => {
  const payload = JSON.parse(init.body);
  rpcCalls.push({name: String(url).split('/rpc/')[1], payload});
  return {ok: true, status: 200, text: async () => JSON.stringify({status: 'PASS', task: {task_id: 'T-1', status: 'RESULT_SUBMITTED'}, callback: {status: 'PENDING'}})};
};

const gateway = (await import('../agy-gateway.candidate-v2.ts')).default;
const post = (path: string, token?: string, body: unknown = {}) => new Request(`http://gateway.test${path}`, {
  method: 'POST', headers: token ? {authorization: `Bearer ${token}`, 'content-type': 'application/json'} : {'content-type': 'application/json'},
  body: JSON.stringify(body),
});

test('v2 readback requires authentication', async () => {
  const res = await gateway.fetch(new Request('http://gateway.test/tasks/T-1/readback', {method: 'GET'}));
  assert.equal(res.status, 401);
  assert.equal(rpcCalls.length, 0);
});

test('v2 readback calls the RPC readback action with the caller identity', async () => {
  rpcCalls = [];
  const res = await gateway.fetch(new Request('http://gateway.test/tasks/T-1/readback', {
    method: 'GET', headers: {authorization: `Bearer ${MUSE_TOKEN}`},
  }));
  assert.equal(res.status, 200);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].payload.p_action, 'readback');
  assert.equal(rpcCalls[0].payload.p_payload.task_id, 'T-1');
  assert.deepEqual(rpcCalls[0].payload.p_payload._caller, {worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'WORKER'});
});

test('v2 claim still derives identity from the token', async () => {
  rpcCalls = [];
  const res = await gateway.fetch(post('/tasks/claim', MUSE_TOKEN, {worker_id: 'GEMINI-SEO-1', provider: 'GEMINI'}));
  assert.equal(res.status, 200);
  assert.equal(rpcCalls[0].payload.p_payload.worker_id, 'MUSE-SEO-1');
});

test('v2 malformed caller registry fails closed for every route', async () => {
  const good = env.AGY_GATEWAY_CALLERS_JSON;
  for (const bad of [
    '{not json',
    JSON.stringify({worker_id: 'X'}),
    JSON.stringify([{worker_id: 'MUSE-SEO-1', provider: 'OPENAI', role: 'WORKER', token_sha256: sha256(MUSE_TOKEN)}]),
    JSON.stringify([{worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'ADMIN', token_sha256: sha256(MUSE_TOKEN)}]),
    JSON.stringify([{worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'WORKER', token_sha256: 'zz'}]),
    JSON.stringify([
      {worker_id: 'MUSE-SEO-1', provider: 'MUSE', role: 'WORKER', token_sha256: sha256(MUSE_TOKEN)},
      {worker_id: 'MUSE-SEO-1', provider: 'GEMINI', role: 'WORKER', token_sha256: sha256('other')},
    ]),
  ]) {
    env.AGY_GATEWAY_CALLERS_JSON = bad;
    const res = await gateway.fetch(post('/tasks/claim', MUSE_TOKEN));
    assert.equal(res.status, 401, `registry must fail closed: ${bad.slice(0, 40)}`);
  }
  env.AGY_GATEWAY_CALLERS_JSON = good;
  const ok = await gateway.fetch(post('/tasks/claim', MUSE_TOKEN));
  assert.equal(ok.status, 200);
});
