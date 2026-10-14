# AGY-DISPATCH-GAP-001: lifecycle guard contract

Journal implements grant→actual dispatch receipt→bound ACK→PLAN→ordered checkpoints.
ack_dispatch requires host-controller receipt `RECEIVED_BY_EXECUTOR` and executor ID.
Queued/spec-created receipt cannot ACK. It cannot itself manufacture a native Work
activation binding: the trusted controller must supply the actual host receipt.
Current pilot entry is the owner's direct AGY RUN in the existing AI master.

ACK includes task, worker, attempt, idempotency, grant/lease ID, timestamp, callback
and executor thread. heartbeat comes from actual executor activity. dispatch_status
returns BLOCKED without ACK, STALE after 90s without activity or on expired/revoked
grant. It never fabricates heartbeats from a timer unrelated to worker progress.
Caller/controller should poll this status and surface it on its tracker. The kit
does not install a background schedule or infer host activity from a GitHub issue.

checkpoint validates actual evidence_id, status, ordered prior PASS and fresh ACK/
heartbeat. Missing evidence or skipped stage is denied. Final PASS additionally
requires a target-matched delivery receipt and independent AGY acceptance. A bounded
FAIL/BLOCKED closure may be recorded without pretending all prior phases passed.

Callback outbox = durable payload, not delivered. The real transport needs to send
the payload once to the owner-designated existing chat and persist its result. A
queue/accepted-send receipt and message readback/AGY acceptance are distinct gates.
Do not resend by timeout. Reconcile cached destination state before any retry.

Remaining native activation gate: trusted host API/MCP capable of activating the
existing Work, dispatch receipt from that actual call, then real ACK/progress and
separate AGY QA. Local guard tests/direct owner activation must not close this broader
defect as autonomous dispatch PASS. Preserve issue #2 open/partial until proven.

Source APIs Journal.ack_dispatch / heartbeat / dispatch_status / checkpoint /
delivery / acceptance are host-controller APIs. Only read-only dispatch_status is
exposed through MCP. Controller signature key is private host state. This is a local
trusted-host boundary, not privilege separation against a malicious same-OS-user.
