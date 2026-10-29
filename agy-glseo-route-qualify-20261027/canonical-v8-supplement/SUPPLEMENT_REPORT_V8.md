# Canonical v8 Supplement — AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1

OFFLINE candidate supplement responding to independent-QA findings
B1–B3 on v7 (A1/A2 themselves accepted). QA instructed: close the
three regression/boundary points from the real source, no new
features, no owner steps executed. Earlier supplements and PR
snapshots stay frozen. This package will be written into PR #15 as
its own version folder under the owner's existing approval.

## Test evidence (all LOCAL, real local PostgreSQL 18.4, migrations
001–008 + candidate 012, RLS-bound NOSUPERUSER runtime role)

- test/worker-surface-v3.integration.test.ts — 1/1 PASS, now covering
  S1–S3, S6, T1, T3, U1–U3, V1–V2, V3-as-corrected-by-B1, A1, A2,
  B1–B3.
- test/worker-ui.integration.test.ts — 1/1 PASS. Canonical repo DB
  integrations — 3/3 PASS. Repo unit suite — 154 pass / 2 fail
  (pre-existing pin inconsistencies) / 9 skipped. tsc clean.
- Stack verification: pin + PR #15 canonical patch + supplement
  patches 01–04 reproduces the tested tree byte-for-byte on all 11
  touched/new source files.

## B1 — The v6 guard regressed legacy semantics; isolation moved to the registry

QA was right on both counts, verified against the pin:
- Patch 01 had changed the dispatch query for ALL callers to join
  agy_tasks. agy_tasks is RLS-scoped to the caller's project, so the
  join hid other projects' demand from the global
  selectProjectDemand — an ungated claim scoped to a low-priority
  project could steal its own task while a higher-priority project's
  demand was invisible. The blanket payload filter
  (target_worker_id / auto_dispatch) also changed semantics for
  every project.
Fix (src/postgres-store.ts):
- The ungated dispatch query and selection are PIN-EXACT again (the
  query text is the pin's; no agy_tasks join, no payload filter).
  Addressed legacy tasks behave exactly as at the pin — the test
  suite's V3 section was rewritten to assert the pin behaviour
  instead of the guard's.
- The GATED namespace keeps its in-transaction gate: payloads are
  read from agy_tasks in a separate scoped query (RLS confines that
  read to the gated caller's own project, which is all a gated
  claim can ever lease).
- External isolation on the ungated route is a REGISTRY property:
  workers whose metadata carries external_namespace_only=true are
  excluded from allowedWorkers whenever the claim carries no gate.
  The qualification registry candidate sets the flag on
  MUSE-QUAL-WORKER; adapter-kind scoping (the kind exists only in
  GL_QUALIFICATION) remains the second wall.
Evidence (new B1 section): with one internal worker allocatable in
both projects — (a) a business-scope ungated claim returns null
while higher-priority demand lives in the qualification project
(the pre-B1 code would have stolen the low task); (b) the same
worker claims the high task from its own project; (c) an addressed
legacy task and then the low task are claimed ungated in priority
order (pin behaviour, no regression); (d) with the fairness fixture
connector disabled (A1 end state restored), ungated claims AS the
external worker and AS a legacy worker both return null and the
external task stays QUEUED at attempt 0.

## B2 — The driver window was renewable by restart; now absolute

QA was right: startedAt/timebox were per-boot, so a restart renewed
the 60-minute window indefinitely.
Fix (src/platform/worker-callback-driver.ts):
- Config now REQUIRES an absolute owner-approved deadline and a run
  identity: AGY_CALLBACK_DRIVER_EXPIRES_AT + AGY_CALLBACK_DRIVER_RUN_ID
  (config-time refusal EXPIRES_AT_REQUIRED / RUN_ID_REQUIRED; a
  driver constructed without them never starts). The local timebox
  can only shorten the window. Every pass computes the remaining
  time and caps its send timeout by it — no pass runs past the
  deadline; a boot past the deadline starts EXPIRED and runs no
  pass. runId is carried in the driver's log lines as evidence.
Evidence: a driver stopped mid-window ("restart") and recreated
with the same env expires at the ORIGINAL deadline (≈900 ms fixture
window, 3.6 M ms timebox — only the absolute deadline can bind);
a third boot after the deadline starts EXPIRED.

## B3 — Definite failures could loop forever; now stop-fast and bounded

QA was right: a 401/403/404/409 mapped to PENDING, so the driver
could re-send an auth/route failure ~120 times an hour, forever.
Fix (src/platform/worker-callbacks.ts, migration 012):
- CallbackDefiniteFailure carries a `blocked` classification. The
  HTTP transport marks 401/403/404 (auth/route) and 409 (tuple
  conflict) as blocked — they stop at the FIRST occurrence. Other
  definite failures (e.g. refused connections, other 4xx) are
  transient: at most 2 retries after the original send, counted by
  the PERSISTED delivery_attempts column, so restarts never reset
  the budget. UNKNOWN is unchanged: reconcile only, never re-send.
- Exhaustion or a blocked failure moves the row to a new BLOCKED
  status with last_error kept and a CALLBACK_DELIVERY_BLOCKED event
  carrying needs_owner_repair: true. The dispatcher reports blocked
  rows in its result; the DRIVER stops in state BLOCKED on the first
  blocked row and logs needs_owner_repair instead of polling no-op
  passes. The only way back is the new explicit
  releaseBlockedCallback (owner/control-plane decision after
  repair), which resets the counter and records the release.
Evidence: an auth-failing transport is called exactly ONCE across a
dispatch pass plus a running driver's ticks (row BLOCKED, driver
never re-sends); a transient-failing transport is called exactly 3
times across four independent dispatch invocations (original + 2
retries; delivery_attempts persisted at 3, row BLOCKED);
releaseBlockedCallback returns the row to PENDING with the counter
reset.

## Boundaries

Offline candidate only; the PR write is the previously approved
review-branch update and nothing more. Migration 012 (revised:
BLOCKED status added) is still unapplied anywhere. Live hosted
behaviour remains UNPROVEN; the live route remains
BLOCKED_TRANSPORT; G2 remains not runnable until the owner steps in
the plan — including the Option A policy exception or a
BLOCKED_RESOURCE_PROFILE record — are decided.
