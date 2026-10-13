# Package contract and acceptance

Default layout: README.md, VERSION, MANIFEST.json, bin/, src/, config/, scripts/,
tests/, examples/, evidence/, docs/. Create only folders the package actually uses.

Manifest fields: package_name, package_version, purpose, created_at,
runtime_requirements, dependencies with versions, entrypoints, input_contract,
output_contract, files with hashes, known_limits, authentication_requirements,
test_status. Exclude the manifest itself from its hash inventory and cover it
with the external release ZIP hash.

Evidence levels:

| Level | Required evidence |
| --- | --- |
| PACKAGE_BUILT | Archive integrity, manifest hashes, entrypoints, declared dependencies, secret screening, ZIP checksum |
| INSTALL_TEST_PASS | Fresh extraction/install and invocation in an identified environment |
| LOCAL_FUNCTION_PASS | Meaningful local behavior tests with logged results |
| AUTH_VERIFIED | Read-only identity/auth check on the actual provider |
| LIVE_EXECUTION_PASS | Authorized real action, provider ID and verified output |
| INTEGRATED_PASS | Receiving system actually ingests and QA-checks the output/callback |

A PASS must name its scope and required checks. Authentication may be
NOT_REQUIRED for a purely local component; a future provider remains UNVERIFIED.
The builder does not promote arbitrary source declarations to verified tests.
Its output preserves those as declared_test_status; independent QA evidence can
raise levels for the specific release hash.

For retrying tools, persist the journal first. States should distinguish planned,
pending, confirmed success/failure and unknown outcome. Reused identity with
different input is an error. Polling does not dispatch. A timeout is not proof
the provider rejected a task. A local receipt does not prove external delivery.

Safe staging must reject symlinks/junctions, platform-specific absolute paths,
traversal, reserved names and case collisions; use UTF-8 and explicit size limits.
No provider output should write straight into a customer repo.
