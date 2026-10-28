# Canonical D049 port candidate — AGY worker namespace

Phase: AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1. Status: CANDIDATE ONLY.
Nothing here is deployed, connected or granted. This package answers QA Q5
and the feasibility supplement: the goal is the canonical D049 runtime, not
a shadow demo, and the canonical entrypoint already exists and is public.

## Verified live facts (Muse's own checks, 2026-10-28)

- Railway service `agy-temporal-staging` (service id
  9c9f2634-3a2c-4577-9db9-d472e397adbd) already has the public HTTPS domain
  `https://agy-temporal-staging-staging.up.railway.app` (target port 8080),
  deployment b12e9dd6-d684-4048-b23b-5798280e2f24, source pin
  36516473f4e41578bb5ee11e33273ce66f9d173d (control-plane reported; the pin
  matches the repo Muse fetched and verified 223/223 blobs).
- Muse performed exactly one harmless request: `GET /health` →
  `{"status":"READY","dependencies":{"postgres":true,"temporal":true,"worker":true},"mode":"TEMPORAL_SHADOW","canonical_authority":"EXISTING_POSTGRES_D049","production":false}`.
  No POST, no token, no Connect was made.
- The service environment already carries the names AGY_IDENTITIES_JSON,
  DATABASE_URL, AGY_STAGE_ONLY (values never read). No new public domain
  and no new service are needed.

## Design: extend the existing entrypoint, add one bounded namespace

The deployed entrypoint is `src/temporal/server.ts` →
`createGatewayHttpServer` (`src/temporal/http-server.ts`). It already
authenticates every action through `src/platform/auth.ts`
(identitiesFromEnv: bearer token → Principal {subject, role, scopes,
workerId}, strict validation, fails closed) and already serves the D-049
Temporal mission actions. The candidate preserves all of that untouched
and adds ONE bounded worker namespace:

```
POST /v1/worker/tenants/:t/workspaces/:w/projects/:p/(claim|ack|heartbeat|checkpoint|result|readback)
```

implemented by the new `src/platform/worker-surface.ts`:

- Authorization: `authorize(principal, scope, 'execute')` — role `worker`
  only; the project scope comes from the URL, and scope/worker keys in the
  body are rejected (BODY_SCOPE_OVERRIDE_DENIED, same rule as
  ProjectService).
- Identity binding: the worker is ALWAYS `principal.workerId`; a worker
  principal without a workerId is refused (WORKER_IDENTITY_REQUIRED).
- Leases: the canonical `PostgresStore` on the RLS-scoped `ProjectPool` —
  allocation (capabilities, project permissions, budgets, failed-worker
  exclusions, checkpoint-adapter continuity), lease_token fencing,
  heartbeat, checkpoint store and transitions are all the repo's existing
  code. No new queue, table, schema or authority is introduced.
- Result semantics: a lease-fenced transition into QA with the result
  stored on the task row. QA acceptance remains a separate reviewer act
  (the Temporal gateway additionally enforces SELF_QA_DENIED). Readback
  returns the actual task row; nothing is presented as "accepted" by
  submission.
- Checkpoint adapter: read from the canonical worker registry
  (agy_workers.adapter), never from the request.

Diff: `canonical-worker-surface.candidate.patch` (2 files modified —
http-server.ts, server.ts — 1 file added — worker-surface.ts). The D-049
mission actions, the Temporal bridge and the gateway-shadow worker are not
modified.

## Provisioning (all control-plane acts, in the package)

1. `identities.candidate.json` — AGY_IDENTITIES_JSON entries for
   claude-seo-worker (worker), gemini-seo-worker (worker),
   gemini-seo-reviewer (reviewer). Tokens are placeholders; real values are
   generated server-side and Muse's token reaches Muse only through the
   Secure Vault page for connector `custom.agy-worker`.
2. `worker-registry.candidate.sql` — agy_workers rows (adapters muse /
   gemini) + agy_connectors project bindings. Canonical rule this relies
   on: the dispatch projection derives `adapter_kinds` from ENABLED
   connector kinds, so a worker is allocatable in GL_AUTOMATION only when
   its adapter matches an enabled connector kind there. Inserts are
   ON CONFLICT DO NOTHING; the file ends with the verification readback
   (adapter_kinds must include muse and gemini).

## Client

`connector-canonical/` — connector descriptor for `custom.agy-worker`
(exact host allowlist: agy-temporal-staging-staging.up.railway.app only)
and `bin/agy_worker.py`, which speaks only to that host, attaches the
credential solely via the dynamic-credentials surrogate, refuses
redirects, redacts lease tokens, and treats unknown POST outcomes as
UNCERTAIN (never auto-retried). Gemini's side is a browser/website route
(no native custom MCP; local script outbound disabled) — its adapter
contract is prepared Gemini-side against the same canonical host and is
not part of this package; no Gemini runtime ACK exists yet and none is
claimed.

## Test evidence (local, labelled)

- `test/worker-surface.integration.test.ts` run in the candidate tree
  against local PostgreSQL 18.4 with migrations 001–008 and an
  RLS-bound runtime role: PASS (1/1). It covers wrong-scope denial,
  missing workerId, operator-claim denial, allocation excluding a worker
  lacking a required capability (Gemini EMPTY), body scope-override
  denial, and the full HTTP lifecycle through the patched entrypoint:
  unauthenticated 401, operator 403, claim → foreign-token heartbeat 403 →
  ack → heartbeat → checkpoint → result (lands in QA) → readback.
- Repo unit suite in the canonical tree: 158 tests, 154 pass, the same 2
  pre-existing fails and 2 env-gated skips as the pristine pin (no
  regression; root causes in QA_FIX_REPORT_V2.md).
- Live verification is limited to the GET /health above. Everything else
  needs the owner gate: deploying this patch changes the hosted service,
  and provisioning identities/registry rows changes canonical state.

## Activation order (after owner consent G1/G2 in QA_FIX_REPORT_V2.md)

1. Provision tokens server-side; add the identities entries; run
   worker-registry.candidate.sql; verify the adapter_kinds readback.
2. Deploy the patched entrypoint to agy-temporal-staging (same service,
   same domain). Rollback = redeploy deployment b12e9dd6 (the unpatched
   pin); the namespace is additive and the mission surface is untouched.
3. Muse enters its token on the Secure Vault page for custom.agy-worker
   (never in chat); health + unauthenticated-claim (expect 401) checks.
4. ONE synthetic staging task in the GL scope (explicitly not
   TSK-SEO-20261027-INTEL / PLAN14): claim → ack → heartbeat → checkpoint
   → result → readback, with row readback as evidence.
5. Cron-pull, Gemini browser-adapter hookup, and any business task remain
   separate later approvals.

## Rollback

- Code: redeploy the unpatched pin (b12e9dd6). The patch is additive.
- Access: remove the identities entries (immediate revocation) and/or set
  the agy_connectors rows enabled=false (unbinds allocation).
- Data: the qualification task is synthetic and stays in the staging
  schema; no production rows are touched by design.
