# H4 Handling Plan (supplied-text planning only)

- Input: 17 records, at most 4 per batch.
- Batches: 5 → sizes 4, 4, 4, 4, 1 (final_batch_size = 1).
- Idempotency: per-batch key `TEST-INTEROP-COMPILED-01:batchN`.
- On failure: reconcile same op and key; no blind re-create.
- No external execution; staging artifact only.
- Callback with checkpoint INTEROP-A1 after plan handoff.