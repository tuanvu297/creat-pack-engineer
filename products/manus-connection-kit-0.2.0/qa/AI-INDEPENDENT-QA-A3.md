# AI Mode independent QA — final A3

Verdict: PASS for Windows current-host isolated installation and local functions. Full user acceptance remains partial.

Archive SHA-256: `9dfd29c46063be497ec099e39264ed6b27457f59f410c1e26c6c7284901060ad`.

12/12 independent checks passed. Packaged tests ran 47 with one Windows symlink-privilege skip. Core adapter, MCP server and baseline tests are byte-identical to 0.1.1-A2. Fresh install, actual generated MCP stdio child, no-grant denial, malformed/checksum archive rejection, update failure preservation, successful update plus rollback and state-preserving uninstall passed.

AI-F01 (S2) raw ZIP separator normalization defect is fixed and independently retested: rejection precedes extraction and destination remains empty. Historical A1 failure reports remain unchanged.

Local stdio is verified. Host client import, actual provider auth/live action, clean VM compatibility and external callback ingestion remain unverified by this QA. No real key or live provider call was used. Commercial readiness is blocked by unresolved license/support.

Evidence: AI-TEST-EVIDENCE-A3.json; AI-ALTERNATE-SEPARATOR-RETEST-A3.json; AI-INDEPENDENT-QA-A1.json; release/AI-A3/SECRET-SCAN.json.
