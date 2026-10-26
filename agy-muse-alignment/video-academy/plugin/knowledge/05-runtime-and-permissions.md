# Runtime, connectors and durable ownership

## Two directions
Muse Custom Connectors let Muse call an authorized service; they do not by themselves provide AGY with a personal-agent task-push API. Model API hosts an inference model for an integrator-owned agent loop; it is not the owner's personal Muse session or its connectors.

A possible future pull integration is existing AGY queue -> project-scoped Muse connector read/claim -> worker-owned executor -> result/receipt -> independent QA -> durable callback. A Muse background goal must be tested; do not infer a wakeup guarantee from connector support.

## Task-scoped access
Grant only the assigned project/job and approved assets. Read source/plan; ACK and heartbeat own lease; execute only the allowlisted action; write own result/evidence; read own callback. Keep deployment, account admin, billing, publication, destructive storage and canon mutation outside this pack's authority.

Authenticate subject/scopes on the server. Bind tenant/workspace/project/worker/task/attempt/operation/reply destination; reject mismatches, stale leases and unassigned jobs. Prompt fields cannot authenticate identity. Use safe server-side credential references, provider consent and secure stores, never pasted API keys, cookies, login tokens or signed secret URLs in repo/prompts/receipts.

## Delivery and recovery
Durable outbox/state exists in canonical AGY, not a new parallel queue. Persist intent/hash before submission, ACK before next dependency and result before final callback. Deduplicate by the retained identity and state version. If a response is lost, read/reconcile; do not retry the business side effect merely because callback delivery failed. Delivery retry is separate from generation retry.

Use current retry policy: at most two retries for a known recoverable terminal failure with safe deduplication and current resource authority. Auth/region/missing-route failures need repair, not a retry loop. Fail closed for unknown spend. Quota unknown is not unlimited capacity.

## Unattended acceptance
After an authorized ACK, close/disconnect the client. Verify the hosted worker continues, writes the artifact/result and callback. Restart/reclaim and independently read the same IDs from another authorized client. Prove effect_count remains one. A foreground browser prompt roundtrip is not this test.

## Current gate
An authenticated Muse personal session was found in Chrome profile Vũ on 26 October 2026 and received a separate source-learning task. Profile Your Chrome still has separate regional-waitlist evidence; do not generalize it to every account/profile. Current exposed ChatGPT tools are inventory evidence only. No broad plugin access has been granted to Muse. Owner Connect/Install is required where applicable; changing countries/copying cookies is not part of recovery.
