# Supplement Report V10 — D1–D3 (controller lifecycle) on top of v9

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1. OFFLINE candidate supplement
responding to independent-QA findings D1–D3 on v9's
qualification-controller. The C1/C2 callback fixes from v9 are
unchanged and stand. Scope kept exactly as set: the controller
lifecycle only, reduced to one-shot prepare + monitor + guarded
cleanup — no generic features added. Earlier supplements and PR
snapshots stay frozen. This package will be written into PR #15
as its own version folder under the owner's existing approval
(2026-10-28 13:11 +07).

## D1 — one-shot grant; ticks after the grant are monitor-only

QA was right: v9's tick re-applied the registry UPDATE (project
ACTIVE) and the transition UPDATE (quota_remaining=1) on EVERY
pass, so a claim that consumed the cap would be silently refilled
on the next tick or restart, and an owner pause would be undone.
The controller now grants at most once per (run id, deadline):
- A session advisory lock keyed by the run id
  (pg_advisory_lock(hashtext('agy:qualification:'||runId)))
  serializes concurrent controllers; the loser then observes the
  durable grant and becomes a monitor.
- The grant marker {run_id, expires_at, granted_at} is written
  into the qualification project's policies in the same prepare
  step that opens the window. A marker whose run id matches but
  whose deadline differs blocks the controller
  (RUN_ID_REUSED_WITH_DIFFERENT_DEADLINE).
- The cap transition is CAS-shaped: quota is filled only WHERE
  quota_remaining IS NULL, so no statement in the controller can
  refill a consumed (0) or granted (1) cap.
- After the grant, ticks only monitor (deadline + state). The
  single completion a monitor may perform is creating the run's
  job if a crash between the marker write and job creation left
  it absent — job creation is conflict-idempotent and touches no
  counters — plus re-inserting a worker/connector row that is
  entirely ABSENT. Existing rows are never rewritten.

## D2 — run ownership fail-closed; cleanup neutralizes the lease

- Preflight (before any grant): a previous run's grant marker,
  ANY job in the scope whose idempotency key is not this run's,
  more than this run's one job, a run job without exactly one
  task, or a qualification worker left READY / holding quota
  without this run's grant — each BLOCKS the controller with
  needs_owner_repair and a named reason. The controller never
  opens a second window on top of history it does not own, and
  the worker can therefore never be re-READIED into claiming a
  previous run's queued task through this path. The exact owner
  dependency is stated in the plan: a genuinely new run requires
  the owner to clear the scope first.
- Guarded cleanup (past the deadline): in addition to worker
  OFFLINE + quota NULL and project PAUSED + priority 0, cleanup
  now (a) forces the run's known active lease into the past
  (lease_expires_at = now() − 1s, fenced on CLAIMED/RUNNING and
  on the lease still being future), (b) settles the lease's HELD
  reservation to EXPIRED under its state='HELD' guard — the
  store's own exactly-once pattern — writing the
  QUALIFICATION_LEASE_NEUTRALIZED event ONLY when a row actually
  changed, so a repeated cleanup is a pure no-op, and
  (c) disables the qualification connector. QA's point stands
  behind this: project PAUSED + worker OFFLINE alone would still
  let an old lease heartbeat/result through the surface fence,
  which checks the lease, not project/worker status. Cleanup
  also refuses to touch a scope whose grant marker belongs to a
  different run (BLOCKED, no writes).
- Lease cap at issuance: createWorkerSurface gained an optional
  leaseDeadlineMs(scope) bound; server.ts wires it to the
  qualification controller's owner deadline for the fixed
  qualification scope (the config is now parsed BEFORE the
  surface is created). Claim inside an expired window returns
  EMPTY; claim/heartbeat lease seconds are clamped to the time
  actually remaining (the deadline beats the 30s lease floor);
  heartbeat at/after the deadline throws LEASE_EXPIRED even if
  the stored lease still looks live. So no lease issued inside
  the window can outlive it — including across a service outage
  at the deadline — and cleanup handles any lease that somehow
  remains.

## D3 — the caps are the owner's numbers, exactly

QUAL_RESOURCE_POLICY quotaCap 100 → 1 in the controller, in
qualification-registry.candidate.sql, and in the surface suite's
qualification fixture; the plan (candidate v6) already specified
quotaCap = the task's estimate (1) and now matches the code. The
worker's arrival registration in the new controller test also
reports quotaCap 1. No cap was kept at 100 to make a test pass:
the one place the tighter cap changed an older scenario is
section B1 of the surface suite, whose two qualification tasks
now carry estimatedQuota 0 with an in-code explanation — the
project's lifetime quotaCap is 1 and section A1's task already
consumed that unit, so a further est-1 demand would be
quota-ineligible and the priority/addressing assertions would
prove nothing. B1's assertions themselves are unchanged.

## Test layout change (why D has its own file)

In v9 the controller tests lived inside the surface suite, whose
qualification scope accumulates jobs from sections A–C. D2's
fail-closed preflight correctly refused that history, which
exposed the fixture design, not a controller defect: a production
GL_QUALIFICATION starts empty. The controller tests therefore
moved to test/qualification-controller.integration.test.ts, which
builds a FRESH schema whose qualification scope starts completely
empty (no project, worker, or connector rows — the controller
creates all three), while the surface suite keeps sections S–C.
Worker presence in the new file is the worker's own arrival act
(a scoped ResourceStore registration under the runtime role,
with labelled local fixture profile values), because the
controller deliberately does not fabricate presence or a
measured profile — allocation requires a non-null worker
quotaCap and a healthy profile, which only the worker's
registration supplies.

## Evidence (local integration, embedded PostgreSQL 18.4)

- test/qualification-controller.integration.test.ts — 1/1 PASS:
  parse gates; grant from an empty scope under the runtime role
  (project ACTIVE with quotaCap 1 + grant marker, connector
  applied, worker READY 1/0 with complete bindings, exactly 1
  job / 1 task); deadline-capped claim (lease_expires_at ≤ cap)
  consuming the cap to 0; monitor tick + restarted controller
  leave quota at 0 and create nothing; owner pause/offline is NOT
  undone by monitoring; a foreign run id is BLOCKED by the
  persisted grant and creates no job; business project + worker
  rows byte-identical throughout; after the deadline, heartbeat
  and result are denied (LEASE_EXPIRED) while the reservation is
  still HELD; cleanup ends ROLLED_BACK with the lease forced into
  the past, the reservation EXPIRED, exactly ONE
  QUALIFICATION_LEASE_NEUTRALIZED event, the connector disabled,
  and a second cleanup instance changing nothing; post-cleanup
  result still denied, task attempt still 1.
- test/worker-surface-v3.integration.test.ts — 1/1 PASS
  (S/T/U/V/A/B/C sections).
- test/worker-ui.integration.test.ts — 1/1 PASS. Canonical repo
  DB integrations — 3/3 PASS. Repo unit suite — 154 pass / 2 fail
  (pre-existing pin inconsistencies) / 10 skipped. tsc clean.
- Stack verification: pin + PR #15 canonical patch + supplement
  patches 01–04 reproduces the tested tree byte-for-byte on all
  12 touched/new source files.

## Boundaries

Nothing deployed, merged, connected, or granted. Migration 012
remains unapplied anywhere. Live route status remains
BLOCKED_TRANSPORT; G2 still requires the owner's Option A policy
exception (now also the controller's explicit
AGY_QUALIFICATION_CAP_ONLY_APPROVED flag) or is recorded
BLOCKED_RESOURCE_PROFILE. Workers remain OFFLINE/UNVERIFIED
outside the candidate window; quota otherwise UNKNOWN. The two
SEO tasks were never created, claimed, or replayed by this work.
