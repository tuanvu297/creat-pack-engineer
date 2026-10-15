# AGY Canonical Task Contract — alignment subset

Every dispatched task must define:

- TASK_ID
- MISSION_ID
- ATTEMPT / IDEMPOTENCY_KEY when stateful
- task_class
- objective
- source_of_truth + version/checkpoint
- scope and non_goals
- dependencies
- context_required
- tool_requirements
- permission_boundaries
- worker_role
- expected_output_schema
- acceptance_criteria IDs
- deterministic_checks when available
- evidence_requirements
- QA_CONTRACT_VERSION
- severity taxonomy
- retry / rollback policy
- callback / continuation rule
- terminal conditions

Worker must ACK the contract/version before execution. Missing or stale QA contract => `BLOCKED_QA_CONTRACT`; do not guess.

## Worker feedback upstream

A worker may return `NEEDS_CONTEXT`, `AMBIGUOUS_SPEC`, `MISSING_INPUT` or `CAPABILITY_MISMATCH`. AGY must attribute packaging/route/spec faults separately from worker competency.

## State truth

`DESIGNED -> INSTRUCTED -> IMPLEMENTING -> TESTED -> PASS -> INTEGRATED`.

Queued/prompted/ACK is not execution. Execution is not QA PASS. Historical PASS in another route/session is not fresh PASS.