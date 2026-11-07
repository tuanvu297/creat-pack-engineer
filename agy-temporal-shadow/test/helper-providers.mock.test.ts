// MOCK-ONLY tests for the provider API adapters (D-057 equip
// round, 2026-11-03). Every HTTP call goes to a recording fake
// fetch; NO network, NO real key, NO provider spend. These
// tests prove request shapes, header names, envelope parsing,
// error mapping and the uncertain-submission semantics against
// the providers' documented schemas - they do not prove any
// live route works. Live verification happens only after a key
// is provisioned through the owner's own flow.
import test from "node:test";
import assert from "node:assert/strict";
import { manusAdapter, grokAdapter, helperAdapterFromEnv, ProviderCallError, type FetchLike } from "../src/platform/helper-providers.js";
import { childKey, resultMatchesAssignment, type HelperAssignment } from "../src/platform/helper-delegation.js";

const a: HelperAssignment = {
  parentWorkerId: 'GEMINI-SEO-WORKER', parentTaskId: 'task-parent-1', parentAttempt: 1,
  subtaskKey: 'extract-1', helperId: 'manus',
  scope: { tenantId: 'gl', workspaceId: 'legacy-workspace', projectId: 'GEMINI_UI_STAGING' },
  sourceAllowlist: ['https://example.com'], toolAllowlist: ['browser.read'],
  budget: { unit: 'provider_credits', cap: 5, spent: 0, enforcement: 'runtime', hard: false },
  expiresAtMs: Date.now() + 600_000, replyTarget: 'CHATGPT_ASSISTANT_CONTROL_PLANE',
  equipment: { pinnedSource: { ref: 'doc:fixture-input', digest: 'a'.repeat(64) },
    surface: { kind: 'api', model: 'fixture-model', authBinding: 'fixture:binding' },
    skillRef: 'skill:fixture', criteria: ['output addresses the pinned source'], rework: { maxAttempts: 1 } },
};
const grokA: HelperAssignment = { ...a, helperId: 'grok', budget: { unit: 'usd', cap: 1, spent: 0, enforcement: 'runtime', hard: false } };

function fakeFetch(handler: (url: string, init: any) => { status: number; body: any } | 'NETWORK_FAIL') {
  const calls: { url: string; init: any }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = handler(url, init);
    if (r === 'NETWORK_FAIL') throw new Error('socket hangup');
    return { status: r.status, json: async () => r.body };
  };
  return { f, calls };
}
const kindOf = (e: unknown) => (e as ProviderCallError).kind;

test('mock-only: manus probe hits GET /v2/user.me with the api-key header and drops PII fields', async () => {
  const { f, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, request_id: 'r1', user_id: 'u-123', name: 'Some One', email: 'x@example.com' } }));
  const ad = manusAdapter({ apiKey: 'test-key', fetch: f });
  const p = await ad.probe();
  assert.equal(p.userId, 'u-123');
  assert.deepEqual(Object.keys(p), ['userId'], 'probe surfaces the id only - no name/email');
  assert.equal(calls[0].url, 'https://api.manus.ai/v2/user.me');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers['x-manus-api-key'], 'test-key');
});

test('mock-only: manus discoverCredits reads the authoritative total', async () => {
  const { f } = fakeFetch(() => ({ status: 200, body: { ok: true, data: { total_credits: 1274, current_period_end: 1799999999 } } }));
  const d = await manusAdapter({ apiKey: 'k', fetch: f }).discoverCredits();
  assert.equal(d.totalCredits, 1274);
});

test('mock-only: manus submit sends the documented shape (childKey title, lite profile, NO budget field) and returns task_id', async () => {
  const { f, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, request_id: 'r', task_id: 'AbCdEfGhIjKlMnOpQrStUv', task_title: 't' } }));
  const ad = manusAdapter({ apiKey: 'k', fetch: f });
  const r = await ad.submit(a, { text: 'read the source and extract dates' });
  assert.equal(r.externalRef, 'AbCdEfGhIjKlMnOpQrStUv');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.manus.ai/v2/task.create');
  assert.equal(body.agent_profile, 'lite');
  assert.equal(body.title, `agy:${childKey(a)}`, 'title carries the reconcile handle');
  assert.equal(body.message.content[0].text, 'read the source and extract dates');
  assert.ok(!('budget' in body) && !('max_credits' in body) && !('budget_credits' in body),
    'no budget field exists in the documented schema - none is sent');
});

test('mock-only: manus error mapping - unauthenticated, and 5xx/internal on create is SUBMISSION_UNCERTAIN', async () => {
  const unauth = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 401, body: { ok: false, error: { code: 'unauthenticated', message: 'bad key' } } })).f });
  await assert.rejects(() => unauth.probe(), (e: unknown) => kindOf(e) === 'UNAUTHENTICATED');
  const five = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 500, body: { ok: false, error: { code: 'internal', message: 'boom' } } })).f });
  await assert.rejects(() => five.submit(a, 'x'), (e: unknown) => kindOf(e) === 'SUBMISSION_UNCERTAIN');
  const net = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => 'NETWORK_FAIL').f });
  await assert.rejects(() => net.submit(a, 'x'), (e: unknown) => kindOf(e) === 'SUBMISSION_UNCERTAIN');
});

test('mock-only: manus readResult maps running->NOT_READY and stopped->envelope with credit actuals + digest', async () => {
  const b1 = { childKey: childKey(a), helperId: 'manus' as const, submissionRef: 'tid1' };
  const running = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { ok: true, task: { id: 'tid1', status: 'running' } } })).f });
  await assert.rejects(() => running.readResultFor(a, 'tid1', b1), (e: unknown) => kindOf(e) === 'NOT_READY');
  const { f } = fakeFetch((url) => url.includes('task.detail')
    ? { status: 200, body: { ok: true, task: { id: 'tid1', status: 'stopped', credit_usage: 15 } } }
    : { status: 200, body: { ok: true, task_id: 'tid1', messages: [{ type: 'user_message', content: 'q' }, { type: 'assistant_message', content: [{ type: 'text', text: 'the answer' }] }], has_more: false } });
  const env = await manusAdapter({ apiKey: 'k', fetch: f }).readResultFor(a, 'tid1', b1);
  assert.equal(env.costUnits, 15, 'actuals come from credit_usage');
  assert.equal((env.payload as any).text, 'the answer');
  assert.ok(resultMatchesAssignment(a, env), 'envelope binds to the assignment');
  assert.ok(typeof env.digest === 'string' && env.digest.length > 0);
});

test('mock-only: manus reconcile finds the childKey-titled task in task.list', async () => {
  const { f } = fakeFetch(() => ({ status: 200, body: { ok: true, has_more: false,
    data: [{ id: 'other', title: 'something else' }, { id: 'mine', title: `agy:${childKey(a)}` }] } }));
  const ad = manusAdapter({ apiKey: 'k', fetch: f });
  assert.deepEqual(await ad.reconcile(a), { state: 'FOUND', ref: 'mine' });
  const none = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { ok: true, has_more: false, data: [] } })).f });
  assert.equal((await none.reconcile(a)).state, 'NOT_FOUND');
});

test('mock-only: grok probe lists models with a Bearer header; submit/readResult round-trip via the Responses API', async () => {
  const { f, calls } = fakeFetch((url, init) => {
    if (url.endsWith('/v1/models')) return { status: 200, body: { data: [{ id: 'grok-4.7' }, { id: 'grok-4.7-mini' }] } };
    if (url.endsWith('/v1/responses') && init.method === 'POST') return { status: 200, body: { id: 'resp_1', status: 'completed' } };
    if (url.includes('/v1/responses/resp_1')) return { status: 200, body: { id: 'resp_1', status: 'completed',
      output: [{ content: [{ type: 'output_text', text: 'grok answer' }] }], usage: { input_tokens: 1000, output_tokens: 500 } } };
    return { status: 404, body: {} };
  });
  const ad = grokAdapter({ apiKey: 'xkey', fetch: f, model: 'grok-4.7', inputUsdPerMTok: 2, outputUsdPerMTok: 6 });
  assert.deepEqual((await ad.probe()).models, ['grok-4.7', 'grok-4.7-mini']);
  assert.equal(calls[0].init.headers.authorization, 'Bearer xkey');
  const s = await ad.submit(grokA, 'summarise');
  assert.equal(s.externalRef, 'resp_1');
  const env = await ad.readResult('resp_1');
  assert.equal((env.payload as any).text, 'grok answer');
  assert.ok(Math.abs(env.costUnits - (1000 * 2 + 500 * 6) / 1_000_000) < 1e-12, 'actual USD computed from usage x configured rates');
  // Without configured rates, actuals stay honestly unknown.
  const ad2 = grokAdapter({ apiKey: 'xkey', fetch: f, model: 'grok-4.7' });
  const s2 = await ad2.submit(grokA, 'summarise');
  const env2 = await ad2.readResult(s2.externalRef);
  assert.ok(Number.isNaN(env2.costUnits), 'no rates configured -> costUnits NaN, never invented');
});

test('mock-only: grok uncertain submit never pretends; factory without keys returns the unbound adapter', async () => {
  const down = grokAdapter({ apiKey: 'k', fetch: fakeFetch(() => 'NETWORK_FAIL').f, model: 'grok-4.7' });
  await assert.rejects(() => down.submit(grokA, 'x'), (e: unknown) => kindOf(e) === 'SUBMISSION_UNCERTAIN');
  const un1 = helperAdapterFromEnv('manus', {}, fakeFetch(() => ({ status: 200, body: {} })).f);
  assert.equal(un1.bound, false);
  await assert.rejects(() => un1.submit(a, 'x'), /HELPER_NOT_BOUND/);
  const un2 = helperAdapterFromEnv('grok', { XAI_API_KEY: 'k' }, fakeFetch(() => ({ status: 200, body: {} })).f);
  assert.equal(un2.bound, false, 'grok without a configured model stays unbound - no silent model default');
});
