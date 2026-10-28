# Activation Plan — CANDIDATE v6 (not executed, approval not requested)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1. Revised per QA findings D1–D3
on v9 (C1–C2 themselves stand): the qualification controller's
lifecycle is now one-shot prepare + monitor + guarded cleanup —
durable grant marker, fail-closed run ownership, lease
neutralization at rollback, and the owner's exact caps
(quotaCap 1). v5 text is otherwise carried over.

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
for the 60-minute window, in GL_QUALIFICATION only, the control
plane registers MUSE-QUAL-WORKER with quotaRemaining = quotaCap =
the task's estimate (1), quota_reserve = 0, maxConcurrency 1,
spendCap 0, status READY. The synthetic job carries
pass_threshold 0, so NO passRate/reliability number is asserted for
anyone; scoring fields stay at engine defaults and are recorded
DEFAULT_NOT_MEASURED. The numbers are ceilings for one task, never
evidence; registry metadata keeps qualification=UNVERIFIED until QA
judges the run's own telemetry.
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
   GL_QUALIFICATION before the window.
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
  The grant is ONE-SHOT per (run id, deadline): an advisory lock
  keyed by the run id serializes concurrent controllers, and a
  grant marker {run_id, expires_at, granted_at} is written into
  the qualification project's policies in the step that opens the
  window (registry inserts ON CONFLICT DO NOTHING, project update
  scope-WHERE'd, cap-only transition READY + quota_remaining=1 +
  quota_reserve=0 — the transition fills quota ONLY from NULL, so
  it cannot refill a consumed cap — and the ONE job via
  ProjectService with idempotency_key = the run id). After the
  grant, ticks are MONITOR-ONLY: no registry re-application, no
  quota refill, no re-activation of an owner-paused project or an
  owner-offlined worker. Before granting, ownership is checked
  fail-closed: a previous run's marker, ANY job not owned by this
  run, or a worker left READY without this run's grant BLOCKS the
  controller (needs_owner_repair) — a new run therefore requires
  the owner to clear the scope first; that is the exact dependency
  if it ever triggers. It cannot touch business rows: every
  statement is scope-fixed or keyed to the one qualification
  worker_id (test-proven byte-identical before/after). Past the
  deadline it rolls back AUTOMATICALLY: the run's active lease is
  neutralized (lease_expires_at forced into the past, the HELD
  reservation settled to EXPIRED exactly once), the qualification
  connector is disabled, the worker goes OFFLINE + quota NULL and
  the project PAUSED + priority 0, evidence preserved; any failure
  stops it BLOCKED with needs_owner_repair. Complementing the
  cleanup, the worker surface caps claim/heartbeat lease seconds
  for the qualification scope at the same deadline (wired in
  server.ts), so no lease issued inside the window can outlive
  it — even if the service is down at the deadline and returns
  later, the old lease's heartbeat/result are denied.

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
4. Muse (claude-qual-worker identity, via Secure Vault connector)
   claims → ack → heartbeat → checkpoint → result through the
   worker surface.
5. Evidence pack (rows, not claims): task + attempt, reservation
   HELD→SETTLED, checkpoint + digest, outbox DELIVERED by the
   driver, receiver receipt effect_count=1, CALLBACK_DRIVER_PASS
   log lines, event trail. Wording limit: the receipt proves the
   canonical host recorded the callback and the control plane read
   it back; native ChatGPT-client ingestion is a separate,
   still-unproven gate. Any unexpected state aborts the run.

## Rollback P3 (window end OR abort, whichever first)

Primary path is automatic: past the deadline the qualification
controller itself neutralizes the run's active lease (expiry
forced into the past; the HELD reservation settled to EXPIRED
exactly once), disables the qualification connector, sets the
qual worker OFFLINE + quota NULL and GL_QUALIFICATION → PAUSED,
priority 0, then stops (evidence rows preserved). The exact owner dependency remains only if the service
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
4. Owner personally completes the Secure Vault credential step for
   custom.agy-worker (claude-qual-worker identity).
5. Owner approve: the G2 window INCLUDING the Option A policy
   exception as written — or record G2 as BLOCKED_RESOURCE_PROFILE.
6. Separately: G3 shadow decision; Gemini's own qualification.

Until step 2 is approved, the correct state remains: candidate code
in the review PR only, live route BLOCKED_TRANSPORT, workers
OFFLINE/UNVERIFIED, G2 not runnable.
