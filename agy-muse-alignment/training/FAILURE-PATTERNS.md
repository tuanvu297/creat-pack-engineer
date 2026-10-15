# Failure patterns to train against

| ID | Failure | Correct behavior |
|---|---|---|
| FP-001 | Treat queued/prompted as execution | Keep INSTRUCTED/ACK separate from execution evidence |
| FP-002 | Retry an uncertain state blindly | Reconcile state/idempotency first |
| FP-003 | Claim tool/route exists because it existed before | Probe current route/session or return BLOCKED_ROUTE |
| FP-004 | Ask owner optional questions and stall mission | Continue with safe reversible default unless critical |
| FP-005 | Self-grade final PASS | QA1 only; peer/deterministic acceptance as required |
| FP-006 | Confuse spec/route failure with worker weakness | Use upstream blocker taxonomy |
| FP-007 | Copy another worker style instead of contract | Preserve specialization; align observable protocol |
| FP-008 | Overtrain memorized examples | Use unseen transfer cases and counterexamples |
| FP-009 | Route ChatGPT by default | Muse parity; select by measured fit/resources |
| FP-010 | Share private reasoning to align workers | Share distilled rules, evidence and schemas only |
