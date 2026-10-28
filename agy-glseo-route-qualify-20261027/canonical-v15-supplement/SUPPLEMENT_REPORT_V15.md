# Supplement Report v15 — L1 lock discipline on v14 (head 1a6b4fe7)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1 / key
AGY|GLSEO|ROUTE-QUALIFY|20261027|A1. Same task, same review
branch (agy/muse-gemini-worker-20261028), same draft PR #15, same
standing review authorization. ControlPlane QA on exact v14 head
1a6b4fe7730616f68b0375731aa3c5f7fc00fd05 accepted H1's final
rollback fences (store + prepare) and H2's atomic arrival gates,
and set ONE concrete defect: L1, an introduced lock-order cycle
between arrival and cleanup. A root follow-up folded into the
same round adds the FK half of the same defect. This round
changes only L1. H1's deadline fences are untouched; no
features, schema, transport, or queue; no Connect, deploy,
grant, credential request, or activation. The disclosed
full-glob state is unchanged in kind: 3 fails = the 2
pre-existing pin fails + the obsolete worker-surface-v2 suite,
still disclosed in §3, not hidden and not removed.

## L1 — what was actually wrong (source-verified, twice)

The v14 report said arrival's order (project → connector →
worker) "matches cleanup". It did not. Cleanup phase 1 read the
project with a plain SELECT (readProject: `SELECT policies,
status FROM agy_projects`, no lock) and its writes ran task →
connector → worker → project. Arrival holds the project row
while waiting on the connector; cleanup holds connector/worker
while its final project UPDATE waits on arrival — a textbook
cycle PostgreSQL resolves only by aborting one side, and a
cleanup victim leaves the controller BLOCKED (its catch stops
the timer) with cleanup unfinished. Per the PG 18 docs, victim
selection is not a strategy.

Fixing phase 1's order alone was then proven insufficient by
this round's own first T13 run: the PostgreSQL log showed a
REAL deadlock between arrival (`SELECT status, metadata FROM
agy_workers WHERE worker_id=$1 FOR UPDATE`) and cleanup phase
2's canonical reclaimExpired (`INSERT INTO
agy_project_worker_health ... ON CONFLICT ... DO UPDATE`) —
arrival held the project row and queued on the worker row;
reclaim held every worker row (its registry lock) and its
health insert queued behind arrival's pending lock (the
insert's FK KEY SHARE on agy_workers queues behind a pending
FOR UPDATE by lock-manager fairness). Arrival was aborted with
40P01. Root's follow-up names the general form: EVERY scoped
child table carries a composite FK to agy_projects (migration
004, the line-102 loop: tasks, task_events, telemetry,
reservations, checkpoints, qa_results, health, …), so any
canonical transaction holding worker/task rows and INSERTing
children needs KEY SHAREs on the parent rows — and a project
row held FOR UPDATE by arrival turns each of those into a
potential wait on arrival.

## The correction — one lock discipline, three parts

1. **One shared coordinator lock.** The controller's scope
   advisory-lock key is now DERIVED from the scope triple
   (`agy:scope:<tenant>/<workspace>/<project>`) instead of a
   hard-coded string, so the worker surface derives the
   identical key from its request scope. Arrival takes it
   (pg_advisory_xact_lock) as the FIRST statement of its
   transaction. Cleanup holds the SAME key at SESSION level on
   a dedicated connection across ALL THREE phases (its phases
   1/3 run their withScopeTx without re-taking it —
   takeLock=false — because a second session would block on
   the first). Phase 2's reclaimExpired, which opens its own
   transaction and could never be covered by a
   transaction-level lock inside phases 1/3, is therefore
   covered too: arrival can never be mid-transaction while any
   cleanup phase runs, and concurrent cleanups/prepares still
   serialize on the same key exactly as before. The lock spans
   more of cleanup; nothing else about cleanup changes — it
   remains deliberately unfenced by the deadline, exactly-once
   settlement and the F4 event discipline are untouched.
2. **Cleanup phase 1 takes the project row first.** Its
   ownership/marker read is now readProjectLocked (a locking
   read) as the transaction's first row lock, before the task,
   connector and worker writes — the same first row lock
   arrival takes, so even at row level the two contend on one
   identical lock instead of crossing.
3. **FK-compatible lock modes.** The project row lock in
   cleanup phase 1 and BOTH the project and worker row locks
   in arrival are FOR NO KEY UPDATE, never FOR UPDATE.
   Qualification never changes project key columns (nor the
   worker key), and NO KEY UPDATE still excludes every non-key
   writer — owner pause/policy UPDATEs and the controller's
   own writes take the same mode, so T10's locked-state
   guarantees stand — while staying compatible with the KEY
   SHAREs canonical child inserts need on the FK parents
   (PG 18: KEY SHARE is compatible with NO KEY UPDATE and
   conflicts with FOR UPDATE). The connector rows keep FOR
   UPDATE: no table FK-references agy_connectors, so no FK
   cycle runs through them, and the mode still serializes
   arrival against cleanup's connector write.

One test fixture follows the key derivation: T4's external
locker (which simulates a held coordinator lock) now names the
derived key `agy:scope:gl/legacy-workspace/GL_QUALIFICATION`.
No test logic changed there.

## Tests

Qualification suite (LOCAL embedded PostgreSQL 18.4), 17/17:

- T13 (arrival ∥ cleanup, deterministic): cleanup is stalled
  INSIDE phase 1 at its worker write (gated pg_sleep trigger,
  test-only DDL in the fresh schema) while holding the
  coordinator + row locks past the cutoff; the rendezvous is
  observed in pg_stat_activity, not guessed. Arrival starts
  during the stall. Outcome: cleanup ROLLED_BACK (never
  BLOCKED, no 40P01), arrival ARRIVAL_NOT_GRANTED with zero
  writes (heartbeat_at byte-identical), worker OFFLINE +
  quota NULL (no READY revival), task BLOCKED, reservation
  EXPIRED, active_count 0, exactly 1
  QUALIFICATION_LEASE_NEUTRALIZED event, business rows
  byte-identical.
- T14 (arrival ∥ canonical reclaimExpired, called directly —
  no coordinator lock held): the lease is pre-expired; reclaim
  is stalled at its health INSERT (BEFORE triggers precede the
  FK checks, so the stall sits between the registry lock and
  the insert's KEY SHAREs). Arrival takes the project/worker
  rows and queues on the worker. Outcome: reclaim completes
  (RECLAIMED:1 — task BLOCKED, reservation EXPIRED,
  active_count 0, health block recorded), arrival completes
  READY after it; neither is a deadlock victim; no
  neutralization event (no cleanup ran).
- T15 (arrival ∥ canonical workerResult): the result is
  stalled at its callback-outbox insert, mid-transaction,
  after its QA/event child inserts. Arrival completes READY
  during the stall; the result then commits RESULT_SUBMITTED
  with exactly-once settlement (reservation SETTLED, 1 outbox
  row, 1 result event, cap accounting consistent).
- Regressions named by QA: T7 (concurrent cleanups — now
  serialized by the session-held coordinator lock — still
  exactly one event, ROLLED_BACK for both) and T3b
  (result-vs-cleanup race: exactly one settles) both PASS, as
  do T8/T9/T10 (H1/H2) and the rest of the suite unchanged.

## 3. Evidence (all LOCAL unless stated; no LIVE evidence)

Embedded PostgreSQL 18.4, same harness as v14.

- qualification-controller.integration.test.ts: 17/17 PASS
  (T1–T12 as in v14, T4 with the derived-key fixture, new
  T13/T14/T15 for L1).
- worker-gateway-loopback.integration.test.ts: 1/1 PASS (the
  HTTP arrival path now also takes the coordinator lock —
  uncontended there; behavior unchanged).
- worker-surface-v3 1/1, worker-ui 1/1, postgres /
  platform-postgres / runtime-postgres integrations 1/1 each.
- Mocked CLI suite: ALL PASS (20 checks).
- Unit glob WITH AGY_TEST_DATABASE_URL: 183 tests = 177 pass /
  3 fail / 3 skipped. The 3 fails are disclosed, unchanged in
  identity from v12–v14: (1) "Temporal worker startup
  sanitizes invalid database connection values" — pre-existing
  at the pin; (2) "no business hard-coded dependency in shared
  core" — pre-existing at the pin; (3)
  test/worker-surface-v2.integration.test.ts — the SUPERSEDED
  v2-era suite (fixture still completes profiles via
  ResourceStore.register; fails 'EMPTY' !== 'LEASED'). A stale
  suite to retire by ControlPlane's decision, NOT a v15
  regression; not deleted or edited. The suite is therefore
  NOT green overall and is not claimed to be.
- tsc --noEmit: clean. Stack check: pin + canonical candidate
  patch + v15 patches 01–04 reproduce the tested tree
  byte-for-byte on all 13 touched/new source files (13/13).
- LIVE: none. No credential registered, no connection page
  requested, deployed gateway untouched.

## 4. What changed, file by file

- src/platform/qualification-controller.ts (patch 04):
  SCOPE_LOCK_KEY derived from the scope triple; withScopeTx
  gains takeLock (default true); cleanup() wraps all phases
  in the session-held coordinator lock and delegates to
  cleanupLocked(); readProjectLocked added (NO KEY UPDATE)
  and used for phase 1's ownership read. H1 fences, F3/F4/F5
  logic unchanged.
- src/platform/worker-surface.ts (patch 02, now v10): arrive
  takes the derived coordinator lock as its first in-tx
  statement; project and worker row locks are FOR NO KEY
  UPDATE. No other action changed; H1/H2 gates, stamps and
  fences unchanged.
- Patches 01 (postgres-store v8) and 03 (worker-ui v7) are
  carried byte-identical from v14 — the store and the
  UI/gateway files did not change this round.
- Tests: qualification suite 14 → 17 tests (T13/T14/T15
  added; T4's locker names the derived key; setup unchanged
  this round). Activation plan candidate v11: L1 revision
  note in the header + a lock-discipline paragraph in the
  arrival section.

## 5. Boundaries and the remaining owner action

Unchanged from v14 §6: nothing merged, deployed, provisioned,
or connected; PR #15 remains a draft; the ONE owner connection
action (entering the claude-qual-worker token once on the
secure page for provider agy-worker) is still NOT requested —
it becomes relevant only after the D-054 prerequisites in
activation plan candidate v11. Source PASS / G1 / G2 remain
un-chốt pending ControlPlane QA on this head. Gemini's own
route qualification remains Gemini's.
