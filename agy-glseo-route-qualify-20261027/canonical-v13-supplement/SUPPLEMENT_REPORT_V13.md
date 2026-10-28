# Supplement Report v13 — QA round F1–F5 on v12 (head a7aada8b)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1 / key
AGY|GLSEO|ROUTE-QUALIFY|20261027|A1. Same task, same review
branch (agy/muse-gemini-worker-20261028), same draft PR #15, same
standing review authorization. This round changes ONLY the five
findings F1–F5. No new transport, queue, or feature beyond F5's
read-only recovery action (which the finding itself required);
no Connect, deploy, grant, credential request, or activation.
Controller, surface, store sources were verified byte-identical
to v11 before this round, exactly as ControlPlane reported; the
v12 arrive-route correction and the CLI are carried over and
extended, not redone. The disclosed full-glob state is unchanged
in kind: 3 fails = the 2 pre-existing pin fails + the obsolete
worker-surface-v2 suite, still disclosed in §6, not hidden and
not removed.

## F1 — arrival is a qualification opt-in, never a revival

The v12 'arrive' unconditionally set the worker READY and
projected the project's permissions/quotaCap, for any scope and
any provisioned worker. The branch now evaluates five gates,
all READ before the single write, so every refusal mutates
nothing (byte-identical rows are asserted in tests):

1. the project carries a live grant marker
   (policies.qualificationRun, phase GRANTED, expires_at in the
   future) — business scopes have no marker and are refused with
   ARRIVAL_NOT_GRANTED, so arrival can never rewrite a business
   worker's profile again;
2. the project status is ACTIVE (owner pause refuses);
3. an ENABLED connector of the worker's own adapter kind exists
   in the scope (cleanup disables the qualification connector);
4. the worker's provisioned bindings are complete
   (bindingsComplete, the gate's own predicate);
5. the worker is ALREADY READY — the state the controller's
   grant transition sets. Arrival's UPDATE no longer writes
   status at all; an owner-OFFLINE worker is refused with
   ARRIVAL_REFUSED (name chosen because the gateway maps any
   *DENIED code to HTTP 403; this refusal is a 400-class business
   refusal). READY is the controller's decision, never arrival's.

On success arrival still stamps heartbeat_at and projects the
project's OWN permissions + resource-policy quotaCap; measured
fields stay DEFAULT_NOT_MEASURED; body-supplied permissions /
quotaCap / status are ignored (asserted). Tests: qualification
suite T5 (surface level: OFFLINE, PAUSED, wrong scope with the
business row byte-identical, body override) and the loopback
suite over real HTTP (OFFLINE → 400 ARRIVAL_REFUSED with
heartbeat_at provably unchanged, PAUSED → 400
ARRIVAL_NOT_GRANTED, after-cleanup → 400 ARRIVAL_NOT_GRANTED +
worker stays OFFLINE + claim EMPTY), plus T1's tail rewritten:
the v12 expectation "arrival after cleanup asserts presence" is
superseded — arrival after cleanup is now REFUSED with the
worker row byte-identical.

## F2 — the absolute cutoff is fenced by post-lock real-clock reads

ControlPlane's citation is correct and it bites deeper than the
v12 text admitted. now() is transaction-start time; but two
further traps were proven empirically against PostgreSQL 18.4
during this round and are now recorded in the source:

- A single UPDATE whose WHERE carries clock_timestamp() still
  updated the row after a lock wait spanning the deadline
  (probe: rowCount 1 with the deadline 900 ms in the past).
- clock_timestamp() in the target list of a SELECT … FOR UPDATE
  is bound at the FIRST tuple fetch — before the wait — not when
  the lock is granted (probe: backend visibly waiting on
  Lock/transactionid in pg_stat_activity, returned value equal
  to its query start, 1.75 s stale).

The only pattern that fences is: acquire every lock the mutation
needs, THEN read clock_timestamp() in its own statement, compare,
and only then write. Applied, qualification-only (every change is
behind the existing opt-in deadline parameter; callers without a
deadline keep pin statements byte-for-byte):

- heartbeat: the deadline variant is now a transaction — lock
  the task row FOR UPDATE, read the clock, refuse (rollback,
  false) when past the deadline or the lease is dead, else write
  with timestamps derived from that post-lock read and the
  expiry LEAST-capped at the deadline. The no-deadline statement
  is the pin's verbatim.
- ack (store.transition): with a deadline, the transaction locks
  the registry, locks the TASK row, then reads the clock and
  refuses before the UPDATE; the surface maps the refusal to
  LEASE_EXPIRED when the cap has passed.
- result (store.workerResult) and checkpoint
  (store.saveCheckpoint): the deadline is checked with a
  clock_timestamp() read taken after the task row lock is held
  and before any mutation or replay answer. (workerResult's
  QA-replay branch stays a pure read, as accepted in E2.)
- job creation (store.createJob + ProjectService passthrough of
  deadline_ms): the creation transaction reads the clock at
  start AND again after the inserts, before COMMIT — a lock wait
  anywhere inside rolls the whole creation back with
  JOB_CREATION_DEADLINE_EXCEEDED. The controller's phase B maps
  that error to EXPIRED (cleanup owns the scope) instead of
  BLOCKED. Phase A additionally reads the DB wall clock inside
  its transaction, after all reads and immediately before the
  grant writes.

Tests (T6): (a) createJob INSERT held by an ACCESS EXCLUSIVE
lock on agy_jobs across the deadline → JOB_CREATION_DEADLINE_
EXCEEDED, zero job/task rows; (b) heartbeat with the task row
lock held across the deadline → LEASE_EXPIRED and the stored
lease_expires_at never moved past the cap; (c) ack with the
registry lock held across a fresh deadline → LEASE_EXPIRED, task
still CLAIMED. This heartbeat test is what caught the
single-statement illusion above: the first implementation of
this very fix (clock predicates inside one UPDATE) FAILED it,
was probed down to pg_stat_activity, and was replaced by the
lock-then-read pattern. Exactness is unchanged: lease_expires_at
≤ deadline with no tolerance anywhere.

## F3 — PREPARING recovery validates; it does not rewrite

Phase A is atomic (E1), so a durable PREPARING marker has
exactly one legitimate shape: project ACTIVE, connector enabled,
worker READY with quota_remaining = 1. Phase A's PREPARING
branch is now validate-only: it checks that shape (plus the
existing job-ownership preflight) and returns PREPARED — phase B
creates the missing job and phase C flips the marker. It issues
NO registry writes at all: no project status/permissions/policy
update, no connector/worker insert, no transition. Any deviation
— owner paused the project, offlined the worker, disabled the
connector, touched the cap — BLOCKS with
PREPARING_OWNER_INTERVENED and zero writes. The v10-era partial
state (marker + OFFLINE shell worker + no connector) is
unreachable from this controller and is treated as intervention,
not as a crash to repair. Tests: T3a rewritten to the true
post-phase-A crash shape — recovery completes job + flip with
granted_at preserved and the cap exactly as left; new T3c —
same shape plus owner PAUSED + OFFLINE → BLOCKED, project stays
PAUSED, worker stays OFFLINE, quota untouched, marker still
PREPARING, zero jobs.

## F4 — cleanup phases are fenced and serialized end to end

Cleanup was: phase 1 under the scope lock; phase 2
(reclaimExpired) unchecked; phase 3 (neutralization event) on a
bare pool with only a NOT EXISTS guard — two concurrent cleanups
could both pass the guard. Now: the run-ownership fence is
re-verified before phase 2, and phase 3 runs inside
withScopeTx — the same fixed scope advisory lock as phases 1
and prepare — re-checks ownership inside the lock, and only
then inserts behind the (kept) NOT EXISTS guard. Concurrent
cleanups therefore serialize on the event write itself, not on
an optimistic check. Tests: new T7 — two past-deadline
controllers of the same run started back to back → both
ROLLED_BACK, task BLOCKED, reservation EXPIRED, active_count 0,
exactly ONE QUALIFICATION_LEASE_NEUTRALIZED event; a delayed
third cleanup still leaves exactly one. T3a/T3b keep covering
crash-resume and the result-vs-cleanup race with the same
invariants.

## F5 — lost-claim recovery is real, worker-driven, read-only

The defect was exactly as stated: readback requires the lease
file whose contents were lost, and returns no lease token; the
v12 loopback test bridged the gap with owner-side DB reads,
which proved nothing about the worker. There is now a minimal
recovery read on the canonical contract:

- Surface action 'recover' (route added to the gateway regex,
  patch 03): the authenticated worker names the owner-issued
  run id — operational knowledge from its assignment, not a
  secret. The job lookup is RLS-scoped to the caller's project;
  the task must be claimed_by the token's worker and CLAIMED or
  RUNNING. The answer is the ORIGINAL lease: same lease_token,
  same attempt, same single reservation. Nothing is created,
  extended, or re-issued. Unknown run → NOT_FOUND with no task
  data; a run the caller holds nothing under → NO_ACTIVE_LEASE
  with no task data; wrong project → 403 PROJECT_SCOPE_DENIED;
  expired lease → LEASE_EXPIRED, never revived.
- CLI: `agy_worker.py recover --run-id <id>` prints the answer
  verbatim; its output is itself a valid lease file for
  ack/heartbeat/checkpoint/result/readback. The UNCERTAIN
  reconcile hint now names recover. CONNECTOR.md documents it.
- The loopback test no longer reads lease_token from the DB at
  all (harness reads are assertions only). Proof path: raw-socket
  disconnect claim commits exactly once → worker-local lease
  knowledge is nil → HTTP recover twice (identical task, task row
  updated_at provably unchanged, still exactly 1 reservation) →
  the real CLI driver starts with NO lease file in its session,
  recovers via the CLI (twice, identical), writes its own lease
  file from the recovery output, and completes ack → heartbeat
  → checkpoint (replay + conflict) → result → readback on
  attempt 1 with the reservation SETTLED. Negatives: wrong run,
  ghost worker (no leak), wrong project, stale lease (recovery
  and heartbeat both LEASE_EXPIRED). Mocked CLI suite covers the
  recover command's shape (path, run-id-only body, output usable
  as a lease file).

No owner step was added and no BLOCKED substitute was needed:
recovery is entirely inside the worker's existing authenticated
contract. No secret, operator identity, or DB access reaches
Muse; the lease token is returned only to the worker that
already owns the lease, over its own authenticated channel —
the same trust position as the original claim response.

## 6. Evidence (all LOCAL unless stated; no LIVE evidence)

Embedded PostgreSQL 18.4, same harness as v12.

- qualification-controller.integration.test.ts: 9/9 PASS — T1
  lifecycle (incl. the F1 refused-arrival tail), T2 concurrency,
  T3a crash recovery (post-phase-A shape) + partial cleanup
  resume, T3b result-vs-cleanup race, T3c owner-intervened
  PREPARING (F3), T4 held scope lock cutoff, T5 arrival opt-in
  (F1), T6 held-lock heartbeat/ack/job-creation fences (F2),
  T7 concurrent cleanup exactly-once event (F4).
- worker-gateway-loopback.integration.test.ts: 1/1 PASS —
  real HTTP + real CLI: health/authority, 401s, ghost arrive
  WORKER_NOT_PROVISIONED, wrong-project 403s both ways, arrive
  200, F1 OFFLINE/PAUSED refusals over HTTP, disconnect claim
  exactly-once, F5 recovery (HTTP + CLI, read-only, no-leak
  negatives, stale fail-closed), full lifecycle on the recovered
  lease, result replay/conflict, callback receive + operator
  lookup rules, after-cleanup arrive refusal + claim EMPTY,
  business worker byte-identical.
- worker-surface-v3 1/1, worker-ui 1/1, postgres /
  platform-postgres / runtime-postgres integrations 1/1 each.
- Mocked CLI suite: ALL PASS (20 checks, incl. recover shape).
- Unit glob WITH AGY_TEST_DATABASE_URL (env-gated suites
  unskipped): 175 tests = 169 pass / 3 fail / 3 skipped. The 3
  fails are disclosed, unchanged in identity from v12: (1)
  "Temporal worker startup sanitizes invalid database
  connection values" — pre-existing at the pin; (2) "no business
  hard-coded dependency in shared core" — pre-existing at the
  pin; (3) test/worker-surface-v2.integration.test.ts — the
  SUPERSEDED v2-era suite (fixture still completes profiles via
  ResourceStore.register; fails 'EMPTY' !== 'LEASED' on code
  paths byte-identical in v11–v13). It is a stale suite to
  retire by ControlPlane's decision, NOT a v13 regression; it
  has not been deleted or edited. The suite is therefore NOT
  green overall and is not claimed to be.
- tsc --noEmit: clean. Stack check: pin + canonical candidate
  patch + v13 patches 01–04 reproduce the tested tree
  byte-for-byte on all 13 touched/new source files (13/13) —
  service.ts joins the touched set in this round.
- LIVE: none. No credential registered, no connection page
  requested, deployed gateway untouched.

## 7. What changed, file by file

- src/postgres-store.ts (patch 01, now v7; also carries types.ts
  as before and platform/service.ts's one-line deadline_ms
  passthrough): createJob in-transaction clock fences;
  heartbeat lock-then-read deadline transaction; transition
  task-lock + post-lock clock refusal; workerResult and
  saveCheckpoint post-lock clock deadline checks. No-deadline
  callers keep pin behavior.
- src/platform/worker-surface.ts (patch 02, now v8): arrive
  opt-in gates (F1); new recover action (F5); ack/result/
  checkpoint pass the scope deadline into the store.
- src/temporal/http-server.ts (patch 03, now v7; worker-ui.ts
  and server.ts carried byte-identical to v12's patch): route
  regex gains 'recover'.
- src/platform/qualification-controller.ts (patch 04):
  validate-only PREPARING recovery (F3); phase A in-transaction
  clock fence; phase B JOB_CREATION_DEADLINE_EXCEEDED → EXPIRED;
  ensureJob sends deadline_ms; cleanup ownership re-checks +
  phase 3 under the scope lock (F4).
- Tests: qualification suite 5 → 9 tests; loopback suite
  reworked (F1 HTTP negatives, F5 worker-driven recovery, no
  lease injection; driver recovers via the CLI); mocked CLI
  suite + recover checks.
- Connector (custom.agy-worker): agy_worker.py gains the
  recover command; CONNECTOR.md updated (arrival opt-in,
  recovery section). connector.yaml unchanged. The CLI is still
  NOT connected.

## 8. Boundaries and the remaining owner action

Unchanged from v12 §8: nothing merged, deployed, provisioned,
or connected; PR #15 remains a draft; the ONE owner connection
action (entering the claude-qual-worker token once on the
secure page for provider agy-worker) is still NOT requested —
it becomes relevant only after the D-054 prerequisites in
activation plan candidate v9. Gemini's own route qualification
remains Gemini's.
