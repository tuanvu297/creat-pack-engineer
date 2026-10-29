# Canonical v7 Supplement — AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1

OFFLINE candidate supplement responding to independent-QA findings
A1–A2 on the v6 activation plan. QA instructed: do not reset the
passing code/tests; fix the plan's two real blockers in the
candidate. Earlier supplements and PR snapshots stay frozen. No
deploy, Connect, credential, or grant. This package will be written
into PR #15 as its own version folder under the owner's existing
approval for QA updates to that PR.

## Test evidence (all LOCAL, real local PostgreSQL 18.4, migrations
001–008 + candidate 012, RLS-bound NOSUPERUSER runtime role)

- test/worker-surface-v3.integration.test.ts — 1/1 PASS, now covering
  S1–S3, S6, T1, T3, U1–U3, V1–V3, A1, A2.
- test/worker-ui.integration.test.ts — 1/1 PASS. Canonical repo DB
  integrations — 3/3 PASS. Repo unit suite — 154 pass / 2 fail
  (pre-existing pin inconsistencies) / 9 skipped. tsc clean.
- Stack verification: pin + PR #15 canonical patch + supplement
  patches 01–04 reproduces the tested tree byte-for-byte on all 11
  touched/new source files.

## A1 — Registry is GLOBAL; isolation rebuilt on a distinct worker

Pin facts, verified by reading the source this round (not assumed):
agy_workers (migration 001) has worker_id as PRIMARY KEY and NO
tenant/workspace/project columns; migration 004's RLS/scope loops
enumerate 21 tables and agy_workers is NOT among them;
ResourceStore.list() is unscoped and register() upserts
ON CONFLICT(worker_id); metadata.bindings live on the global row.
Plan v6's "project-scoped registration" claim was therefore wrong,
and the same worker_id cannot be OFFLINE for business and READY for
qualification. No per-project RLS for agy_workers is claimed.

Fix (plan + registry/qualification-registry.candidate.sql):
- A DISTINCT worker MUSE-QUAL-WORKER with DISTINCT adapter kind
  'muse-qual'; that connector kind is inserted ONLY in project
  GL_QUALIFICATION. Allocation is adapter-filtered per project
  (adapter_kinds derive from each project's enabled connectors —
  connectors ARE in the 004 RLS list), so the qual worker is
  allocatable only there, and no business worker is allocatable in
  GL_QUALIFICATION. The business row MUSE-SEO-WORKER is never
  registered, flipped, or debited by the qualification flow; its
  bindings stay incomplete and dormant. The qual row's bindings are
  global but single-purpose, so globality has no cross-talk.
- Four-state integration evidence: (1) adapter_kinds isolation per
  project asserted from agy_dispatch_projects; (2) the business
  global row (status/metadata/quota/active_count) is byte-identical
  before vs after the entire qualification flow; (3) a queued
  untargeted business task stays QUEUED at attempt 0 with zero
  reservations — never mutated, never alternately claimed
  (cross-scope surface claims are PROJECT_SCOPE_DENIED in both
  directions); (4) the qualification task is claimed and resulted
  only by MUSE-QUAL-WORKER inside GL_QUALIFICATION.
- Exact-shape findings recorded in the candidate SQL and plan:
  scheduler hard-gate quotaRemaining − estimatedQuota >=
  quotaReserve ⇒ the cap-only profile must carry quota_reserve = 0;
  selectProjectDemand skips projects whose resource_policy lacks
  finite maxConcurrentTasks/quotaCap/spendCap/reservation ⇒ the
  qualification policy carries all four; cross-project selection
  sorts by project priority first ⇒ the qualification project
  carries priority 10 during the window only; the synthetic job
  carries pass_threshold 0 ⇒ no passRate is ever asserted. G2's
  cap-only profile remains an explicit owner policy exception;
  without it G2 is BLOCKED_RESOURCE_PROFILE (unchanged).

## A2 — A real runtime driver for the callback dispatcher

Fix (new src/platform/worker-callback-driver.ts, wired into
src/temporal/server.ts; mission filter added to worker-callbacks.ts):
- The driver is the missing runtime caller of
  dispatch/reconcile/recover. It is DEFAULT DISABLED and starts only
  with AGY_CALLBACK_DRIVER_ENABLED=true AND an explicit
  AGY_CALLBACK_DRIVER_SCOPE (one project) AND
  AGY_CALLBACK_DRIVER_MISSION (allowlist) — missing either refuses
  to start. Per pass: stale-intent sweep → reconcile → dispatch,
  all mission-filtered; limit default 1 (hard cap 5);
  AGY_CALLBACK_DRIVER_TIMEBOX_MS makes it stop itself (EXPIRED) and
  never restart alone. A restart therefore recovers the outbox
  instead of resending blind.
- Credentials: the driver acts as the EXISTING scoped operator
  identity, resolved server-side from AGY_IDENTITIES_JSON
  (findCallbackOperator); the default transport/lookup call the
  co-located receiver in-process. No operator token is ever handed
  to Muse or Gemini; no new queue, service, or secret.
- Integration evidence: parse defaults disabled; enabled without
  scope → SCOPE_REQUIRED; driver without an operator identity →
  NO_OPERATOR; a foreign mission allowlist touches nothing in the
  same project (seen=0, callback stays PENDING); a running driver
  delivered the qualification callback end-to-end (outbox DELIVERED,
  receipt effect_count=1); a zero timebox → EXPIRED before any pass.
- Plan honesty updated: with this code deployed but disabled, the
  cycle runs only inside the configured window; against any source
  without the driver, approving "G1, G2" could not have produced a
  full cycle. Native ChatGPT-client ingestion remains a separate
  UNPROVEN gate (unchanged).

## Boundaries

Offline candidate only; the PR write is the previously approved
review-branch update and nothing more. Migration 012 is still
unapplied anywhere. Live hosted behaviour remains UNPROVEN; the
live route remains BLOCKED_TRANSPORT; G2 remains not runnable
until the owner steps in the plan — including the Option A policy
exception or a BLOCKED_RESOURCE_PROFILE record — are decided.
