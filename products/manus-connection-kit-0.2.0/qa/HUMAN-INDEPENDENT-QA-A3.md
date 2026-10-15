# Easy Human Mode independent QA — final A3

Verdict: PASS for Windows current-workstation isolated installation and local functions. Full nontechnical-user acceptance remains unverified.

ZIP SHA-256: `5246f39546b064a55abed32d6b5efe5bdb6fe74b19a56156c393b1fce43fdd13`. EXE SHA-256: `f49812ecade1231b1003ac135532f68e90db61a9f85df0769110e150ed0815a6`.

10/10 main independent checks passed. Frozen setup self-test and install worked with PATH containing only System32. Actual installed MCP stdio handshake, eight tools, journal query and no-grant denial passed. Missing/corrupt key handling, synthetic CurrentUser DPAPI encryption, injected read-only Test Connection and error redaction passed. These synthetic tests do not authenticate a real account.

Supplemental actual frozen update and rollback passed using earlier A1 development candidate bytes. Wrong update checksum and tampered backup were blocked while current code stayed intact. Actual uninstall preserved synthetic private state. Independent junction rejection and AI-first/Human-mode coexistence passed. Internal source manifest verified 23 files and embedded core source/test bytes match canonical 0.1.1-A2.

Historical S1 installer lock, path, maintenance verification and coexistence findings are corrected and retested; A1 evidence remains intact.

No native visual QA, novice participant study, clean VM, actual AI client import, real Human account auth or live Human task is claimed. GUI self-maintenance click/spawn route remains unverified; direct maintenance worker passed. Unsigned private pilot; commercial license/support unresolved.

Evidence: HUMAN-TEST-EVIDENCE-A3.json; HUMAN-PACKAGE-INVENTORY-A3.json; HUMAN-FROZEN-UPDATE-ROLLBACK-A3.json; HUMAN-BOUNDARY-RETEST-A3.json; HUMAN-INDEPENDENT-QA-A1.json.
