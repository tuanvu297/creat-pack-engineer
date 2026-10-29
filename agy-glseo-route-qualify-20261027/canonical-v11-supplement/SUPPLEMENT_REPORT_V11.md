# Supplement Report — canonical v11 (QA findings E1–E4 on v10 head 91c3ee75)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1. Offline candidate work
only: nothing deployed, merged, provisioned, granted, or posted.
D3 (quotaCap 1) and the no-refill discipline were confirmed by QA
and are NOT reopened; the C1/C2 and B1–B3 behaviour stands. This
supplement changes only what E1–E4 name.

## E1 — ownership / crash atomicity (qualification-controller.ts)

Was: the prepare advisory lock was keyed by run id, so two
DIFFERENT run ids never serialized; marker, registry, transition
and job creation were separate transactions; a crash after
marker+insertWorker but before the transition left an OFFLINE
worker that the monitor path would never complete, while the
controller still reported ACTIVE.

Now: ONE advisory transaction lock keyed by the FIXED SCOPE
serializes every controller for GL_QUALIFICATION, whatever its
run id. The grant is phased and transactional: marker
{run_id, expires_at, granted_at, phase} + registry + transition
commit in ONE transaction (phase 'PREPARING'); the job is created
(conflict-idempotent); a second locked transaction flips the
marker to 'GRANTED' after revalidating marker + job + task count.
Crash boundaries: nothing persisted / PREPARING (the same run
completes it — inserts are no-ops, the transition still fills
only from NULL, so completion cannot refill) / GRANTED. The
monitor path revalidates: a GRANTED marker whose job is missing
BLOCKS (GRANT_JOB_MISSING) instead of being silently repaired,
and monitoring still never rewrites project/worker state, so an
owner pause after the grant is never undone. The D2 fail-closed
preflight remains, with one correction: the worker blocker now
keys on quota (a worker HOLDING a cap without this run's grant);
a merely-READY worker is arrival presence (E4), not a grant.

## E2 — absolute cutoff at the authoritative mutation

Was: the controller checked the time only before waiting on the
lock; the surface computed relative lease seconds before the
store's locks, so a lock wait could push a lease past the
deadline; heartbeat's Math.max(1, floor(remaining)) crossed the
deadline in the last fraction of a second; the test tolerated
capD + 1000.

Now: the controller re-checks the deadline INSIDE the prepare
transaction after the lock is acquired, again before job
creation, and again inside the flip transaction — a prepare that
crosses the cutoff while waiting grants nothing and falls
through to cleanup. Claim and heartbeat carry the deadline INTO
the store: claim re-checks it after the registry lock is held
and again per candidate, and both writes compute
lease_expires_at = LEAST(now() + interval, deadline) in SQL, so
lease_expires_at <= deadline holds exactly; heartbeat's UPDATE
additionally refuses to run at/after the deadline. Callers
without a deadline pass NULL and get the pin expression back
(COALESCE(deadline, 'infinity')), so ungated behaviour is
unchanged. ack / checkpoint / result needed no new code: their
store paths already validate lease_expires_at under the task row
lock (transition's UPDATE condition; saveCheckpoint's and
workerResult's locked reads), and a capped lease turns that
check into a deadline check. The surface keeps only label checks
(EMPTY / LEASE_EXPIRED); all enforcement is in the transactions.

## E3 — cleanup fencing / exactly-once, canonical accounting

Was: cleanup's ad-hoc lease-expiry UPDATE could re-fire on a
later pass and emit duplicate neutralization events, it raced a
concurrent result (which could settle while cleanup expired the
reservation), and it left the task CLAIMED with active_count
unreleased.

Now: cleanup runs under the same fixed scope lock. Phase 1 (one
transaction) fences on the grant marker (foreign scope =
untouched), forces the run's active leases into the past, and
sets the dormant state. Phase 2 hands the leases to the engine's
OWN reclaimExpired(): task row locks, HELD→EXPIRED reservation
settlement under its state guard, task transition (this run's
maxRetry-0 task lands BLOCKED — never runnable again), capacity
release through the canonical trigger, job aggregation. A result
racing cleanup serializes on the task row — exactly one settles,
and cleanup can no longer flip a SETTLED reservation. Phase 3
writes QUALIFICATION_LEASE_NEUTRALIZED under a durable NOT
EXISTS guard, so repeated cleanups (>1s apart) and crash-resumed
cleanups emit it exactly once, and a cleanup interrupted between
settlement and transition still converges (tested with a
hand-crafted partial state).

## E4 — an actual runnable entrypoint: the 'arrive' action

Was: the controller's worker row is a shell
(resource_profile {spendCap: 0, quotaCap: null}, no permissions,
no presence); allocateDemand rejects quotaCap-null and
permission-less profiles, and the only thing that ever completed
the profile was the integration test calling
ResourceStore.register with fabricated measurements
(passRate .95 …). No exposed action registered presence.

Now: the worker surface has an 'arrive' action, reachable at
POST /v1/worker/tenants/:tenant/workspaces/:workspace/projects/:project/arrive
(the gateway dispatches the action segment generically — the
same route family as claim). It is identity-bound (worker id
from the token; body-supplied worker ids are still rejected as
BODY_SCOPE_OVERRIDE), refuses unprovisioned workers
(WORKER_NOT_PROVISIONED — no self-provisioning), and does only
server-derived work: stamps heartbeat_at + status READY and
projects the PROJECT's own provisioned permissions and the
project's own resource-policy quotaCap into the worker profile.
Measured fields are never written — passRate & friends stay at
the engine defaults (DEFAULT_NOT_MEASURED), which the synthetic
job's pass_threshold 0 accepts without asserting anything.
Arrival never touches quota_remaining/quota_reserve (the
controller's grant), metadata/bindings, project status,
connectors, or jobs; after cleanup it cannot reopen the window
(verified: claim returns EMPTY). The qualification integration
suite now runs the whole cycle from an empty scope through ONLY
exposed actions — controller grant → arrive → claim → ack →
heartbeat → result — with no ResourceStore.register anywhere in
the file. No owner operation remains hidden; the remaining owner
operations are exactly the plan's D-054 steps.

## Test-layout change

test/qualification-controller.integration.test.ts was rewritten
around a shared fresh-schema setup (each test's qualification
scope starts completely empty) with five tests: T1 lifecycle +
arrival + full cycle + monitor discipline + foreign block +
cleanup; T2 concurrency (different runs → exactly one owner /
job / task; same-run convergence); T3a crash boundaries
(PREPARING recovery) + partial-state cleanup resume + repeated
cleanup; T3b result-vs-cleanup race (either winner, invariants
asserted); T4 absolute cutoff (held scope lock across the
deadline → no grant; held registry lock across the deadline →
claim EMPTY; exact lease caps with NO tolerance; last-fraction
heartbeat bounded). The worker-surface suite is unchanged this
round (its B1 ungated-semantics sections re-ran green against
the modified store).

## Evidence (LOCAL integration, embedded PostgreSQL 18.4; not live)

- test/qualification-controller.integration.test.ts: 5/5 PASS.
- test/worker-surface-v3.integration.test.ts: 1/1 PASS
  (S/T/U/V/A/B/C sections — B1 pin-exact ungated semantics hold
  against the deadline-aware store).
- test/worker-ui.integration.test.ts: 1/1 PASS.
- postgres / platform-postgres / runtime-postgres integration:
  1/1 PASS each.
- Unit glob (non-integration): 170 tests = 154 pass / 2 fail
  (the same two pre-existing pin failures) / 14 skipped.
- npx tsc --noEmit: clean.
- Stack check: pin + canonical worker-surface patch + v11
  patches 01–04 applied to a fresh stack reproduce the tested
  tree byte-for-byte on all 12 touched/new source files (12/12).

## Changed files in this supplement

- patches/01-postgres-store-v6.patch — postgres-store.ts (claim:
  post-lock deadline re-check + per-candidate check + LEAST
  lease cap; heartbeat: optional deadline, LEAST cap + at/after
  refusal) and types.ts (ClaimRequest.deadlineMs). Supersedes
  01-postgres-store-v5.
- patches/02-worker-surface-v7.patch — worker-surface.ts
  ('arrive' action; claim/heartbeat pass the deadline through to
  the store instead of surface-side second math). Supersedes
  02-worker-surface-v6.
- patches/03-worker-ui-v5.patch — unchanged from v10.
- patches/04-new-modules.patch — qualification-controller.ts
  rewritten (E1/E3 lifecycle); the other five modules unchanged.
- src/ snapshots updated for postgres-store consumers: the flat
  src/ set is the same eight platform modules; worker-surface.ts
  and qualification-controller.ts carry the new content.
- test/qualification-controller.integration.test.ts rewritten
  (T1–T4 above); the other two test files unchanged.
- ACTIVATION_PLAN_CANDIDATE.md is plan candidate v7.

## Boundaries (unchanged)

Offline only. Migration 012 has not been applied anywhere. The
live route remains BLOCKED_TRANSPORT. G2 still requires the
Option A owner policy exception (the
AGY_QUALIFICATION_CAP_ONLY_APPROVED flag is its code form) or is
BLOCKED_RESOURCE_PROFILE. No merge, deploy, credential grant,
posting, or business-row write was performed; PR #15 remains a
draft review artifact and must not be merged into the deployment
lineage.
