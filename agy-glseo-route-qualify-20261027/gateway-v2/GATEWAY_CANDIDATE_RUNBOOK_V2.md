# Gateway candidate runbook v2 — shadow fix + canonical port

Phase: AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1. Supersedes
GATEWAY_CANDIDATE_RUNBOOK.md (v1). Nothing in this runbook has been
executed. Every step that touches a live system sits behind the owner
consent items G1–G3 in QA_FIX_REPORT_V2.md.

## Part A — Canonical worker namespace (primary route, Q5)

Preconditions (already true, verified 2026-10-28): service
agy-temporal-staging is READY at
https://agy-temporal-staging-staging.up.railway.app with env names
AGY_IDENTITIES_JSON / DATABASE_URL / AGY_STAGE_ONLY present.

1. Provision per-principal tokens server-side. Store only what the
   platform already stores (the identities config holds tokens by design
   of src/platform/auth.ts); Muse's token goes to Muse exclusively via
   the Secure Vault page for connector custom.agy-worker. Gemini's tokens
   go to Gemini's side only.
2. Append the entries from canonical/identities.candidate.json to
   AGY_IDENTITIES_JSON (placeholders replaced server-side).
3. Run canonical/worker-registry.candidate.sql; verify the readback:
   agy_dispatch_projects.adapter_kinds for gl/GL_AUTOMATION includes
   'muse' and 'gemini'.
4. Deploy canonical/canonical-worker-surface.candidate.patch to the
   service (same domain, same port). The D-049 mission surface is
   untouched by the patch.
5. Smoke (read-only first): GET /health → READY; POST worker claim with
   no token → 401; with the operator identity → 403.
6. First qualification (G2): one synthetic staging task created through
   the existing ProjectService surface; Muse runs claim → ack →
   heartbeat → checkpoint → result → readback with its connector;
   evidence = task row readback showing status QA and the stored result.
   The two ROUTED SEO tasks are never used for qualification.
7. Rollback: redeploy deployment b12e9dd6-d684-4048-b23b-5798280e2f24
   (unpatched pin); remove identities entries; optionally set the two
   agy_connectors rows enabled=false.

## Part B — Shadow gateway v2 (only if the shadow plane stays reachable)

The deployed shadow gateway still carries the three QA'd defects. If the
shadow Function remains deployed and reachable, leaving it unfixed keeps
an unauthenticated register/create/claim surface alive. Recommendation:
either apply v2 or retire the Function; do not leave v1/deployed as-is.

Apply order (shadow Supabase first, then the Function):

1. Confirm agy_shadow.schema_meta state_plane mode is 'SHADOW_STAGING';
   the candidate refuses every mutation otherwise.
2. Apply agy-gateway-rpc.candidate-v2.sql (CREATE OR REPLACE + one
   idempotent ALTER adding workers.scopes + the ACL block). Verify with
   the has_function_privilege query in the file header of Part B of the
   SQL: anon/authenticated EXECUTE=false on all five functions,
   service_role=true.
3. Redeploy the Railway Function from agy-gateway.candidate-v2.ts with
   AGY_GATEWAY_CALLERS_JSON provisioned (SHA-256 hashes only).
4. Smoke: health; claim with no token → 401; worker self-register for a
   new worker_id → WORKER_NOT_PROVISIONED; CONTROL register → provision;
   synthetic task full cycle incl. callback + readback.
5. Rollback: redeploy the supplement-preserved deployed sources
   (gateway-supplement-20261027/) and remove AGY_GATEWAY_CALLERS_JSON.

Operator notes:

- auto_dispatch=false tasks (incl. the two real SEO tasks) are held by
  design: claim answers NOT_CLAIMABLE/AUTO_DISPATCH_DISABLED and creates
  no attempt. Their queue messages stay parked at the head; archive a
  message only as a deliberate control-plane hold action — the task row
  and its ROUTED state are never changed by this route.
- A recorded callback with status PENDING means stored, not delivered.
  Delivery is a control-plane act that sets delivered_at out of band;
  acceptance is the separate QA state. Readback exposes exactly what is
  stored.
- Head-of-line behaviour from v1 still applies on the shadow queue:
  messages are archived on result, not on claim.

## Part C — Cron-pull (not created; separate later approval)

Only after Part A step 6 evidence exists: a bounded Muse cron (5-minute
interval, max 1 claim per run, health gate first, unattended boundary —
attempt 1 only, cost 0, permissions within read/analyze/planning/qa) may
poll the canonical worker claim endpoint via connector custom.agy-worker.
The phase-3 cron_pull_candidate.json remains a draft and is not part of
this package's activation.
