# Activation Plan — CANDIDATE v9 (not executed, approval not requested)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1. Revised after ControlPlane
QA round F1–F5 on v12 (E1–E4 themselves stand). What changed:
arrival is now a qualification OPT-IN (a live GRANTED marker for
the run, project ACTIVE, an enabled connector of the worker's own
adapter kind, complete provisioned bindings, and the worker
already in the controller-granted READY state) — arrival never
sets status and can no longer revive an owner-OFFLINE worker, act
in an owner-PAUSED or cleaned-up scope, or rewrite a business
worker's profile. The absolute-cutoff fences were rebuilt on a
proven PostgreSQL rule: a clock read only fences a mutation when
it is taken in its own statement AFTER every lock the mutation
needs is held (a clock predicate inside a waited-on UPDATE, and
a clock read inside the locking SELECT's target list, both bind
before the wait — proven on PostgreSQL 18); heartbeat, ack,
checkpoint, result, and job creation all follow it now. PREPARING
recovery is validate-only (it resumes the missing job/phase and
rewrites no registry state; any deviation from phase A's exact
committed shape BLOCKS). The cleanup neutralization event is
written under the same scope lock as every other cleanup phase.
And a lost claim response is now recoverable by the worker
itself: the surface 'recover' action (and the CLI's recover
command) returns the worker's OWN live lease for the owner run
id — read-only, no new lease/attempt/reservation, no foreign
task data. The rest of this header is v8's, carried over.

Revised after the owner's
connector-continuation directive on v11 (E1–E4 themselves stand):
two corrections and one addition. CORRECTION 1: plan v7 said the
gateway dispatches the worker action segment generically — it
does not; the HTTP route enumerated the actions and omitted
'arrive', so arrival was surface-reachable but NOT HTTP-reachable.
The route now includes 'arrive' and the loopback suite proves it
over real HTTP. CORRECTION 2: a prepared connector already existed
in Muse's workspace (custom.agy-runtime) but it targets the
gateway-SHADOW contract — connecting it would have made Muse a
worker on the shadow plane, which is not the authority. It is
marked do-not-connect. ADDITION: the real Muse-side connector
candidate for THIS plan is custom.agy-worker (canonical
worker-surface contract, Muse's included custom-connector
tooling, credential via the secure connection flow). The minimal
transport contract is the gateway's existing HTTP API — Muse
pulls work by calling it; no AGY push into a personal session is
required, and no MCP server is needed for this route (an MCP
tool mapping is specified in the v12 report as an unbuilt
alternative). v7 text is otherwise carried over.

- A1: the worker registry is GLOBAL, not project-scoped (evidence
  below). The v6 isolation claim was wrong; isolation is rebuilt on
  a distinct qualification worker identity.
- A2: the callback dispatcher existed only as helpers. A runtime
  driver is now part of the candidate code and wired into the
  canonical service (default disabled).

NOTHING in this plan has been done.

## Corrected registry facts (pin 36516473, read from source)

- agy_workers (migration 001): worker_id is the PRIMARY KEY; the
  table has NO tenant/workspace/project columns. Migration 004's
  RLS/scope loops enumerate 21 tables — agy_workers is NOT among
  them. ResourceStore.list() selects all rows unscoped; register()
  upserts ON CONFLICT(worker_id). metadata.bindings live on the
  global row.
- Therefore one worker_id cannot be OFFLINE for business and READY
  for qualification, and bindings cannot differ per project for one
  worker_id. No per-project RLS for agy_workers is claimed anywhere
  in this plan.
- Project-scoped levers that DO exist: agy_connectors (RLS-scoped;
  the dispatch projection derives each project's adapter_kinds from
  its ENABLED connector kinds) and agy_project_worker_health.

## Isolation model (rebuilt, test-evidenced)

- Business worker MUSE-SEO-WORKER: global row stays OFFLINE, its
  'muse' connector stays as provisioned dormant in GL_AUTOMATION,
  its bindings stay incomplete. Nothing in the G2 window registers,
  flips, or debits it.
- Qualification worker MUSE-QUAL-WORKER: a DISTINCT global row with
  adapter kind 'muse-qual'. The 'muse-qual' connector is inserted
  ONLY in project GL_QUALIFICATION, so:
  * GL_AUTOMATION's adapter_kinds never contains 'muse-qual' → the
    qualification worker is not allocatable there;
  * GL_QUALIFICATION's adapter_kinds contains ONLY 'muse-qual' →
    no business worker is allocatable there;
  * the qual row's bindings are global but single-purpose (missions
    ['GL_QUALIFICATION'] only), so globality has no cross-talk.
- Ungated-route isolation (B1, replacing the v6 guard): the v6
  blanket payload filter was a REGRESSION (it also changed the
  dispatch query for every caller) and is removed. The ungated
  dispatch query and selection are pin-exact again; payload
  addressing keeps pin semantics for legacy tasks. The NEW external
  worker is isolated through the registry instead: its global row
  carries metadata.external_namespace_only=true, and ungated claims
  exclude such workers from allowedWorkers in every project, while
  gated claims (the new namespace, scoped payload read + gate) are
  unaffected. Adapter-kind scoping remains the second wall: the
  qualification kind exists only in GL_QUALIFICATION, so no legacy
  worker can take the qualification task either.
- Local test evidence for the four states (integration suite):
  adapter_kinds isolation asserted per project; the business row's
  status/metadata/quota/active_count are byte-identical before and
  after the full qualification flow; a queued untargeted business
  task remains QUEUED at attempt 0 with zero reservations (never
  mutated, never alternately claimed — cross-scope claims are
  PROJECT_SCOPE_DENIED in both directions); the qualification task
  is claimed/resulted only by MUSE-QUAL-WORKER in GL_QUALIFICATION.

## Identities and secrets

- Receiver and driver act as the EXISTING control-plane operator
  identity (already in AGY_IDENTITIES_JSON), in-process on the
  server. No new operator identity; the operator token is never
  handed to Claude/Gemini — workers authenticate with their own
  worker identities only.
- Worker-plane identities: claude-worker (MUSE-SEO-WORKER,
  dormant), claude-qual-worker (MUSE-QUAL-WORKER — the G2 actor,
  scoped to GL_QUALIFICATION only), gemini-worker
  (GEMINI-SEO-WORKER, incomplete bindings, denied by design),
  gemini-reviewer (dormant).
- Secrets: server-side env values only (AGY_IDENTITIES_JSON);
  Muse's worker token reaches Muse solely via the Secure Vault
  into the custom.agy-worker connector (exact-host allowlist).

## Runtime driver (A2 — now real candidate code)

- src/platform/worker-callback-driver.ts, wired in
  src/temporal/server.ts next to the receiver. No new queue, no new
  service, no raw secret handling.
- DEFAULT DISABLED: it starts only when ALL of these env NAMES are
  set for the window: AGY_CALLBACK_DRIVER_ENABLED=true,
  AGY_CALLBACK_DRIVER_SCOPE=gl:legacy-workspace:GL_QUALIFICATION,
  AGY_CALLBACK_DRIVER_MISSION=GL_QUALIFICATION. Missing scope or
  mission → it refuses to start (state reported at boot).
- Window identity (B2): AGY_CALLBACK_DRIVER_EXPIRES_AT (absolute
  ISO timestamp) and AGY_CALLBACK_DRIVER_RUN_ID are REQUIRED and
  owner-issued for the window. A restart re-reads the same deadline
  — the window can never renew; a boot past the deadline starts
  EXPIRED and runs no pass. Bounds: AGY_CALLBACK_DRIVER_LIMIT=1
  (hard cap 5), AGY_CALLBACK_DRIVER_INTERVAL_MS (default 30000),
  AGY_CALLBACK_DRIVER_TIMEBOX_MS (default 3600000) may only shorten
  the window further; each pass's send timeout is capped by the
  time actually left, so no pass runs past the deadline. The
  deadline is re-checked after EVERY phase and before every
  intent/send inside a pass (C1): remaining time is never captured
  once and reused, and a send's timeout is computed from the time
  actually remaining at that send, with no floor that could push it
  past the window. A reconcile phase that itself crosses the
  cutoff may still record read-only proof it already read, but no
  dispatch follows it.
- Delivery-failure policy (B3): auth/route failures (401/403/404)
  and tuple conflicts (409) stop at the FIRST occurrence; transient
  definite failures retry at most twice after the original send,
  with the counter persisted in delivery_attempts (a restart never
  resets it); UNKNOWN still only reconciles, never re-sends.
  Exhaustion or a blocking failure lands the row in BLOCKED with
  needs_owner_repair in the event trail; the driver stops in state
  BLOCKED and reports instead of polling. The only way back is the
  owner's explicit releaseBlockedCallback after repair. BLOCKED
  is a persisted state, not a per-pass event (C2): the driver reads
  persisted BLOCKED rows for its scope/mission at the start of
  every pass — including the first pass after a restart — and stops
  BLOCKED before any lookup or send. A reconcile lookup that fails
  with an auth/config block (401/403, a denied guard, a missing
  route) is classified the same way: the row moves to BLOCKED with
  needs_owner_repair and processing stops, instead of repeating as
  lookup_failed every interval. A clean receipt-not-found
  ({found:false}) is distinct from a route-error 404 and simply
  leaves the row UNKNOWN.
- Every pass: crash-recovery sweep (stale SENDING → UNKNOWN) →
  reconcile → dispatch, all mission-filtered to the allowlist, so
  the driver can only ever touch GL_QUALIFICATION callbacks inside
  the one project. Restart-safe by the same protocol (no blind
  resend; UNKNOWN reconciles first).
- Transport/lookup default to the co-located receiver in-process —
  the idempotency/receipt protocol is identical to the HTTP shape;
  the operator credential never leaves the server.
- Test evidence: disabled driver starts as DISABLED; enabled
  without an operator identity → NO_OPERATOR; mission filter with a
  foreign mission touches nothing (seen=0); a running driver
  delivered the qualification callback (receipt effect_count=1);
  an exhausted timebox → EXPIRED before any pass.
- Until this code is deployed (owner gate), the live statement
  remains: source prior to this candidate never called the
  dispatcher, so approving "G1, G2" against the OLD source could
  not have produced a full cycle. With the driver deployed but
  disabled, the cycle still does not run until the window config
  above is set.

## The resource-profile constraint (exact, unchanged + two additions)

Canonical allocation has NO null-quota path, and two further hard
gates were verified in source during this round:

- Scheduler: quotaRemaining − estimatedQuota >= quotaReserve is
  required — a cap-only profile must therefore carry
  quota_reserve = 0.
- selectProjectDemand SKIPS a project whose resource_policy lacks
  finite maxConcurrentTasks/quotaCap/spendCap/reservation — the
  qualification project's policy must carry all four (candidate SQL
  does). Cross-project selection is global and sorts by project
  priority first — the qualification project carries priority 10
  during the window only (rollback restores 0).

Option A — bounded owner policy exception (required for G2 to run):
for the 60-minute window, in GL_QUALIFICATION only: the
qualification controller's one-shot transition grants the worker
quota_remaining = 1 with quota_reserve = 0 (filled only from NULL,
never refilled), and the worker completes its own profile by
ARRIVING through the exposed surface action (see "Worker arrival"
below), which projects the project's own provisioned permissions
and its resource-policy quotaCap (= 1, the same approved number)
into the worker profile. maxConcurrency 1, spendCap 0. The
synthetic job carries pass_threshold 0, so NO passRate/reliability
number is asserted for anyone; scoring fields stay at engine
defaults and are recorded DEFAULT_NOT_MEASURED. The numbers are
ceilings for one task, never evidence; registry metadata keeps
qualification=UNVERIFIED until QA judges the run's own telemetry.
Option B — no exception: G2 is BLOCKED_RESOURCE_PROFILE. Approving
"G1, G2" without the exception does NOT make the run possible.

## Preflight P0 (all must verify, else stop)

1. Staging health READY, production=false.
2. Migration 012 applied (both tables exist).
3. Receiver smoke: no token → 401; worker token → 403; operator on
   a foreign project path → 403.
4. Business state: MUSE-SEO-WORKER OFFLINE; GL_AUTOMATION
   adapter_kinds does NOT contain 'muse-qual'.
5. GL_QUALIFICATION provisionable by the qualification controller
   (below): adapter_kinds exactly ['muse-qual'] once it has run;
   MUSE-QUAL-WORKER OFFLINE, quota NULL, bindings complete for
   GL_QUALIFICATION before the window. The worker's presence step
   inside the window is its own 'arrive' call (see "Worker
   arrival"): before it, claims return EMPTY by design.
6. Driver state at boot: DISABLED (no driver env set outside the
   window).
7. The two SEO tasks untouched (never claimed/replayed/relabelled).
8. Owner policy exception (Option A) explicitly granted, OR the run
   is recorded BLOCKED_RESOURCE_PROFILE and stops.

## Provisioning entrypoint (feasibility, verified from the pin)

There is NO existing executable entrypoint for the data lifecycle,
and this plan no longer pretends otherwise:
- The deployed service (src/temporal/server.ts) exposes mission
  actions, worker routes and callback routes only. It constructs
  no ProjectService and has no /jobs route; ProjectService is
  library code (tests, the legacy daemon, a separate platform
  server that is not this deployment). The Railway connector
  available to the control plane has no exec/SQL either. At the
  pin, "ControlPlane creates the job" names NO real caller —
  without the candidate below, provisioning is
  BLOCKED_PROVISIONING (manual SQL by whoever holds the bootstrap
  connection, which must not be pulled out of its environment).
- Schema DOES have a real entrypoint: the Railway predeploy
  command node dist/src/hosted/provision-cli.js →
  provisionStaging() re-reads migrations/ sorted, SHA-tracks each
  file in agy_hosted_migrations, applies new ones and grants the
  runtime role SELECT/INSERT/UPDATE on all tables. Once migration
  012 is in migrations/ via the deployment delta, it applies
  automatically at predeploy — no migration edits, no bootstrap
  secret anywhere else.
- The DATA lifecycle is covered by the candidate
  src/platform/qualification-controller.ts, wired into
  src/temporal/server.ts next to the callback driver. It runs
  in-process under the service's existing runtime DATABASE_URL
  role, DEFAULT DISABLED, and starts only with ALL of:
  AGY_QUALIFICATION_ENABLED=true, AGY_STAGE_ONLY=true,
  AGY_QUALIFICATION_RUN_ID (owner-issued),
  AGY_QUALIFICATION_EXPIRES_AT (absolute, owner-issued),
  AGY_QUALIFICATION_CAP_ONLY_APPROVED=true (the Option A flag).
  Scope/project/mission/worker/adapter/target are fixed constants.
  The grant is ONE-SHOT per (run id, deadline) and TRANSACTIONAL
  (E1): every controller for this scope — ANY run id — serializes
  on ONE advisory transaction lock keyed by the fixed scope, so
  two different runs racing from an empty scope produce exactly
  one owner and the loser blocks on the winner's marker. The
  grant marker {run_id, expires_at, granted_at, phase} is written
  into the qualification project's policies in the SAME
  transaction as the registry inserts and the cap-only transition
  (phase 'PREPARING'); the ONE job follows via ProjectService
  (idempotency_key = the run id); a second short transaction then
  flips the marker to 'GRANTED' after revalidating marker + job +
  exactly-one-task under the same lock. A crash therefore leaves
  nothing, a durable PREPARING grant (which the SAME run's next
  controller completes — registry re-application is
  insert-if-absent and the transition fills quota ONLY from NULL,
  so completion can never refill a consumed cap), or a GRANTED
  window. A GRANTED marker whose job is missing fails closed
  (BLOCKED), never silently repaired. After the grant, ticks are
  MONITOR-ONLY: no registry re-application, no quota refill, no
  re-activation of an owner-paused project or an owner-offlined
  worker. The deadline is re-checked INSIDE the prepare
  transaction after the lock is held, again before job creation,
  and again inside the flip transaction (E2): a prepare that
  crosses the cutoff while waiting on the lock grants nothing and
  falls through to cleanup. Before granting, ownership is checked
  fail-closed: a previous run's marker, ANY job not owned by this
  run, or a worker already holding quota without this run's grant
  BLOCKS the controller (needs_owner_repair) — a new run
  therefore requires the owner to clear the scope first; that is
  the exact dependency if it ever triggers. (A worker that is
  merely READY from an early arrival holds no cap; arrival is
  presence, not a grant, and does not block.) It cannot touch
  business rows: every statement is scope-fixed or keyed to the
  one qualification worker_id (test-proven byte-identical
  before/after). Past the deadline it rolls back AUTOMATICALLY
  (E3): under the same scope lock it forces the run's active
  leases into the past and sets the dormant state (connector
  disabled, worker OFFLINE + quota NULL, project PAUSED +
  priority 0) in one transaction, then hands the leases to the
  engine's own reclaimExpired() — the canonical expiry path that
  locks the task rows, settles HELD reservations to EXPIRED under
  their state guard, transitions the tasks (this run's
  maxRetry-0 task lands BLOCKED: nothing stays runnable) and
  releases capacity through the canonical trigger. A result
  racing cleanup serializes on the task row: exactly one of them
  settles. The QUALIFICATION_LEASE_NEUTRALIZED event is written
  under a durable NOT EXISTS guard, so repeated or crash-resumed
  cleanups emit it exactly once; evidence rows are preserved; any
  failure stops it BLOCKED with needs_owner_repair.
  Complementing the cleanup, the owner deadline is enforced at
  the authoritative mutation point for worker leases (E2): the
  store's claim and heartbeat accept the deadline and enforce it
  INSIDE their transactions — claim re-checks it after the
  registry lock is held (a claim that waited past the cutoff
  leases nothing) and lease_expires_at is LEAST-capped at the
  deadline, so lease_expires_at <= deadline holds exactly, with
  no tolerance; heartbeat's extension is capped the same way and
  its UPDATE refuses to run at/after the deadline, so a
  last-fraction-second heartbeat can reach the deadline but never
  cross it. ack, checkpoint and result need no extra wiring:
  their store paths already validate lease_expires_at under the
  task row lock, and a capped lease makes that check a deadline
  check — even if the service is down at the deadline and returns
  later, the old lease's mutations are denied. The wiring lives in
  server.ts (the surface's per-scope lease deadline); scopes
  without a deadline, including all ungated business callers, are
  untouched.

## Worker arrival (the runnable entrypoint, E4)

The controller grants a SHELL worker row on purpose: no presence,
a resource_profile of {spendCap: 0, quotaCap: null} and no
permissions — by itself it cannot be allocated, and earlier
versions of this plan silently relied on a test-only
ResourceStore.register with fabricated measurements to complete
the profile. The candidate now carries the real entrypoint: the
'arrive' action on the canonical worker surface, reachable at
POST /v1/worker/tenants/:tenant/workspaces/:workspace/projects/:project/arrive
on the deployed gateway (the same route family as claim/ack/
heartbeat/result), authenticated by the worker's OWN identity
(worker id derived from the token, never from the request body).
Route correction (v12): the gateway's worker route originally
enumerated only claim|ack|heartbeat|checkpoint|result|readback —
'arrive' was missing at the HTTP layer even though the surface
accepted it. The candidate route regex now includes 'arrive',
and the loopback integration suite proves the full HTTP path
(real server, real CLI, local Postgres). On the Muse side, the
calls are made by the custom.agy-worker connector candidate
(~/workspace/custom-connectors/custom.agy-worker/), which uses
Muse's included custom-connector tooling: the worker token is
registered once by the owner through Muse's secure connection
page (credentials.request_api_access, provider agy-worker,
api_key in the bearer header, host
agy-temporal-staging-staging.up.railway.app) and reaches requests
only through the dynamic-credential surrogate. Muse pulls work
by calling the gateway — no push into a personal session, no
model-API substitution, no cookie or secret export anywhere in
the design.
Arrival is an OPT-IN stamp (F1), not a general presence call.
It proceeds only when ALL of these hold, read before any write,
so a refusal mutates nothing: the project carries this run's
live grant marker (phase GRANTED, deadline in the future —
business projects have no marker and are refused outright); the
project is ACTIVE; an enabled connector of the worker's own
adapter kind exists in the scope; the worker's provisioned
bindings are complete; and the worker is ALREADY in the
controller-granted READY state. Arrival then does exactly two
things, both server-derived: stamps presence (heartbeat_at) and
projects the project's OWN provisioned permissions and OWN
resource-policy quotaCap into the worker's profile — allocation
requires both, and both are numbers/lists the owner already
provisioned, so no measurement is fabricated: passRate and the
other scoring fields stay at DEFAULT_NOT_MEASURED, which the
synthetic job's pass_threshold 0 accepts without asserting
anything. Arrival NEVER sets the worker status: READY is the
controller's grant decision, and an owner-OFFLINE worker is
refused (ARRIVAL_REFUSED), as is any arrival in an owner-PAUSED
project or after cleanup (ARRIVAL_NOT_GRANTED). It never grants
or refills quota (quota_remaining/quota_reserve are the
controller's), never touches metadata/bindings, never activates
a project, enables a connector, or creates a job; an
unprovisioned worker id is refused (WORKER_NOT_PROVISIONED — no
self-provisioning, per the Q1 rule).

## Lost-claim recovery (F5)

A claim whose response is lost in transport no longer strands
the worker. The surface 'recover' action — CLI:
`agy_worker.py recover --run-id <owner-run-id>` — takes only the
worker identity (from its token) and the owner-issued run id
from its assignment, and returns the worker's OWN live lease for
that run's job in this scope: the exact lease_token and attempt
the original claim issued. It is a pure read (repeatable,
identical output), creates no lease, attempt, or reservation,
and returns NOT_FOUND / NO_ACTIVE_LEASE with no task data for a
run the caller holds nothing under; an expired lease fails
closed (LEASE_EXPIRED) and is never revived. The loopback suite
proves the full path with zero harness-supplied lease material:
disconnect claim → all worker-local lease knowledge discarded →
CLI recover → ack → heartbeat → checkpoint → result on the
original attempt and the original single reservation. The end-to-end qualification
cycle in the integration suite now runs from an empty scope
through ONLY these exposed actions (controller grant → arrive →
claim → ack → heartbeat → result), with no direct ResourceStore
intervention anywhere. No owner operation remains hidden in the
flow: the remaining owner operations are exactly the D-054 steps
listed at the end of this plan.

## Transition P1 + Run P2 (window, ≤ 60 minutes, one task)

1. Set the qualification controller env (run id + absolute deadline
   = window end + the cap-only approval flag) together with the
   driver env (scope + mission + limit 1 + the owner-issued
   AGY_CALLBACK_DRIVER_EXPIRES_AT set to window end + a fresh
   AGY_CALLBACK_DRIVER_RUN_ID) and restart the staging service;
   boot log must show the controller ACTIVE and the driver RUNNING
   with that runId. A restart inside the window resumes against
   the SAME deadlines; the controller re-derives everything from
   the database and the driver performs the dispatcher's bounded
   passes — there is no manual pass and no manual SQL anymore.
2. The controller performs the window transition and creates
   exactly ONE synthetic job in GL_QUALIFICATION: pass_threshold 0,
   one planning task, estimatedQuota 1, estimatedCost 0, payload
   mission_id GL_QUALIFICATION + target_worker_id
   MUSE-QUAL-WORKER + callback_target
   CHATGPT_ASSISTANT_CONTROL_PLANE. No external calls, no paid API.
3. Muse (claude-qual-worker identity, via Secure Vault connector)
   arrives ('arrive' action) → claims → ack → heartbeat →
   checkpoint → result through the worker surface. Arrival is a
   real step of the run, not a fixture: without it the claim
   returns EMPTY, and the evidence pack includes the arrival.
5. Evidence pack (rows, not claims): task + attempt, reservation
   HELD→SETTLED, checkpoint + digest, outbox DELIVERED by the
   driver, receiver receipt effect_count=1, CALLBACK_DRIVER_PASS
   log lines, event trail. Wording limit: the receipt proves the
   canonical host recorded the callback and the control plane read
   it back; native ChatGPT-client ingestion is a separate,
   still-unproven gate. Any unexpected state aborts the run.

## Rollback P3 (window end OR abort, whichever first)

Primary path is automatic: past the deadline the qualification
controller itself neutralizes the run's active lease through the
engine's canonical expiry accounting (lease forced into the past;
reclaimExpired settles the HELD reservation to EXPIRED exactly
once under its state guard, transitions the task to BLOCKED so
nothing remains runnable, and releases capacity through the
canonical trigger; the neutralization event is emitted exactly
once under a durable guard), disables the qualification
connector, sets the qual worker OFFLINE + quota NULL and
GL_QUALIFICATION → PAUSED, priority 0, then stops (evidence rows
preserved). The exact owner dependency remains only if the service
is DOWN at the deadline: then the same three updates are the
owner's manual fallback via the candidate SQL step 5, and the run
is recorded as rolled back manually, not automatically. Driver env
unset + service restart returns the driver to DISABLED.
Business project untouched throughout. Code/config/migration
rollback as in the previous plan version (redeploy f40 lineage;
remove worker-plane identities; unset AGY_WORKER_UI_SESSION_SECRET;
012 tables additive and inert without the code).

## Final owner steps (per D-054 — listed, NOT requested here)

1. ControlPlane final QA verdict on the current supplement head.
2. Owner chốt: prepare the deployment delta branch from f40c15b9
   (GitHub write — separate consent from PR #15 updates).
3. Owner approve: staging deploy (including the driver code) + env
   NAME changes + migration 012 + dormant registry provisioning
   (business registry v3 + qualification registry candidate).
4. Owner personally completes the ONE connection action for
   custom.agy-worker: when Muse presents the secure connection
   page (credentials.request_api_access for provider agy-worker),
   enter the claude-qual-worker token that step 3 provisioned
   server-side. That single entry is the entire connection
   procedure on the Muse side — the connector candidate, its
   helper and its docs are already prepared and locally proven;
   nothing else needs to be installed, pasted, or configured.
   Muse's first live call afterwards is the harmless health
   read, reported before any arrive or claim.
5. Owner approve: the G2 window INCLUDING the Option A policy
   exception as written — or record G2 as BLOCKED_RESOURCE_PROFILE.
6. Separately: G3 shadow decision; Gemini's own qualification.

Until step 2 is approved, the correct state remains: candidate code
in the review PR only, live route BLOCKED_TRANSPORT, workers
OFFLINE/UNVERIFIED, G2 not runnable.
