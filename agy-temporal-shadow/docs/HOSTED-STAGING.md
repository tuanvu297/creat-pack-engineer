# Hosted staging continuation

Mission AGY-TEMPORAL-20261018. Default routing remains LEGACY. Existing PostgreSQL/AGY is domain authority; Temporal stores progression/history; Supabase is shadow only.

The dedicated control-plane service starts with `node dist/src/temporal/supervisor.js`. Hosted mode requires AGY_HOSTED_STAGING=true, AGY_STAGE_ONLY=true and AGY_ORCHESTRATION_MODE=TEMPORAL_SHADOW. Temporal must use an explicit private Railway hostname and port, namespace agy-staging. Public addresses are rejected. No hosted mode is inferred from Railway variables.

The gateway binds 0.0.0.0 at PORT, with strict numeric range validation. GET /health performs bounded PostgreSQL and Temporal namespace reads and requires a worker readiness message from the supervisor. Any dependency failure returns 503 and booleans only; connection strings, auth tokens and database errors are never returned. All gateway actions authenticate first, then enforce the existing project/action scope. Error responses are sanitized; responses are not cached.

The supervisor starts the Temporal Activities worker and gateway as separate children. Unexpected exit, including exit 0, terminates the sibling and exits with failure for Railway ON_FAILURE restart. Graceful SIGTERM stops both children. Worker readiness follows Worker.run() entering RUNNING. The control-plane processes require a restricted PostgreSQL role; they are not the R11 executor.

R11 runs separately under GATEWAY_SHADOW with its existing LEGACY orchestration-mode contract. DATABASE_URL and every SUPABASE_* name must be absent from its environment. Do not pass the control-plane environment to R11. Existing worker/daemon and recovery semantics are unchanged by this hosted HTTP preparation.

Storage: the staged 100 MB journal volume mounts at /data. It is not provisioned until deployment. Initialize a verified-empty new journal once through the offline init-journal command; never attach initialization to startup. One active writer only. Missing/corrupt state remains BLOCKED; accepted/UNCERTAIN historical work must never be replayed. The worker still requires operator verification before removing a stale lock; no automatic post-crash recovery is claimed.

Backend provisioning/deployment are blocked by automatic approval review until explicit resource-usage approval. On 19 October 2026 the account shows a Trial grant of USD 5, current bill USD 0 and incurred usage USD 0.0011. Trial credit does not prove zero resource cost. PostgreSQL template staging was rejected for nonzero usage under the mission's zero-spend constraint. No workaround was attempted. No template/backend was provisioned, no new domain or deployment created, and no hosted acceptance run occurred.

These source changes have focused local tests only. Source attachment and volume staging are configuration evidence, not hosted runtime, storage persistence, integrated staging or production PASS. On approval: provision only within the explicit usage ceiling, attach secret references and restricted roles, validate the final diff and pinned source, deploy, then use fresh acceptance IDs for all hosted gates. Preserve rollback to LEGACY and the older checkpoint until hosted evidence exists.
