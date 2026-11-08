---
name: muse-runtime-handoff
description: "Prepare and reconcile AGY task-scoped Muse jobs, permissions, evidence receipts and callbacks. Use for worker handoff and recovery; it does not grant connectors or replace the canonical runtime."
---

# Runtime handoff

Read ../../knowledge/00-operating-contract.md and ../../knowledge/05-runtime-and-permissions.md. Match tenant/workspace/project/controller/task/attempt/idempotency, worker, executor and reply destination before action. Never accept self-reported worker identity as authentication.

Inventory tools from the actual Muse session. ChatGPT's plugins are not automatically Muse's plugins. Use provider-owned OAuth/consent or secret references; never copy cookies/API keys into prompts, repo, screenshots or receipts. Ask the owner to perform a new Connect/Install as required by the project.

Save durable intent before submission. A timeout after submission may mean accepted work: query/reconcile the same operation and do not issue a replacement. Retry only definite terminal failure with provider deduplication support and current cost authority; max two retries, no retry for absent auth/route.

Receipts must preserve source/input/model/reference IDs, actual operation/output IDs, artifact hash/location, QA/time/cost evidence, blocker and next safe step. A queued job, callback delivery or schema-valid JSON is not artifact acceptance. Retain QA and callback delivery/acceptance as separate states. For no-ChatGPT routine execution, qualify independent QA and disconnect/recovery behavior first.

