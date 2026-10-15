# Decision ADR-001 — persistent host executor with connector-backed inbox

OBSERVED: Codex0.162.0-alpha.17.2 app-server initializes and reads the exact primary Work metadata. Resume is rejected because the desktop has an active writer. Managed daemon control socket was unavailable. Standalone stdio context exposes the existing GitHub connector and performs actual issue reads; the isolated model context has zero MCP connector tools. Git CLI lacks unattended GitHub auth; no token was copied or requested.

SELECTED: a Python host daemon owns queue/lease/checkpoint state and a logical AGY primary worker. It drives the official app-server JSON-RPC stdio protocol and an ephemeral model context. Existing Work remains a monitor; no new stored Work is created. GitHub issue2 is a machine-callable durable control-plane inbox, not execution proof. SQLite is atomic operational queue truth.

INFERRED: this is the smallest supported route with the current surfaces. It avoids stealing native writer locks, UI injection, API token extraction and a new cloud service. It is not a universal best architecture for multiple machines or production.

Limit: independent AGY native-chat acceptance requires the host readback verifier; declaration-only GitHub review is not enough. A fully autonomous verifier/host lifecycle attachment and a literal fresh human-only control-chat UX test remain separate gates. Ephemeral provider history does not survive crashes; journal fencing prevents replay and records uncertainty instead of pretending to resume inaccessible context.

Official source read2026-10-14: https://learn.chatgpt.com/docs/app-server . Runtime schema generated from the installed executable, kept privately outside the package. No thread/start persisted, fork, Work creation, nativeDB edit, global config update, remote-control enabling or production rollout.
