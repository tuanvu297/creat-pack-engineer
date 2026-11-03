// Provider API adapters for the D-057 helper delegation
// contract (candidate, 2026-11-03). These implement the
// HelperAdapter interface from helper-delegation.ts against the
// providers' OFFICIAL APIs, from their published docs:
//
//   Manus v2  - https://api.manus.ai, header x-manus-api-key
//     POST /v2/task.create        (async; NO budget parameter
//                                  and NO idempotency key in the
//                                  documented schema)
//     GET  /v2/user.me            (read-only auth probe)
//     GET  /v2/usage.availableCredits  (spend-free balance read;
//                                  total_credits is authoritative)
//     GET  /v2/task.detail        (status + credit_usage actuals)
//     GET  /v2/task.listMessages  (result content)
//     GET  /v2/task.list          (reconcile by title/api key)
//   xAI       - https://api.x.ai, Authorization: Bearer key
//     POST /v1/responses          (Responses API; OpenAI-
//                                  compatible per the xAI REST
//                                  reference index)
//     GET  /v1/responses/{id}     (durable result read)
//     GET  /v1/models             (spend-free metadata + probe)
//     Prepaid credits (console-funded); a separate Management
//     API (management-api.x.ai) covers keys/teams/billing.
//
// HONESTY RULES baked in:
//  - No provider documents a per-task hard budget cap for
//    either helper, so both adapters report
//    budgetEnforcement 'prompt_only' and actualCostBounded
//    false: the delegation contract keeps denying hard-budget
//    assignments to them. Manus credit_usage and xAI token
//    usage make ACTUALS known after the fact (reconcile), they
//    do not cap spend before it.
//  - Manus task.create has no idempotency key: an uncertain
//    submission raises SUBMISSION_UNCERTAIN and is reconciled
//    via task.list (the adapter stamps every task title with
//    `agy:<childKey>` for exactly this), never blind-retried.
//    xAI responses are synchronous creations with no documented
//    idempotency either: same rule.
//  - Keys are read from env NAMES by the factory and held in
//    memory only; nothing here logs, persists, or returns a
//    key. probe() surfaces only the provider user id (Manus
//    user.me also returns name/email - deliberately dropped).
//  - NOTHING in this module is wired into the server yet, and
//    constructing an adapter performs no network call. Tests
//    are mock-only (test/helper-providers.mock.test.ts).
import { childKey, unboundAdapter, type HelperAdapter, type HelperAssignment, type HelperId, type HelperResultEnvelope } from './helper-delegation.js';
import { digestOf } from './digest.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; json(): Promise<any> }>;

export const defaultFetch: FetchLike = async (url, init) => {
  const r = await fetch(url, init as any);
  return { status: r.status, json: () => r.json() };
};

export type EnvelopeWithScope = HelperResultEnvelope & { scope: { tenantId: string; workspaceId: string; projectId: string } };

export type ProviderErrorKind = 'UNAUTHENTICATED' | 'PERMISSION' | 'INVALID' | 'NOT_FOUND'
  | 'RATE_LIMITED' | 'NOT_READY' | 'PROVIDER_ERROR' | 'SUBMISSION_UNCERTAIN' | 'RESULT_BINDING_UNKNOWN' | 'INPUT_TOO_LARGE';
export class ProviderCallError extends Error {
  constructor(public kind: ProviderErrorKind, message: string, public providerCode?: string) { super(message); }
}

const err = (kind: ProviderErrorKind, msg: string, code?: string) => new ProviderCallError(kind, msg, code);

function extractText(input: unknown): { text: string; structuredOutputSchema?: Record<string, unknown> } {
  if (typeof input === 'string') return { text: input };
  if (input && typeof input === 'object') {
    const o = input as any;
    if (typeof o.text === 'string') return { text: o.text, structuredOutputSchema: o.structuredOutputSchema };
    if (typeof o.prompt === 'string') return { text: o.prompt, structuredOutputSchema: o.structuredOutputSchema };
  }
  throw err('INVALID', 'helper input must be a string or { text }');
}

// ----------------------------------------------------------------
// Manus
// ----------------------------------------------------------------
export interface ManusConfig {
  apiKey: string;
  fetch: FetchLike;
  baseUrl?: string;                       // default https://api.manus.ai
  agentProfile?: 'lite' | 'standard';     // default 'lite' (cheapest documented tier)
  apiKeyId?: string;                      // enables task.list reconcile filtering
}
export interface ManusAdapter extends HelperAdapter {
  probe(): Promise<{ userId: string }>;
  discoverCredits(): Promise<{ totalCredits: number; currentPeriodEnd: number }>;
  reconcile(a: HelperAssignment): Promise<string | null>;
  readResultFor(a: HelperAssignment, externalRef: string): Promise<EnvelopeWithScope>;
}

export function manusAdapter(cfg: ManusConfig): ManusAdapter {
  const base = (cfg.baseUrl ?? 'https://api.manus.ai').replace(/\/$/, '');
  const bindings = new Map<string, HelperAssignment>();
  async function call(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string>; body?: unknown; mutating?: boolean } = {}): Promise<any> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    let res: { status: number; json(): Promise<any> };
    try {
      res = await cfg.fetch(`${base}${path}${qs}`, {
        method, headers: { 'x-manus-api-key': cfg.apiKey, 'content-type': 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e: any) {
      if (opts.mutating) throw err('SUBMISSION_UNCERTAIN', `manus ${path}: network failure on a mutating call - reconcile, never resubmit (${e?.message ?? e})`);
      throw err('PROVIDER_ERROR', `manus ${path}: ${e?.message ?? e}`);
    }
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!data || data.ok !== true) {
      const code = data?.error?.code as string | undefined;
      const msg = data?.error?.message ?? `HTTP ${res.status}`;
      switch (code) {
        case 'unauthenticated': throw err('UNAUTHENTICATED', msg, code);
        case 'permission_denied': throw err('PERMISSION', msg, code);
        case 'invalid_argument': throw err('INVALID', msg, code);
        case 'not_found': throw err('NOT_FOUND', msg, code);
        case 'rate_limited': throw err('RATE_LIMITED', msg, code);
        default:
          if (opts.mutating && (res.status >= 500 || code === 'internal'))
            throw err('SUBMISSION_UNCERTAIN', `manus ${path}: ${msg} - reconcile via task.list before any retry`, code);
          throw err('PROVIDER_ERROR', `manus ${path}: ${msg}`, code);
      }
    }
    return data;
  }
  const titleOf = (a: HelperAssignment) => `agy:${childKey(a)}`;
  async function readResultFor(a: HelperAssignment, externalRef: string): Promise<EnvelopeWithScope> {
    const detail = await call('GET', '/v2/task.detail', { query: { task_id: externalRef } });
    const task = detail.task ?? {};
    if (task.status === 'running' || task.status === 'waiting') throw err('NOT_READY', `manus task ${externalRef} is ${task.status}`);
    if (task.status === 'error' || task.status === 'deleted') throw err('PROVIDER_ERROR', `manus task ${externalRef} ended as ${task.status}`);
    // stopped: collect assistant messages (asc, paginated).
    const texts: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await call('GET', '/v2/task.listMessages', { query: { task_id: externalRef, order: 'asc', limit: '200', ...(cursor ? { cursor } : {}) } });
      for (const m of r.messages ?? []) {
        if (m?.type !== 'assistant_message') continue;
        const c = m.content;
        if (typeof c === 'string') texts.push(c);
        else if (Array.isArray(c)) for (const part of c) if (typeof part?.text === 'string') texts.push(part.text);
        else if (typeof m.text === 'string') texts.push(m.text);
      }
      if (!r.has_more || !r.next_cursor) break;
      cursor = r.next_cursor;
    }
    const payload = { text: texts.join('\n'), status: 'stopped', creditUsage: typeof task.credit_usage === 'number' ? task.credit_usage : null };
    return { childKey: childKey(a), helperId: 'manus', externalRef, digest: digestOf(payload),
      payload, costUnits: payload.creditUsage ?? Number.NaN,
      scope: { tenantId: a.scope.tenantId, workspaceId: a.scope.workspaceId, projectId: a.scope.projectId } };
  }
  return {
    helperId: 'manus', surface: 'api', bound: true,
    async probe() { const r = await call('GET', '/v2/user.me'); return { userId: String(r.user_id ?? '') }; },
    async discoverCredits() {
      const r = await call('GET', '/v2/usage.availableCredits');
      return { totalCredits: Number(r.data?.total_credits ?? 0), currentPeriodEnd: Number(r.data?.current_period_end ?? 0) };
    },
    async submit(a, input) {
      const { text, structuredOutputSchema } = extractText(input);
      // Documented input ceiling is ~5,000 estimated tokens per
      // request; this char guard is ours (conservative), labelled
      // as such - it is not a provider limit quote.
      if (!text.trim()) throw err('INVALID', 'empty helper input');
      if (text.length > 20_000) throw err('INPUT_TOO_LARGE', 'input exceeds the adapter guard for the documented ~5k-token request ceiling');
      const body: Record<string, unknown> = {
        message: { content: [{ type: 'text', text }] },
        agent_profile: cfg.agentProfile ?? 'lite',
        title: titleOf(a),
        share_visibility: 'private',
      };
      if (structuredOutputSchema) body.structured_output_schema = structuredOutputSchema;
      const r = await call('POST', '/v2/task.create', { body, mutating: true });
      const ref = String(r.task_id ?? '');
      if (!ref) throw err('SUBMISSION_UNCERTAIN', 'manus task.create returned no task_id - reconcile via task.list');
      bindings.set(ref, a);
      return { externalRef: ref };
    },
    async readResult(externalRef) {
      const a = bindings.get(externalRef);
      if (!a) throw err('RESULT_BINDING_UNKNOWN', 'no submit-time binding for this ref in this process - use readResultFor(assignment, ref) after a restart; the queue-side persisted binding in helper-queue.verifyHelperResult remains authoritative');
      return readResultFor(a, externalRef);
    },
    readResultFor,
    async reconcile(a) {
      const want = titleOf(a);
      let cursor: string | undefined;
      for (let page = 0; page < 3; page++) {
        const r = await call('GET', '/v2/task.list', { query: { limit: '100', order: 'desc',
          ...(cfg.apiKeyId ? { api_key_id: cfg.apiKeyId } : {}), ...(cursor ? { cursor } : {}) } });
        for (const t of r.data ?? []) if (t?.title === want) return String(t.id);
        if (!r.has_more || !r.next_cursor) break;
        cursor = r.next_cursor;
      }
      return null;
    },
  };
}

// ----------------------------------------------------------------
// xAI (Grok)
// ----------------------------------------------------------------
export interface GrokConfig {
  apiKey: string;
  fetch: FetchLike;
  baseUrl?: string;                       // default https://api.x.ai
  model: string;                          // required - never defaulted silently
  inputUsdPerMTok?: number;               // for actual-cost accounting
  outputUsdPerMTok?: number;
}
export interface GrokAdapter extends HelperAdapter {
  probe(): Promise<{ models: string[] }>;
  discoverModels(): Promise<{ models: string[] }>;
  readResultFor(a: HelperAssignment, externalRef: string): Promise<EnvelopeWithScope>;
}

export function grokAdapter(cfg: GrokConfig): GrokAdapter {
  const base = (cfg.baseUrl ?? 'https://api.x.ai').replace(/\/$/, '');
  const bindings = new Map<string, HelperAssignment>();
  async function call(method: 'GET' | 'POST', path: string, opts: { body?: unknown; mutating?: boolean } = {}): Promise<any> {
    let res: { status: number; json(): Promise<any> };
    try {
      res = await cfg.fetch(`${base}${path}`, {
        method, headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e: any) {
      if (opts.mutating) throw err('SUBMISSION_UNCERTAIN', `xai ${path}: network failure on a mutating call - no documented idempotency, never blind-retry (${e?.message ?? e})`);
      throw err('PROVIDER_ERROR', `xai ${path}: ${e?.message ?? e}`);
    }
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (res.status === 401) throw err('UNAUTHENTICATED', 'xai rejected the API key');
    if (res.status === 429) throw err('RATE_LIMITED', 'xai rate limited');
    if (res.status === 404) throw err('NOT_FOUND', `xai ${path} not found`);
    if (res.status >= 400) {
      if (opts.mutating && res.status >= 500) throw err('SUBMISSION_UNCERTAIN', `xai ${path}: HTTP ${res.status} on a mutating call - reconcile, never blind-retry`);
      throw err('PROVIDER_ERROR', `xai ${path}: HTTP ${res.status} ${data?.error?.message ?? data?.error ?? ''}`.trim());
    }
    return data;
  }
  async function readResultFor(a: HelperAssignment, externalRef: string): Promise<EnvelopeWithScope> {
    const r = await call('GET', `/v1/responses/${encodeURIComponent(externalRef)}`);
    if (r?.status === 'in_progress' || r?.status === 'queued') throw err('NOT_READY', `xai response ${externalRef} is ${r.status}`);
    if (r?.status === 'failed' || r?.status === 'incomplete' || r?.error) throw err('PROVIDER_ERROR', `xai response ${externalRef} ended as ${r?.status ?? 'error'}`);
    const texts: string[] = [];
    for (const item of r?.output ?? []) for (const part of item?.content ?? [])
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    if (typeof r?.output_text === 'string') texts.push(r.output_text);
    const usage = r?.usage ?? null;
    const payload = { text: texts.join('\n'), status: r?.status ?? 'completed', usage };
    let costUnits = Number.NaN;   // unknown actuals stay unknown (fail-closed money rules treat NaN as BUDGET_UNKNOWN downstream)
    if (usage && cfg.inputUsdPerMTok !== undefined && cfg.outputUsdPerMTok !== undefined) {
      const inTok = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
      const outTok = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
      if (Number.isFinite(inTok) && Number.isFinite(outTok))
        costUnits = (inTok * cfg.inputUsdPerMTok + outTok * cfg.outputUsdPerMTok) / 1_000_000;
    }
    return { childKey: childKey(a), helperId: 'grok', externalRef, digest: digestOf(payload),
      payload, costUnits,
      scope: { tenantId: a.scope.tenantId, workspaceId: a.scope.workspaceId, projectId: a.scope.projectId } };
  }
  const models = async () => {
    const r = await call('GET', '/v1/models');
    return { models: (r?.data ?? []).map((m: any) => String(m?.id ?? '')).filter(Boolean) };
  };
  return {
    helperId: 'grok', surface: 'api', bound: true,
    probe: models, discoverModels: models,
    async submit(a, input) {
      const { text } = extractText(input);
      if (!text.trim()) throw err('INVALID', 'empty helper input');
      const r = await call('POST', '/v1/responses', { body: { model: cfg.model, input: text }, mutating: true });
      const ref = String(r?.id ?? '');
      if (!ref) throw err('SUBMISSION_UNCERTAIN', 'xai responses.create returned no id - reconcile manually, never blind-retry');
      bindings.set(ref, a);
      return { externalRef: ref };
    },
    async readResult(externalRef) {
      const a = bindings.get(externalRef);
      if (!a) throw err('RESULT_BINDING_UNKNOWN', 'no submit-time binding for this ref in this process - use readResultFor(assignment, ref) after a restart; the queue-side persisted binding in helper-queue.verifyHelperResult remains authoritative');
      return readResultFor(a, externalRef);
    },
    readResultFor,
  };
}

// ----------------------------------------------------------------
// Factory: env-named credentials, safe-by-default (no key = the
// honest unbound adapter; constructing anything here performs
// NO network call).
// ----------------------------------------------------------------
export function helperAdapterFromEnv(helperId: HelperId, env: Record<string, string | undefined>,
  fetchImpl: FetchLike = defaultFetch): HelperAdapter {
  if (helperId === 'manus') {
    const key = env.MANUS_API_KEY;
    if (!key) return unboundAdapter('manus', 'api');
    return manusAdapter({ apiKey: key, fetch: fetchImpl, apiKeyId: env.MANUS_API_KEY_ID,
      agentProfile: env.AGY_MANUS_PROFILE === 'standard' ? 'standard' : 'lite' });
  }
  const key = env.XAI_API_KEY;
  const model = env.AGY_GROK_MODEL;
  if (!key || !model) return unboundAdapter('grok', 'api');
  return grokAdapter({ apiKey: key, fetch: fetchImpl, model,
    inputUsdPerMTok: env.AGY_GROK_INPUT_USD_PER_MTOK ? Number(env.AGY_GROK_INPUT_USD_PER_MTOK) : undefined,
    outputUsdPerMTok: env.AGY_GROK_OUTPUT_USD_PER_MTOK ? Number(env.AGY_GROK_OUTPUT_USD_PER_MTOK) : undefined });
}

// Budget posture, stated in code so no caller has to guess:
// neither provider documents a per-task hard cap.
export const PROVIDER_BUDGET_POSTURE = {
  manus: { enforcement: 'prompt_only', actualCostBounded: false,
    note: 'task.create has no budget/max-credit parameter (full schema read 2026-11-03); credit_usage makes actuals known after completion only. Account balance (usage.availableCredits total_credits) is a wallet bound, not a per-task cap.' },
  grok: { enforcement: 'prompt_only', actualCostBounded: false,
    note: 'No per-request budget parameter documented; prepaid console credits bound the ACCOUNT, not a task. Token usage makes actuals computable after the call when rates are configured.' },
} as const;
