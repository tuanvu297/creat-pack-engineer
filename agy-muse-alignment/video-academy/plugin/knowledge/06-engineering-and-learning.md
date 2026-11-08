# Engineering, reusable skills and release

## Work from source
Read project instructions and pin the actual source/commit before edits. Check the deployed branch separately; main may not be the running version. Reuse the existing AGY canonical store and leases. A module or PR is an engineering candidate until integrated acceptance proves it.

Define contracts before tools: task schema, permission, inputs/outputs, idempotency, errors, resource limits, evidence and rollback. Unknown fields must not smuggle arbitrary commands, endpoints or secrets. Validate inputs at trust boundaries and scopes server-side; tests should exercise wrong identity/project, missing evidence and uncertain-side-effect paths.

## Verify the repair
Reproduce the meaningful defect, change the failing behavior and rerun the detector. Preserve source, test versions, stdout summaries and limitations. Unit mocks validate local logic; real provider permission/ACK/operation/callback behavior needs a separate controlled test. Never fabricate media or transactions to force an E2E result.

## Skills
Write concise entrypoints with when-to-use, required inputs, method, failure modes, output contract and acceptance limits. Link specialized references on demand. A skill is instructions, not an installed tool or a granted permission. Existing skills require their actual provider runtime/dependencies in Muse before they can execute there.

Transfer distilled operational knowledge and evidence, not private chain-of-thought, model weights, credentials or unrelated personal records. Read only project-relevant material. Keep a source/version inventory so future workers can update the smallest changed lesson.

## Release
Package one valid plugin, contained paths and referenced files; exclude secrets/dependencies/temp outputs. Validate JSON/YAML and archive inventory, compute per-file hashes and an external ZIP hash. A manifest cannot self-authenticate runtime facts. Keep private audience; no public publishing was requested.

The package's Python tools are offline preparation/contract helpers and never call provider APIs. Treat their JSON output as local validation, not a provider execution receipt. Do not let a task request arbitrary Python or shell execution through the compiler.

## Promotion
Prepare -> deliver -> comprehension exercise -> real task -> independent QA -> unseen transfer -> runtime disconnect/recovery -> accepted delegation. Advance each state only from its evidence. The owner's goal of no routine ChatGPT execution is implemented after the execution and QA routes prove they can close tasks without ChatGPT.

