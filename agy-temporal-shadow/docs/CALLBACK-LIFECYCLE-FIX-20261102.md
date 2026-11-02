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
