# Supplement Report v14 — QA residuals H1/H2 on v13 (head 82f070fb) + H1 clarification

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1 / key
AGY|GLSEO|ROUTE-QUALIFY|20261027|A1. Same task, same review
branch (agy/muse-gemini-worker-20261028), same draft PR #15, same
standing review authorization. ControlPlane QA on exact v13 head
82f070fdc093121bbe4cbd5daff47edbeeeeeb53 accepted F3 (PREPARING
no-rewrite), F4 (serialized cleanup event), F5 (actual own-lease
CLI recovery) and the F2 heartbeat/ACK post-lock pattern, and set
exactly two residuals in the existing deadline/arrival contract:
H1 (transaction-wide cutoff) and H2 (arrival TOCTOU). A follow-up
clarification folds into H1 in this same round: the final
pre-COMMIT rollback fence applies to EVERY deadline-carrying
mutation transaction, not only claim/prepare. This round changes
only those points. No new features, schema, transport, or queue;
no Connect, deploy, grant, credential request, or activation.
The disclosed full-glob state is unchanged in kind: 3 fails = the
2 pre-existing pin fails + the obsolete worker-surface-v2 suite,
still disclosed in §4, not hidden and not removed.

## H1 — the cutoff fence is transaction-wide

v13 fenced the START of each deadline transaction (post-lock
real-clock reads) and, for createJob, also just before COMMIT.
That left a hole the QA round named exactly: a transaction can
pass its post-lock clock read and then WAIT at a late write stage
— a trigger, an event/outbox insert, a worker-counter,
reservation or job-aggregate lock — and COMMIT after the cutoff.

The fix is one shared fence, `deadlineCrossed(client,
deadlineMs)` on PostgresStore: it reads `clock_timestamp()` in
its OWN statement at the point of the call (the only placement
proven to fence on PostgreSQL 18 — a clock value bound inside a
waited-on statement is bound before the wait). It sits
immediately before COMMIT, after ALL writes, in every
deadline-carrying MUTATION transaction:

- claim (already placed in this round's first pass; now routed
  through the shared helper, behavior identical): a crossed
  deadline rolls back lease, attempt, counters, reservation,
  allocation event and job aggregate together; the surface maps
  the null to EMPTY.
- controller prepare phases A and C (fenceBeforeCommit +
  QUALIFICATION_DEADLINE_CROSSED → the transaction rolls back,
  prepare reports EXPIRED, and cleanup owns the scope): no late
  grant writes, no late GRANTED flip.
- heartbeat (deadline variant): after the task UPDATE, before
  COMMIT — a crossed deadline rolls back and returns false; the
  surface labels it LEASE_EXPIRED.
- ack (store transition, deadline variant): after the task
  UPDATE, the QA insert and the job aggregate, before COMMIT —
  a crossed deadline rolls back and returns false.
- result (workerResult, deadline variant): after the job
  aggregate, before COMMIT — a crossed deadline throws
  LEASE_EXPIRED and the catch rolls back task→QA + QA receipt +
  task event + callback outbox + reservation settlement +
  telemetry + worker counters together. No half-committed
  result is possible.
- checkpoint (saveCheckpoint, deadline variant): after the
  checkpoint INSERT, before COMMIT — a crossed deadline throws
  LEASE_EXPIRED and rolls back both the task checkpoint write
  and the checkpoint row.
- createJob already carried the equivalent fence (its local
  fence() before COMMIT, throwing
  JOB_CREATION_DEADLINE_EXCEEDED); unchanged in this round.

Deliberate distinctions, per the clarification:

- No-deadline callers are untouched: every fence is guarded by
  the deadline argument (deadlineCrossed returns false
  immediately when none is set), so ungated/business paths run
  the pin statements byte-identically in behavior.
- Read-only paths are NOT fenced: the workerResult QA-replay
  branch and the saveCheckpoint replay return sit BEFORE the
  mutation stages and stay answerable past the deadline (a
  replay proves a past on-time commit; it mutates nothing);
  readback and recover involve no transaction of this kind at
  all. T12(d) proves readback still answers past the cap.
- Cleanup is NOT fenced: it carries no deadline and runs
  BECAUSE the deadline passed (its own scope-lock discipline is
  F4's, unchanged).

Tests (qualification suite, LOCAL embedded PostgreSQL 18.4):

- T8 (claim): the job row — the claim's last write stage, its
  aggregate UPDATE — is held across a 900 ms cap; the claim
  returns EMPTY and task row, reservations, quota, active_count
  and allocation events are all exactly as before.
- T9 (prepare): (a) phase A's grant writes held on the worker
  row lock across the deadline commit nothing (no project, no
  connector, no job; the shell stays OFFLINE/quota NULL; the
  controller ends ROLLED_BACK); (b) phase C's marker flip held
  on the project row lock across the deadline never commits —
  the marker stays PREPARING.
- T11 (result, new with the clarification): a gated pg_sleep
  trigger on the callback-outbox INSERT stands in for a blocked
  late write; the result passes its post-lock clock read, runs
  its task→QA / QA-receipt / task-event stages in-transaction,
  waits 2 s at the outbox insert across a 900 ms cap, and the
  final fence rolls EVERYTHING back — task still RUNNING with a
  null result, 0 QA rows, 0 RESULT_SUBMITTED events, 0 outbox
  rows, 0 telemetry rows, reservation still HELD with null
  actuals, and no settlement refund (the call carried
  quota_units 0, so a committed settlement would have refunded
  the cap unit to quota_remaining 1; it stays 0). Job aggregate
  unchanged.
- T12 (ack/heartbeat/checkpoint, new with the clarification):
  (a) ack — the job aggregate waits on the owner's held job-row
  lock across the cap; LEASE_EXPIRED, the task stays CLAIMED,
  and an in-window ack afterwards still succeeds (the lease is
  undamaged); (b) heartbeat — the write itself is held by a
  gated trigger on the task UPDATE past the cap; LEASE_EXPIRED,
  heartbeat_at and lease_expires_at byte-identical to before;
  (c) checkpoint — the checkpoint INSERT is held by a gated
  trigger past the cap; LEASE_EXPIRED, checkpoint_version and
  the task checkpoint payload unchanged, 0 checkpoint rows;
  (d) readback past the same cap still answers and reports the
  true state (RUNNING, null result) — read-only is not fenced.
  The pg_sleep triggers are test-only DDL inside each test's
  fresh schema, gated by a control table; no production schema
  or code carries them.

## H2 — arrival is one atomic transaction

v13 arrival read the project, worker and connector in separate
pool queries and then issued its UPDATE unconditionally: an
owner OFFLINE/PAUSE, or the deadline passing and cleanup
starting, could land between the checks and the write and be
overwritten from a stale snapshot.

Arrival now runs in ONE scoped transaction on one connection
from the surface's ProjectPool: BEGIN → lock the project row
FOR UPDATE → read the worker's adapter (provisioning fact, no
lock needed) → lock the connector rows of that adapter kind FOR
UPDATE → lock the worker row FOR UPDATE → read
clock_timestamp() in its own statement → evaluate every F1 gate
on the LOCKED rows (live GRANTED marker with a future deadline,
project ACTIVE, bindings complete, an enabled connector, worker
already READY) → the same stamp as v13 (heartbeat_at +
resource_profile merge of the project's own permissions and
quotaCap — never status, never quota) → a FINAL deadline fence
(second clock read; expiry at or past the marker deadline
refuses ARRIVAL_NOT_GRANTED) → COMMIT. Any refusal rolls back:
zero heartbeat/profile writes. Lock order (project → connector
→ worker) matches the controller's cleanup phase-1 order, so no
new lock cycle is introduced; arrival still never takes the
scope advisory lock.

Test T10: (a) the owner holds the worker row, flips it OFFLINE
in the same transaction and commits only after arrival has
queued on the lock — arrival sees the locked OFFLINE row and
refuses ARRIVAL_REFUSED, heartbeat_at and resource_profile
byte-identical, owner state standing; (b) the marker deadline
is shortened (owner fixture control) and the worker row is held
past it — arrival refuses ARRIVAL_NOT_GRANTED with zero writes.
Business rows byte-identical in both.

## 3. What stands unchanged from QA-accepted v13

F1 arrival gates and refusal codes; F2's post-lock real-clock
pattern in heartbeat/ack/result/checkpoint and createJob's
fences; F3 validate-only PREPARING recovery; F4's scope-locked
cleanup event phase; F5 recover (surface action, CLI command,
loopback proof). The connector candidate (custom.agy-worker),
migration 012, the registry candidates, the callback
driver/receiver, and the gateway route set are untouched in
this round.

## 4. Evidence (all LOCAL unless stated; no LIVE evidence)

Embedded PostgreSQL 18.4, same harness as v13.

- qualification-controller.integration.test.ts: 14/14 PASS —
  the 9 v13 tests (T1 lifecycle, T2 concurrency, T3a, T3b, T3c,
  T4, T5, T6, T7), T8/T9/T10 (H1 claim/prepare, H2 arrival),
  and the new T11/T12 (H1 extension: result, ack, heartbeat,
  checkpoint late-stage waits; readback distinction).
- worker-gateway-loopback.integration.test.ts: 1/1 PASS (real
  HTTP + real CLI, incl. F1 HTTP refusals and F5 recovery —
  unchanged behavior through the refactored store).
- worker-surface-v3 1/1, worker-ui 1/1, postgres /
  platform-postgres / runtime-postgres integrations 1/1 each.
- Mocked CLI suite: ALL PASS (20 checks, incl. recover shape).
- Unit glob WITH AGY_TEST_DATABASE_URL (env-gated suites
  unskipped): 180 tests = 174 pass / 3 fail / 3 skipped. The 3
  fails are disclosed, unchanged in identity from v12–v13: (1)
  "Temporal worker startup sanitizes invalid database
  connection values" — pre-existing at the pin; (2) "no business
  hard-coded dependency in shared core" — pre-existing at the
  pin; (3) test/worker-surface-v2.integration.test.ts — the
  SUPERSEDED v2-era suite (fixture still completes profiles via
  ResourceStore.register; fails 'EMPTY' !== 'LEASED'). It is a
  stale suite to retire by ControlPlane's decision, NOT a v14
  regression; it has not been deleted or edited. The suite is
  therefore NOT green overall and is not claimed to be.
- tsc --noEmit: clean. Stack check: pin + canonical candidate
  patch + v14 patches 01–04 reproduce the tested tree
  byte-for-byte on all 13 touched/new source files (13/13).
- LIVE: none. No credential registered, no connection page
  requested, deployed gateway untouched.

## 5. What changed, file by file

- src/postgres-store.ts (patch 01, now v8; still also carries
  types.ts and platform/service.ts as before — both unchanged
  since v13): new shared deadlineCrossed fence helper; claim's
  final fence routed through it; NEW final pre-COMMIT fences in
  the deadline variants of heartbeat, transition (ack),
  workerResult and saveCheckpoint. No-deadline callers keep pin
  behavior exactly.
- src/platform/worker-surface.ts (patch 02, now v9): arrive
  rewritten as one scoped transaction (H2) — locked reads,
  post-lock clock, gates on locked rows, final deadline fence.
  No other action changed.
- src/platform/qualification-controller.ts (patch 04):
  fenceBeforeCommit + QUALIFICATION_DEADLINE_CROSSED in prepare
  phases A and C (H1); cleanup deliberately unfenced.
- Patches 03 (worker-ui v7: worker-ui.ts, http-server.ts,
  server.ts) is carried byte-identical from v13 — nothing in
  its files changed this round.
- Tests: qualification suite 12 → 14 tests (T11, T12 added;
  setup now also returns the per-test runtime role name so the
  gated hold triggers can be granted). No other test file
  changed.
- Activation plan candidate v10 (this package): H1
  transaction-wide + H2 atomic arrival revision notes; the
  remaining gates and the one owner action are unchanged.

## 6. Boundaries and the remaining owner action

Unchanged from v13 §8: nothing merged, deployed, provisioned,
or connected; PR #15 remains a draft; the ONE owner connection
action (entering the claude-qual-worker token once on the
secure page for provider agy-worker) is still NOT requested —
it becomes relevant only after the D-054 prerequisites in
activation plan candidate v10. Source PASS / G1 / G2 remain
un-chốt pending ControlPlane QA on this head. Gemini's own
route qualification remains Gemini's.
