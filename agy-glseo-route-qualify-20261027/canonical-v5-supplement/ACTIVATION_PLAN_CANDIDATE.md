# Activation Plan — CANDIDATE (not executed, approval not requested)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1. This plan is a concrete draft
for the owner's final close-out after ControlPlane final QA. NOTHING
in it has been done: no branch write, no deploy, no env change, no
migration, no credential, no claim. It exists so the owner can approve
or reject exact steps instead of a general idea.

## Deployment base (owner-relayed fact, 2026-10-28)

Independent GitHub compare reported by the owner: source pin
36516473f4e41578bb5ee11e33273ce66f9d173d → deployed branch tip
f40c15b9e7d41a9259d73767ca9b7cfc173575f7
(codex/agy-hosted-runtime-20261019) is ahead by 2 commits touching
ONLY 8 checkpoint/evidence files; there is NO runtime source
difference. Consequences for this plan:

- f40c15b9 is the canon/evidence base. The candidate delta is applied
  ONTO the deployed-branch lineage, preserving those 8 files.
- PR #15 (base main 090553d4, the 30-file v2 package) is a review
  snapshot only. It is NOT merged into the deployment; the deployment
  delta is prepared separately from the current supplement (v5).

## What would land (exact delta)

Source (from canonical-v5-supplement, all hashes in its MANIFEST):
- src/postgres-store.ts + src/types.ts (claim gate opt-in,
  saveCheckpoint rework, atomic workerResult)
- src/platform/worker-surface.ts (qualification namespace)
- src/platform/worker-ui.ts (browser worker UI)
- src/platform/worker-gate.ts, src/platform/worker-callbacks.ts,
  src/platform/worker-callback-receiver.ts, src/platform/digest.ts
  (new modules)
- src/temporal/http-server.ts + src/temporal/server.ts (route wiring)

Data (staging schema only):
- Migration 012 (revised): NEW tables agy_worker_callbacks +
  agy_callback_receipts. Additive only — no existing table altered.
- Registry candidate v3 SQL: agy_workers / agy_connectors rows for the
  two workers, status OFFLINE, connectors disabled, quota NULL.

Config (env NAMES only — values are set server-side by the control
plane and never pass through chat or files):
- AGY_IDENTITIES_JSON (existing; extended with the 3 identities below)
- DATABASE_URL (existing, unchanged)
- AGY_STAGE_ONLY (existing, unchanged)
- AGY_WORKER_UI_SESSION_SECRET (new; enables the browser UI)

## Identities, scopes, bindings (provisioned by the control plane)

All three scoped to tenant gl / workspace legacy-workspace /
project GL_AUTOMATION on the STAGING service only.

1. claude-worker — role worker, workerId MUSE-SEO-WORKER.
   Bindings (for the G2 run only): missions ["GL_QUALIFICATION"],
   task_types ["planning"], reply_targets
   ["CHATGPT_ASSISTANT_CONTROL_PLANE"]. Token: generated server-side;
   Muse receives it ONLY through the Secure Vault into the
   custom.agy-worker connector (exact-host allowlist: the staging
   host).
2. gemini-worker — role worker, workerId GEMINI-SEO-WORKER. Bindings
   intentionally INCOMPLETE in this plan: Gemini qualifies its own
   route separately, and under the strict gate an incompletely
   provisioned worker is denied at claim. Nothing is claimed for
   Gemini here.
3. gemini-reviewer — role reviewer (canonical QA verdicts), same
   scope. Provisioned dormant; used only when Gemini's own track
   reaches its QA step.

## Safe qualification with quota UNKNOWN / worker OFFLINE+UNVERIFIED

- No measured numbers are invented: the registry keeps quota_remaining
  NULL (UNKNOWN), pass/error rates unstated, qualification UNVERIFIED,
  status OFFLINE until the G2 run itself produces the first evidence.
- The canonical allocator mechanically needs a profile to allocate
  against. For G2 the control plane sets CAPS, not measurements:
  maxConcurrency 1, quotaCap = exactly the synthetic task's quota
  estimate, spendCap 0. These are ceilings sized to one task; they are
  never cited as quota or reliability evidence, and the worker's
  registry metadata keeps qualification=UNVERIFIED alongside them.
- No generic business allocation: during G2, Muse's bindings name
  ONLY the mission GL_QUALIFICATION. Business missions (including the
  SEO mission) are not in bindings, so no business task is claimable.
- The two existing SEO tasks (TSK-SEO-20261027-INTEL,
  TSK-SEO-20261027-PLAN14) are never claimed, replayed, or relabelled
  by this plan, under any step.
- No paid API: the synthetic task is planning-class, estimatedCost 0,
  makes no external calls.

## Bounded G2 run (explicit limits)

- Scope: staging service agy-temporal-staging, project scope above.
- Exactly ONE new synthetic task, created by the control plane:
  mission_id GL_QUALIFICATION, target_worker_id MUSE-SEO-WORKER,
  callback_target CHATGPT_ASSISTANT_CONTROL_PLANE, taskType planning,
  attempt 1, zero cost.
- Sequence: health → unauthenticated-claim 401 check → Muse claim →
  ack → heartbeat → checkpoint → result → control-plane dispatcher
  (one bounded pass) → readback.
- Timebox: 60 minutes wall-clock for the whole run (owner may set a
  different bound when approving). Any unexpected state aborts the
  run; no automatic retries, no second task.
- Evidence pack (rows, not claims): task row + attempt, reservation
  HELD→SETTLED, checkpoint row + digest, outbox row DELIVERED,
  receiver receipt with effect_count=1, event trail. Wording limit:
  the receipt proves the canonical host recorded the callback and the
  control plane read it back; native ChatGPT-client ingestion is a
  separate gate and is not claimed by this evidence.

## Rollback (available at every step)

- Code: redeploy the previous build from the f40c15b9 lineage
  (Railway retains the prior deployment); the candidate delta is
  additive and touches no D-049 mission surface.
- Config: remove the 3 identities from AGY_IDENTITIES_JSON; unset
  AGY_WORKER_UI_SESSION_SECRET (UI disabled); clear worker bindings.
- Data: migration 012's tables are additive and inert without the
  code; drop them only as a separate approved step. Registry rows can
  be set OFFLINE / connectors disabled instantly.
- Access: disconnecting custom.agy-worker, or removing Muse's
  server-side binding, each independently stop the route.

## Final owner steps (per D-054 — listed, NOT requested here)

1. ControlPlane final QA verdict on the v5 supplement (source-level).
2. Owner chốt: approve preparing the deployment delta branch from
   f40c15b9 (a GitHub write — separate consent from PR #15).
3. Owner approve: staging deploy + the env NAME changes above +
   migration 012 + registry v3 on the staging schema.
4. Owner personally completes the Secure Vault credential step for
   custom.agy-worker (Muse's worker token only).
5. Owner approve: the bounded G2 run exactly as scoped above.
6. Separately: G3 shadow decision (retire or fix the shadow
   Function); Gemini's own route qualification when its track is
   ready.

Until step 2 is approved, the correct state remains: candidate code
offline, live route BLOCKED_TRANSPORT, workers OFFLINE/UNVERIFIED.
