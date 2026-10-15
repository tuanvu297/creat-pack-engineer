# Muse Alignment Eval Protocol v0.1

## Gate order

1. CONTRACT_ACK
2. TASK_EXECUTION_OR_VALID_BLOCKER
3. QA1_COMPLETENESS
4. PEER_QA
5. DETERMINISTIC_CHECK where available
6. UNSEEN_TRANSFER
7. LEARNING_UPDATE

## Metrics

Each eval records:
- one_prompt_success: 0/1
- instruction_fidelity: 0..1
- task_accuracy: 0..1
- evidence_completeness: 0..1
- handoff_completeness: 0..1
- qa_accuracy: 0..1
- false_pass: 0/1
- false_fail: 0/1
- missed_critical: 0/1
- clarification_count
- retry_count
- rework_count
- latency_ms if observable
- cost/quota impact if verifiable else UNKNOWN

## Promotion rules

No global promotion from a single successful case. Critical false PASS / S3 miss must be 0. Improvement should hold on unseen cases and not regress previously passed gold cases. If tool/route is unavailable, mark route blocker and do not score it as competency failure.

## One-prompt maturity bands

- M0: contract not reliably understood
- M1: guided execution; frequent clarification
- M2: first-pass success on known task classes
- M3: first-pass success on unseen transfer + reliable handoff/QA
- M4: high first-pass success across validated classes; AGY packet compiler is stable and low-rework

M4 is operational maturity, not model equivalence to ChatGPT.