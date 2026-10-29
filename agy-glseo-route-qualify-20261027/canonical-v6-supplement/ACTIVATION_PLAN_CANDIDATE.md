# Activation Plan — CANDIDATE v2 (not executed, approval not requested)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1. Revised per QA finding V3:
the v1 draft was circular — it kept the worker OFFLINE/UNVERIFIED
until G2 produced evidence, but a claim requires a READY, allocatable
profile. This version resolves the circle with an exact, bounded
preflight/transition/rollback, names the one policy exception it
depends on, and states plainly when G2 is BLOCKED_RESOURCE_PROFILE
instead. NOTHING in this plan has been done.

## Deployment base (owner-relayed fact, 2026-10-28)

Pin 36516473f4e41578bb5ee11e33273ce66f9d173d → deployed branch tip
f40c15b9e7d41a9259d73767ca9b7cfc173575f7: ahead 2 commits, ONLY 8
checkpoint/evidence files, no runtime source difference. f40c15b9 is
the canon base; the delta is prepared onto the deployed lineage.
PR #15 is a review snapshot only and is NOT merged into deployment.

## Identities and secrets

- The receiver and the dispatcher run under the EXISTING
  control-plane operator identity (already provisioned in
  AGY_IDENTITIES_JSON). No new operator identity is created by this
  plan; the receiver's authorization relies on that operator (or a
  platform-admin) exactly as coded.
- Three identities are provisioned for the worker plane:
  1. claude-worker — role worker, workerId MUSE-SEO-WORKER.
  2. gemini-worker — role worker, workerId GEMINI-SEO-WORKER;
     bindings intentionally INCOMPLETE (Gemini qualifies separately;
     the strict gate denies it by design).
  3. gemini-reviewer — role reviewer, same scope, dormant.
- Secrets live only as server-side values/references: identity tokens
  inside AGY_IDENTITIES_JSON on the server; Muse's worker token
  reaches Muse only through the Secure Vault into the
  custom.agy-worker connector (exact-host allowlist: the staging
  host). The worker never holds or transmits server secrets.
- Env NAMES involved: AGY_IDENTITIES_JSON (extended), DATABASE_URL
  (unchanged), AGY_STAGE_ONLY (unchanged), AGY_WORKER_UI_SESSION_SECRET
  (new, enables the browser UI).

## Isolation model (why business allocation cannot happen)

- Project GL_AUTOMATION (business): Muse's row stays OFFLINE, its
  connector disabled, its bindings incomplete — dormant. No business
  task payload is created or modified by this plan.
- Project GL_QUALIFICATION (new, staging, same tenant/workspace):
  the ONLY project in which a transition happens. It contains exactly
  one task during the run. Worker/connector registration is
  project-scoped in the canonical schema, so a READY profile here is
  invisible to allocation in the business project.
- Code guard (candidate v6, PostgresStore.claim): an UNGATED legacy
  claim never allocates a task whose payload addresses a worker
  (target_worker_id) or is marked auto_dispatch=false — in ANY
  project. Addressed tasks are leasable only through the gated worker
  namespace. Test-verified locally (legacy claim skips the addressed
  qualification-shaped task at attempt 0; the gated claim leases it).

## The resource-profile constraint (exact)

Canonical allocation has NO null-quota path: a worker is allocatable
only with status READY and numeric quota headroom. The registry
therefore CANNOT stay quota-NULL through the claim itself. Two
honest options exist, and only two:

- Option A — bounded owner policy exception (required for G2 to run):
  for the 60-minute qualification window, in GL_QUALIFICATION only,
  the control plane registers Muse with CAP-ONLY values:
  quotaRemaining = quotaCap = exactly the synthetic task's quota
  estimate (1), maxConcurrency 1, spendCap 0, status READY.
  Scoring fields (passRate/errorRate) take the engine's registration
  defaults and are recorded in the evidence as DEFAULT_NOT_MEASURED.
  These numbers are ceilings for one task; they are never reported as
  measured quota, reliability, or qualification evidence, and the
  registry metadata keeps qualification=UNVERIFIED until QA judges
  the run's own telemetry.
- Option B — no exception: G2 is BLOCKED_RESOURCE_PROFILE. Approving
  "G1, G2" without the exception does NOT make the run possible, and
  this plan does not pretend otherwise.

## Preflight P0 (all must verify, else stop before any transition)

1. Staging health READY (postgres/temporal/worker), production=false.
2. Migration 012 applied on the staging schema (both tables exist).
3. Receiver route smoke: no token → 401; worker token → 403;
   operator token on a foreign project path → 403.
4. Business project GL_AUTOMATION: Muse worker OFFLINE, connector
   disabled, bindings incomplete (denied by design).
5. GL_QUALIFICATION project exists (or is created in P1 step 1) with
   zero pre-existing tasks.
6. The two SEO tasks (TSK-SEO-20261027-INTEL / -PLAN14) untouched —
   they are never claimed, replayed, or relabelled by this plan.
7. Owner policy exception (Option A) explicitly granted for the
   window, OR the run is recorded BLOCKED_RESOURCE_PROFILE and stops.

## Transition P1 (control plane, in order, inside the window)

1. Create/activate project GL_QUALIFICATION with resource_policy
   maxConcurrentTasks=1, quotaCap = task estimate, spendCap=0.
2. Insert connector kind 'muse', enabled, in GL_QUALIFICATION only.
3. Register the cap-only worker profile per Option A.
4. Provision bindings: missions ["GL_QUALIFICATION"],
   task_types ["planning"], reply_targets
   ["CHATGPT_ASSISTANT_CONTROL_PLANE"].
5. Create exactly ONE synthetic task: mission_id GL_QUALIFICATION,
   target_worker_id MUSE-SEO-WORKER, callback_target
   CHATGPT_ASSISTANT_CONTROL_PLANE, taskType planning, estimatedCost
   0, no external calls, no paid API.

## Run P2 (≤ 60 minutes wall-clock, one task, no retries)

health → unauthenticated-claim 401 check → Muse claim → ack →
heartbeat → checkpoint → result → one bounded dispatcher pass →
readback. Evidence pack (rows, not claims): task + attempt,
reservation HELD→SETTLED, checkpoint + digest, outbox DELIVERED,
receiver receipt effect_count=1, event trail. Wording limit: the
receipt proves the canonical host recorded the callback and the
control plane read it back; native ChatGPT-client ingestion is a
separate, still-unproven gate. Any unexpected state aborts the run.

## Rollback P3 (at window end OR on abort, whichever comes first)

Worker → OFFLINE and connector disabled in GL_QUALIFICATION;
bindings cleared; profile quota zeroed; project → SUSPENDED.
Evidence rows are preserved. Code rollback: redeploy the f40c15b9
lineage build (the delta is additive; the D-049 mission surface is
untouched). Config rollback: remove the 3 worker-plane identities,
unset AGY_WORKER_UI_SESSION_SECRET. Migration 012's tables are
additive and inert without the code; dropping them is a separate
approved step. Disconnecting custom.agy-worker, or removing Muse's
server-side binding, each independently stop the route.

## Final owner steps (per D-054 — listed, NOT requested here)

1. ControlPlane final QA verdict on the current supplement head.
2. Owner chốt: prepare the deployment delta branch from f40c15b9
   (GitHub write — separate consent from PR #15 updates).
3. Owner approve: staging deploy + env NAME changes + migration 012
   + dormant registry provisioning (business project, OFFLINE).
4. Owner personally completes the Secure Vault credential step for
   custom.agy-worker.
5. Owner approve: the G2 window INCLUDING the Option A policy
   exception as written above — or record G2 as
   BLOCKED_RESOURCE_PROFILE.
6. Separately: G3 shadow decision; Gemini's own qualification.

Until step 2 is approved, the correct state remains: candidate code
in the review PR only, live route BLOCKED_TRANSPORT, workers
OFFLINE/UNVERIFIED, G2 not runnable.
