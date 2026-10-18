# AGY durable runtime remediation

Checkpoint: CP-AGY-RUNTIME-TESTED-1. State: TESTED. PASS=false; INTEGRATED=false.

The implementation extends Worker Engine V2 with a continuously polling dispatcher,
independent worker lanes, fenced task leases, stale recovery, bounded exponential
retry, worker failover and project-scoped durable heartbeat/status records. It uses
the existing PostgreSQL queue, isolation, reservations and checkpoint store.

## Verified evidence and its scope

Full regression suite: 93 PASS, zero FAIL/SKIP. Real disposable PostgreSQL 17.11.
The process acceptance test launches the actual daemon entrypoint with scoped
NOLOGIN/NOBYPASSRLS test identities and a controlled HTTP provider. It proves caller
disconnect continuation, overlapping independent lanes, dependency isolation,
transient failure retry on another worker, queryable status, heartbeat expiry,
SIGKILL/restart recovery and zero duplicate provider submissions after recovery.

These are local process/runtime tests, not an actual closed-chat hosted test or
fresh Gemini/Muse/Codex provider execution. Synthetic schemas/roles are removed
after each test. No historical application data was removed.

## Starting on an existing approved staging host

Apply additive migration 008 once, after migrations 001–007, using the existing
staging migration process. Preserve a verified database backup. Refresh each
authorized project routing projection with a scoped project update after applying.
The runtime DB role needs SELECT/INSERT/UPDATE on agy_runtime_workers in addition
to existing grants. No credentials or permissions have been changed by this task.

Run `npm run worker:daemon` with the existing approved DATABASE_URL, scoped
AGY_IDENTITIES_JSON and existing worker tokens/connector secrets supplied by the
host's existing secret mechanism. Do not put credentials in Drive or source.

AGY_STAGE_ONLY=true is mandatory. AGY_RUNTIME_LANES_JSON is an array of:
`{"scope":{"tenantId":"...","workspaceId":"...","projectId":"..."},"workerTokenRef":"AGY_WORKER_TOKEN","connectorId":"..."}`.
Each workerTokenRef resolves an already configured, bound worker identity. Supply
all eligible project/worker bindings so project priority cannot await an unpolled
worker. The runtime never creates accounts, projects, worker approvals or secrets.

Defaults: poll 1 second, dispatcher heartbeat 5 seconds (stale after 15 seconds),
task lease 30 seconds, process concurrency 4. Registry locks are short allocation
transactions; execution holds task leases, not a project execution lock.
Task dependencies and explicit sharedStateKey remain authoritative. No automated
bulk change of live project registries has been performed.

Use the approved host's process supervisor with restart-on-failure and startup
activation. Service command: absolute node executable plus
`--import tsx /absolute/package/src/platform/daemon.ts`, package working directory.
Keep environment/secrets outside source control. A supervisor restart resumes the
same persisted provider operation. An INTENT without an acknowledged operation ID
blocks as SUBMISSION_UNCERTAIN rather than blindly repeating an external effect.

If the host only supports schedules, run this same entrypoint from its existing
approved scheduler. Allow only one scheduled process per configured binding or
rely on fenced task claims; preserve DB state across invocations. Forced timeout
will leave a lease, recovered after expiry and worker cooldown (up to 30 seconds).
This scheduled alternative has a wake-up gap equal to the scheduler interval;
it is not continuous. It has not been installed or tested on a hosted scheduler.

## Status and monitoring

Authenticated existing project API suffix: GET `/runtime/status`. Response includes
observedAt, dispatcherHealthy, worker heartbeat/expiry/health and task raw/status,
worker, attempt, dependency IDs, availability and external operation ID. Worker
heartbeats past expires_at report STALE. A stale running task is QUEUED pending
recovery, with raw_status preserved; QA awaiting evidence is BLOCKED for delivery.
Task transitions/submission intent/checkpoint changes are written atomically to
agy_task_events by migration 008; operation checkpoints and accounting remain in DB.

The generic /health endpoint retains its existing conservative staging response;
it is not evidence that a dispatcher has attached. Read scoped /runtime/status.
No deployed status URL or reachable hosted DB has been verified.

Evidence Watchdog automation `agy-runtime-evidence-watchdog` is ACTIVE in this
chat on a 15-minute cadence. It stays quiet for unchanged/non-actionable state.
Creation confirms the schedule, not a completed scheduled run. It depends on
desktop/app availability; it is not the hosted queue consumer.

## Worker Drive storage

Root: https://drive.google.com/drive/folders/1K97FCMYjp3itlYStW4uc7t6hVyeY5v0Y
Checkpoints: folder ID 1Dr5pqe6IHtmRrJYFAlc1xiXiphBQ2J7M
Evidence: folder ID 1HDfMOlwgXf5mgmjhyPE06e1eSD6sG9yP
Results: folder ID 1E7n6p_LGGVH0W6JBz868i9bh7y-4VKJO

Connected Assistant/worker sessions use the native Drive connector to upload into
these folders. Supply folder IDs and this contract in every worker handoff. File
names should contain TASK_ID, attempt/checkpoint version, worker and artifact kind.
Before retrying an uncertain upload, list/read the target and compare ID/hash;
retain history and never replace a different task's file. Record returned Drive
file IDs in the task ledger. A result requires QA evidence; saving it is not PASS.

Keep secrets, account tokens and private credentials out of all artifacts. No
sharing or security changes were made. A standalone daemon still needs an existing
authorized Drive connector/writer before automatic DB-to-Drive mirroring can be
claimed. The folders alone do not establish that access. DB is the atomic runtime
ledger; Drive checkpoints are a timestamped cross-device mirror, not live heartbeat.

## Guardrails and remaining integration gates

The automatic daemon rejects OpenAI paid/Expert adapters and rejects dispatch with
nonzero/unknown estimated cost, unapproved permissions/safety, HIGH risk, Expert
role or permissions beyond read/analyze/planning/QA. Publishing, hard deletion,
security/credential changes and ChatGPT-Expert invocation remain excluded.

GL AI bridge health currently reports no supported AGY dispatch endpoint and Muse
execution is read-only. LUME health reports READY but does not prove no-cost worker
dispatch or integration into this queue. Existing GL Agency Control Site is active
with no linked schedule. Its connector tools can create/track briefs, but that
does not attach this PostgreSQL runtime. Sites deployments are production and were
not performed under the user's no-publish requirement.

Before PASS: select an already approved zero-new-spend staging host/DB, attach
approved native connector executors (Muse only after an actual supported write
route exists), verify background execution after the real chat closes, read status
cross-device, restart supervised runtime, and verify automatic evidence mirroring.
Then, and only then, advance TESTED→PASS→INTEGRATED in the canonical Drive chain.

Canonical Docs were edited through fresh native reads with revision-fenced append
and readback. The skill's checked-in file read bridge assumes POSIX absolute paths;
this Windows session used the supported direct-connector fallback. No controls,
historical content, tab topology or existing ranges were edited.
