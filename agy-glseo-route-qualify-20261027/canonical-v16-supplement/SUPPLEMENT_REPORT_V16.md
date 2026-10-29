# Supplement Report v16 — R1 feasibility gate on v15 (head 1021bda2)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1 / key
AGY|GLSEO|ROUTE-QUALIFY|20261027|A1. Same task, same review
branch (agy/muse-gemini-worker-20261028), same draft PR #15,
same standing review authorization. ControlPlane source QA on
exact v15 head 1021bda291f24db1e275bdc8f224335a58643d6c
verified all 26 manifest files (SHA/bytes), the 27-file
review-folder-only branch delta, and the actual source locks +
T13/T14/T15, and CLOSED L1 and all prior H/F findings
CLOSED_FOR_BOUNDED_STAGING_SOURCE_REVIEW (not a global,
full-suite, or runtime PASS — and this round claims none).
Code that was tested stays as tested: H1's deadline fences and
L1's lock discipline are byte-untouched. This round closes ONE
feasibility gate, R1 — the ACTIVATION/EVIDENCE readback — and
the activation doc errata that travel with it. No generic
features, no new API, queue, schema, endpoint, or ledger.

## R1 — the determination (each exposed path checked in source)

ControlPlane's real caller set: Railway describe/logs and
GitHub/Drive; NO exec/SQL on D049; the existing AGY connector
exposes shadow/legacy job controls only, no worker HTTP auth;
the operator token stays server-side and is never sent to
Claude/Gemini/a browser. Against that set:

1. `GET /health` — unauthenticated, but the body is only
   {status, mode: TEMPORAL_SHADOW, canonical_authority,
   production: false}. No run evidence exists on this path.
2. Worker `readback` action — returns the task's status/result
   plus the latest callback's status. It answers the WORKER's
   own bearer token: it is the worker reporting on itself, and
   it carries no receiver receipt (no effect_count, no
   received_at), no reservation row, no checkpoint rows, no
   event counts. Not an independent ControlPlane readback, and
   handing ControlPlane the worker token would break the
   credential boundary it exists under.
3. Callback receiver `lookup` (GET
   /v1/callbacks/tenants/:t/workspaces/:w/projects/:p/receive/:id)
   — returns the FULL receipt identity {callback_id, task_id,
   attempt, worker_id, target, content_digest, received_at,
   effect_count}. But its guard requires an operator /
   platform-admin principal authorized for the path scope —
   i.e. a bearer call with the OPERATOR token that lives in
   the server's AGY_IDENTITIES_JSON. ControlPlane has no
   authenticated gateway HTTP caller in its tooling, the token
   must not leave the server, and the lookup is per-callback-id
   besides (ControlPlane cannot learn the id independently,
   and the route says nothing about tasks, reservations,
   checkpoints, or events).

Conclusion: NO already-exposed control-plane readback is
executable without exporting the operator token, a bootstrap
credential, or DATABASE_URL — and none of those is exported.
The v15 plan's "ControlPlane reads receipt/evidence rows" had
no executable caller; local tests and worker self-reports are
not a hosted receipt and are not called one here.

## The minimal correction — a sanitized evidence snapshot log

The qualification controller already writes its lifecycle as
JSON lines to the service stdout — a channel ControlPlane
DOES read (Railway logs). R1 adds one observational emission
to that same channel, from the same process, with the
controller's existing scoped read access. No transport,
endpoint, schema, or ledger is added; the callback driver is
unchanged (its in-process operator identity and pass logs stay
as they are).

`QUALIFICATION_EVIDENCE_SNAPSHOT` is emitted:
- once when the grant lands (reason=GRANTED),
- once per OBSERVED CHANGE of the run's evidence tuple while
  ACTIVE (reason=STATE_CHANGE; an unchanged tuple emits
  nothing),
- once after cleanup completes (reason=ROLLED_BACK) — the
  read is a pure scoped SELECT, deliberately unfenced like
  readback, so the rolled-back state remains observable past
  the deadline. A FOREIGN-owned scope is never snapshotted.

The tuple is built field by field (whitelist only) from the
run's OWN rows — the job is found by the run's idempotency
key, every read is RLS-bound to GL_QUALIFICATION, and no
business project is read:
run_id, scope, worker_id, marker_phase, project_status, job
{job_id, status}, task_count, task {task_id, status, attempt,
lease_fp}, reservation {state, fp}, checkpoint {version,
context_digest}, callback {callback_id, status, attempt,
content_digest}, receipt {callback_id, effect_count,
received_at, content_digest}, events {total, by_type},
capacity {worker_status, active_count, quota_remaining}.
Secrets discipline: lease_fp is a truncated SHA-256
fingerprint of the lease token; the reservation is identified
by the fingerprint of its id — in the canonical store the
reservation_id IS the lease token, so it is hashed identically
and never logged raw. Result/customer payloads, freeform error
text, and credentials are excluded by construction. The
snapshot states facts only and never asserts PASS — the
verdict remains ControlPlane's, drawn from the lines.
Emission is best-effort observational: a failed evidence read
is swallowed inside emitEvidence and can never block, alter,
or roll back the run (the controller's H1/L1 behavior is
unchanged — patches 01–03 are byte-identical to v15; only
patch 04's controller module changes).

One correction of record this round surfaced: cleanup never
flips the run marker — the marker stays phase GRANTED, and
rollback state is expressed by project_status PAUSED + worker
OFFLINE + connector disabled. The snapshot therefore carries
project_status explicitly, and T16 asserts exactly that (an
earlier draft assertion of a ROLLED_BACK marker phase was
wrong and was corrected against the source).

## Tests — T16 (LOCAL, embedded PostgreSQL 18.4)

Qualification suite 17 → 18 tests; T16 drives a full real
cycle (grant → arrive → claim → ack → checkpoint → result →
canonical dispatcher → real receiver receipt → past-deadline
cleanup) with a capturing logger and asserts:
- the GRANTED snapshot's tuple (QUEUED task, task_count 1,
  capacity quota_remaining 1, marker GRANTED);
- after claim/ack/checkpoint, exactly one STATE_CHANGE
  snapshot whose values equal the REAL DB rows (checkpoint
  version/context_digest read back from agy_checkpoints; event
  total from agy_task_events), task.lease_fp =
  sha256(lease_token)[..16], reservation {HELD, same fp};
- no emitted snapshot contains the raw lease token, any
  'payload' field, or a verdict string; no business scope data
  appears;
- QUIET + READ-ONLY: a further tick with no state change
  emits nothing, and a DB fingerprint (row counts + md5 over
  task/worker state incl. lease tokens) is identical before
  and after the observation;
- after the real dispatch (delivered=1 through
  dispatchWorkerCallbacks into the real receiver), the next
  snapshot shows callback DELIVERED with the outbox's
  content_digest and the receipt row's identity/effect_count
  1/received_at — all read from the actual tables;
- the final ROLLED_BACK snapshot (second, past-deadline
  controller) still carries the full tuple: project_status
  PAUSED, worker OFFLINE, task QA, reservation SETTLED, receipt
  effect_count 1 — post-deadline readability proven, raw lease
  still absent.
Disclosure: in ONE combined four-file run under parallel file
load, T16 failed once (timing under contention); it passed on
the immediate re-run of the same combination (21/21), in the
qualification file alone (18/18), and in the full glob below.
Reported, not hidden.

## Activation errata (plan candidate v12)

- P0 gains item 9 (starts-empty acceptance: qualification rows
  may be absent/dormant before G2 — the proven path; NO step
  promises registry seeding, since Railway tooling has no SQL
  exec and predeploy applies migrations only) and item 10
  (operator scope coverage: the control-plane operator identity
  in AGY_IDENTITIES_JSON must actually list GL_QUALIFICATION;
  if not, the exact owner gate is a server-side scope addition
  + redeploy before G2 — recorded, never assumed).
- The Final owner steps no longer list "dormant registry
  provisioning (business registry v3 + qualification registry
  candidate)": G1 is named as the deployment delta from the
  f40 lineage + the v16 code/evidence delta; the deploy step is
  deploy + env names + migration 012 only; no business or
  dormant Muse SEO / Gemini provisioning belongs to one Muse
  qualification run. G2 is named as one task / ≤ 60 minutes /
  cap-only under the explicit owner exception.
- A new "Evidence readback (R1)" plan section carries the
  determination above and the five-step Railway-logs runbook
  (STARTED → GRANTED snapshot → STATE_CHANGE chain with
  lease-fingerprint continuity → driver pass + DELIVERED/
  receipt snapshot → ROLLED_BACK + final snapshot), including
  what each line establishes and that a missing line is itself
  the finding.

## Evidence (LOCAL unless stated; LIVE: none)

- qualification-controller.integration.test.ts: 18/18 PASS
  (T1–T15 unchanged, T16 new).
- worker-gateway-loopback 1/1, worker-surface-v3 1/1,
  worker-ui 1/1 PASS; targeted DB integrations were green in
  the v15 round and the store/surface files are unchanged
  (patches 01–03 byte-identical to v15).
- Mocked CLI suite: ALL PASS (20 checks).
- Full glob WITH AGY_TEST_DATABASE_URL: 184 tests = 178 pass /
  3 fail / 3 skipped — the same disclosed three: the 2
  pre-existing pin fails ("Temporal worker startup sanitizes
  invalid database connection values"; "no business hard-coded
  dependency in shared core") and the obsolete
  worker-surface-v2 suite. The suite is NOT green and is not
  claimed to be; the CLOSED_FOR_BOUNDED_STAGING_SOURCE_REVIEW
  scope of the v15 verdict is unchanged by this round.
- tsc --noEmit: clean. Stack check: pin + canonical candidate
  patch + v16 patches 01–04 reproduce the tested tree
  byte-for-byte on all 13 touched/new source files (13/13).
- LIVE: none. Nothing deployed, connected, provisioned, or
  executed against the hosted gateway.

## Boundaries

Unchanged: PR #15 stays a draft; no merge/deploy/grant/
Connect; the ONE owner connection action remains unrequested
pending the D-054 prerequisites, now with plan v12's P0 items
9–10 and the R1 runbook as part of what G1/G2 approval would
rest on. The two SEO tasks remain untouched.
