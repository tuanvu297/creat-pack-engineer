# Temporal staging slice 2 — producer QA1

Mission AGY-TEMPORAL-20261018. Supersedes CP-AGY-TEMPORAL-SHADOW-20261018-01 for this mission only. New checkpoint CP-AGY-TEMPORAL-STAGING-20261018-02. Date 2026-10-18, Asia/Saigon. Executor: Codex engineering; originating Chat/Work remains controller and independent QA. Production is not authorized. Default routing remains LEGACY.

## Verified outcome

| Gate | Status | Boundary |
| --- | --- | --- |
| EVENT_DRIVEN_PASS | PASS | Actual local Temporal and PostgreSQL; one result-wait Activity, result/QA deadline timers only; worker crash recovery |
| NATIVE_EXECUTOR_ACK_PASS | PASS | One fixed native Codex command lane, no model inference; actual command PID, ACK/checkpoint, compiler result and artifact |
| CALLBACK_RECEIPT_PASS | PASS | RESULT_READY receipt in canonical PostgreSQL for the isolated local staging scope; exact readback after restart and authenticated HTTP |
| HOSTED_RUNTIME_PASS | BLOCKED | Railway project list empty; confirmed Render workspace returned null services and no PostgreSQL instances; no existing approved host attachment discovered |
| UNIVERSAL_GATEWAY_PASS | BLOCKED | Required API actions implemented and local transport verified; no callable originating Chat/Work gateway binding exposed |
| CROSS_ENTRYPOINT_CONTINUATION_PASS | BLOCKED | Local connection/process restart proof exists; actual supported Chat/Work entrypoint pair absent |
| INTEGRATED_STAGING_PASS | BLOCKED | Hosted/surface/cross-entrypoint gates and independent controller acceptance missing |

Native chat ingestion remains UNVERIFIED. A Drive read, this engineering chat, a localhost request, and a native command invocation do not establish originating-chat gateway ingestion. There is no conversational auto-callback claim.

## Implementation and authority

New histories use the version patch `agy-event-driven-v2`; old histories retain the original deterministic path. A long-running result Activity waits on PostgreSQL LISTEN/NOTIFY, rereads canonical state after subscribing/retry and uses runtime wakeups for lease/health and synthetic fixture readiness. Workflow conditions wait for result completion, QA/reconcile/stop signals and deadlines. No 500 ms result/QA polling is scheduled into new Workflow histories. Notification loss does not become lost domain state. PostgreSQL owns task, lease, attempt, ACK, result, QA and callback truth; Temporal owns progression/history.

The native allowlist is restricted to this mission and fixed source/gateway verification commands. There is no caller argv, URL, arbitrary shell, automatic native correction, model turn, Work fallback or paid inference. The actual Codex app-server command runs in workspace-write sandbox with networking disabled. Windows uses its supported buffered command route. ACK/checkpoint events in stdout are observable by AGY when the buffered command completes, not streamed live. Runtime maintains the task lease independently while the command runs.

Native proof: operation `41be194b-228c-4b28-9472-9e9203f69728`; worker `CODEX_ENGINEERING_COMMAND`; command PID 21672; task `AGY-TEMPORAL-NATIVE-GATEWAY-CONTRACT-SLICE2-R2`; workflow `agy-shadow-968fc96b91ab9c3cdb7495303a7f7d9a148e9428c0cff417b90c83bbbc32acba`; run `01a14e5a-a0ba-7745-992d-4fff8adbcccb`. The command compiled the source through the TypeScript compiler API and produced a hashed source/action manifest. Artifact SHA-256 `56a914b4b52cae6d9b608381a6f54071f6d27fa475486bfb62174f1731e23eb7`. This qualifies the bounded command lane, not general model-driven software execution.

Additive migration 010 records native intent/request ID before launch. A duplicate intent returns UNCERTAIN and reconciles; it never launches again. Native ACK and checkpoint are validated against the persisted operation. Immutable result files can reconcile a lost command response without command resubmission. Migration 009 and all historical records are retained. Project scope/RLS and non-superuser checks remain enforced.

Callbacks are emitted at RESULT_READY with QA PENDING, separately from terminal completion. Receipts include mission/task/attempt/idempotency, executor, workflow/run, result/evidence refs, QA state, callback state, state version and timestamp. The native mission is WAIT_QA; it has not been approved by this executor. Self-QA is rejected. Existing terminal-callback tests select the terminal receipt explicitly now that result-ready receipts coexist.

Gateway actions: bootstrap/current_state, dispatch, task_status/get_run, active_missions, reconcile, submit_qa, callback_status and safe stop. All retain scoped authentication. Bootstrap includes mission rows; callback_status reads PostgreSQL without requiring a live worker. The server still binds loopback. No public ingress, deployment, new service or credential change was made.

## Validation and negative evidence

- Native slice acceptance PASS: real command/artifact, PostgreSQL receipt readback, caller connection closed, both worker and Temporal SIGKILL/restart, same run/operation, exactly one accepted native gateway-contract operation, QA still PENDING.
- Event-driven history: load, dispatch, ACK and one result-wait Activity; zero heartbeat/result-poll Activities. Two deadline timers (result 60s, QA 10s) in the fresh regression fixture. Worker restart recovered one synthetic operation with a new lease fence.
- Related regression: 12 PASS, 0 FAIL, 0 SKIP; includes duplicate/conflicting keys, uncertain reconcile/no-blind-retry, unavailable executor/no Work fallback, correction/QA boundaries, official SDK history replay (no Activity side effects), rollback and scoped HTTP. These used new fixture IDs; no completed historical operation was dispatched again. The inherited 104/104 full-suite evidence is historical and was not relabeled as a new full baseline run.
- Additional HTTP readback: 401 without auth, 403 for wrong project, and byte-equivalent callback payload through authenticated local API after process restart. Explicitly not native Chat or cross-entrypoint acceptance.
- Typecheck/build PASS. Three additional native-contract tests are part of the 12-test regression. Secret scan and manifest/hashes are delivered separately with exact coverage.
- Initial harness used incorrect sample database roles; cluster metadata identified the retained `agy_test_admin` role. No cluster was reinitialized. A missing derived dispatch-table permission was restored only inside the new isolated test schema, matching the original test contract.
- Streaming route preflight returns RPC -32600: `streaming command/exec is not supported with windows sandbox`. The first adapter did not retain its original RPC response, so operation `1197b204-16ba-4660-9dff-233b1eefe821` remains UNCERTAIN and is not retried. Its workflow is BLOCKED; no native ACK/result exists. Later preflight evidence does not retrospectively prove its original outcome.
- Buffered gateway task R1 received a retained RPC -32600 before command execution: `custom outputBytesCap is not supported with windows sandbox`. That operation `9009531b-1daf-4d41-bbb0-4018c44ac0c0` remains BLOCKED_ROUTE. R2 changed the request materially by removing unsupported parameters and used a distinct task/idempotency key. Only R2 has a native command ACK/result. Negative records were not deleted or relabeled.

## Resume without replay

Read the checkpoint, source manifest and `evidence/slice2/` receipts first. Restore the same retained PostgreSQL schema and Temporal SQLite/namespace/task queue. Do not rerun `test/temporal-staging-slice2.ts` as a production launcher: it is a local acceptance harness with fresh synthetic regression identities and a fixed idempotent native task. `test/temporal-slice2-http-readback.ts` and `test/temporal-slice2-reconcile.ts` only read existing native mission state. Keep accepted native operation IDs and leave the first uncertain operation untouched pending authoritative reconciliation. Workflow deadlines remain bounded; pending QA can time out after the runtime resumes.

Next required attachment is an existing authorized zero-new-spend host with PostgreSQL/Temporal and a supported authenticated gateway transport exposed to the originating Chat/Work surfaces. No such host or ingress was found. Configuration currently rejects remote Temporal addresses intentionally; a future verified host attachment requires a scoped configuration change and transport verification. Do not remove that guard as a substitute for hosting evidence. Independent controller/peer QA is still required before integrated staging acceptance. Local test services are stopped after evidence capture; retained stores survive restart, but always-on availability is not claimed.

Rollback: stop assigning new shadow work and use unchanged LEGACY entrypoints. Retain migrations 009/010, callbacks, intent/operation IDs and workflow history. Do not re-route accepted or uncertain native operations into legacy as fresh work. No production PASS or cutover.

Official protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Temporal Activities and heartbeats](https://docs.temporal.io/encyclopedia/detecting-activity-failures). Installed Codex-generated JSON schema and actual Windows responses were used to verify the local protocol differences.
