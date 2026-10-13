# Software engineering

Identify real user workflow, source version, runtime, preserved interfaces,
allowed changes and measurable acceptance before coding. For broad objectives,
build a bounded working slice and record assumptions instead of inventing scope.
Choose architecture from offline/hosting, privacy, latency, provider access,
testability and maintenance constraints. Keep provider adapters separate from
domain logic; validate input/output/error contracts.

Give AI source snapshots, allowed files, expected/prohibited behavior, checks
and evidence requirements. Inspect generated code/dependencies; model claims
of tests, filesystem access and provider ACK require actual verification.
Debug from a reproducible failure and distinguish spec, tool and code defects.
Correct the cause, then run relevant regression. Preserve data/interfaces.

Test meaningful boundary behavior, state transitions, idempotency, recovery and
integration. Record environment/check results. Avoid cosmetic tests that only
match implementation wording. One local PASS is not cross-platform proof.
Deliver a reviewed diff, dependency/runtime versions, documented entrypoint,
examples, test evidence and limitations, then follow the release contract.
