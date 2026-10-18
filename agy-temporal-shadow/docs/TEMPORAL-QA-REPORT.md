# AGY Temporal integration — Codex QA1 report

Superseded for current mission status by [staging slice 2 report](TEMPORAL-STAGING-SLICE2.md), checkpoint CP-AGY-TEMPORAL-STAGING-20261018-02. Historical findings and counts below retain their original scope.

Mission: AGY-TEMPORAL-20261018. Date: 2026-10-18, Asia/Saigon. Executor/author: CODEX-ENGINEERING. Status: **LOCAL_SHADOW_IMPLEMENTED; INTEGRATED_STAGING_UNVERIFIED**. Originating controller/QA: conversation `6acdf9e5-0718-83ec-a843-0646519e307b` (“Thiết lập quy trình đóng gói”). No production PASS or cutover is claimed.

## Outcome and pass ladder

| Gate | Result | Evidence boundary |
| --- | --- | --- |
| BASELINE_PASS | PASS after source-package repair | 95/95, PostgreSQL included; initial missing-file failure preserved |
| TEMPORAL_BOOTSTRAP_PASS | PASS, local | Official SDK 1.24.0, CLI 1.9.1, Server 1.32.0; actual local service |
| MIN_WORKFLOW_PASS | PASS, synthetic | START/load/dispatch/ACK/result/QA/complete/block/correction/reconcile |
| ACTIVITY_ADAPTER_PASS | PASS, synthetic only | Existing PostgresStore functions reused; native provider attachment UNVERIFIED |
| POSTGRES_BRIDGE_PASS | PASS, local scoped runtime | Additive 009, NOSUPERUSER/NOBYPASSRLS role, scoped tables, same job/task/operation references |
| DURABILITY_TEST_PASS | PASS, controlled local | Actual worker SIGKILL, expired-lease reconciliation/new fence, caller disconnect, SDK replay, actual server SIGKILL and persistent restart |
| WORK_QA_ONLY_COMPAT_PASS | PASS, controlled contract | Self-QA/premature/missing evidence rejection, FAIL instruction and executor redispatch, no Work fallback |
| SHADOW_MODE_PASS | PASS, bounded synthetic | LEGACY default, same supplied integer compared with existing WorkerEngine; no live parallel provider dispatch |
| INTEGRATED_STAGING_PASS | UNVERIFIED | Native executor binding, Chat/Work surface and independent controller QA still missing |

The lower gates describe technical controlled tests. They do not imply a deployed production or native worker lane. Test reviewer identities represent authenticated fixture principals, not an independent human/AI review of this code. This report is producer QA1 plus deterministic evidence; originating controller QA remains pending.

## Baseline and post-change checks

- Canonical TESTED-2 ZIP SHA-256: `CECE24208982EDA501E006479C5E7C1829672B8A0B5B787C57DBA30A3533E843`; migrations 001–008; package runtime version 1.0.0. Node v24.19.0; PostgreSQL portable 17.11; Windows host.
- Original source import Git commit: `4ff9c5e67aa5f64b01a7d5fad55f51d4cc58956d`. New branch: `codex/agy-temporal-shadow-20261018`. No upstream runtime Git commit existed in the canonical ZIP; the import commit is explicitly local provenance.
- First baseline: typecheck PASS; 94 PASS / 1 FAIL / 0 SKIP. Failure: archive omitted `rollback/007_runtime_capability_projection.sql`, required by the platform integration test.
- Recovered original rollback file from the preserved local Mission5 source, hash `79A04E27778215F82921F3E69B022B6E166E78F883089A913F75467A5F4631FF`. Repaired baseline: **95 PASS / 0 FAIL / 0 SKIP**. No test was weakened or skipped.
- First Temporal run: 7 PASS / 2 FAIL (9 includes parent). Actual crash caused Activity redelivery after domain lease expiry. Negative evidence retained. Corrected by explicit operation reconciliation and a new fenced claim, preserving provider/submission attempt.
- Final full suite: **104 PASS / 0 FAIL / 0 SKIP**, including historical PostgreSQL and process tests plus 9 Temporal checks. Final typecheck PASS. `git diff --check` PASS (line-ending notices are informational).
- Additional standalone actual Temporal server SIGKILL/restart probe: **TEMPORAL_SERVER_RESTART_PASS**. Same workflow run restored from its persistent SQLite file; one synthetic side effect; PostgreSQL COMPLETE. The test's own child processes are stopped afterward.
- Secret signature scan covered all 100 source files at scan time and reported one reviewed false positive: `test/mission5-resume6-native.ts:18` is an environment-variable lookup assigned to a variable named `secret`; it contains no credential literal. Raw scanner output is retained rather than relabeled as an unqualified PASS. Release inventory is screened for auth/state files and private key/token signatures. Scanner coverage is bounded; no secret-store/auth files, database files, binary SDK/CLI or local credentials are packaged.

## Changes and rationale

| Exact path | Purpose |
| --- | --- |
| `src/temporal/contracts.ts` | Versioned mission, activity, binding, receipt and QA types; submission attempt distinct from lease claim attempt |
| `src/temporal/workflow.ts` | Deterministic orchestration, ACK deadline, polling, QA signal, correction limit, reconciliation and safe stop |
| `src/temporal/bridge.ts` | Scoped domain bridge, payload hashes, submission intent/ACK/evidence receipts, new-fence lease recovery, QA/callback ledger |
| `src/temporal/gateway.ts` | Entrypoint-independent authenticated action contract and canonical-vs-progress status separation |
| `src/temporal/server.ts` | Loopback HTTP gateway with existing scoped identity authentication, request bound and safe error mapping |
| `src/temporal/worker.ts` | Long-running official SDK worker; denies superuser/RLS bypass; separate shadow entrypoint |
| `src/temporal/config.ts` | LEGACY default; only local synthetic staging mode allowed |
| `migrations/009_temporal_shadow.sql` | Additive missions, immutable receipts and synthetic-operation tables, project RLS; no old history changes |
| `test/temporal-shadow.integration.test.ts` | Real Temporal/PG/process/gateway/QA/replay/idempotency tests A–I |
| `test/temporal-server-restart.ts` | Additional actual Temporal service persistent-restart acceptance probe |
| `config/temporal.env.example` | Isolated local configuration; no credentials |
| `examples/temporal-shadow-mission.json` | Bounded machine-callable example |
| `docs/TEMPORAL-ARCHITECTURE.md` | Diagram, authority, sources, scope and failure policy |
| `docs/TEMPORAL-RUNBOOK.md` | Bootstrap, API use, test prerequisites, rollback without history deletion |
| `docs/TEMPORAL-QA-REPORT.md` | This QA1 report, gates and limitations |
| `docs/TEMPORAL-LEARNING.md` | Evidence-backed engineering lessons, local candidate only |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Official pinned SDK, build/worker/gateway scripts and bounded install script allowlist |
| `rollback/007_runtime_capability_projection.sql` | Recover missing original baseline file, no rewritten migration behavior |
| `VERSION` | Snapshot release label 0.1.0-shadow; inherited package runtime version remains 1.0.0 |

`.gitignore` is import hygiene (node_modules/dist/auth/runtime evidence excluded). Existing runtime source and migrations 001–008 are unchanged. Historical runner scripts are retained as source reference and were not invoked against paid providers. The source ZIP and Git bundle preserve baseline provenance; generated evidence is packaged separately.

## Unresolved acceptance findings

| Finding | Truth / severity | Required next gate |
| --- | --- | --- |
| Native Temporal executor attachment absent | OBSERVED / S2 | Implement and verify a currently callable authorized worker adapter. Current daemon pilot is explicitly fixed-task/read-only; current synthetic Activities reject other executor IDs. Do not infer native ACK from this Codex engineering session. |
| Chat/Work reachability of localhost gateway | UNVERIFIED / S2 | Bind an approved server/API/MCP transport; prove authenticated dispatch, worker ACK, callback and controller ingestion from the actual surface. HTTP loopback test is not this proof. |
| Independent code/mission acceptance QA | UNVERIFIED / S2 | Originating controller reads the durable source/test evidence and records its own findings/verdict. Codex QA1 is not peer acceptance. |
| Managed staging/always-on uptime | UNVERIFIED / S2 | Existing approved host/DB/worker attachment and real closed-chat continuity. No cloud credential/config was established here; no purchase is needed for the local result. |
| Production routing | OUT OF SCOPE | Separate explicit owner cutover decision after staging acceptance; no production PASS. |

No direct inference call, paid purchase, public publication, hard-delete of user data, secret exposure, native provider task replay or global canon/skill promotion occurred. Existing synced `sources/` and project role files were not modified. Dedicated local test stores are retained for inspection; runtime callbacks clearly mark native-chat ingestion UNVERIFIED.

Resume this same mission from the current code and receipts. Do not restart the completed baseline/shadow implementation or resubmit accepted operations. The controller can inspect the private GitHub branch/PR and Drive checkpoint/evidence without the owner using the execution chat. See release receipt for exact final commit and artifact IDs/hashes.
