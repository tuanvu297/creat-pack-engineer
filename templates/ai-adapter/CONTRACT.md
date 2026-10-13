# AI adapter starter

`python worker.py task.json --state <dedicated-journal-directory>`

Input: JSON with nonempty mission_id, task_id, idempotency_key (maximum 200
characters), positive integer attempt, and payload.text (maximum 100 KB UTF-8).
Output: JSON with identity, payload_sha256, provider, status and result.
Exit 0: DONE; exit 3: uncertain or rejected. No external callbacks are sent.

This runnable example counts local text. It is a transport contract starter,
not an implementation of Muse/OpenAI/Gemini. A provider implementation must
inject credentials outside the package, save the provider request ID before
polling, and expose status/reconciliation separately from submission.

PREPARED -> PENDING -> DONE. An incomplete journal or existing lock means
UNCERTAIN. Never resend based only on a timeout. Same mission/task plus changed
payload or key is a conflict; changing attempt does not bypass deduplication.
The journal contains receipt metadata and counts, not the raw text or auth.

The state directory must be private and exclusively managed by this worker.
OS locking is local-filesystem only; multi-host/network filesystems need a
transactional database. A stale lock requires operator reconciliation, not
automatic deletion. Duplicate requests return the saved receipt.
