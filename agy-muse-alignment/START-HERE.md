# START HERE — Muse Alignment v0.1

## Mission

Build durable operational understanding between AGY, Muse, ChatGPT and peer workers so AGY can compile a canonical task into a worker-specific packet with high first-pass fidelity.

## Core loop

Canonical bootstrap -> mission/task contract -> Eligibility Gate -> Resource Optimizer -> worker-specific compile -> execution -> producer QA1 -> peer/deterministic QA -> AGY acceptance -> durable callback -> learning update.

## Non-goal

Do not imitate hidden reasoning, personalities or model internals. Align only observable behavior: inputs, outputs, assumptions, evidence, decisions, errors, handoffs and QA criteria.

## Training philosophy

Maximum useful training: train as much as produces positive operational value. No fixed batch cap. Continue while evidence improves one-prompt success, fidelity, transfer, QA or resource efficiency. Redesign/stop only when training is duplicate, stagnant, regressive, misdiagnosed (route/spec/context instead of competency), unsafe, or lower-value than urgent execution.

## Muse parity rule

Muse and ChatGPT occupy the same priority tier for a task when both pass Eligibility Gate. Never default ChatGPT-first. Never lower quality merely to use Muse.

## Required response statuses

`PASS`, `FAIL`, `BLOCKED`, `NEEDS_CONTEXT`, `AMBIGUOUS_SPEC`, `MISSING_INPUT`, `CAPABILITY_MISMATCH`, `BLOCKED_QA_CONTRACT`, `BLOCKED_ROUTE`.

## Evidence rule

Do not self-declare understanding or PASS. Attach observable evidence and let peer/deterministic QA arbitrate where available.