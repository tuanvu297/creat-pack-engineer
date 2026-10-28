# Canonical v9 Supplement — AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1

OFFLINE candidate supplement responding to independent-QA findings
C1–C2 on v8 (B1–B3 themselves accepted), plus the provisioning
feasibility supplement QA required alongside them. Scope kept
exactly as set: the two boundary points, their tests, and the
minimal provisioning candidate — no other features, no owner
steps executed. Earlier supplements and PR snapshots stay frozen.
This package will be written into PR #15 as its own version folder
under the owner's existing approval.

## Test evidence (all LOCAL, real local PostgreSQL 18.4, migrations
001–008 + candidate 012, RLS-bound NOSUPERUSER runtime role)

- test/worker-surface-v3.integration.test.ts — 1/1 PASS, now covering
  S1–S3, S6, T1, T3, U1–U3, V1–V2, V3-as-corrected-by-B1, A1, A2,
  B1–B3, C1–C2, D (provisioning controller).
- test/worker-ui.integration.test.ts — 1/1 PASS. Canonical repo DB
  integrations — 3/3 PASS. Repo unit suite — 154 pass / 2 fail
  (pre-existing pin inconsistencies) / 9 skipped. tsc clean.
- Stack verification: pin + PR #15 canonical patch + supplement
  patches 01–04 reproduces the tested tree byte-for-byte on all 12
  touched/new source files.

## C1 — The deadline was checked too early; now re-checked at every effect

QA was right: the driver computed `remaining` ONCE, before
recover+reconcile, and reused it for the dispatch timeout — a slow
lookup or DB phase could carry the pass past the cutoff and a send
would still start, with a timeout derived from stale remaining time
(and a 50 ms floor that could itself overrun the window).
Fix (src/platform/worker-callback-driver.ts,
src/platform/worker-callbacks.ts):
- The driver re-checks the absolute deadline after EVERY phase
  (persisted-blocked preflight → recover → reconcile → dispatch)
  and hands the dispatcher the absolute deadline, not a duration.
- The dispatcher re-checks the deadline before EVERY intent claim
  and every send in a multi-row pass, and computes each send's
  timeout from the time actually remaining at that moment —
  min(configured timeout, remaining), with NO 50 ms floor when a
  deadline is set; an already-passed deadline means the transport
  is never invoked (the row classifies UNKNOWN, the pass reports
  expired and stops). A reconcile phase that itself crosses the
  cutoff may still record read-only proof it already read; no
  dispatch follows it.
Evidence: (a) a two-row dispatch pass under a 250 ms deadline with
a 350 ms transport starts exactly ONE send (bounded by the real
remaining time, classified UNKNOWN) and never claims the second
row (still PENDING, delivery_attempts 0, pass reports expired);
(b) a driver whose reconcile lookup deliberately takes 350 ms
against a 200 ms deadline performs ZERO sends and ends EXPIRED,
and the clean found:false it read leaves the UNKNOWN row UNKNOWN —
recorded, never re-sent.

## C2 — BLOCKED was per-pass; now persisted state stops the driver, and lookup blocks classify

QA was right on both halves: dispatchWorkerCallbacks reported
blocked=[] for a row blocked by an earlier process, so a restarted
driver polled no-op passes forever; and a reconcile lookup failing
with 401/403 or a denied guard was recorded as a generic
lookup_failed and retried every interval.
Fix (src/platform/worker-callbacks.ts,
src/platform/worker-callback-driver.ts):
- New listBlockedWorkerCallbacks(scope, mission) reads persisted
  BLOCKED rows. The driver checks it at the start of every pass —
  before any lookup or send — and stops in state BLOCKED with
  needs_owner_repair. A restart therefore behaves exactly like the
  process that blocked the row.
- Reconcile classifies auth/config lookup blocks
  (CallbackLookupBlocked; HTTP 401/403; a missing-route 404; the
  in-process ACTION_DENIED / PROJECT_SCOPE_DENIED guards): the row
  moves UNKNOWN → BLOCKED with a CALLBACK_RECONCILE_BLOCKED event
  carrying needs_owner_repair, the blocked row is returned in the
  reconcile result, processing stops (the same broken lookup would
  fail for every row), and the driver stops BLOCKED before any
  dispatch. The HTTP lookup adapter distinguishes a clean
  receipt-not-found — a 404 whose JSON body is the receiver's own
  {found:false} — from a route-error 404, which is a config block.
  A clean found:false still just leaves the row UNKNOWN.
Evidence: (a) a fresh driver started against the B3 section's
persisted BLOCKED row stops BLOCKED with ZERO lookup and ZERO send
calls; (b) a driver whose lookup throws a 401 block makes exactly
ONE lookup call in total, lands the row BLOCKED, stops BLOCKED,
and never sends the pending row behind it; (c) a direct reconcile
with an ACTION_DENIED lookup reports blocked=1, lookup_failed=0.

## Provisioning feasibility — no such entrypoint exists at the pin; a minimal candidate is included

QA's catch was correct: the plan said "Control Plane creates ONE
job", but the deployed public gateway
(src/temporal/server.ts + http-server.ts) exposes mission actions,
worker routes and callback routes only — it constructs no
ProjectService and has no /jobs route, ProjectService is library
code (tests, legacy daemon, a separate platform server that is not
this deployment), and the control plane's Railway connector has no
exec/SQL. At the pin there is NO executable caller for applying
the qualification registry, creating the job, or rolling the scope
back — only test helpers and candidate SQL. Without a candidate,
that state is BLOCKED_PROVISIONING and "approve G1, G2" could not
run.
What DOES exist (verified in source): the Railway predeploy
command node dist/src/hosted/provision-cli.js → provisionStaging()
re-reads migrations/ sorted, SHA-tracks files in
agy_hosted_migrations, applies new ones, and grants the runtime
role SELECT/INSERT/UPDATE on all tables — under the bootstrap
connection, which stays inside the predeploy environment. So
migration 012 needs no new mechanism and no secret handling: it
applies automatically once the deployment delta puts the file in
migrations/.
Candidate (src/platform/qualification-controller.ts, wired into
src/temporal/server.ts like the callback driver): an in-process
controller under the service's existing runtime DATABASE_URL role.
DEFAULT DISABLED; it starts only with AGY_QUALIFICATION_ENABLED=
true AND AGY_STAGE_ONLY=true AND an owner-issued
AGY_QUALIFICATION_RUN_ID AND an absolute
AGY_QUALIFICATION_EXPIRES_AT AND AGY_QUALIFICATION_CAP_ONLY_APPROVED
=true (the Option A approval as an explicit flag — without it,
config parsing refuses with CAP_ONLY_APPROVAL_REQUIRED).
Scope/project/mission/worker/adapter/target are fixed constants.
Each tick derives state from the database: idempotent registry
application (ON CONFLICT DO NOTHING inserts, scope-WHERE'd project
update), the cap-only transition, and exactly ONE job via
ProjectService with idempotency_key = run id (createJob is
conflict-idempotent — restarts and repeated ticks can never create
a second job or task). Past the deadline it performs the rollback
itself and stops; any failure stops it BLOCKED with
needs_owner_repair. The only owner dependency left is the one
named in the plan: if the service is DOWN at the deadline, the
same three updates are a manual owner fallback — otherwise
rollback is automatic, and no bootstrap credential is ever needed
outside predeploy.
Evidence (section D of the surface suite, all under the
role-switched runtime pool, never the owner pool): the controller
re-applies a deleted qualification connector by itself, reaches
ACTIVE (worker READY, quota_remaining=1, quota_reserve=0), creates
exactly 1 job / 1 task with the fixed mission/target payload; a
second instance with the same run id (restart) still leaves
exactly 1 job / 1 task; the business project and business worker
rows are byte-identical before/after; a third instance past the
deadline ends ROLLED_BACK with worker OFFLINE/quota NULL and
project PAUSED/priority 0, and no second job.

## Boundaries

Offline candidate only; the PR write is the previously approved
review-branch update and nothing more. Migration 012 is still
unapplied anywhere. Live hosted behaviour remains UNPROVEN; the
live route remains BLOCKED_TRANSPORT; G2 remains not runnable
until the owner steps in the plan — including the Option A policy
exception or a BLOCKED_RESOURCE_PROFILE record — are decided.
