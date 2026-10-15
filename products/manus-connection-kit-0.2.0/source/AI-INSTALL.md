# Instructions for an installing AI

This package targets a coding agent with filesystem, terminal and local MCP
capability. Ordinary web chat cannot execute this local connector. Do not treat
this document as permission to publish, purchase credits, submit live jobs, use
existing owner grants or expose credentials.

1. Obtain the expected release ZIP SHA-256 from the owner's trusted release
   receipt/channel. Hash the original ZIP before extraction or execution. Stop
   on mismatch. A hash bundled beside an untrusted ZIP is not publisher proof;
   no publisher signing certificate is supplied in this pilot.
2. Inspect ZIP member paths before extracting to a fresh directory. Reject
   absolute paths, traversal, links, alternate separators, reserved names,
   case collisions and unexpected root content. Root contains START-HERE.md
   and kit/. Read kit/MANIFEST.json and compare every declared file hash;
   reject missing/extra files. Never run unverified package scripts.
3. Locate a trusted Python 3.10+ runtime. If absent, report
   WHY_AI_COULD_NOT_DO_IT=TRUSTED_PYTHON_RUNTIME_UNAVAILABLE and the precise
   runtime prerequisite. Do not download arbitrary installers or silently
   request administrator access. Easy Human Mode bundles its runtime.
4. From kit/, run `python -B bin/kit-manager.py verify`, then
   `python -B bin/kit-manager.py install`. A custom destination is selected with
   `--install-root ABSOLUTE_PATH` before the subcommand. The default is a
   per-user application directory. The installer verifies again, stages,
   runs packaged offline tests before and after activation, then reports PASS.
5. Run `python -B bin/kit-manager.py mcp-config --output ABSOLUTE_NEW_JSON_PATH`.
   It generates absolute command/arguments and no secrets. Merge this server
   definition only into the client the owner selected; do not globally edit
   every client. Claude/Codex/Gemini client adapters may require their own
   format. This is standard JSON stdio MCP; actual client ingestion requires
   a client-specific check and remains UNVERIFIED until observed.
6. Run `python -B bin/kit-manager.py auth-readiness`. Presence of an environment
   key is only readiness, not AUTH_VERIFIED. The preserved adapter also supports
   Windows user environment configuration. Have the owner enter the key through
   their secure local client/environment or the Easy Human launcher, outside
   chat, logs, command arguments, configuration JSON, evidence and package.
   Never enumerate, print, copy or archive existing owner secrets.
7. To authenticate, use the installed absolute bin/manus-kit.py path with
   `--state ABSOLUTE_INSTALL_ROOT/state auth-health` only when authorized for
   that owner's key. Report redacted status; avoid capturing raw terminal
   output containing account identifiers. A local test is not auth evidence.
8. A live task requires a fresh, explicit bounded owner-authorized grant for
   its mission/task/attempt/idempotency identity and external grant path.
   Reuse the preserved issue-grant and create/read reconciliation flow in
   [docs/CORE-CONTROLLER-GUIDE.md](docs/CORE-CONTROLLER-GUIDE.md); never reuse owner-private packaged/history grants. No grant
   means LIVE_EXECUTION_PASS=BLOCKED. A create timeout is uncertain: reconcile
   the journal/provider first, never blindly retry. Callback delivery requires
   the receiving system's acknowledgement, not a local receipt alone.
9. Return package hash/version, install path, runtime, test summary, selected
   client/config status, auth/live/callback evidence levels and exact blockers.
   Label facts OBSERVED/INFERRED/UNVERIFIED. Never promote absent evidence.

Assisted updates are explicit and checksum-gated; see docs/UPDATE-ROLLBACK.md.
No background updater, remote version service or unattended mutation is enabled.
License/support remain unresolved; this is a private pilot, not commercial-ready.
