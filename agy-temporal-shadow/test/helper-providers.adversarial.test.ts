// ADVERSARIAL MOCK-ONLY tests for the provider adapters
// (root QA round, 2026-11-03). Every case targets a provenance
// or fail-open hole: an adapter must never stamp an
// assignment's identity onto an arbitrary provider response,
// never default an unknown status to success, never silently
// truncate a paginated result, never call "not found" what is
// only "not seen yet", and never let provider/exception text
// carry a secret into our errors. All HTTP is a recording fake
// fetch - no network, no keys, no spend.
import test from "node:test";
import assert from "node:assert/strict";
import { manusAdapter, grokAdapter, ProviderCallError, type FetchLike } from "../src/platform/helper-providers.js";
import { childKey, type HelperAssignment } from "../src/platform/helper-delegation.js";

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
const binding = { childKey: childKey(a), helperId: 'manus' as const, submissionRef: 'ref-1' };
const grokBinding = { childKey: childKey(grokA), helperId: 'grok' as const, submissionRef: 'resp_1' };

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

test('adversarial: readResultFor refuses a binding for a different child or ref - with ZERO provider calls', async () => {
  const { f, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, task: { id: 'ref-1', status: 'stopped', credit_usage: 1 } } }));
  const ad = manusAdapter({ apiKey: 'k', fetch: f });
  await assert.rejects(() => (ad as any).readResultFor(a, 'ref-1', { ...binding, childKey: 'helper:manus:other:1:x' }),
    (e: unknown) => kindOf(e) === 'RESULT_BINDING_MISMATCH');
  await assert.rejects(() => (ad as any).readResultFor(a, 'ref-1', { ...binding, submissionRef: 'ref-OTHER' }),
    (e: unknown) => kindOf(e) === 'RESULT_BINDING_MISMATCH');
  await assert.rejects(() => (ad as any).readResultFor(a, 'ref-1', undefined),
    (e: unknown) => kindOf(e) === 'RESULT_BINDING_MISMATCH');
  assert.equal(calls.length, 0, 'binding is verified before any provider call');
});

test('adversarial: a provider response about a DIFFERENT object is never stamped with our identity', async () => {
  const { f } = fakeFetch(() => ({ status: 200, body: { ok: true, task: { id: 'SOMEONE-ELSES-TASK', status: 'stopped', credit_usage: 3 } } }));
  const ad = manusAdapter({ apiKey: 'k', fetch: f });
  await assert.rejects(() => (ad as any).readResultFor(a, 'ref-1', binding),
    (e: unknown) => kindOf(e) === 'RESULT_REF_MISMATCH');
  const g = grokAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { id: 'resp_OTHER', status: 'completed', output: [] } })).f, model: 'grok-4.7' });
  await assert.rejects(() => (g as any).readResultFor(grokA, 'resp_1', grokBinding),
    (e: unknown) => kindOf(e) === 'RESULT_REF_MISMATCH');
});

test('adversarial: unknown, missing or malformed terminal status is DENIED - grok {} must not default to completed', async () => {
  const g1 = grokAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: {} })).f, model: 'grok-4.7' });
  await assert.rejects(() => (g1 as any).readResultFor(grokA, 'resp_1', grokBinding),
    (e: unknown) => kindOf(e) === 'UNKNOWN_STATUS');
  const g2 = grokAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { id: 'resp_1', status: 'banana', output: [] } })).f, model: 'grok-4.7' });
  await assert.rejects(() => (g2 as any).readResultFor(grokA, 'resp_1', grokBinding),
    (e: unknown) => kindOf(e) === 'UNKNOWN_STATUS');
  const m1 = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { ok: true, task: { id: 'ref-1', status: 'exploded' } } })).f });
  await assert.rejects(() => (m1 as any).readResultFor(a, 'ref-1', binding),
    (e: unknown) => kindOf(e) === 'UNKNOWN_STATUS');
  const m2 = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { ok: true } })).f });
  await assert.rejects(() => (m2 as any).readResultFor(a, 'ref-1', binding),
    (e: unknown) => kindOf(e) === 'UNKNOWN_STATUS' || kindOf(e) === 'PROVIDER_ERROR');
});

test('adversarial: manus pagination beyond the page cap is an explicit PARTIAL with a resume cursor, never a silent complete', async () => {
  let n = 0;
  const { f } = fakeFetch((url) => url.includes('task.detail')
    ? { status: 200, body: { ok: true, task: { id: 'ref-1', status: 'stopped', credit_usage: 9 } } }
    : { status: 200, body: { ok: true, task_id: 'ref-1', has_more: true, next_cursor: `cur-${++n}`,
        messages: [{ type: 'assistant_message', content: [{ type: 'text', text: `page ${n}` }] }] } });
  const ad = manusAdapter({ apiKey: 'k', fetch: f });
  await assert.rejects(() => (ad as any).readResultFor(a, 'ref-1', binding), (e: unknown) => {
    const pe = e as ProviderCallError & { resumeCursor?: string; pagesFetched?: number };
    return kindOf(e) === 'PARTIAL_RESULT' && typeof pe.resumeCursor === 'string' && (pe.pagesFetched ?? 0) >= 1;
  });
});

test('adversarial: reconcile distinguishes FOUND / NOT_FOUND (list exhausted) / UNKNOWN (page budget spent, more remain)', async () => {
  const found = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { ok: true, has_more: false,
    data: [{ id: 'mine', title: `agy:${childKey(a)}` }] } })).f });
  assert.deepEqual(await (found as any).reconcile(a), { state: 'FOUND', ref: 'mine' });
  const exhausted = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { ok: true, has_more: false, data: [] } })).f });
  assert.equal(((await (exhausted as any).reconcile(a)) as any).state, 'NOT_FOUND');
  const endless = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 200, body: { ok: true, has_more: true, next_cursor: 'c', data: [] } })).f });
  const r = await (endless as any).reconcile(a);
  assert.equal(r.state, 'UNKNOWN', 'pages ran out while more remain - that is UNKNOWN, not proof of absence');
});

test('adversarial: provider and exception text is sanitized - the api key and bearer tokens never reach our errors', async () => {
  const KEY = 'sk-manus-SECRET-1234567890';
  const leaky = manusAdapter({ apiKey: KEY, fetch: fakeFetch(() => ({ status: 401, body: { ok: false,
    error: { code: 'unauthenticated', message: `key ${KEY} rejected; retry with x-manus-api-key: ${KEY}` } } })).f });
  await assert.rejects(() => leaky.probe(), (e: unknown) => {
    const msg = (e as Error).message;
    return kindOf(e) === 'UNAUTHENTICATED' && !msg.includes(KEY) && !msg.includes('SECRET');
  });
  const net = manusAdapter({ apiKey: KEY, fetch: (async () => { throw new Error(`dial failed Authorization: Bearer abc.def.ghi key=${KEY}`); }) as any });
  await assert.rejects(() => net.probe(), (e: unknown) => {
    const msg = (e as Error).message;
    return !msg.includes(KEY) && !msg.includes('abc.def.ghi');
  });
  const long = manusAdapter({ apiKey: 'k', fetch: fakeFetch(() => ({ status: 400, body: { ok: false,
    error: { code: 'invalid_argument', message: 'x'.repeat(5000) } } })).f });
  await assert.rejects(() => long.probe(), (e: unknown) => (e as Error).message.length <= 400);
});
