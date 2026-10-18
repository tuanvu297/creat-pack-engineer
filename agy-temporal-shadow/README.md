# AGY Temporal shadow — 0.1.0-shadow

Codex-authored isolated snapshot of canonical AGY runtime TESTED-2 with an additive Temporal orchestration slice. Local synthetic staging is implemented and tested; native executor, Chat/Work surface and independent controller acceptance remain UNVERIFIED. No production routing was changed.

Read [QA report](docs/TEMPORAL-QA-REPORT.md), [architecture and diagram](docs/TEMPORAL-ARCHITECTURE.md), and [run/rollback instructions](docs/TEMPORAL-RUNBOOK.md).

Baseline: 95/95 tests after recovery of the original missing rollback file. Final full suite: 104/104, no skips, plus separate real Temporal service persistent-restart PASS. Evidence is delivered separately with the same release receipt and source manifest. The inherited `package.json` version 1.0.0 is preserved; snapshot `VERSION` is 0.1.0-shadow.

Use Node 20+ and the official SDK dependencies in the lockfile. Start the existing AGY entrypoint normally for LEGACY routing. The separate Temporal worker/gateway require explicit local SHADOW config and an isolated staging project. No credentials are included. This is not a native provider or production certification.
