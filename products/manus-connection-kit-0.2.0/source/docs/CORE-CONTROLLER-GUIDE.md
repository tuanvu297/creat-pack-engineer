# Preserved 0.1.1 controller and MCP interface

These are procedural examples for the original engine, retained unchanged by
0.2 packaging. They are not evidence of current provider authentication, a
live task, independent acceptance or callback delivery. Use real absolute paths
in place of ALL_CAPITAL placeholders and quote them as required by your shell.
Never put an API key in command arguments. A fresh owner-authorized grant is
required for live task mutations; package installation alone does not grant it.

## Local checks and owner auth boundary

```text
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" self-test
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" auth-health
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" credits
```

The installer reports the active kit path as current/ and its separate private
state path. Preserve that same state for every command; never use the package
directory for state. self-test detects runtime and key presence without network.
auth-health performs a read-only provider identity check; credits performs a
read-only available-credits check. The key is read from the process environment
or Windows User environment. Use local secure entry and do not capture raw
account data into shared evidence. A key's presence does not prove validity.

## Fresh bounded controller grant and task

Only the trusted host controller acting on a current owner's scoped approval
may issue a grant. The authorization argument is the approval reference, not
a password, API key, or authority secret. Include mission identity in TASK_ID
and retain the same attempt and idempotency identity across reconciliation.

```text
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" issue-grant --task-id "MISSION_TASK_ID" --worker-id "WORKER_ID" --attempt 1 --idempotency-key "MISSION_TASK_ATTEMPT_1" --callback-target "OWNER_SELECTED_CALLBACK_ID" --authorization "FRESH_OWNER_SCOPE_REFERENCE" --ttl 600 --out "ABSOLUTE_PRIVATE_GRANT.json"
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" --grant "ABSOLUTE_PRIVATE_GRANT.json" create --prompt "OWNER_APPROVED_BOUNDED_PROMPT"
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" --grant "ABSOLUTE_PRIVATE_GRANT.json" read
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" journal-status
```

A grant permits at most one create for its bound identity; the engine caps TTL
at 900 seconds. Keep authority key, grant, database and callback state outside
the release and outside shared evidence. Reusing the same identity with changed
input is an error. If a create has an uncertain result, do not issue a new create
or change its key to bypass the guard. Inspect the journal and reconcile the
provider result. A read does not submit another task. A signed owned expired
grant may support read-only reconciliation; mutations need a valid fresh grant.

Stopping and resuming also need the original bound task context:

```text
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" --grant "ABSOLUTE_PRIVATE_GRANT.json" stop --command-key "STOP_ATTEMPT_1"
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" --grant "ABSOLUTE_PRIVATE_GRANT.json" resume --prompt "APPROVED_REPLY" --command-key "RESUME_ATTEMPT_1" --reason "OWNER_APPROVED_REASON"
```

Resume requires a permissible stopped/ordinary-question state observed through
readback. Do not use it to confirm payment, deploy or connector permissions that
the owner did not approve. Renew a grant with the same identity when authorized
to operate on an existing task; renewal is not a task retry authorization.

## MCP and acceptance

Generate the ready-to-merge stdio config with kit-manager.py mcp-config, selecting
the owner's client and external grant path. Equivalent engine launch:

```text
python -B "ABSOLUTE_INSTALLED_KIT/bin/manus-kit.py" --state "ABSOLUTE_PRIVATE_STATE" --grant "ABSOLUTE_PRIVATE_GRANT.json" mcp
```

The engine uses JSON-lines stdio, initialize/initialized, tools/list and
tools/call. The same Adapter and Journal serve CLI and MCP; no authority-issuance
tool is exposed to the worker. Client-specific configuration and ingestion must
be checked in that actual client before claiming compatibility. A plain web chat
has no demonstrated local bridge in this release.

Task readback is not acceptance merely because a reply appears stopped. Require
complete pagination, no active background jobs, newest reply after the input,
the owner's task rubric and independent QA. See AGY-DISPATCH.md for preserved
ACK, heartbeat, checkpoint, callback outbox, receiver delivery and acceptance
gates. A local callback file is not proof that an external receiver ingested it.
CLI exit 0 means that command completed, not that all release/mission gates PASS.
