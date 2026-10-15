# H4 bounded handling plan

- Scope: supplied synthetic text only; no external execution.
- Input: 17 records; maximum 4 records per batch.
- Partition deterministically into 5 batches: 4, 4, 4, 4, 1.
- `final_batch_size`: 1.
- Carry task identity, source version, acceptance IDs, checkpoint, idempotency key, bounded lease/retry, and callback target with the staged plan.
- If an operation outcome is missing, reconcile the same operation before any retry; do not create a replacement operation blindly.
- L1 self-check, L2 peer review, and L3 deterministic checks remain separate. No execution, publication, or pass claim is made.