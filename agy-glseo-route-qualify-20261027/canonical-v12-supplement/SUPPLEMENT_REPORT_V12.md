# Connection Package — AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1 (canonical v12 supplement)

Owner directive for this round: continue to a REAL connection
result, do not stop at a candidate label; a provider label on a
patch does not by itself qualify a personal Claude/Gemini executor
or its auth. Qualify the real connector with Muse's own tooling.
Same TASK / ATTEMPT / KEY; prior snapshots untouched; nothing
connected, installed, activated, deployed, granted, or published
in this round.

## 1. Inventory — what already existed, and what was wrong with it

- NO system connector covers AGY (connector search: no AGY /
  temporal / worker connector in the system catalog).
- A custom connector candidate ALREADY existed in Muse's
  workspace: `custom.agy-runtime`
  (~/workspace/custom-connectors/custom.agy-runtime/). Reading it
  end to end shows it targets the GATEWAY-SHADOW contract:
  paths /workers/register, /tasks/claim, /ack, /heartbeat,
  /checkpoint, /result, /callback, x-agy-* identity headers, a
  lease model with attempt_id / idempotency_key / trace_id /
  fence, and a self-registration call. That is the Supabase-shadow
  plane's API. The shadow is a control-plane shadow ONLY (3
  QA-confirmed defects were recorded against it earlier in this
  task) and is never the authority — connecting that connector
  would have made Muse a worker on the wrong ledger. Its doc
  now carries a do-not-connect warning naming this package as the
  canonical route. It was never connected (no credential was ever
  registered for it) and this round did not change that.
- Muse's included tooling for a real connection is the
  custom-connector flow (custom_connector_setup skill): a
  connector doc + helper under ~/workspace/custom-connectors/,
  the credential registered through `credentials.request_api_access`
  (the owner enters it once on Muse's secure page; helpers only
  ever see an `hsurr:` surrogate that Muse swaps for the real
  credential on approved requests to registered hosts). That is
  the ONLY transport this package uses. No model API is presented
  as personal Muse, no cookie/session is exported anywhere.
- Permissions inventory (what Muse can and cannot do here):
  Muse CAN author connector candidates and helpers in its
  workspace, run them locally, and prepare repo candidates in
  PR #15 under the standing approval. Muse CANNOT register a
  credential itself (the owner enters it), cannot deploy the
  gateway, and cannot create the server-side identity (the token
  is issued into AGY_IDENTITIES_JSON by whoever operates the
  staging service). Those three limits define the owner steps in
  section 6 — everything else is done.

## 2. The minimal contract (determined from source, not assumed)

The canonical gateway ALREADY exposes everything a worker needs;
Muse pulls work by calling it — no AGY push into a personal
session is required, and no new server component is needed:

- GET /health → {status: READY, canonical_authority:
  EXISTING_POSTGRES_D049, production: false}. Unauthenticated;
  the connector refuses to proceed on any other authority value.
- POST /v1/worker/tenants/:tenant/workspaces/:workspace/projects/:project/<action>,
  action ∈ arrive | claim | ack | heartbeat | checkpoint |
  result | readback. Auth: `Authorization: Bearer <worker token>`;
  the gateway's authenticate() resolves the principal (subject,
  role, workerId, scopes) from the token alone — the worker id is
  NEVER taken from the request body (the surface rejects
  body-supplied identity overrides). Errors map to
  401 UNAUTHORIZED / 403 *DENIED* / 400 <CODE>.
- POST /v1/callbacks/tenants/:t/workspaces/:w/projects/:p/receive
  and GET .../receive/:callbackId — the operator-only callback
  delivery/readback routes (the worker's own callback state is
  read through the surface readback action instead).
- Server side, these routes are served by the worker surface over
  PostgresStore on the canonical Postgres (EXISTING_POSTGRES_D049)
  — that surface IS the server-side adapter; this task's v2–v12
  candidate code is its delta. No new ledger, queue, or service
  is introduced anywhere in this package. Generic R11 mission
  actions and synthetic workers play no part in it.

MCP determination: an MCP server is NOT required for this route,
because Muse's included custom-connector transport (helper +
surrogate credential) already reaches the API with the same auth.
For the record, the MCP mapping, if the owner ever prefers it,
is a pure 1:1 projection — tools agy_health, agy_arrive,
agy_claim, agy_ack, agy_heartbeat, agy_checkpoint, agy_result,
agy_readback with the same bearer auth and the same JSON bodies —
and it is specified here only; it was NOT built, because adding a
second network transport to the canonical service is new attack
surface that this qualification does not need.

## 3. Correction found by this round's own verification (E4 gap)

Plan v7 / report v11 stated the gateway "dispatches the action
segment generically" and that 'arrive' was reachable over HTTP.
Re-reading src/temporal/http-server.ts shows the worker route
REGEX enumerated (claim|ack|heartbeat|checkpoint|result|readback)
— 'arrive' was missing at the HTTP layer: the surface accepted
it, the deployed route would have 400'd it. Fixed in this
supplement: the regex now includes 'arrive' (patch 03), and the
new loopback suite proves arrival over real HTTP. The v11 claim
is corrected here and in plan v8; the underlying E4 design
(arrival semantics) is unchanged.

## 4. What was built this round

Server side (repo candidate, tree = canonical-tree2):
- src/temporal/http-server.ts: worker route includes 'arrive'.
- test/worker-gateway-loopback.integration.test.ts (new): the
  real gateway server on a loopback port over a local embedded
  Postgres with the qualification window granted by the
  controller — health; no/bad token 401; unprovisioned worker
  refused; wrong-project claims denied in both directions
  (PROJECT_SCOPE_DENIED); arrive over HTTP; a DISCONNECT claim
  (client destroys its socket after sending) commits exactly
  once (second claim EMPTY, readback shows the committed lease);
  stale lease denied (LEASE_EXPIRED) then restored; the real CLI
  drives ack/heartbeat/checkpoint/result/readback; checkpoint
  replay idempotent and conflicting content denied (in the
  driver, while RUNNING); result replay exactly-once and
  RESULT_CONTENT_CONFLICT on changed content; callback delivered
  through the real receive route (effect_count 1, replay
  duplicate:true), operator lookup found:true, worker lookup 403,
  unknown id a clean 404 {found:false}; business worker
  byte-identical throughout.
- test/agy-worker-cli-driver.py (new): the driver the loopback
  suite spawns to run the real CLI against the real server.

Muse side (workspace candidate, NOT connected):
- ~/workspace/custom-connectors/custom.agy-worker/connector.yaml
- ~/workspace/custom-connectors/custom.agy-worker/CONNECTOR.md
- ~/workspace/custom-connectors/custom.agy-worker/bin/agy_worker.py
  Commands: health, arrive, claim, ack, heartbeat, checkpoint,
  result, readback — canonical contract only (no register, no
  callback-send, no QA, no admin). Identity from the token via
  the surrogate; gateway URL must be https (http only for
  loopback tests, mirroring the gateway's own rule); a 5xx or
  transport failure on a POST is reported UNCERTAIN (exit 3,
  reconcile by readback — never a blind resend); rejections are
  BLOCKED (exit 2) with the gateway's error code; the claim
  output is the lease file.
- test/agy-worker-cli-mocked.test.py: mocked-transport tests.

Copies of the connector candidate are packaged under connector/
in this supplement so ControlPlane can review it from PR #15
alone; the live candidate stays in the workspace path above.

## 5. Test evidence, classified

MOCKED (stub HTTP + stub surrogate; proves CLI request shapes and
outcome mapping only):
- agy-worker-cli-mocked.test.py: 17/17 PASS — health authority
  check and mismatch refusal, no credential on the health call,
  canonical paths, bearer attached, no worker id in bodies,
  claim-shaped lease round-trip, 403 → BLOCKED with the gateway
  code, 500 → UNCERTAIN, transport failure → UNCERTAIN,
  non-loopback http refused, lease-file guards.

LOCAL (real code, real local Postgres 18.4, real loopback HTTP;
not the deployed service):
- worker-gateway-loopback.integration.test.ts: 1/1 PASS (cases in
  section 4 — wrong token, wrong worker, wrong project, stale
  lease, duplicates, uncertain/disconnect recovery, result
  evidence with digest-checked callback delivery, callback
  readback).
- Regression after the route change: worker-surface-v3 1/1,
  worker-ui 1/1, qualification-controller 5/5, postgres /
  platform-postgres / runtime-postgres integrations 1/1 each,
  tsc clean, stack check 12/12 (pin + canonical + v12 patches
  reproduce the tested tree byte-for-byte). Unit glob WITH the
  test-database env set (env-gated suites unskip): 171 tests =
  165 pass / 3 fail / 3 skipped. The 3 fails are the 2
  pre-existing pin failures plus worker-surface-v2 — a
  SUPERSEDED v2-era suite that self-skips without the env (it
  was inside the 14 skipped of every earlier env-less glob run),
  whose fixture still completes profiles via
  ResourceStore.register and never calls 'arrive'; it fails on
  code paths byte-identical to v11 (this round changed only the
  HTTP route file), i.e. a stale suite to retire, not a v12
  regression. The current suites (v3 surface, qualification,
  loopback) all pass.
- Prior rounds' suites (surface S–E sections, qualification
  T1–T4, UI, DB integrations) stand as recorded in reports
  v5–v11 and were re-run where the changed files touch them.

LIVE: none. Nothing in this package has touched the deployed
gateway, and no credential exists yet. The first live proof is
defined in section 6 and has not happened.

## 6. Owner operations — prerequisites and the ONE connection action

Prerequisites (already listed as D-054 steps in the activation
plan; unchanged, not re-requested here): ControlPlane QA verdict
on this head; the deployment delta from f40c15b9 carrying the
candidate (now including the 'arrive' route) to the staging
service; migration 012 applied by the existing predeploy;
registry provisioning; the claude-qual-worker identity present in
AGY_IDENTITIES_JSON server-side; the Option A cap-only approval
for the window itself.

The ONE connection action (the only manual step the connection
itself needs): when Muse presents the secure connection page
for provider `agy-worker` (credentials.request_api_access with
auth_scheme api_key, placement bearer_header, api_hosts
[agy-temporal-staging-staging.up.railway.app]), the owner enters
the claude-qual-worker token once. Nothing else — no install, no
config file, no pasted secret anywhere else. Immediately after,
Muse's first live call is the harmless `health` read, reported
back before any arrive or claim. Until the owner chốt, Muse has
NOT called request_api_access and nothing is connected.

## 7. Missing-files inventory for Control Plane

Nothing is missing for building or testing this candidate:
package.json, pnpm-lock.yaml and tsconfig.json are present at the
pin and in the working tree; the test suites run from the
lockfile's toolchain (tsx + embedded Postgres locally). The
server-side adapter needs no additional file: the worker surface,
gateway HTTP server, callback receiver/dispatcher and the
qualification controller are the complete set (patches 01–04 +
this round's patch 03 delta). If repo access is the constraint,
PR #15's branch already carries every version folder v2–v12; no
file needs to be supplied out of band. The only artifacts that
exist solely in Muse's workspace by design are the connector
candidate files (copied into this supplement under connector/)
and this report.

## 8. Boundaries

Offline/local only. No connection was registered, no token was
requested or entered, no deploy/merge/grant/publish/spend
occurred, and the deployed branch is untouched. Gemini's own
qualification remains Gemini's own route through its own
tooling; nothing here acts for Gemini. PR #15 remains a draft
review artifact and must not be merged into the deployment
lineage. Live route status is unchanged: BLOCKED_TRANSPORT until
the section-6 steps are executed by their owners.
