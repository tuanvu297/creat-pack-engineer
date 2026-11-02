# AGY MCP facade — candidate package (2026-11-02)

Status: **candidate code, NOT installed, NOT connected.** Prepared to
the final owner-consent step per the Control Plane instruction.

## What it is

A thin MCP server (`server.mjs`, zero dependencies, Node ≥ 18) that
exposes the AGY runtime's existing read/reconcile surface as MCP
tools: `agy.health`, `agy.callback_lookup`, `agy.callback_reconcile`
(dry-run), and `agy.mission_result` (an honest pointer to the
authorized mailbox bridge until a grant-scoped read endpoint
exists). No dispatch/submit tool: submissions require an
owner-granted qualification window by design.

## What installation requires (the exact final actions)

1. **Hosting**: create one new Railway service in AGY Core Staging
   from this repo path (`tools/agy-mcp-facade`), start command
   `node server.mjs`. (Owner action in the Railway dashboard, or an
   explicitly approved API call — creating a service is a new
   exposure, so it is NOT done under the repair package.)
2. **Identity**: provision a dedicated operator identity for the
   facade (read/reconcile scope only) in AGY_IDENTITIES_JSON and set
   the same value as the service's `AGY_OPERATOR_TOKEN`; set
   `AGY_SURFACE_URL` to the runtime service URL. Token values are
   entered by the owner in the dashboard — never via chat.
3. **Host connection**: in Muse, register the facade through the
   secure custom-connector flow (service URL + the facade token).
   In ChatGPT, add it as a remote MCP server with the same URL/token.

Until steps 1–3 are approved and done, the authorized bridge
remains the Google Doc task mailbox; this package changes nothing
about that.

## Honest limits

- The callback lookup/reconcile tools assume the runtime exposes
  the receiver's lookup over HTTP at `/worker/callbacks...`; where
  the deployed build does not, the tool returns the surface error
  verbatim rather than fabricating state.
- Manus and Gemini are NOT reachable through this facade: each
  worker needs its own authenticated surface (Gemini = the AGY
  worker route; Manus = its own API connector). Calling Gemini
  through a Muse tool is not Gemini's independent AGY worker
  identity and is never presented as such.
