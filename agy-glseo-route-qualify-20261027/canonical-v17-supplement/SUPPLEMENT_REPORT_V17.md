# Supplement Report v17 — R2a/R2b on v16 (head 277c876e)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1 / key
AGY|GLSEO|ROUTE-QUALIFY|20261027|A1. Same task, same review
branch (agy/muse-gemini-worker-20261028), same draft PR #15,
same standing review authorization. ControlPlane QA on exact
v16 head 277c876e34cc4dd3e17b984a36c384a7705c8544
independently fetched and verified all 26 manifest files
(manifest 5299bdc3…), accepted the R1 Railway-logs route and
the carried patches 01–03, and set TWO concrete evidence
defects in the NEW readEvidence code — R2a (snapshot
consistency) and R2b (receipt identity completeness) — plus,
folded into the same round, one plan contradiction (P0 item 5
vs item 9). Scope is exactly those: the already-accepted H/L
code is untouched (patches 01–03 byte-identical to v16; only
patch 04's controller module changes, and inside it only
readEvidence and its comments). No endpoint, schema, queue,
or feature is added.

## R2a — one consistent snapshot

Defect: readEvidence issued each SELECT through
scopedPool().query, and the ProjectPool wrapper wraps every
statement in its own BEGIN/COMMIT at READ COMMITTED. A
result (or receipt, or cleanup) committing between two reads
would splice a tuple that never existed — task RUNNING beside
reservation SETTLED + callback DELIVERED, project ACTIVE
beside worker OFFLINE — unusable as QA evidence.

Fix: readEvidence now runs on ONE connection in a single
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` …
`COMMIT` transaction (explicit rollback on error). Every
read — marker/project, job, task, reservation, checkpoint,
callback, receipt, events, worker — shares one snapshot, so
the emitted tuple is a state that existed at one instant. A
READ ONLY snapshot takes no row locks and never blocks
cleanup or any writer, and the post-deadline final read keeps
working exactly as before.

Connection choice, pin-verified (this is the subtle part):
the read does NOT route through the ProjectPool proxy, and
the shared wrapper is NOT modified. At the pin,
scoped-pool.ts's proxy marks a transaction only when the
statement is exactly 'BEGIN'; its BEGIN handler then
immediately runs the scope-context set_config query. Two
consequences, both proven against the real wrapper in T20:
(1) exact 'BEGIN' + a later SET TRANSACTION ISOLATION LEVEL
is rejected by PostgreSQL — "SET TRANSACTION ISOLATION
LEVEL must be called before any query", SQLSTATE 25001 —
because the context query already ran; (2) a BEGIN carrying
the transaction modes, sent through the proxy, falls into
its auto BEGIN/query/COMMIT branch, whose own BEGIN +
context query precede the nested modes-BEGIN, which is
rejected with the same 25001. So neither naive route can
carry the isolation through the wrapper. The snapshot
instead takes a plain client from the SAME runtime pool,
declares the modes in the BEGIN itself, and issues the
identical transaction-local set_config scope context
(tenant/workspace/project/subject) as its first
in-transaction statement — the same runtime role, search
path, and RLS policies bind every read, which T17–T19
exercise end-to-end (correct scope rows, business rows
invisible). A preliminary raw-pool probe was used during
development to check the mechanism; the shipped evidence is
T20 (the real ProjectPool boundary) + T17/T18 (the real
controller path), not the probe.

Deterministic tests (no sleep-based synchronization;
rendezvous observed in pg_stat_activity):
- T17 — the snapshot is parked mid-read by an ACCESS
  EXCLUSIVE lock on agy_checkpoints (its checkpoint SELECT
  sits between the task/reservation reads and the
  callback/receipt/event reads) while a result commits under
  it. The emitted tuple is pure BEFORE (task RUNNING,
  reservation HELD, callback/receipt null, result_digest
  null, no RESULT_SUBMITTED event, checkpoint v1 read
  consistently); the next tick emits pure AFTER (QA, SETTLED,
  callback PENDING, result_digest present, event counted).
  Under the old per-query reads this interleave produces
  exactly the forbidden hybrid.
- T18 — same park, while a past-deadline controller commits
  the WHOLE cleanup under the snapshot: pure BEFORE
  (project ACTIVE + worker READY + task RUNNING + HELD, no
  neutralization event) from the parked read, and pure AFTER
  (PAUSED + OFFLINE + BLOCKED + EXPIRED + exactly 1
  neutralization event) in the cleanup controller's final
  snapshot.
- T20 — the wrapper boundary above, asserted against the
  real ProjectPool (both rejection legs + the connection
  stays usable afterwards).

## R2b — receipt identity completeness

Defect: the snapshot's receipt carried only
callback_id/effect_count/received_at/content_digest, and the
callback lacked its identity fields, so a reader could not
independently verify the tuple/result — at best they could
trust a join by callback_id.

Fix (whitelist extension from the canonical rows only):
- callback now also carries task_id, attempt, worker_id,
  target — from agy_worker_callbacks itself.
- receipt now also carries task_id, attempt, worker_id,
  target — from agy_callback_receipts itself.
- task now carries result_digest: the canonical digestOf
  computed server-side over the PERSISTED agy_tasks.result.
  The result is not itself persisted as a digest anywhere;
  this is the canonical-source computation the QA brief
  allows, and the result payload is never logged. It is a
  DIFFERENT digest from content_digest, which is persisted
  and covers the {result, evidence} outbox envelope — the
  plan's runbook now says so explicitly and prescribes
  field-by-field comparison (receipt.* vs callback.* vs
  task.*), where any inequality is a conflict finding.

- T19 proves it: snapshot identity fields deep-equal the
  real outbox and receipt rows field by field; cross-tuple
  equalities hold inside the line; result_digest equals
  digestOf of the DB row's result while the result's own
  marker string appears nowhere in any snapshot; after the
  receipt row is TAMPERED (attempt set to 99 through a
  scoped owner write), the next snapshot emits attempt 99
  beside callback/task attempt 1 — the conflict is visible
  in the line, never smoothed over; and a controller for a
  foreign run emits zero snapshots.

## Doc fold (plan candidate v13)

P0 item 5 contradicted item 9: it required MUSE-QUAL-WORKER
OFFLINE, quota NULL, bindings complete BEFORE the window,
while item 9 (the R1 erratum) accepts starts-empty. Item 5
is rewritten: no pre-window registry state is required —
rows absent, or dormant exactly as a prior cleanup left
them; bindings are an OUTCOME of prepare, not a preflight
input. Item 9's closing sentence ("A scope found
FOREIGN-owned is the only stopper") is removed: starts-empty
acceptance waives nothing, and the item now lists prepare's
existing fail-closed blockers (foreign marker or job,
multiple jobs, cap without grant, reused run id with a
different deadline, owner-intervened PREPARING, task-count
drift). The controller's grant/owner policy is unchanged —
this is documentation alignment only. The R1 runbook gains
the exact-compare step and the per-process dedup note (a
restart may re-emit an identical tuple once; a repeated
identical line is not a new effect — no cross-restart
exactly-once log is claimed).

## Evidence (LOCAL, embedded PostgreSQL 18.4; LIVE: none)

- qualification-controller.integration.test.ts: 22/22 PASS
  (T1–T16 unchanged in behavior — T16's final-snapshot wait
  was given the same deterministic line-wait synchronization
  as T18 after its one parallel-load flake recurred; T17,
  T18, T19, T20 new).
- Targeted set: qualification + loopback + surface-v3 +
  worker-ui + postgres/platform-postgres/runtime-postgres =
  28/28 PASS. Mocked CLI: ALL PASS (20 checks).
- Full glob WITH AGY_TEST_DATABASE_URL: 188 tests = 182 pass
  / 3 fail / 3 skipped — the same disclosed three (2
  pre-existing pin fails + the obsolete worker-surface-v2
  suite). Not claimed green; the bounded staging source
  review scope is unchanged.
- tsc --noEmit: clean. Stack check: pin + canonical patch +
  v17 patches 01–04 = tested tree byte-for-byte on the 13
  touched/new files (13/13). Patches 01–03 byte-identical
  to v16 (the store, surface and UI/gateway did not change).
- Disclosure carried from v16: T16 flaked once under
  parallel file load in the v16 round and once more here
  (same assert class — the final snapshot line lagging the
  state flip under contention); both times it passed on
  re-run, in the file alone, and in the full glob. The wait
  is now synchronized on the emitted line itself (T18's
  pattern), which removes the race rather than tolerating
  it.
- LIVE: none. Nothing deployed, connected, provisioned, or
  executed against the hosted gateway.

## Boundaries

Unchanged: PR #15 stays a draft; no merge/deploy/grant/
Connect; the ONE owner connection action remains
unrequested pending the D-054 prerequisites (plan v13).
The two SEO tasks remain untouched.
