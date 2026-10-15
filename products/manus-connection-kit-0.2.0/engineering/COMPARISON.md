# Manus Connection Kit 0.2 comparison

| Aspect | AI Mode 0.2.0-ai.1 | Easy Human Mode 0.2.0-human.1 |
|---|---|---|
| User | Coding-capable AI and its owner | Nontechnical Windows user |
| Delivery | ZIP, one obvious START-HERE, internal kit folder | ZIP with one read-first page and one setup EXE |
| Runtime | Existing Python 3.10+; AI detects missing runtime | Bundled Windows runtime; no manual Python |
| Install | AI verifies, installs per-user and runs checks | Visible per-user installer/launcher |
| Key boundary | Owner supplies own key locally; never in chat/config/package | Masked local input; Windows CurrentUser DPAPI |
| Test | Offline tests, MCP handshake; authenticated checks separately | Test Connection read-only auth result PASS/BLOCKED |
| AI surface | Local filesystem/terminal; generated stdio MCP config | Local launcher + stdio MCP configuration for compatible clients |
| Ordinary AI web chat | No supported local bridge proven | No supported local bridge proven |
| Updates | Explicit checksum verification, backup, self-test, rollback | Explicit verified candidate, backup, self-test and rollback |
| Uninstall | Removes installation surface; retains journal/state | Visible action; retains journal and encrypted key unless explicitly removed |
| Human steps | Unavoidable key/account/OS/client registration boundaries | Open installer, install, enter key, Test Connection; OS confirmations if shown |
| Commercial status | BLOCKED: license/support unresolved | BLOCKED: license/support/signing unresolved |

Manual Python installation in Human Mode is a UX defect. A missing compatible AI
client binding is an explicit external boundary, not permission to advertise web
chat compatibility. See per-mode QA reports for OBSERVED results and remaining
UNVERIFIED acceptance criteria.
