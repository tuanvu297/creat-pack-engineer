# Callback + Qualification Lifecycle Fix — 2026-11-02 (candidate)

Repair job `gl_2e367da8-da06-4de7-b38d-1a3fb091283c`, follow-up phase.
Base: staging branch `agy/muse-qualification-staging-20261029` (tip `43f6cd3a`).
Status: **IMPLEMENTED_NOT_QA_ACCEPTED** — candidate branch + draft PR only.
No deployment was made from this change. Canonical authority unchanged:
PostgreSQL D049 (`agy_hosted_staging`).

## Why — three failures proven live on 2026-11-02 (run-20261102-restore3)

1. **Callback delivery died with the driver's startup timebox.**
   `AGY_CALLBACK_DRIVER_TIMEBOX_MS=480000` and
   `deadline() = min(expiresAtMs, startedAt + timeboxMs)` expired the
   callback driver 8 minutes after container boot (EXPIRED 08:33:06Z)
   while the owner window ran to 14:00:00Z. The result submitted at
   08:38:03Z recorded its callback PENDING and nothing dispatched it
   until an operator restarted the service by hand (delivered
   08:42:57Z after `serviceInstanceRedeploy`). The same 8-minute
   pattern had already silently killed restore2's driver on
   2026-10-31; G2 passed only because its lifecycle fit inside
   8 minutes.
2. **A completed run blocked every later grant until its evidence
   was deleted by hand.** The controller failed closed on any prior
   `qualificationRun` marker (PREVIOUS_RUN_GRANT_PRESENT) and on any
   foreign job in scope. Unblocking restore3 required an operator
   transaction deleting the G2 job's full FK closure — 17 rows
   across 11 tables of completed evidence (job, task, checkpoints,
   QA result, callback + receipt, telemetry, learning sample).
3. **Two more stale leftovers broke the fresh grant itself.**
   Cleanup disables the connector row; `insertConnector` uses
   `ON CONFLICT DO NOTHING`, so the row stayed disabled and arrive
   failed ARRIVAL_NOT_GRANTED until enabled by hand. The worker's
   cached `resource_profile.quotaUsed` stayed 1 (cap 1) after G2
   settled, so every claim failed the allocator's quota check until
   reset by hand. Root also observed pool-after-end errors during
   the restart: server shutdown ended the pool while the driver and
   controller intervals were still live (their handles were scoped
   inside `if` blocks and never stopped).

## Changes

### `src/platform/worker-callback-driver.ts`
- `deadline()` is now the owner's absolute `expiresAtMs` only.
  Delivery of a callback recorded inside the window is an
  already-authorized effect, not a new grant; the absolute expiry
  still bounds every pass, and a restart recomputes the same
  absolute deadline, so the B2 anti-extension property (a restart
  can never extend the window) is preserved. `timeboxMs` remains
  parsed for config compatibility but no longer shortens delivery.
- `start()` no longer treats an exhausted/zero timebox as EXPIRED;
  an already-past owner expiry still starts EXPIRED.
- A tick that hits a pool-after-end error (shutdown race) stops the
  driver quietly with one `CALLBACK_DRIVER_POOL_ENDED` log instead
  of logging a pass error every interval against a dead pool.

### `src/temporal/server.ts`
- Driver and qualification-controller handles are retained and
  stopped in the SIGINT/SIGTERM shutdown path **before**
  `pool.end()` runs in the `finally` block.

### `src/platform/qualification-controller.ts`
- New exported pure gate `assessPriorRun(facts, nowMs)`: a prior run
  is ARCHIVABLE only when its marker is expired, its job exists if
  the marker was GRANTED, no task is live, no lease is live, and
  every callback recorded for the run is DELIVERED.
- Phase A now archives a settled prior run instead of blocking:
  the full marker + census is appended to
  `policies.qualificationRunHistory` (append-only) and only the
  `policies.qualificationRun` pointer is removed. **No job, task,
  event, checkpoint, receipt or callback row is deleted or
  rewritten.** The job census treats archived job ids as history,
  not foreign work. Unsettled or unexpired prior runs block with
  the historical reasons (plus the more precise
  `PREVIOUS_RUN_NOT_SETTLED` / `PREVIOUS_RUN_JOB_MISSING`).
- Grant path repairs its own leftovers inside the grant
  transaction: `ensureConnectorEnabled` re-enables the qual
  connector row cleanup disabled (a connector disabled *during* a
  live window is untouched — the PREPARING-recovery validation
  still blocks on it as an owner intervention), and
  `recomputeWorkerQuotaUsed` recomputes the cached `quotaUsed`
  from the worker's live HELD reservations instead of trusting the
  cache (a genuinely held reservation still counts, so a leak
  surfaces as a failed allocation rather than being zeroed).

### Tests
- `test/callback-lifecycle-fix.test.ts` (new, UNIT — stub pool):
  driver gate past the old timebox, restart re-deriving the same
  absolute deadline, stale-grant EXPIRED, timebox=0 compatibility,
  pool-ended quiet stop, config parse compatibility, and the full
  `assessPriorRun` matrix (settled/unexpired/missing-job/live-task/
  live-lease/undelivered-callback/expired-QUEUED). **13/13 PASS**
  in the authoring environment.
- `test/callback-lifecycle.integration.test.ts` (new, INTEGRATION —
  real PostgreSQL, skipped without `AGY_TEST_DATABASE_URL`):
  L1 settled run archived + evidence intact + connector/quota
  repaired + next lifecycle completes; L2 undelivered callback
  keeps the next grant BLOCKED with `PREVIOUS_RUN_NOT_SETTLED`.
  Typechecked in the authoring environment; **not executed there
  (no local PostgreSQL)** — to be run by QA with the repo's
  `test:postgres` setup.
- `test/worker-surface-v3.integration.test.ts`: the one assertion
  that pinned the old timebox semantics (`timeboxMs: 0` → EXPIRED)
  now pins the new contract (RUNNING; a past owner expiry still
  starts EXPIRED). The B2 restart assertions are unchanged and
  still hold, because the deadline remains the original absolute
  expiry.

### Suite results (authoring environment, 2026-11-02)
- `tsc --noEmit`: clean.
- Full suite on the candidate tree: 217 tests, 181 pass, 2 fail,
  34 skip. Base tree same day: 202 tests, 168 pass, 2 fail, 32 skip.
  The 2 failures are identical on both trees (pre-existing:
  "Temporal worker startup sanitizes invalid database connection
  values", "no business hard-coded dependency in shared core").
  Delta = +13 passing unit tests, +2 integration tests skipping
  without a database. **No regressions.**

## What is NOT proven by this candidate
- Live behaviour after deployment (the integration suite and a
  bounded staging window remain QA's to run). In particular the
  >8-minute callback case is proven at unit level with a stub pool
  and by the restore3 incident itself; a post-deploy live window
  with a deliberately delayed result (>8 minutes after boot) is
  the remaining live check.
- No grant auto-renewal is introduced: archival never extends a
  deadline, never creates a window, and never touches an unexpired
  marker. Task-scoped authorization is unchanged (the grant still
  requires the full owner window variables).

## QA correction round 2 (2026-11-02, reviewer findings R1/R2)

Independent QA of 735f1a20 confirmed two P1 defects; both are fixed
in this round and proven on a REAL local PostgreSQL (embedded
binaries, repo migrations) — the integration tests are no longer
skipped-only.

R1 — an expired run's UNCLAIMED task stayed claimable under the
next run's grant (the worker gate has no run fence and the claim
stamps the CURRENT scope-wide deadline). Fix: expired work is made
non-runnable atomically while retaining evidence. The run's own
cleanup retires its QUEUED/RETRY tasks to terminal CANCELLED (row +
payload kept, task event RUN_EXPIRED_TASK_RETIRED); archival does
the same for a prior run whose cleanup never ran
(RUN_ARCHIVED_TASK_RETIRED), in the same transaction as the marker
swap and before the new grant activates the scope. Archival also
returns the prior window's worker/connector to dormant, so a run
whose cleanup never ran cannot strand a live cap
(WORKER_CAP_WITHOUT_GRANT). Regression test L3: run A's task never
claimed → expires → run B grant → claim returns B's task, never A's
(both the cleanup path and the archival path are exercised).

R2 — reservation accounting summed EVERY reservation in the
project, so a settled prior run permanently consumed the next run's
per-run cap (restore3's live EMPTY claim). Fix: authorized per-run
accounting closure at archival. Migration
013_reservation_accounting_closure.sql adds the terminal state
CLOSED, redefines the dispatch projection sums to count only
HELD/SETTLED, and recomputes existing projections. At archival the
prior run's SETTLED reservations transition to CLOSED — the row and
its actual_quota are retained as evidence; only the accounting
state advances, recorded in the history entry
(reservations_closed). The claim-time usage query applies the same
state filter. Cleanup deliberately does NOT close reservations:
the T3b invariant (cleanup never rewrites a result-settled
reservation) is preserved — closure happens only at archival, when
the gate has proven the run fully settled. Test L1 asserts the
CLOSED state with actual_quota intact AND the next run's claim
returning LEASED. A/B evidence: with the closure and retirement
disabled, L1 fails with claim EMPTY (the restore3 symptom) and L3
fails with the task left QUEUED; with the fixes, the full suite is
227 tests / 221 pass / 3 fail, the 3 fails identical to the
pristine-base run (pre-existing: Temporal startup sanitization,
no-business-hard-coded, worker surface v2).

All pre-existing PG integration harnesses now apply migration 013
alongside 012 (their fixed migration lists are part of this
candidate).

## Routing decision path (D3/D4 runnable candidate)

src/platform/routing-decision.ts implements the work-breakdown /
action-journal / resource-aware routing contracts as a pure,
versioned decision function (ASSIGN / TEACH_THEN_ASSIGN / REPAIR /
RESOURCE_WAIT / RECONCILE_FIRST) over plain JSON records, so the
brain state survives model/host replacement. Capacity is accounted
per ACCOUNT shared across roles, expected totals are per ACCEPTED
output including retries and the shared review charge, and UNKNOWN
quota is a wait, never a guess. test/routing-decision.test.ts
covers the seven contract scenarios plus dependency acceptance and
journal append-only behaviour.
