# Packaging readiness

PACKAGE_READINESS=NOT_READY

The bounded hosted runtime is a useful accepted engineering baseline. An installable AGY core for other AI systems/accounts/devices is not yet certified. Native Chat binding is absent; hosted DNS, mission/worker policies, journal location and seed identity remain environment-specific; generic model/provider execution and clean independent installation have not been proved. An evidence ZIP is an audit artifact, not a commercial software package.

## Release gates

| Gate | Label | Finding |
|---|---|---|
| Accepted source and bounded staging execution | OBSERVED | Source pin and fresh fixed R11 operation verified; production remains false |
| Other clients can call authenticated HTTPS | OBSERVED / INFERRED | Independent PowerShell/Python observed; arbitrary devices/providers inferred only |
| Native Chat connector | OBSERVED BLOCKED | Exact originating chat tool surface and /mcp rejection documented |
| Portable configuration and install | OBSERVED blockers / UNVERIFIED install | Fixed Railway/mission/storage policies; no clean target install certification |
| Provider execution | UNVERIFIED for general AI | Fixed compiler/source check uses no paid inference; do not advertise provider completion |
| Upgrade/rollback/uninstall | Partial OBSERVED / remainder UNVERIFIED | Current same-source redeploy and prior rollback retained; cross-version migration/uninstall not certified |
| Secrets and credentials | OBSERVED scoped scan | No credential values permitted in artifacts; replace one-off staging identity for portable clients |
| Licenses/SBOM | Partial OBSERVED | Direct metadata inspected; full transitive inventory, redistribution rights and first-party release license unresolved |

## Concrete packaging plan

1. INSPECT — freeze accepted source and evidence; inventory direct/transitive dependencies, runtime binaries, migrations, APIs, assets and licensing. Preserve immutable historical checkpoints and source input.
2. NORMALIZE — externalize tenant/workspace/project/mission policy, hosted DNS/Temporal namespace, journal root and ports; separate legacy seeds from canonical migrations and secrets from config. Preserve fail-closed safety and workflow compatibility.
3. PACKAGE DESIGN — define versioned Core, REST contract, MCP adapter, provider adapters and host profiles. Approve the native authentication/trust design in NATIVE-ADAPTER-DESIGN.md. Define operator vs client tools, safe upgrade/rollback/data-retention contract and target OS/CPU support.
4. BUILD — implement the smallest hosted plus local-client slice; include README, VERSION, documented entrypoints, config schema, bootstrap, doctor, migrations and rollback instructions. Do not bundle staging auth state, old Muse assets or unrelated source archives.
5. SECRET SCAN — screen filename/content and archive contents; compare known staging secrets in memory without reporting them; review entropy/signature findings; keep scanner coverage and exclusions.
6. TEST — fresh extraction/install in an independent target, authenticated client/native Chat ingress, real ACK/result/callback, disconnect continuation, cross-client readback, 401/403, journal corrupt/missing, uncertainty/no replay, restart/redeploy, scope isolation and upgrade/rollback. Reuse unchanged accepted suites only with source/evidence identity.
7. MANIFEST — inventory all shipped files with SHA-256, versions, dependencies/licenses, environment requirements, auth requirements, test scopes and known limits. Exclude manifest self-hash explicitly.
8. HASH — verify every manifest entry; calculate external archive checksum after archive completion.
9. RELEASE ZIP — build the internal candidate only after required install/native gates and source normalization pass. Do not label it production/commercial ready. External checksum covers manifest too.
10. QA REPORT — verify fresh unpacked candidate independently under the same QA contract; record exact release hash, evidence levels and all remaining limits; publish to authorized private GitHub/Drive checkpoints with readback.

Next engineering action: implement and test the scoped native MCP/identity adapter after the concrete staging design is approved, then normalize Core configuration before building an internal release candidate.

No production cutover, paid top-up, new hosting purchase, Supabase promotion, global LEGACY change or general provider claim is part of this audit.

