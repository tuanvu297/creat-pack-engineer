# Native AGY adapter: concrete design boundary

Status: DESIGN_ONLY. No native ingestion PASS, connector installation, new identity, credential change or adapter deployment is claimed.

## Observed gap

The originating ordinary ChatGPT chat, message 24eb2f54-5fc3-43bb-a8f9-5fc5047134e3, reported no callable AGY Temporal connector and no exact AGY plugin discovery result. The audit read back its exact request and response. The staging server accepts REST actions under /v1/agy; an authenticated JSON-RPC initialize to /mcp returns HTTP 400 UNKNOWN_GATEWAY_ACTION. Existing GL Agency Control content/video and local browser/Manus tools are different contracts.

This is BLOCKED_PRODUCT_BINDING for this chat/account surface, not proof that ChatGPT cannot support custom MCP servers. [Official OpenAI connection/testing documentation](https://developers.openai.com/plugins/deploy/connect-chatgpt) describes public HTTPS Streamable HTTP or Secure MCP Tunnel, authentication discovery, installation and tool-selection evaluation. Account/workspace policy and actual enabled access still require verification.

## Minimal architecture

Preserve existing agy-gateway and canonical PostgreSQL. Add a thin MCP protocol adapter in front of the dedicated staging REST gateway, without moving workflows, database authority or execution into a chat. Prefer a separately versioned module on the existing dedicated staging service if identity isolation and resource limits can be met; otherwise obtain a separately approved hosting/trust design. Do not assume a new paid service.

Client -> MCP adapter -> existing authenticated/scoped REST gateway -> Temporal -> R11/provider -> PostgreSQL + journal.

MCP tools:
- agy_bootstrap: validated mission envelope -> current project and missions.
- agy_dispatch: validated complete envelope -> durable workflow/run identity; record intent/hash before forwarding once.
- agy_task_status / agy_get_result: envelope -> canonical operational state plus Temporal progression and evidence references.
- agy_callback_status: envelope -> durable callback receipts.
- agy_reconcile: exact retained identity -> reconciliation request, never replacement dispatch.
- agy_stop: exact retained identity -> safe stop retaining accepted operation.
Do not expose r11_control, journal initialization, destructive storage, deployment controls, raw SQL, arbitrary commands or submit_qa by default. QA requires a separately scoped non-executor identity and explicit contract.

## Identity and transport contract

Public ChatGPT registration requires a supported authenticated MCP transport and account/workspace binding. The current single staging bearer identity is not a portable account identity and must never be embedded in a plugin, prompt, ZIP or mobile binary. Select and validate OAuth/delegated per-user scopes or an approved secure private tunnel credential strategy. Bind tenant/workspace/project server-side. Never infer authority from text fields. Preserve 401 missing identity and 403 scope denial.

Limit request size to current 64 KiB, reject unknown mission fields, expose stable JSON schemas and tool annotations. Dispatch and reconcile are writes; status/bootstrap/callback are read-only. Responses sanitize lease tokens, secrets and internal failure details. Durable adapter intents store identity and payload hash with PLANNED/SENT/ACKED/UNCERTAIN; lost response requires read/reconcile, never a second POST dispatch. Do not depend on long-lived ChatGPT connections. Reuse original run and operation for follow-ups.

The existing native-command lane only permits mission AGY-TEMPORAL-20261018 and fixed verification commands. Parameterizing this policy for other missions/providers must be a separately tested Core change, never an adapter bypass.

## Required acceptance before claiming native PASS

1. Inspector initialize/tools/list/schema/auth and wrong-scope tests.
2. Install/bind in the actual ChatGPT workspace and inspect discovered tools.
3. One fresh authorized native task; persist intent and durable ACK identity.
4. Close/disconnect the originating client after ACK.
5. Hosted execution reaches result and callback independently.
6. Separate authorized client retrieves the same run/result without dispatch.
7. Originating ChatGPT retrieves it through its MCP tools without Work.
8. Verify no duplicates, no secret exposure, no alternate executor, no production change.
9. Test account disconnect/revocation and different-workspace isolation.
10. Repeat from an independent workspace/account before portability claims.

## Why this audit stops at design

No native binding exists to invoke. No MCP endpoint or user identity-discovery implementation exists in the accepted service. Turning the current staging service credential into a multi-account ChatGPT connector introduces a new external authentication/trust surface and persistent workspace connection. That exceeds a low-risk local adapter shim. The owner explicitly required a concrete design/evidence boundary for a major connector change. No prototype is presented as a working connector.

Single next owner action: approve this scoped staging MCP adapter and identity-binding design. After approval, engineer the adapter, validate the identity strategy, deploy only within existing approved resources if feasible, connect via the product-supported flow and rerun the native acceptance steps. Any actual account-owner consent remains subject to the product's connection process.

