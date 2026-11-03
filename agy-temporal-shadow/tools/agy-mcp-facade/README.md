# AGY MCP facade — candidate package v0.2 (2026-11-03)

Status: **candidate code, tested locally, NOT installed, NOT
connected.** Round-1 of this package was rejected in QA (no inbound
authentication; assumed endpoints). v0.2 fixes both defects.

## Tools (only proven routes)

Contracts verified against the runtime source
(`src/temporal/http-server.ts`, `src/platform/worker-callback-receiver.ts`)
and exercised in `test/facade.http.test.mjs` against a stub upstream
implementing those exact contracts:

| Tool | Upstream route (proven) | Returns |
|---|---|---|
| `agy.health` | `GET /health` | the runtime's health JSON verbatim (READY/BLOCKED, dependencies, production flag) |
| `agy.callback_lookup` | `GET /v1/callbacks/tenants/:t/workspaces/:w/projects/:p/receive/:callbackId` | `{found:true, callback_id, task_id, attempt, worker_id, target, content_digest, received_at, effect_count}` or `{found:false}` |

Deliberately **omitted**: any mission-result tool (the worker
`readback` action belongs to the worker's own identity — the facade
never impersonates a worker — and no operator mission-result read
route is proven), and any reconcile/dispatch tool (submissions
require an owner-granted window by design). A pointer is not a
result, so the v0.1 `agy.mission_result` pointer tool is gone.

## Security model

- **Inbound** (`AGY_FACADE_INBOUND_TOKEN`): every `/mcp` request
  needs `Authorization: Bearer <token>`; constant-time comparison;
  missing/wrong → 401 and the upstream is never touched.
- **Upstream** (`AGY_UPSTREAM_TOKEN`): the facade's OWN dedicated
  read identity toward the runtime — separate from the inbound
  token and from every worker/controller token. An upstream
  401/403 surfaces as a tool error, never as data.
- **Scope allowlist** (`AGY_FACADE_ALLOWED_SCOPES`): exact
  `tenant/workspace/project` triples; cross-scope lookups are
  rejected before any upstream call. Callback ids must match the
  receiver's UUID shape.
- **Bounds**: request bodies capped at 64 KiB (413), mirroring the
  runtime. The facade refuses to start (exit 2) if any required
  variable is missing or the allowlist is empty.

Tests (`npm test`, official SDK client + raw negative cases):
initialize/tools/list via the SDK, `notifications/initialized` →
202, health + lookup happy paths, `{found:false}` passthrough,
401 no-token/wrong-token with zero upstream hits, cross-scope and
malformed-id rejection with zero upstream hits, 413 oversize,
inbound≠upstream separation, fail-closed startup. **3/3 pass**
(local, stub upstream — not a live runtime).

## Concrete install config (for owner consent — NOT executed)

1. **Railway service** (AGY Core Staging, new service from this
   repo, root directory `agy-temporal-shadow/tools/agy-mcp-facade`):
   build `npm install`, start `npm start`. Railway assigns the
   public domain `<facade-domain>`; the MCP endpoint is
   `https://<facade-domain>/mcp`.
2. **Service variables**:
   - `AGY_UPSTREAM_URL=https://agy-temporal-staging-staging.up.railway.app`
   - `AGY_FACADE_ALLOWED_SCOPES=gl/legacy-workspace/GL_QUALIFICATION`
   - `AGY_FACADE_INBOUND_TOKEN=` — owner generates a fresh random
     token and enters it in the dashboard (never via chat).
   - `AGY_UPSTREAM_TOKEN=` — Control Plane provisions a NEW
     dedicated operator identity in AGY_IDENTITIES_JSON carrying
     `actions: ["read"]` and the owner enters its token in the
     dashboard. No existing token is reused. HONESTY NOTE: in the
     CURRENTLY DEPLOYED auth model a principal has only
     role/scopes, and an operator holds read AND write within
     scope — "read-only" is enforceable only with the candidate
     Principal action-allowlist change in PR #19
     (src/platform/auth.ts + test/auth-actions.test.ts). Until
     that change is deployed, any operator identity the facade
     could use carries scope-limited WRITE authority, so the
     facade stays uninstalled and unapproved.
3. **Host registration** (after 1–2 exist): in Muse, add a custom
   connector — transport: streamable HTTP; URL:
   `https://<facade-domain>/mcp`; header:
   `Authorization: Bearer <the inbound token from step 2>`, entered
   through the secure connector flow. In ChatGPT, add the same URL
   and header as a remote MCP server.
4. **First verification after consent**: `agy.health` returns the
   staging READY body, and `agy.callback_lookup` for callback
   `dacea26f-c7ce-4949-b1ff-f2caca7624e5` in scope
   `gl/legacy-workspace/GL_QUALIFICATION` returns the restore3
   receipt with `effect_count: 1` — the same tuple root QA verified
   independently on 2026-11-02.

Until the owner approves steps 1–3, nothing is deployed and the
Google Doc mailbox remains the authorized bridge.
