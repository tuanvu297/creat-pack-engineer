# Gemini Worker Route Repair — 20261030

- job_id: `gl_4d5bd416-63fb-47c6-9dd8-12fb289c3c4e`
- affected task: `gl_7ff68d2e-0c33-482b-be41-af18fb0f77dc`
- worker: MUSE (AGY Technical Repair Worker)
- base: branch `agy/muse-qualification-staging-20261029` @ `7a063bbaa51c4edc1f2f5fb5d8718fe69790b179`
  (deployed lineage `codex/agy-hosted-runtime-20261019` @ `f40c15b9e7d41a9259d73767ca9b7cfc173575f7`)
- repair branch: `agy/muse-gemini-route-repair-20261030`
- status: IMPLEMENTED_NOT_QA_ACCEPTED — no merge, no deploy, no business execution.

## Why the base is not `main`

OBSERVED: `main` @ `3366edf513b3c7b749fa204de715f53aeb49a943` and branch
`agy/muse-gemini-worker-20261028` @ `bb448a4558e8a429852b396a7204d467f1c314d9`
contain no `agy-temporal-shadow/` runtime tree at all. The canonical runtime
lives only on the deployed/staging lineage. `src/adapters.ts`,
`src/platform/worker-surface.ts`, `src/platform/worker-ui.ts`,
`src/platform/worker-callbacks.ts` and `src/types.ts` are byte-identical
(SHA-256 verified) between the deployed branch, the staging branch and the
local source snapshot used for this repair. Branching from `main` would have
produced a standalone adapter with no AGY runtime — explicitly out of scope.

## Root cause (evidence)

OBSERVED in the canonical runtime (all refs above):

1. There is no native Gemini API adapter in the repo. Gemini is a generic
   connector: `configuredAdapters` maps `gemini` → `HttpJsonAdapter` at
   `env.GEMINI_ENDPOINT` (token env `GEMINI_TOKEN`), and project connector
   bindings of kind `gemini` also resolve to `HttpJsonAdapter`
   (`src/platform/connectors.ts`). The registry candidate binds Gemini to
   `browser-adapter:/worker/ui`, `enabled=false`,
   `secret_ref=vault:gemini-side-not-created` — i.e. the Gemini route was
   never natively qualified; the browser UI is its registered surface.
2. `HttpJsonAdapter.call()` parsed every HTTP-200 body with
   `response.json()` and nothing else. A 200 with a non-JSON body (HTML UI
   page, plain text, SSE stream, provider error page) escaped as a raw
   `SyntaxError` with `code=undefined`, `retryable=undefined`.
   Reproduced locally against the unmodified source: stub 200 `text/html`
   → `SyntaxError: Unexpected token '<' ... is not valid JSON`.
3. `WorkerEngine.tick()` treats an error with `retryable!==false` as
   retryable: the raw SyntaxError therefore became a task RETRY with the
   checkpoint cleared — a blind re-execution path after the provider may
   already have accepted the submission, and a guaranteed loss of the
   structured result, ACK trail and callback. This chain matches the
   observed symptom set: `FAIL / REVISION_REQUESTED`, worker invocation
   `Non-JSON response`, no valid ACK / execution identity / structured
   result / callback evidence.
4. The browser worker surface (`/worker/ui/action`) answers form POSTs with
   an HTML envelope page (JSON only inside
   `<pre id="agy-response-envelope">`). A programmatic invocation that parses
   the whole body as JSON gets a non-JSON response on this route by design.
   Its request-side JSON parser also flattened malformed JSON into a generic
   `REQUEST_FAILED`.

INFERRED: the Gemini invocation hit one or both of (2) and (4). Which one
fired for the specific task is UNVERIFIED — the task/job ids do not appear
in the repo or in any Muse-readable runtime source, and no Gemini-side
invocation log is available to Muse. The fix removes both mechanisms
without assuming either one.

## Fix (bounded)

`src/adapters.ts`
- Response bodies are read once as text and parsed via `parseConnectorBody`:
  plain JSON as-is; `text/event-stream` bodies contribute their last
  complete `data:` frame; anything else is a deterministic parse failure.
- Non-JSON on a submission (`/execute` with an idempotency key) →
  `ConnectorError('SUBMISSION_UNCERTAIN', retryable=false)` with a redacted
  diagnostic (status, content-type, request id, ≤200-char body snippet with
  bearer/token-like values masked). Engine semantics already preserve the
  checkpoint and block blind retry for this code; reconcile by the same
  idempotency key before any resubmission.
- Non-JSON on a read (status/result/usage) →
  `ConnectorError('NON_JSON_RESPONSE', retryable=false)`.
- `validateExecutionResult` gates `check_status`/`collect_result`: known
  state required; a provider-reported `externalOperationId` must equal the
  requested externalId (`RESULT_IDENTITY_MISMATCH`); `output` must be a
  plain object — a string output is accepted only when it carries a JSON
  object directly or in one fenced block, else
  `RESULT_SCHEMA_INVALID`. Only a result passing parse + schema + identity
  can reach result-commit/callback.

`src/platform/worker-ui.ts`
- Content negotiation: form POSTs still render the HTML envelope by
  default (DOM/browser flow unchanged), but a caller sending
  `Accept: application/json` receives the JSON body directly.
- Malformed JSON request bodies now fail as `INVALID_JSON_BODY` instead of
  a flattened `REQUEST_FAILED`.

`test/gemini-worker-route-repair.test.ts` — T1–T8 + UI-1..UI-3 (see below).

No Flow/video route was touched. No credential, security policy, queue,
schema or AGY architecture change. Env var names involved (names only):
`GEMINI_ENDPOINT`, `GEMINI_TOKEN`, `AGY_WORKER_UI_SESSION_SECRET`,
`AGY_IDENTITIES_JSON`.

## Tests (local, fake connector + stub surface on 127.0.0.1; no real
Gemini provider, no production runtime, no business task)

- T1 adapter basic — PASS (JSON round-trip; SSE final frame)
- T2 structured schema — PASS (string + fenced JSON outputs validate;
  prose output → deterministic `RESULT_SCHEMA_INVALID`)
- T3 task identity — PASS (task_id/job_id/attempt/idempotency_key reach
  the connector unchanged, header == body key)
- T4 callback identity — PASS (result naming another execution →
  `RESULT_IDENTITY_MISMATCH`, never committed; matching execution collects
  only under its own identity)
- T5 duplicate protection — PASS (same task+attempt+key → one business
  execution, same externalId)
- T6 failure parsing — PASS (non-JSON 200 on /execute →
  `SUBMISSION_UNCERTAIN` + redacted diagnostic, not a SyntaxError;
  malformed JSON on read → `NON_JSON_RESPONSE`)
- T7 timeout/reconcile — PASS (dropped submission: exactly one in-call
  attempt, `SUBMISSION_UNCERTAIN`; reconcile with the same key returns the
  same externalId, business execution count stays 1)
- T8 catch-up compatibility — PASS as dry-run only (envelope carrying the
  existing task/job ids completes execute→status→result against the fake
  connector, ids unchanged, evidence `{external_operation_id, qa_state:
  'PENDING'}`; no new job created). Real-task catch-up remains
  UNVERIFIED until QA authorises a live window.
- UI-1/UI-2/UI-3 — PASS (HTML envelope default preserved; `Accept:
  application/json` returns parseable JSON; malformed body →
  `INVALID_JSON_BODY`)
- Full unit suite: repaired tree 202 tests / 168 pass / 2 fail / 32 skip.
  Pristine base tree: 188 / 154 / 2 / 32 — the same 2 failures pre-exist
  on the base (`platform.test.ts` hard-coded-dependency scan of
  `provision.ts`; temporal worker startup sanitisation) and are unrelated
  to this repair. `tsc --noEmit` clean.

## UNVERIFIED

- Any live Gemini execution, ACK, callback delivery or end-to-end PASS.
- Gemini-side invocation code/logs; the production `GEMINI_ENDPOINT`
  value and whether the Gemini connector binding is enabled in any live
  project (registry candidate says disabled / secret not created).
- Live lease/fence behaviour under reassignment for the Gemini worker
  (adapter contract tested; live runtime not exercised).

## Rollback

Do not merge; to abandon, delete the repair branch. If merged later,
revert the single repair commit — `src/adapters.ts` and
`src/platform/worker-ui.ts` return to the base versions and the added
test/doc files are removed. No data migration is involved.
