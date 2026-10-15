# Release candidate limitations

Versions 0.2.0-ai.1 and 0.2.0-human.1 are separate SemVer prerelease channels.
The unchanged Manus adapter/MCP core still reports engine version 0.1.1. The
package VERSION and receipt identify the upgraded onboarding layer.

- Private evaluation candidates. Product license, redistribution terms and
  customer support obligations are UNRESOLVED: commercial-ready is BLOCKED.
- Windows x64 is the build host. Other OS/architectures and clean Windows VM
  compatibility remain UNVERIFIED unless a report names that environment.
- Coding-capable AI needs filesystem and terminal access. A client supporting
  local stdio MCP can connect using the generated configuration. Client-specific
  automatic configuration is not certified by generating a JSON file.
- Ordinary ChatGPT, Claude or Gemini web chat has no proven bridge to this local
  kit. Installing the kit does not activate such a bridge.
- The local connector runs when a compatible client launches it. No always-on
  service, scheduled task, remote tunnel or native Work activation is installed.
- Live mutations need an owner-scoped, short-lived controller grant. Uncertain
  provider outcomes must be reconciled using the retained journal and provider
  task ID. Update/uninstall never authorizes replay or deletes that journal.
- A checksum supplied through a trusted channel establishes the selected bytes;
  an internal manifest alone is not publisher identity. Publisher code signing
  and signed release metadata are unavailable in this candidate.
- A finite filename/content secret scan cannot detect every secret format or
  prove absence of all encoded secrets. Build provenance and allowlists are
  recorded separately; owner grants, authority keys and runtime DB are excluded.
- DPAPI protects stored human-mode key bytes for the current Windows user. It
  does not isolate against malicious software running as that same user. Keys
  necessarily exist briefly in process memory for authenticated requests.
- Offline tests and synthetic API transports do not establish AUTH_VERIFIED,
  LIVE_EXECUTION_PASS or end-to-end user acceptance. Historical pilot PASS
  remains historical. Inspect the external release receipt for each new level.
- A GUI smoke check is not a usability study with a nontechnical participant.
  Installer signing/SmartScreen reputation may require OS confirmation.

