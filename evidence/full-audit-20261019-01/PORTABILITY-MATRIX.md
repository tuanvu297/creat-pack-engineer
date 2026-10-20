# AGY portability matrix

Evidence labels: OBSERVED means directly inspected/tested in this audit; INFERRED means supported by the interfaces but not installed there; UNVERIFIED means no sufficient execution evidence.

| Target | Client feasibility | Runtime installation | Current blocker / acceptance needed |
|---|---|---|---|
| Another ChatGPT workspace/account | UNVERIFIED | Not applicable for a hosted client | Originating chat OBSERVED missing binding; build authenticated MCP transport, account consent and per-workspace scopes; actual second-account test required |
| Codex/Work as client | OBSERVED independent HTTPS clients from this Codex engineering session | UNVERIFIED as installed native tool | No Work executor fallback used; native tool discovery/install remains unverified; this audit's shell is a test client only |
| Gemini/other AI via MCP/HTTP | INFERRED HTTP compatibility | UNVERIFIED | No Gemini dispatch/result was executed; add scoped HTTP/MCP adapter and prove actual client and provider output |
| Local desktop agent | OBSERVED Windows PowerShell and Python HTTP sessions | UNVERIFIED independent Core install | Remove fixed host/mission/storage policies; secure credential storage, package installer and OS-specific journal semantics |
| Server/edge device | OBSERVED Railway Linux host only | UNVERIFIED elsewhere, especially ARM64 | Node >=20.3, supported Temporal native worker binary, Postgres/Temporal endpoints, durable POSIX storage, one writer, migrations and bounded capacity |
| Mobile/device HTTPS client | INFERRED authenticated HTTPS capability | UNVERIFIED / not required for thin clients | Keep credentials in a secure per-device identity strategy; never ship shared staging token; actual device/background/reconnect test required |

Only independently authenticated HTTP continuation and the existing hosted fixed verification lane are certified. None of the untested target installations inherit PASS.

## Reusable component separation

| Component | Current observed material | Required normalization / verification |
|---|---|---|
| AGY Core runtime | Worker/lease/events/idempotency and scope modules | Stable module API, namespace/tenant policies, eliminate project fixture defaults from bootstrap |
| Gateway/API | Authenticated /v1/agy REST actions | Versioned schemas, error catalog, external vs admin tool separation, sanitized response adapter |
| Temporal workflows | Event-driven workflow, compatibility patch and retained legacy branch | Versioned workflows and replay fixtures; deployment/SDK compatibility matrix |
| Canonical PostgreSQL | Additive migrations, scoped runtime role and ledger | Separate baseline schema from legacy imports, checked migrations/backups and upgrade rehearsal |
| Journal/storage | Durable files, intent-before-effect, exclusive lock | Configurable absolute root, storage adapter, disk/permission validation; fail closed on missing/corrupt/uncertain state |
| Auth/identity | Configured bearer identities and project/action scope | Per-account/device identity, expiry/revocation, secret references and no shared shipping token |
| AI/provider workers | Fixed source-check R11 lane is OBSERVED; other inference not certified here | Provider-specific auth/quota/cost/ACK/poll/reconcile/result/QA contracts and live acceptance per provider |
| Native Chat/Work | No originating ChatGPT binding OBSERVED | Native MCP adapter design and product installation/auth acceptance |
| Config/env | Existing env schemas and guardrails | Configurable hosted DNS, namespace, paths, ports, project/mission IDs; preserve safe defaults |
| Install/bootstrap | Railway isolated-schema provisioning | Portable bootstrap and explicit offline journal init; never automatic journal reset on startup |
| Doctor/self-test | Health route and isolated negative probes | Non-mutating doctor, isolated test identities, meaningful health/read/write/recovery evidence, clear failure codes |
| Upgrade/migration | Migration ledger and retained workflow history | Versioned upgrade rehearsal, checksum conflict detection, compatibility policy |
| Rollback/uninstall | LEGACY path and prior deployment retained | Tested version rollback; uninstall retains database/journal/evidence unless explicitly approved deletion |
| Evidence/QA bundle | Source hashes, receipts, callback and focused checks | Stable manifest, version, limitations, source/license inventory and exact release checksum |

## Source portability findings

The checked 147 source/config/test/evidence files match runtime commit 36516473f4e41578bb5ee11e33273ce66f9d173d after line-ending normalization where needed. A separate textual portability scan of first-party source/config/docs/tests found 31 project/mission identity lines, 25 hosting/Supabase lines, 84 loopback lines, 11 fixed-storage lines, 11 fixed-command lines and one historical chat-reference line. These are hit counts, not vulnerability counts. See PORTABILITY-SOURCE-FINDINGS.json for file/line evidence.

Observed executable blockers include temporal/config.ts's railway.internal-only hosted validation, hosted/r11-host.ts's /data/r11-hosted and fixed loopback ports/worker ID, bridge.ts's mission allowlist and fixed command policy, provision.ts and migrations' GL_AUTOMATION/legacy-workspace seed/import assumptions. Local worker loopback is intentional process isolation; preserve that isolation while making ports/root injectable. Supabase references are compatibility/shadow paths, not permission to promote it. Windows-only absolute path hits are zero in the scoped module scan, but audit/client scripts and surrounding release workflows use machine-specific Windows paths; a zero hit count is not a cross-OS install PASS. Historical chat IDs in documentation should remain provenance, outside shipped active configuration.

One-off staging credential portability, transitive licensing, native dependencies on alternative CPU/OS, full dependency SBOM and a clean offline/fresh install remain UNVERIFIED. Direct inspected packages declare MIT, with TypeScript Apache-2.0; this is not a complete dependency clearance. RIGHTS.md records that a first-party public redistribution license/customer contract has not been selected.

