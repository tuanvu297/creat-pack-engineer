# QA fix report v2 — AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1

Response to Control Plane QA (Q1–Q5) and the feasibility supplement.
Status of everything below: CANDIDATE. Nothing has been deployed,
connected, granted or provisioned. The only live request Muse made in
this phase is one `GET /health` (see Feasibility).

## Feasibility supplement — incorporated

- The canonical service `agy-temporal-staging`
  (9c9f2634-3a2c-4577-9db9-d472e397adbd) already exposes
  `https://agy-temporal-staging-staging.up.railway.app` (port 8080,
  deployment b12e9dd6…, pin 36516473…). Muse verified reachability with
  a single read-only `GET /health` on 2026-10-28:
  READY, postgres/temporal/worker all true, mode TEMPORAL_SHADOW,
  canonical_authority EXISTING_POSTGRES_D049, production false.
  No new public domain is needed for either plane.
- Env names AGY_IDENTITIES_JSON, DATABASE_URL, AGY_STAGE_ONLY are present
  (values never read). The canonical candidate therefore extends THIS
  entrypoint and its existing auth/principal/scope/leases (Q5 package),
  with a bounded worker namespace and the D-049 mission surface untouched.
- The connector client enforces an exact-host allowlist (that one host)
  and attaches credentials only via the auth surrogate; no private
  *.railway.internal URL is generalized into an arbitrary endpoint.
- Gemini (Tasks4Argon) state is as the control plane reported: real tool
  reads of the ledger done, no native custom MCP, local script outbound
  disabled, browser/website route available, /health read attempted
  Gemini-side, browser adapter contract in preparation, NO runtime ACK.
  This package does not claim anything for Gemini beyond preparing its
  canonical identity/registry/binding candidates.

## Q1 — Provisioning, scopes, fail-closed claim

Shadow SQL v2 (`agy-gateway-rpc.candidate-v2.sql`):

- register_worker is split: a WORKER caller can no longer create a worker
  row (WORKER_NOT_PROVISIONED) nor change capabilities / permissions /
  competency / scopes / role (SCOPE_CHANGE_DENIED). CONTROL provisions and
  re-provisions; provider stays immutable even for CONTROL.
- Workers gain a CONTROL-provisioned `scopes` jsonb (additive idempotent
  ALTER in the candidate): missions[], projects[], task_types[],
  reply_targets[]. Claim enforces them; a present key fails closed,
  including on missing task fields (e.g. no project_id on the mission →
  WORKER_PROJECT_SCOPE denial).
- Claim additionally requires the worker's last_validated_at to be set
  (CONTROL provisioning is the validation act) → WORKER_NOT_VALIDATED.
- Fail-closed task scope: a task whose payload lacks target_provider is
  NOT_CLAIMABLE/TASK_SCOPE_MISSING for everyone on this route, and
  payload.auto_dispatch=false yields NOT_CLAIMABLE/AUTO_DISPATCH_DISABLED
  with zero attempts created — the two ROUTED SEO tasks stay genuinely
  unclaimable here (verified by test, including attempts=0).

Canonical: scopes are native — ProjectScope (tenant/workspace/project) +
role-action authorization in src/platform/auth.ts, project permissions
and budgets in PostgresStore.claim allocation, adapter binding via
agy_connectors. The worker surface adds no second scope system.

## Q2 — Callback authority as a fenced result receipt

- The shadow result action now mints, onto the attempts row,
  `callback_authority = sha256(task|attempt|lease_token|fence|result_version)`.
- agy_gateway_callback_rpc validates, in order: caller present; attempt
  exists AND attempts.worker_id matches; a result exists for the attempt;
  the leases row matches attempt + worker + the exact presented
  lease_token + fence AND is released; and the minted digest matches.
  Any drift (stale/rotated token, wrong fence, foreign attempt) →
  CALLBACK_AUTHORITY_DENIED. HTTP headers alone no longer suffice; the
  SQL validates the completed attempt's lease lineage itself.
- Target, status and reply target remain server-derived; replay with the
  exact receipt is idempotent; changed content under the same
  callback_id → CALLBACK_CONFLICT (v1 immutability kept).

Canonical: result submission IS the fenced act — PostgresStore.transition
checks lease_token + live lease + status; the result lands on the task
row in QA and readback exposes it. There is no separate worker-settable
callback on canonical, by design.

## Q3 — Fail-closed caller checks + RPC ACL

- assert_caller_ now raises CALLER_REQUIRED whenever _caller is absent,
  and claim/callback call it before any queue read (v1 enforced it only
  inside agy_gateway_rpc). Tested directly at SQL level for both RPCs.
- HTTP v2: the caller registry parser fails closed on ANY malformed
  content — invalid JSON, non-array, unknown provider/role, non-hex
  token hash, duplicate worker_id → zero trusted callers (all routes
  401). Tested with six malformed variants.
- ACL: the v2 SQL ends with an explicit, idempotent ACL block preserving
  the control-plane-verified live grants (anon/authenticated EXECUTE =
  false, service_role = true) on the three RPCs, and applying the same
  restriction to the two new helper functions — which Postgres would
  otherwise grant EXECUTE to PUBLIC by default. Tests simulate the live
  ACL on the deployed definitions first, verify a direct anon call is
  permission-denied, apply the candidate, and re-verify grants + a
  service_role call + a second anon denial.

## Q4 — Replay conflicts, evidence, readback

- create_task: same task_id with different payload/acceptance →
  TASK_CONTENT_CONFLICT (identity-only replay still returns
  IDEMPOTENT_REPLAY).
- checkpoint: same (task_id, version) with different state/evidence →
  CHECKPOINT_CONFLICT; identical replay returns replay: true.
- result: result_status is now REQUIRED and restricted to
  PASS/FAIL/RESULT_READY (the deployed default 'PASS' is removed), and
  evidence.external_operation_id is required (EVIDENCE_REQUIRED). Stored
  content is compared on replay → RESULT_CONFLICT. Note the honest
  boundary: after a successful result the lease is released, so a blind
  re-submit is stopped earlier by lease validation — conflict detection
  covers the paths where a live lease legitimately presents a second
  version (e.g. a re-claimed retryable task).
- Readback: new RPC action + authenticated `GET /tasks/{id}/readback`
  returning the stored task/result/callback rows with an explicit
  semantics field — PENDING means recorded only; DELIVERED is a
  control-plane act; acceptance is QA state. Workers can read back only
  tasks they participate in (READBACK_DENIED otherwise); CONTROL can
  read all.

## Q5 — Canonical D049 port (primary deliverable)

`canonical/` package:

- `canonical-worker-surface.candidate.patch` — extends the EXISTING
  canonical entrypoint: new `src/platform/worker-surface.ts` (bounded
  namespace /v1/worker/tenants/:t/workspaces/:w/projects/:p/{claim,ack,
  heartbeat,checkpoint,result,readback}) wired into
  src/temporal/http-server.ts + server.ts. It reuses platform identities,
  ProjectScope authorization, the RLS ProjectPool and PostgresStore
  leases/allocation — no new queue, database or domain authority, and the
  D-049 Temporal mission surface is byte-untouched.
- `identities.candidate.json` — AGY_IDENTITIES_JSON entries (worker
  Muse, worker Gemini, reviewer Gemini; tokens are placeholders for
  server-side provisioning + Secure Vault delivery).
- `worker-registry.candidate.sql` — agy_workers + agy_connectors
  provisioning with the verification readback. A debugging finding worth
  recording: allocation binds workers through ENABLED connector kinds
  projected into agy_dispatch_projects.adapter_kinds — registry rows
  alone do not make a worker allocatable; the connector binding is
  required, and the package includes it.
- `CANONICAL_PORT_CANDIDATE.md` — design, evidence, activation order,
  rollback (redeploy b12e9dd6; remove identity entries; disable
  connector rows).
- `connector-canonical/` — custom.agy-worker connector descriptor +
  exact-host client (surrogate credential, no redirects, UNCERTAIN
  discipline, lease-token redaction).

## Test matrix (all local; nothing live except the one GET /health)

| Suite | Result | Evidence class |
|---|---|---|
| Shadow SQL v2 (`run-rpc-tests-v2.mjs`) | **42/42 PASS** | Local integration: real local PostgreSQL 18.4, inferred agy_shadow DDL, minimal pgmq test double, deployed defs installed first + simulated live ACL |
| Shadow SQL v1 (previous phase) | 33/33 PASS | Same harness |
| HTTP gateway v2 auth/readback | **4/4 PASS** | Local unit, mocked fetch |
| HTTP gateway v1 auth | 9/9 PASS | Local unit, mocked fetch |
| Canonical worker surface (`worker-surface.integration.test.ts`) | **1/1 PASS** (full lifecycle + 6 denial cases) | Local integration: local PG 18.4, repo migrations 001–008, RLS runtime role, real HTTP through the patched entrypoint |
| Repo unit suite, pristine pin | 154 pass / 2 fail / 2 skip (158) | Local unit |
| Repo unit suite, canonical candidate tree | 154 pass / 2 fail / 2 skip (158) | No regression |
| Repo integration vs local PG (this phase) | provision 3/3, platform-postgres PASS, postgres PASS, runtime-postgres PASS | Local integration, real PG |
| temporal-shadow.integration | SKIPPED | Needs AGY_TEST_TEMPORAL_ADDRESS (a live Temporal server) — the one suite still requiring real runtime |
| *.integration on live D049 / Supabase / deployed gateway | NOT RUN | Owner gate; never claimed |

## Baseline root causes (pristine pin, reproduced)

1. platform.test "no business hard-coded dependency in shared core":
   the pinned src/hosted/provision.ts itself seeds GL_AUTOMATION with
   tenant 'gl' literals — the documented one-time project seed
   (docs/HOSTED-STAGING.md) contradicts the test's invariant at this pin.
   Repo inconsistency, pre-existing, unrelated to any candidate.
2. hosted-staging "Temporal worker startup sanitizes invalid database
   connection values": the test spawns a child with an intentionally
   missing entry module and expects the worker's TEMPORAL_WORKER_BLOCKED
   guard text; in this environment the child dies earlier in the module
   loader, so the expected guard output never appears.
   Environment/harness-sensitive, pre-existing.
3. The 2 unit-suite skips are hosted-provision tests gated on
   AGY_PROVISION_TEST_DATABASE_URL; with a local PG provided they PASS
   (3/3 incl. both). The 4 integration-file skips are gated on
   AGY_TEST_DATABASE_URL (3 now run and PASS locally) and additionally
   AGY_TEST_TEMPORAL_ADDRESS for temporal-shadow (still skipped).

## What still needs real runtime (not done, not claimed)

- Deploying either candidate and any live claim/result against D049 or
  Supabase/pgmq (pgmq behaviour is proven only against the local test
  double; function logic is proven, queue semantics on real pgmq are
  not).
- temporal-shadow.integration (needs a Temporal server address).
- Gemini's browser adapter against the canonical host (Gemini-side work;
  no runtime ACK exists).

## Final owner consent required (revised: canonical-first per Q5)

- **G1 — canonical activation prep**: provision the three identities
  (tokens server-side; Muse's only via the Secure Vault page for
  custom.agy-worker), run worker-registry.candidate.sql on the staging
  schema, deploy the worker-surface patch to agy-temporal-staging.
- **G2 — first live qualification**: one synthetic staging task in the
  GL scope through the canonical namespace (not the SEO tasks):
  claim → ack → heartbeat → checkpoint → result → readback with row
  evidence.
- **G3 — shadow plane decision**: apply the v2 fix to the shadow
  gateway, or retire the shadow Function. (Recommendation: do not leave
  the deployed v1 surface as-is while it stays reachable.)
- Separately, later: cron-pull activation (only after G2 evidence) and
  Gemini browser-adapter hookup (when Gemini's contract is ready).

Reply format: "Approve G1, G2" (G3 decided separately). On approval
Muse will, in order: present the Secure Vault credential card for
custom.agy-worker → verify health + unauthenticated claim returns 401 on
the canonical host → report before any register/claim.
