# AGY auto-dispatch — bounded local bridge 0.1.1

Owner control chat submits a structured mission with the existing GitHub connector. A detached host daemon independently polls that durable inbox, validates a pre-authorized exact payload, claims a SQLite mission and invokes Codex app-server. Existing Work remains the monitoring surface; the model runs in ephemeral contexts, not newly stored Works.

## Architecture actually implemented

Control chat → GitHub issue #2 AGY_MISSION_V1 envelope → connector-only app-server context → SQLite queue → persistent logical worker → isolated app-server model context → GitHub callback readback → independent AGY review → trusted native-chat readback confirmation.

The installed desktop owns the existing primary thread writer. The standalone daemon does not steal that lock, resume unrelated missions, edit native Codex DBs or pretend to activate the exact desktop thread. Stable binding is AGY-PRIMARY-PERSISTENT + external journal + current PID/instance + primary monitor thread ID. Ephemeral model context IDs may change after restart; uncertain work is never resubmitted automatically.

The control context uses existing authenticated connectors without copying tokens. The model context disables apps, configured MCP servers, plugin MCP servers and web search, uses read-only sandbox and no environments. Startup verifies zero worker connector tools. The pilot supports one nonce/arithmetic task only; arbitrary coding missions require separate explicit authorization and implementation.

## Runtime and start

- Python >=3.11, standard library only; sqlite3, tomllib, threading, subprocess.
- Existing signed-in Codex app-server, tested version recorded in evidence.
- Existing GitHub connector permission for tuanvu297/creat-pack-engineer.
- Private state/config outside package. Host signing key, DB, grants and auth files are never packaged.

Copy config/runtime.example.json to a private external state directory and register the exact owner-approved payload hash and expiry. Example config is intentionally expired and cannot run.

Start a detached local process:

    powershell -File scripts/start.ps1 -State D:/Codex/agy-auto-dispatch-state/live -Config D:/Codex/agy-auto-dispatch-state/runtime.json -Python ABSOLUTE_PYTHON_PATH

Inspect http://127.0.0.1:8788/status or the external status.json. It distinguishes QUEUED, CLAIMED, ACKED, RUNNING, CHECKPOINT, CALLBACK_DELIVERED, AGY_REVIEW_REPORTED, AGY_ACCEPTED, BLOCKED, STALE and UNCERTAIN. A process-start receipt is not a mission ACK.

The process survives closing the engineering turn. No boot/logon service, Windows service, remote listener or scheduled notification has been installed. Computer shutdown ends the process; scripts/restart.ps1 deliberately restarts with the retained journal. Managed app-server daemon socket was unavailable; supported stdio transport is used. This is a bounded pilot, not a production rollout.

## Control-plane contract

External submit: existing GitHub add_comment_to_issue, repo tuanvu297/creat-pack-engineer, issue2, body AGY_MISSION_V1 followed by newline + strict JSON matching the private registered mission exactly. Duplicate same-payload submissions are cached; conflict/unknown author/schema/expiry is denied.

An optional bounded owner-UX recipe can register exactly one additional fixed mission identity, scope, callback and task class while allowing control chat to compile nonce/a/b from a fresh Owner AGY RUN. It cannot change identity, execute shell/code, expand worker scopes or create arbitrary future missions. Control publisher must be the configured authenticated owner account; actual human input is still separately verified in native chat rather than inferred from owner_scope_ref. This permits the final Owner-only UX probe without Engineer preparing the exact payload or resending a previously accepted task.

Status: read-only localhost endpoint, status.json or bin/agy_queue.py --state STATE status. Worker-only host operations in src/queue_store.py: claim, ack, heartbeat, checkpoint, complete, fail. They are not untrusted caller-issued authority. Grant is HMAC-signed, registered locally, binds identity/instance, TTL45s and owner expiry; renewal fences the old grant. Missing ACK prevents PLAN; stale heartbeat15s or expired grant becomes STALE. Watcher runs independently every second. Lease heartbeat means actual worker liveness while waiting, not fabricated model progress.

Callback: authenticated GitHub issue comment AGY_CALLBACK_V1 is an outbox receipt until exact GET readback succeeds. It is delivered to the durable control-plane inbox; native control-chat ingestion is a separate evidence gate. AGY_ACCEPTANCE_V1 needs QA v1.1, AC01–AC10, callback/result binding and evidence IDs; it first becomes AGY_REVIEW_REPORTED. AGY_ACCEPTED additionally requires actual independent control-chat readback recorded by the trusted host verifier. The daemon does not manufacture that native-chat receipt. The autonomous long-term native receipt-verifier attachment remains a separate limitation; bounded engineering can verify it through the available native read_thread tool.

## Recovery / rollback

Intent is persisted before turn/start or callback POST. Pending/uncertain intent cannot be blindly retried. Restart marks in-flight work UNCERTAIN. For a verified result with uncertain callback, the daemon only GET-reconciles the exact immutable persisted callback payload; unique authenticated match can recover delivery, zero/ambiguous matches stay uncertain and never POST again. Accepted work and known callback delivery survive restart. Legacy intent schema is migrated without dropping journal rows; unknown historic payload stays null/unverified.

Safe stop:

    python bin/agy_queue.py --state STATE stop

No force-kill or hard-delete. Uninstall means stop, retain state/evidence for reconciliation and remove only any user-created launch mechanism separately. Global Codex config, auth, synced sources and existing AGY runtime remain unchanged. No automatic boot installation was performed.

## QA and limits

Run python -B -m unittest discover -s tests -v. Tests cover races, migration, fencing, stale, expired preflight, uncertain replay, callback reconciliation and independent receipt gates. Local tests do not establish live execution, unattended uptime, owner UX or full AGY acceptance. Check release receipt/evidence for each separate PASS level.

Evidence assumes trusted local host/account; HMAC is not a hostile same-user sandbox. GitHub connector comments use the same account across agents, so native independent reviewer readback is required before final acceptance. Tool discovery, durable handoff, execution, callback delivery and acceptance remain separate. Monetary cost is UNKNOWN; only the signed-in included route and observed usage limits are used. No paid API key, purchase/top-up, production deployment or global skill promotion.
