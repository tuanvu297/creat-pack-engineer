# R11 Gateway Adapter — additive staging transport

This change is based on PR #9 head `eb1fa7c0c862f67c043bf5c0c6339e44545a8db7`.
`AGY_WORKER_TRANSPORT` defaults to `LEGACY`. The original worker and daemon are
retained byte-for-byte in `src/platform/legacy-worker.ts` and `legacy-daemon.ts`.
Their existing env/auth/SQL/QA behavior is unchanged. The two existing entrypoints
select a transport before importing a runtime. Gateway mode does not import `pg`,
construct a database pool, or accept `DATABASE_URL`/`SUPABASE_*` variables.

The new path is `worker/daemon -> AGY Gateway -> SHADOW_STAGING`.
`EXISTING_POSTGRES_D049` remains canonical. This is a worker HTTP transport, separate
from the existing Temporal orchestration gateway. It does not bridge Temporal to
the hosted shadow, alter D-049, run migrations, or promote the shadow to canonical.

## Runtime contract and Railway configuration

Use Node 24, the checked-in pnpm lockfile and root directory `/agy-temporal-shadow`.
Install with `pnpm install --frozen-lockfile --ignore-scripts`, build with
`pnpm build`, then use this exact daemon start command:

```text
node dist/src/platform/daemon.js
```

Before the **first** start on a newly provisioned empty journal directory, use the
same staging env to initialize it offline:

```text
node dist/src/gateway-shadow/init-journal.js
```

Initialization makes no network requests and refuses any nonempty directory or
existing writer lock. It is a provisioning command, not a restart/startup hook.
The runtime never initializes missing storage: `JOURNAL_MISSING` blocks before
health/register/claim, including when the entire directory is missing. Restore
the original journal or reconcile the old operation; never initialize a fresh
directory to bypass uncertain effects. Existing valid journals need no migration.

For a single tick use `node dist/src/platform/worker.js`. The existing
`pnpm worker:daemon` / `pnpm worker:tick` development scripts also select the same
transport. Do not use `pnpm start` (that starts the legacy API server).

All worker env is specified in `config/r11-gateway.env.example`. Required values:

```dotenv
AGY_WORKER_TRANSPORT=GATEWAY_SHADOW
AGY_STAGE_ONLY=true
AGY_STATE_MODE=SHADOW_STAGING
AGY_CANONICAL_AUTHORITY=EXISTING_POSTGRES_D049
AGY_ORCHESTRATION_MODE=LEGACY
AGY_WORKER_ID=R11-STAGING
AGY_GATEWAY_URL=http://${{agy-gateway.RAILWAY_PRIVATE_DOMAIN}}:8080
AGY_GATEWAY_STATE_DIR=/data/r11-gateway
AGY_R11_CONNECTOR_URL=http://r11-connector.railway.internal:8080
AGY_R11_CAPABILITIES_JSON=["text"]
```

`r11-connector` is an **example existing connector service name, not a provisioned
or verified service**. Set its actual private origin and verified capabilities.
It must already implement the module's R11 `WorkerAdapter` HTTP contract:
GET `/health` returning `{ready:true}`, POST `/execute` returning `{externalId}`,
GET `/status/{externalId}` and `/result/{externalId}` returning `ExecutionResult`.
The optional existing `AGY_R11_CONNECTOR_TOKEN` is sent only to that connector.
No connector is discovered, created, authenticated or contacted live by this PR.
No inference or provider readiness is inferred from the example config.

Use the same Railway project/environment as the gateway, region
`asia-southeast1-eqsg3a`, one worker replica, one writer, no overlapping deploys,
and an **existing approved persistent mount** at `/data`. The journal includes
lease tokens and task/output receipts: keep it private, outside Git/artifacts,
and retain the same directory across restarts. No volume is provisioned here.
Private domains and loopback are accepted; public URLs, embedded credentials,
paths, query strings and redirects are rejected. No public domain is needed.
Railway documents [private domains and reference variables](https://docs.railway.com/overview/advanced-concepts#private-networking).
The port `8080` follows the observed gateway runtime; private DNS/listener
reachability still needs verification from a worker inside the staging network.

Defaults: lease 120s (30–900), request timeout 5s, heartbeat 5s, poll 1s.
Do not configure an HTTP healthcheck for this outbound daemon. Gateway startup
health must return the observed `SHADOW_STAGING` and D-049 authority before any
registration/claim. Rollback for future dispatch is `AGY_WORKER_TRANSPORT=LEGACY`
with the original legacy env; do not redispatch accepted/uncertain shadow tasks
as fresh legacy work. Retain journals and receipts.

## Task and receipt semantics

The gateway task's `payload` is a `TaskSpec` envelope, for example:

```json
{"name":"bounded read","taskType":"text","payload":{"input":"approved input"},"requiredCapabilities":["text"],"requiredPermissions":["read"],"estimatedCost":0,"permissionGranted":true,"safetyApproved":true,"risk":"LOW","timeoutSeconds":300}
```

Only explicit zero-cost approved LOW-risk tasks pass unattended gates. Required
capabilities must match configured R11 capabilities; existing runtime capability
checks also apply. The claim is the source of task/mission/attempt/idempotency/
trace/worker/token/fence identity. It overrides identity-like envelope properties.
R11 receives the original idempotency key plus `attemptId`, `traceId`, `workerId`
and `fence`. No new task/attempt is invented on restart.

The worker validates real responses for register, claim, ACK, heartbeat,
checkpoint v1 INTENT, checkpoint v2 ACCEPTED, result v1 and callback. Every task
action, including callback, carries all seven `x-agy-*` identity/fencing headers.
The deployed callback route forwards only its four identity headers to its
separate callback RPC; it requires an existing result after the lease is released.
The adapter preserves that behavior and does not treat callback as lease renewal.

External SUCCEEDED becomes `result_status=RESULT_READY`, not QA PASS. FAILED and
CANCELLED remain those states. Result evidence and callback retain QA PENDING.
The callback is persisted as PENDING only: no chat delivery, DELIVERED or ACKED is
fabricated. No automatic cancel, correction, provider retry or reroute occurs.
Gateway and R11 HTTP transports make one request per invocation, including on
429/5xx/redirects. Status/collect reads for a confirmed operation may be repeated.

## Recovery boundaries

An exclusive filesystem lock and fsynced intent/receipt journal protect every
HTTP mutation and external submission. Payload hashes reject changed requests.
Confirmed ACK/checkpoint/result receipts replay locally without reposting.
A persisted accepted external ID resumes status/collect under the same live
lease. A confirmed result resumes callback directly without touching the released
lease. A live heartbeat renews actual server state during slow connector calls.
Lease loss or stop aborts connector work and prevents result/callback submission.

Any pending intent after an error/crash stops with `RECONCILIATION_REQUIRED` before
further network activity. Do not delete that intent or retry by changing IDs.
Malformed JSON and invalid journal structure/receipt entries fail with
`JOURNAL_INVALID`, retaining the original bytes. Acquisition reads existing state
without rewriting it. DB/Supabase environment names are rejected even when empty
or differently cased; those variables must be absent.
After a forced kill, `worker.lock` remains. An operator must first verify the old
writer is stopped, retain receipts and reconcile uncertain effects; remove only
that stale lock to resume a confirmed operation. There is no automatic stale-lock
steal. Empty claim polls are also archived; plan journal retention on the private
mount without deleting active/uncertain evidence.

The observed hosted APIs have **no read/reconcile/checkpoint-fetch endpoint**;
ACK/result are not server-idempotent, claim does not expose previous effects, and
checkpoint version conflicts do not compare payloads. Therefore fresh claims with
attempt_no > 1 are blocked before ACK/execute. Lost response recovery, expired
leases, missing journals and attempts from another worker require operator
reconciliation. Automated recovery beyond the confirmed same-attempt path needs
an additive server reconciliation contract in a separate change. This PR makes
no DB or gateway-runtime change to work around those limits.

## Validation and source provenance

Inspected repository source/tests at the exact parent SHA, the deployed Railway
function source, service config (no variable values), and read-only definitions
of `agy_gateway_rpc`, `agy_gateway_claim_rpc`, `agy_gateway_callback_rpc`.
Observed gateway: service `27be7aa3-3794-4f51-87b8-def294570762`, project
`45e66534-44ed-484e-bbf4-d63c311d6f27`, environment
`792d1b9e-73f5-434b-936f-f3b96d405253`, deployment
`bbd63784-5f8a-4cfb-889f-458678cd5bb4` SUCCESS, Singapore, no staged changes,
no domains/TCP proxies. These observations are not a live worker E2E PASS.

The test fixture is a captured non-secret deployed router, SHA-256 (LF bytes):
`9c03efca158e7576911720a0d12022526c8050a8b902afe0f4ef2395932c8a52`.
Tests evaluate that exact router with an in-memory RPC backend and real loopback
HTTP, including the separate claim/callback routes. The fake models observed RPC
transitions; it does not prove PostgreSQL locking, pgmq behavior or hosted R11.

Commands: `pnpm typecheck`, `pnpm build`, `pnpm test`, or
`node node_modules/tsx/dist/cli.mjs --test test/gateway-shadow.test.ts`.
Baseline: 95 PASS / 0 FAIL / 4 SKIP. Adapter: 32 PASS / 0 FAIL / 0 SKIP.
Full regression: 127 PASS / 0 FAIL / 4 SKIP. The same four PostgreSQL/Temporal
integration tests require `AGY_TEST_DATABASE_URL`/local Temporal fixtures and were
not run; there is no new claim of those integrations passing.
Changed-file signature secret scan passes. The full-repo scanner still flags one
unchanged parent file, `test/mission5-resume6-native.ts:18`; that finding is not
silently relabeled PASS or modified in this adapter change.

Hosted integration remains UNVERIFIED: the actual R11 connector/private listener,
worker private reachability and approved persistent journal mount were not tested
or provisioned. No merge, deployment, public publish, paid inference, DB writes,
credential changes or production changes were performed.
