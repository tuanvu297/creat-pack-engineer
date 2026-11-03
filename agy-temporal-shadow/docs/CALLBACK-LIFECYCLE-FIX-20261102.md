# Callback + Qualification Lifecycle Fix — 2026-11-02 (candidate)

Repair job `gl_2e367da8-da06-4de7-b38d-1a3fb091283c`, follow-up phase.
Base: staging branch `agy/muse-qualification-staging-20261029` (tip `43f6cd3a`).
Status: **IMPLEMENTED_NOT_QA_ACCEPTED** — candidate branch + draft PR only.
No deployment was made from this change. Canonical authority unchanged:
PostgreSQL D049 (`agy_hosted_staging`).

## Why — three failures proven live on 2026-11-02 (run-20261102-restore3)

1. **Callback delivery died with the driver's startup timebox.**
   `AGY_CALLBACK_DRIVER_TIMEBOX_MS=480000` and
   `deadline() = min(expiresAtMs, startedAt + timeboxMs)` expired the
   callback driver 8 minutes after container boot (EXPIRED 08:33:06Z)
   while the owner window ran to 14:00:00Z. The result submitted at
   08:38:03Z recorded its callback PENDING and nothing dispatched it
   until an operator restarted the service by hand (delivered
   08:42:57Z after `serviceInstanceRedeploy`). The same 8-minute
   pattern had already silently killed restore2's driver on
   2026-10-31; G2 passed only because its lifecycle fit inside
   8 minutes.
2. **A completed run blocked every later grant until its evidence
   was deleted by hand.** The controller failed closed on any prior
   `qualificationRun` marker (PREVIOUS_RUN_GRANT_PRESENT) and on any
   foreign job in scope. Unblocking restore3 required an operator
   transaction deleting the G2 job's full FK closure — 17 rows
   across 11 tables of completed evidence (job, task, checkpoints,
   QA result, callback + receipt, telemetry, learning sample).
3. **Two more stale leftovers broke the fresh grant itself.**
   Cleanup disables the connector row; `insertConnector` uses
   `ON CONFLICT DO NOTHING`, so the row stayed disabled and arrive
   failed ARRIVAL_NOT_GRANTED until enabled by hand. The worker's
   cached `resource_profile.quotaUsed` stayed 1 (cap 1) after G2
   settled, so every claim failed the allocator's quota check until
   reset by hand. Root also observed pool-after-end errors during
   the restart: server shutdown ended the pool while the driver and
   controller intervals were still live (their handles were scoped
   inside `if` blocks and never stopped).

## Changes

### `src/platform/worker-callback-driver.ts`
- `deadline()` is now the owner's absolute `expiresAtMs` only.
  Delivery of a callback recorded inside the window is an
  already-authorized effect, not a new grant; the absolute expiry
  still bounds every pass, and a restart recomputes the same
  absolute deadline, so the B2 anti-extension property (a restart
  can never extend the window) is preserved. `timeboxMs` remains
  parsed for config compatibility but no longer shortens delivery.
- `start()` no longer treats an exhausted/zero timebox as EXPIRED;
  an already-past owner expiry still starts EXPIRED.
- A tick that hits a pool-after-end error (shutdown race) stops the
  driver quietly with one `CALLBACK_DRIVER_POOL_ENDED` log instead
  of logging a pass error every interval against a dead pool.

### `src/temporal/server.ts`
- Driver and qualification-controller handles are retained and
  stopped in the SIGINT/SIGTERM shutdown path **before**
  `pool.end()` runs in the `finally` block.

### `src/platform/qualification-controller.ts`
- New exported pure gate `assessPriorRun(facts, nowMs)`: a prior run
  is ARCHIVABLE only when its marker is expired, its job exists if
  the marker was GRANTED, no task is live, no lease is live, and
  every callback recorded for the run is DELIVERED.
- Phase A now archives a settled prior run instead of blocking:
  the full marker + census is appended to
  `policies.qualificationRunHistory` (append-only) and only the
  `policies.qualificationRun` pointer is removed. **No job, task,
  event, checkpoint, receipt or callback row is deleted or
  rewritten.** The job census treats archived job ids as history,
  not foreign work. Unsettled or unexpired prior runs block with
  the historical reasons (plus the more precise
  `PREVIOUS_RUN_NOT_SETTLED` / `PREVIOUS_RUN_JOB_MISSING`).
- Grant path repairs its own leftovers inside the grant
  transaction: `ensureConnectorEnabled` re-enables the qual
  connector row cleanup disabled (a connector disabled *during* a
  live window is untouched — the PREPARING-recovery validation
  still blocks on it as an owner intervention), and
  `recomputeWorkerQuotaUsed` recomputes the cached `quotaUsed`
  from the worker's live HELD reservations instead of trusting the
  cache (a genuinely held reservation still counts, so a leak
  surfaces as a failed allocation rather than being zeroed).

### Tests
- `test/callback-lifecycle-fix.test.ts` (new, UNIT — stub pool):
  driver gate past the old timebox, restart re-deriving the same
  absolute deadline, stale-grant EXPIRED, timebox=0 compatibility,
  pool-ended quiet stop, config parse compatibility, and the full
  `assessPriorRun` matrix (settled/unexpired/missing-job/live-task/
  live-lease/undelivered-callback/expired-QUEUED). **13/13 PASS**
  in the authoring environment.
- `test/callback-lifecycle.integration.test.ts` (new, INTEGRATION —
  real PostgreSQL, skipped without `AGY_TEST_DATABASE_URL`):
  L1 settled run archived + evidence intact + connector/quota
  repaired + next lifecycle completes; L2 undelivered callback
  keeps the next grant BLOCKED with `PREVIOUS_RUN_NOT_SETTLED`.
  Typechecked in the authoring environment; **not executed there
  (no local PostgreSQL)** — to be run by QA with the repo's
  `test:postgres` setup.
- `test/worker-surface-v3.integration.test.ts`: the one assertion
  that pinned the old timebox semantics (`timeboxMs: 0` → EXPIRED)
  now pins the new contract (RUNNING; a past owner expiry still
  starts EXPIRED). The B2 restart assertions are unchanged and
  still hold, because the deadline remains the original absolute
  expiry.

### Suite results (authoring environment, 2026-11-02)
- `tsc --noEmit`: clean.
- Full suite on the candidate tree: 217 tests, 181 pass, 2 fail,
  34 skip. Base tree same day: 202 tests, 168 pass, 2 fail, 32 skip.
  The 2 failures are identical on both trees (pre-existing:
  "Temporal worker startup sanitizes invalid database connection
  values", "no business hard-coded dependency in shared core").
  Delta = +13 passing unit tests, +2 integration tests skipping
  without a database. **No regressions.**

## What is NOT proven by this candidate
- Live behaviour after deployment (the integration suite and a
  bounded staging window remain QA's to run). In particular the
  >8-minute callback case is proven at unit level with a stub pool
  and by the restore3 incident itself; a post-deploy live window
  with a deliberately delayed result (>8 minutes after boot) is
  the remaining live check.
- No grant auto-renewal is introduced: archival never extends a
  deadline, never creates a window, and never touches an unexpired
  marker. Task-scoped authorization is unchanged (the grant still
  requires the full owner window variables).

## QA correction round 2 (2026-11-02, reviewer findings R1/R2)

Independent QA of 735f1a20 confirmed two P1 defects; both are fixed
in this round and proven on a REAL local PostgreSQL (embedded
binaries, repo migrations) — the integration tests are no longer
skipped-only.

R1 — an expired run's UNCLAIMED task stayed claimable under the
next run's grant (the worker gate has no run fence and the claim
stamps the CURRENT scope-wide deadline). Fix: expired work is made
non-runnable atomically while retaining evidence. The run's own
cleanup retires its QUEUED/RETRY tasks to terminal CANCELLED (row +
payload kept, task event RUN_EXPIRED_TASK_RETIRED); archival does
the same for a prior run whose cleanup never ran
(RUN_ARCHIVED_TASK_RETIRED), in the same transaction as the marker
swap and before the new grant activates the scope. Archival also
returns the prior window's worker/connector to dormant, so a run
whose cleanup never ran cannot strand a live cap
(WORKER_CAP_WITHOUT_GRANT). Regression test L3: run A's task never
claimed → expires → run B grant → claim returns B's task, never A's
(both the cleanup path and the archival path are exercised).

R2 — reservation accounting summed EVERY reservation in the
project, so a settled prior run permanently consumed the next run's
per-run cap (restore3's live EMPTY claim). Fix: authorized per-run
accounting closure at archival. Migration
013_reservation_accounting_closure.sql adds the terminal state
CLOSED, redefines the dispatch projection sums to count only
HELD/SETTLED, and recomputes existing projections. At archival the
prior run's SETTLED reservations transition to CLOSED — the row and
its actual_quota are retained as evidence; only the accounting
state advances, recorded in the history entry
(reservations_closed). The claim-time usage query applies the same
state filter. Cleanup deliberately does NOT close reservations:
the T3b invariant (cleanup never rewrites a result-settled
reservation) is preserved — closure happens only at archival, when
the gate has proven the run fully settled. Test L1 asserts the
CLOSED state with actual_quota intact AND the next run's claim
returning LEASED. A/B evidence: with the closure and retirement
disabled, L1 fails with claim EMPTY (the restore3 symptom) and L3
fails with the task left QUEUED; with the fixes, the full suite is
227 tests / 221 pass / 3 fail, the 3 fails identical to the
pristine-base run (pre-existing: Temporal startup sanitization,
no-business-hard-coded, worker surface v2).

All pre-existing PG integration harnesses now apply migration 013
alongside 012 (their fixed migration lists are part of this
candidate).

## QA round 3 (2026-11-03) — routing v2 and facade v0.2

Routing: independent execution of the v1 module reproduced four
defects, all fixed in routing-decision.ts v2
(ROUTING_DECISION_VERSION = 2) with failing-first regressions in
test/routing-decision-round3.test.ts (8/8 failed on v1, all pass
on v2; 36/36 across the routing + callback unit suites):
(1) planWorkBreakdown now carries a reservation ledger across the
plan — execution, model caps, and the reviewer pool are reserved
per decision, so a shared account is never double-spent;
(2) an unknown cost is never a funded ASSIGN — it requires the
task's bounded calibration budget (TEACH_THEN_ASSIGN) or waits;
(3) reviewer capacity is verified before assignment — a missing
reviewer snapshot is a REPAIR, an UNKNOWN/stale/insufficient one a
RESOURCE_WAIT, including the reviewer's own model cap;
(4) the metric is defined once: meanCreditsPerAccepted already
includes rework and is never divided by firstPassRate (a quality
gate) again. Inputs are validated (finite, nonnegative, rates in
[0,1]) and snapshots must be fresh. The routing unit is now
(provider, account, observed model/mode, class): model-level
task eligibility and tool support, model-specific caps alongside
the shared account pool, unknown/stale mode availability as
calibration-only, native automatic modes as ordinary observed
modes, and quotaKind (api_credits vs subscription) carried on
every decision and never conflated.

Facade: v0.1 was rejected (no inbound authentication; assumed
endpoints). v0.2 (tools/agy-mcp-facade) is built on the official
MCP SDK with a separate inbound host token (fail-closed 401,
constant-time compare), its own upstream operator identity, an
exact scope allowlist enforced before any upstream call, and a
64 KiB body bound. It exposes ONLY the two routes proven in
src/temporal/http-server.ts — GET /health and the callback
receiver lookup — and omits mission-result/reconcile tools whose
contracts are not proven under an operator identity. Real HTTP
tests (SDK client + negative cases, stub upstream implementing
the proven contracts): 3/3 pass. The README carries the concrete
install config for owner consent; still NOT installed.

## QA round 4 (2026-11-03) — routing v3, auth allowlist, D6 inventory

Routing v3 (same public decision shapes as v2; new fields are
additive): requiredTools is a hard per-model gate (known-lacking
excludes; UNKNOWN support or availability yields a TEACH plan
carrying pendingVerification that reserves and executes nothing
until verified); model caps are three-state (an UNKNOWN cap
waits for a reading); TEACH reserves the model cap in the plan
ledger; model pools are keyed (provider|account|pool) so role
aliases share one ledger, and inconsistent snapshots of one
pool are a plan-wide REPAIR; freshness rejects future snapshots
beyond a 60 s skew; budget units are enforced (account.unit
names the pool unit, estimates must name estimateUnit and match,
unnamed-unit pools fund nothing); hardBudget tasks route only
where budgetEnforcement is provider/runtime — prompt targets
are not ceilings (live proof: Manus prompt targets 10/5 produced
actuals 20/15; the official Manus task.create has no budget
parameter). Regressions: test/routing-decision-round4.test.ts,
11/11 failing-first on v2; routing+callback+auth suites 51/51.

Auth: Principal gains an optional actions allowlist
(src/platform/auth.ts) — when present it narrows every role,
platform-admin included; absent = legacy behaviour. This makes
a genuinely read-only operator representable for the first
time; without it the facade upstream identity would carry
scope-limited WRITE authority, so the facade README now says
so and the facade stays uninstalled. Tests:
test/auth-actions.test.ts (4/4; platform suite unchanged apart
from the one pre-existing failure).

D6 is NOT completed by the read facade: the real control/result
surface (POST /v1/agy/{current_state,get_run,active_missions,
callback_status,dispatch,reconcile,...} over pinned missions)
is inventoried separately in the job record
(D6_REMAINING_INVENTORY_20261103.md) with the bounded
least-privilege exposure set and the exact missing
provisioning actions. No deploy/grant/consent implied.

## Routing decision path (D3/D4 runnable candidate)

src/platform/routing-decision.ts implements the work-breakdown /
action-journal / resource-aware routing contracts as a pure,
versioned decision function (ASSIGN / TEACH_THEN_ASSIGN / REPAIR /
RESOURCE_WAIT / RECONCILE_FIRST) over plain JSON records, so the
brain state survives model/host replacement. Capacity is accounted
per ACCOUNT shared across roles, expected totals are per ACCEPTED
output including retries and the shared review charge, and UNKNOWN
quota is a wait, never a guess. test/routing-decision.test.ts
covers the seven contract scenarios plus dependency acceptance and
journal append-only behaviour.

## Round 5 — worker-UI actions preservation + single-task admission (2026-11-03)
Root findings: (1) worker-ui's action form offered no arrive/
recover although the surface supports both — a real UI gap for
the Gemini admission; (2) the UI reconstructed the Principal
without the configured identity's actions allowlist and recheck
ignored actions, so the round-4 restriction was not enforced
through the UI. Fixes (candidate, same branch):
- worker-ui.ts: session claims snapshot the login actions, but
  enforcement re-reads the CURRENT configured identity on every
  request (liveClaims -> currentIdentity): a mid-session
  narrowing/revocation takes effect on the next action. The
  Principal handed to the surface carries the current allowlist,
  and authorize() gates each action before the surface runs
  (readback -> 'read'; arrive/claim/ack/heartbeat/checkpoint/
  result/recover -> 'execute'). Form gains arrive + recover
  options and the recover run_id field.
- worker-gate.ts + postgres-store.ts: optional admission pin —
  when gate.admission is present, only the pinned taskId passes
  and only until expiresAtMs; the store passes taskId into the
  in-transaction gate filter.
- worker-surface.ts: metadata.admission (task/mission/type/
  scope/expiry/presence TTL) narrows claim missions+types to the
  admission, requires a fresh arrival stamp (presence) before
  claim, and gives arrive an admission branch that stamps
  heartbeat_at under bindings-complete + READY checks. Expiry
  denies in both arrive and claim with no cleanup dependency.
Tests: worker-gate-admission 6/6; worker-ui-actions 5/5
(restricted claim/result denied with zero surface calls,
readback passes with the allowlist on the Principal,
mid-session restriction + revocation); worker-admission
integration 1/1 on real local Postgres (presence denied ->
arrive -> pinned HELLO leased over the higher-priority video
task, video attempt stays 0, one-task capacity, fail-closed
expiry). Combined run with the existing suites: 90/90 pass.
The two worker-surface-v2 / Temporal-startup failures are the
documented pre-existing base failures (round-2 comparison);
the local PG from round 2 was lost to a VM replacement before
a fresh A/B rerun this round.

## Round 6 (2026-11-03, D-057 wiring): 'delegate' surface action

helper-queue is now reachable through the worker surface —
candidate wiring, NOT a deployment. worker-surface gains the
'delegate' action: identity and scope are taken from the
authenticated principal and the request scope (body copies are
overwritten; scope keys in the body were already rejected),
the parent lease token is a required possession proof verified
against the persisted parent row (new optional
ChildSpec.parentLeaseToken -> PARENT_LEASE_DENIED), and job
creation runs under a caller-wired system principal resolver —
server.ts wires it to the already-configured operator identity
via the existing findCallbackOperator; an unwired surface
answers DELEGATION_NOT_CONFIGURED and fabricates nothing.
Routes: the HTTP worker route and the worker-UI dropdown both
accept 'delegate' (UI authorization maps it to 'execute' like
every non-readback action). Proven by
test/worker-surface-delegate.integration.test.ts on real
PostgreSQL (unconfigured denial, missing/forged token, forged
body parentWorkerId ignored, surface idempotency, foreign
worker denied); combined suites 94/94. Adapters remain
unbound: 'delegate' creates the child assignment on the queue
only — no provider call exists behind it yet.

## Round 7 (2026-11-03, D-057 equip): provider API adapters, mock-only

Owner asked for API/MCP routes after local-Chrome autoBrowse
proved unavailable. helper-providers.ts implements the
HelperAdapter interface against the providers' official REST
APIs, built entirely from their published OpenAPI/docs (read
2026-11-03): Manus v2 (POST /v2/task.create, GET /v2/user.me
probe, GET /v2/usage.availableCredits, GET /v2/task.detail,
GET /v2/task.listMessages, GET /v2/task.list reconcile) and
xAI (POST /v1/responses, GET /v1/responses/{id},
GET /v1/models). Neither provider documents a per-task hard
budget cap or an idempotency key, so both adapters report
prompt_only / actualCostBounded=false in
PROVIDER_BUDGET_POSTURE, uncertain submissions raise
SUBMISSION_UNCERTAIN (Manus reconciles via the `agy:<childKey>`
task title in task.list), and actuals are read back after the
fact (Manus credit_usage; xAI token usage x configured rates,
NaN when rates are unconfigured - never invented). The env
factory returns the honest unbound adapter when a key (or the
Grok model) is not configured. NOT wired into the server, NO
provider call has been made, NO key exists yet; tests are
mock-only (test/helper-providers.mock.test.ts, 8/8). The
integration delta + credential/cost gates live in the Drive
delta doc (mailbox MB-20261103-011).

## Round 8 (2026-11-03): peer-QA F1–F5 repairs + provider provenance hardening + facade OAuth

Root's four live repros against 85bd3e30 and Gemini's peer-QA
(F1–F5, artifact Drive 1u_li23PNbQ0tfLapE635XPYtU3DzG_zK) are
fixed at source, each failing-first:
- Providers: readResultFor requires the persisted submission
  binding (queue-read) and echo-checks the provider's own id;
  unknown/missing/malformed statuses denied (Grok {} no longer
  defaults to completed); Manus pagination past the cap raises
  PARTIAL_RESULT with a resume cursor; reconcile is tri-state
  (FOUND / NOT_FOUND only when the list is exhausted / UNKNOWN);
  provider + exception text is sanitized of credential material.
  helper-queue.loadSubmissionBinding +
  readVerifiedHelperResult enforce the boundary.
- F1: verifyHelperResult takes the authenticated principal and
  now checks result types explicitly, the CURRENT parent fence,
  the child's claim, submission_state = SUBMITTED, the EXACT
  persisted external ref, and finite cost against the budget's
  remaining room. digestOf(undefined) throws DIGEST_INPUT_INVALID
  (never mapped to null - that would collide with a real null
  payload; stableStringify's format is UNCHANGED for
  compatibility, its locale-dependent sort is a documented v2
  item per the corrected repair 5b).
- F2: begin/record check role, child lease expiry and the
  current-parent fence; record rejects empty refs (wedge).
- F3: createDelegatedChild holds SELECT ... FOR UPDATE on the
  parent row across verify+create, re-verifies after the
  concurrent-winner wait, and verifies the persisted child
  binding on both reconcile branches (reply-target drift under
  a shared childKey is CHILD_BINDING_MISMATCH, not a silent
  return).
- F4: ChildSpec rejects negative/non-finite money and any
  estimatedCost above the assignment budget's remaining room.
- F5: scoped-pool classifies transaction statements properly
  (BEGIN; / BEGIN ISOLATION LEVEL ... / START TRANSACTION are
  honoured; ROLLBACK TO SAVEPOINT and SAVEPOINT are in-tx
  statements, never ends, never auto-wrapped).
Tests: providers mock 8/8 + adversarial 6/6; scoped-pool 2/2;
queue + queue-security + surface-delegate PG integrations 3/3
suites; delegation suites 19/19.
- Facade v0.3 (tools/agy-mcp-facade): OAuth 2.1 mode on the
  official SDK (see the facade README) - Gemini-compatible
  discovery incl. the required registration_endpoint (gated
  DCR), owner-in-person consent, S256 PKCE, audience-bound
  tokens, persistent refresh for the Google client, family
  revocation on replay. 5/5 facade tests (bearer regression +
  OAuth flow). Deploy/consent steps: Drive doc (mailbox
  MB-20261103-012). Nothing deployed; no key created; no
  provider called.

## Round 8.1 (2026-11-03): OAuth O1/O2 revocation correctness + locked packaging

Root QA on 5b0b00ad confirmed two revocation defects with
direct repros; both fixed:
- O1: tokens outlived their client. verifyAccessToken and
  exchangeRefreshToken now re-verify the CURRENT registry
  (client exists, subject binding unchanged, scopes within the
  client's current ceiling) against the persistent store.
- O2: mintPair's second write could resurrect a family revoked
  mid-issuance. Family revocation is now a durable tombstone
  (agy_oauth_families); token inserts are guarded by the family
  row lock (PG CTE ... FOR UPDATE) or the synchronous in-memory
  check, and revocation during issuance surfaces as a grant
  error. Proven by an in-memory gated race test and a REAL
  local-Postgres concurrent test (oauth-store.pg.test.mjs).
- Packaging: pg is a declared dependency; package-lock.json
  pins SDK 1.32.2 / express 4.22.3 / zod 3.25.76 / pg 8.23.1
  (the versions root's isolated QA resolved); facade suite
  9/9 on the locked install. Deploy prep de-circularised
  (authorize capture flow for the exact redirect), scoped to
  GEMINI_UI_STAGING (GL_QUALIFICATION not reopened), DCR state
  stated MANUAL ONLY.
