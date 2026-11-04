// Provider API adapters for the D-057 helper delegation
// contract (candidate, 2026-11-03; provenance-hardened after
// root QA the same day). These implement the HelperAdapter
// interface from helper-delegation.ts against the providers'
// OFFICIAL APIs, from their published docs:
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
//    idempotency either: same rule. A reconcile scan that runs
//    out of pages reports UNKNOWN - never NOT_FOUND.
//  - PROVENANCE: an adapter mints a result envelope ONLY
//    against a PersistedSubmissionBinding the caller read from
//    the canonical queue (helper-queue.loadSubmissionBinding),
//    and ONLY when the provider's own answer echoes the bound
//    ref. Stamping an assignment's identity onto an arbitrary
//    provider response would fabricate ownership and digest
//    provenance. Unknown/missing/malformed terminal statuses
//    are denied, never defaulted to success; a paginated
//    result cut off by the read cap is an explicit
//    PARTIAL_RESULT with a resume cursor.
//  - Provider/transport text is untrusted (it can echo the
//    credential): everything reaching our errors is sanitized
//    and length-capped. Keys live in memory only; probe()
//    surfaces only the provider user id (Manus user.me also
//    returns name/email - deliberately dropped).
//  - NOTHING in this module is wired into the server yet, and
//    constructing an adapter performs no network call. Tests
//    are mock-only (test/helper-providers.mock.test.ts and
//    test/helper-providers.adversarial.test.ts).
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
  | 'RATE_LIMITED' | 'NOT_READY' | 'PROVIDER_ERROR' | 'SUBMISSION_UNCERTAIN' | 'RESULT_BINDING_UNKNOWN' | 'INPUT_TOO_LARGE'
  | 'RESULT_BINDING_MISMATCH' | 'RESULT_REF_MISMATCH' | 'UNKNOWN_STATUS' | 'PARTIAL_RESULT';
export class ProviderCallError extends Error {
  resumeCursor?: string;
  pagesFetched?: number;
  constructor(public kind: ProviderErrorKind, message: string, public providerCode?: string) { super(message); }
}

const err = (kind: ProviderErrorKind, msg: string, code?: string) => new ProviderCallError(kind, msg, code);

// The persisted operation binding, read by the CALLER from the
// canonical queue: the child key, the helper, and the EXACT
// provider ref recorded at submission time.
export interface PersistedSubmissionBinding {
  childKey: string;
  helperId: HelperId;
  submissionRef: string;
}

export type ReconcileOutcome =
  | { state: 'FOUND'; ref: string }
  | { state: 'NOT_FOUND'; pagesScanned: number }
  | { state: 'UNKNOWN'; pagesScanned: number };

export function sanitizeProviderText(text: unknown, secrets: string[] = []): string {
  let out = String(text ?? '');
  for (const sec of secrets) if (sec && sec.length >= 4) out = out.split(sec).join('[redacted]');
  out = out.replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/(x-manus-api-key\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/(api[-_ ]?key\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*)\S+/gi, '$1[redacted]');
  return out.slice(0, 300);
}

function extractText(input: unknown): { text: string; structuredOutputSchema?: Record<string, unknown> } {
  if (typeof input === 'string') return { text: input };
  if (input && typeof input === 'object') {
    const o = input as any;
    if (typeof o.text === 'string') return { text: o.text, structuredOutputSchema: o.structuredOutputSchema };
    if (typeof o.prompt === 'string') return { text: o.prompt, structuredOutputSchema: o.structuredOutputSchema };
  }
  throw err('INVALID', 'helper input must be a string or { text }');
}

function checkBinding(a: HelperAssignment, helperId: HelperId, externalRef: string, binding?: PersistedSubmissionBinding): void {
  if (!binding || binding.childKey !== childKey(a) || binding.helperId !== helperId || binding.submissionRef !== externalRef)
    throw err('RESULT_BINDING_MISMATCH', 'persisted submission binding does not match this assignment and ref');
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
  authBinding?: string;                   // credential binding NAME for equipment pinning (default 'manus:x-manus-api-key')
}
export interface ManusAdapter extends HelperAdapter {
  probe(): Promise<{ userId: string }>;
  discoverCredits(): Promise<{ totalCredits: number; currentPeriodEnd: number }>;
  reconcile(a: HelperAssignment): Promise<ReconcileOutcome>;
  readResultFor(a: HelperAssignment, externalRef: string, binding: PersistedSubmissionBinding): Promise<EnvelopeWithScope>;
}

export function manusAdapter(cfg: ManusConfig): ManusAdapter {
  const base = (cfg.baseUrl ?? 'https://api.manus.ai').replace(/\/$/, '');
  const bindings = new Map<string, HelperAssignment>();
  const titleOf = (a: HelperAssignment) => `agy:${childKey(a)}`;
  async function call(method: 'GET' | 'POST', path: string, opts: { query?: Record<string, string>; body?: unknown; mutating?: boolean } = {}): Promise<any> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    let res: { status: number; json(): Promise<any> };
    try {
      res = await cfg.fetch(`${base}${path}${qs}`, {
        method, headers: { 'x-manus-api-key': cfg.apiKey, 'content-type': 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e: any) {
      const safe = sanitizeProviderText(e?.message ?? e, [cfg.apiKey]);
      if (opts.mutating) throw err('SUBMISSION_UNCERTAIN', `manus ${path}: network failure on a mutating call - reconcile, never resubmit (${safe})`);
      throw err('PROVIDER_ERROR', `manus ${path}: ${safe}`);
    }
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!data || data.ok !== true) {
      const code = data?.error?.code as string | undefined;
      const msg = sanitizeProviderText(data?.error?.message ?? `HTTP ${res.status}`, [cfg.apiKey]);
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
  async function readResultFor(a: HelperAssignment, externalRef: string, binding?: PersistedSubmissionBinding): Promise<EnvelopeWithScope> {
    checkBinding(a, 'manus', externalRef, binding);
    const detail = await call('GET', '/v2/task.detail', { query: { task_id: externalRef } });
    const task = detail.task;
    if (!task || typeof task !== 'object') throw err('UNKNOWN_STATUS', 'manus task.detail returned no task object');
    if (typeof task.id !== 'string') throw err('UNKNOWN_STATUS', 'manus task.detail returned a task without an id - malformed');
    if (task.id !== externalRef) throw err('RESULT_REF_MISMATCH', 'manus task.detail answered about a different task than the bound ref');
    if (task.status === 'running' || task.status === 'waiting') throw err('NOT_READY', `manus task ${externalRef} is ${task.status}`);
    if (task.status === 'error' || task.status === 'deleted') throw err('PROVIDER_ERROR', `manus task ${externalRef} ended as ${task.status}`);
    if (task.status !== 'stopped') throw err('UNKNOWN_STATUS', `manus task ${externalRef} has an unknown or missing status: ${sanitizeProviderText(task.status, [cfg.apiKey])}`);
    const texts: string[] = [];
    let cursor: string | undefined;
    const PAGE_CAP = 10;
    for (let page = 0; page < PAGE_CAP; page++) {
      const r = await call('GET', '/v2/task.listMessages', { query: { task_id: externalRef, order: 'asc', limit: '200', ...(cursor ? { cursor } : {}) } });
      if (r.task_id !== undefined && r.task_id !== externalRef) throw err('RESULT_REF_MISMATCH', 'manus task.listMessages answered about a different task than the bound ref');
      for (const m of r.messages ?? []) {
        if (m?.type !== 'assistant_message') continue;
        const c = m.content;
        if (typeof c === 'string') texts.push(c);
        else if (Array.isArray(c)) for (const part of c) if (typeof part?.text === 'string') texts.push(part.text);
        else if (typeof m.text === 'string') texts.push(m.text);
      }
      if (!r.has_more || !r.next_cursor) {
        const payload = { text: texts.join('\n'), status: 'stopped', creditUsage: typeof task.credit_usage === 'number' ? task.credit_usage : null };
        return { childKey: childKey(a), helperId: 'manus', externalRef, digest: digestOf(payload),
          payload, costUnits: payload.creditUsage ?? Number.NaN,
          scope: { tenantId: a.scope.tenantId, workspaceId: a.scope.workspaceId, projectId: a.scope.projectId } };
      }
      cursor = r.next_cursor;
    }
    const partial = err('PARTIAL_RESULT', `manus task ${externalRef}: messages exceed the ${PAGE_CAP}-page read cap - result is PARTIAL, continue from the resume cursor`);
    partial.resumeCursor = cursor; partial.pagesFetched = PAGE_CAP;
    throw partial;
  }
  return {
    helperId: 'manus', surface: 'api', bound: true,
    descriptor: { model: 'manus-api-v2', authBinding: cfg.authBinding ?? 'manus:x-manus-api-key' },
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
      if (!a) throw err('RESULT_BINDING_UNKNOWN', 'no submit-time binding for this ref in this process - use readResultFor(assignment, ref, persistedBinding) with the queue-read binding; helper-queue.verifyHelperResult remains authoritative');
      return readResultFor(a, externalRef, { childKey: childKey(a), helperId: 'manus', submissionRef: externalRef });
    },
    readResultFor,
    async reconcile(a) {
      const want = titleOf(a);
      let cursor: string | undefined;
      const PAGE_BUDGET = 3;
      for (let page = 1; page <= PAGE_BUDGET; page++) {
        const r = await call('GET', '/v2/task.list', { query: { limit: '100', order: 'desc',
          ...(cfg.apiKeyId ? { api_key_id: cfg.apiKeyId } : {}), ...(cursor ? { cursor } : {}) } });
        for (const t of r.data ?? []) if (t?.title === want) return { state: 'FOUND', ref: String(t.id) };
        if (!r.has_more || !r.next_cursor) return { state: 'NOT_FOUND', pagesScanned: page };
        cursor = r.next_cursor;
      }
      // Pages ran out while the provider says more remain: the
      // task may well exist beyond the scan. That is UNKNOWN,
      // never proof of absence.
      return { state: 'UNKNOWN', pagesScanned: PAGE_BUDGET };
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
  authBinding?: string;                   // credential binding NAME for equipment pinning (default 'xai:bearer')
}
export interface GrokAdapter extends HelperAdapter {
  probe(): Promise<{ models: string[] }>;
  discoverModels(): Promise<{ models: string[] }>;
  readResultFor(a: HelperAssignment, externalRef: string, binding: PersistedSubmissionBinding): Promise<EnvelopeWithScope>;
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
      const safe = sanitizeProviderText(e?.message ?? e, [cfg.apiKey]);
      if (opts.mutating) throw err('SUBMISSION_UNCERTAIN', `xai ${path}: network failure on a mutating call - no documented idempotency, never blind-retry (${safe})`);
      throw err('PROVIDER_ERROR', `xai ${path}: ${safe}`);
    }
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (res.status === 401) throw err('UNAUTHENTICATED', 'xai rejected the API key');
    if (res.status === 429) throw err('RATE_LIMITED', 'xai rate limited');
    if (res.status === 404) throw err('NOT_FOUND', `xai ${path} not found`);
    if (res.status >= 400) {
      const safe = sanitizeProviderText(data?.error?.message ?? data?.error ?? '', [cfg.apiKey]);
      if (opts.mutating && res.status >= 500) throw err('SUBMISSION_UNCERTAIN', `xai ${path}: HTTP ${res.status} on a mutating call - reconcile, never blind-retry`);
      throw err('PROVIDER_ERROR', `xai ${path}: HTTP ${res.status} ${safe}`.trim());
    }
    return data;
  }
  async function readResultFor(a: HelperAssignment, externalRef: string, binding?: PersistedSubmissionBinding): Promise<EnvelopeWithScope> {
    checkBinding(a, 'grok', externalRef, binding);
    const r = await call('GET', `/v1/responses/${encodeURIComponent(externalRef)}`);
    if (!r || typeof r !== 'object') throw err('UNKNOWN_STATUS', 'xai returned a malformed response object');
    if (typeof r.id !== 'string' || typeof r.status !== 'string')
      throw err('UNKNOWN_STATUS', 'xai response is missing its id or status - malformed, never defaulted');
    if (r.id !== externalRef) throw err('RESULT_REF_MISMATCH', 'xai answered about a different response than the bound ref');
    if (r.status === 'in_progress' || r.status === 'queued') throw err('NOT_READY', `xai response ${externalRef} is ${r.status}`);
    if (r.status === 'failed' || r.status === 'incomplete' || r.status === 'cancelled')
      throw err('PROVIDER_ERROR', `xai response ${externalRef} ended as ${r.status}`);
    if (r.status !== 'completed')
      throw err('UNKNOWN_STATUS', `xai response ${externalRef} has an unknown or missing status: ${sanitizeProviderText(r.status, [cfg.apiKey])}`);
    const texts: string[] = [];
    for (const item of r.output ?? []) for (const part of item?.content ?? [])
      if (part?.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    if (typeof r.output_text === 'string') texts.push(r.output_text);
    const usage = r.usage ?? null;
    const payload = { text: texts.join('\n'), status: 'completed', usage };
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
    descriptor: { model: cfg.model, authBinding: cfg.authBinding ?? 'xai:bearer' },
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
      if (!a) throw err('RESULT_BINDING_UNKNOWN', 'no submit-time binding for this ref in this process - use readResultFor(assignment, ref, persistedBinding) with the queue-read binding; helper-queue.verifyHelperResult remains authoritative');
      return readResultFor(a, externalRef, { childKey: childKey(a), helperId: 'grok', submissionRef: externalRef });
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

// Equipment surface guard (D-057 equip rule, 2026-11-04): the
// executor calls this before ANY adapter submit. The
// assignment pins the surface kind, the model/agent build and
// the credential binding NAME; an adapter that would run
// anything else - a different model, a different key binding,
// an unbound stub - is refused here, before a provider call
// can happen. This is a pure comparison over declared values;
// it performs no I/O and reads no credential.
export function assertAdapterMatchesAssignment(a: HelperAssignment, adapter: HelperAdapter): void {
  if (adapter.helperId !== a.helperId) throw new Error('SURFACE_HELPER_MISMATCH');
  if (!adapter.bound) throw new Error('HELPER_NOT_BOUND');
  const pin = a.equipment?.surface;
  if (!pin) throw new Error('SURFACE_UNPINNED');
  if (adapter.surface !== pin.kind) throw new Error('SURFACE_KIND_MISMATCH');
  if (!adapter.descriptor) throw new Error('SURFACE_DESCRIPTOR_MISSING');
  if (adapter.descriptor.model !== pin.model) throw new Error('SURFACE_MODEL_MISMATCH');
  if (adapter.descriptor.authBinding !== pin.authBinding) throw new Error('SURFACE_AUTH_MISMATCH');
}
