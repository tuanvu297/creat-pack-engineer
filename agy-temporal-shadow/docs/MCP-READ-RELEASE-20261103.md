# ISOLATED READ-ONLY MCP RELEASE — source package (2026-11-03)

Status: SOURCE ONLY. Nothing merged, deployed, created, or
provisioned. This branch exists so the owner can approve ONE
concrete action instead of the whole unfinished PR #19.

## What this release is
- Branch: `agy/mcp-read-release-20261103` in repo
  `tuanvu297/creat-pack-engineer` (exact release SHA is returned
  with this package; the branch head is the release).
- Base: EXACTLY the currently deployed commit
  `14f0667716538bf05b626f6b96e65b21674452ac`
  (= head of `agy/muse-qualification-staging-20261029`).
- Delta on that base — three parts, nothing else:
  1. `agy-temporal-shadow/src/platform/auth.ts` — the
     already-scoped ACTIONS RESTRICTION only: optional
     per-identity `actions` allowlist, narrowed inside the
     shared `authorize()` (ACTION_DENIED), with config
     validation in `identitiesFromEnv`. Byte-identical to the
     PR #19 candidate's auth.ts, whose full diff against this
     base is exactly this restriction.
  2. `agy-temporal-shadow/test/auth-actions.test.ts` — the
     restriction's runtime tests (fixture scope set to the
     release mission, GEMINI_UI_STAGING).
  3. `agy-temporal-shadow/tools/agy-mcp-facade/**` — the
     corrected, LOCKED facade package v0.3.2 (see below).
- PR #19 (`agy/muse-callback-lifecycle-fix-20261102`, head
  `691aa7ec`) is PRESERVED untouched as the main candidate.
  Its helper-queue layer is NOT accepted (root: split-pool tx
  and begin/record TOCTOU remain) and NOTHING in this release
  depends on it: no helper queue, no delegation, no admission,
  no worker-surface or worker-ui changes.

## Facade v0.3.2 (release line) = candidate v0.3.1 + triage delta
- Dedicated DB schema: the PG store qualifies EVERY table with
  schema `agy_oauth` (env `AGY_OAUTH_SCHEMA`); the DDL creates
  that schema. No unqualified default-`public` bleed.
- Root HTTP triage hardening: FAMILY_REVOKED maps to
  InvalidGrantError at EVERY exchange exit (rotating AND
  persistent); custom async handlers are wrapped
  (Promise.resolve(...).catch(next)) behind a controlled-500
  error middleware ({error:'server_error'}, no stack, no
  internal text); the bootstrap redirect log line is bounded
  and sanitized (scalar only, CR/LF stripped, URL-validated).
- Two REAL-HTTP negative tests with injected failures prove
  both behaviours (test/oauth.negative.test.mjs).
- Gemini's four held-out findings were re-checked: they drive
  internal methods / mock SQL directly and overstate HTTP
  impact; the SDK's own handlers already cover the DCR/PKCE
  paths, so no broad refactor was made. H4 (an orphaned
  rotation can strand a family's refresh) is an AVAILABILITY
  note, not a revocation break — the family guard keeps every
  such token unusable for minting; recorded, not "fixed" by
  weakening the guard.
- O1/O2 semantics from v0.3.1 are preserved unchanged.
- Registration state: MANUAL ONLY (endpoint advertised for
  Gemini discovery; dynamic registration refused unless
  explicitly enabled, then runtime-only). Root's HTTP check
  confirmed /register ignores a supplied client_id and
  preserves static clients; the release does not rely on DCR.
- Dependencies LOCKED (package-lock.json): SDK 1.32.2,
  express 4.22.3, zod 3.25.76, pg 8.23.1. Install: `npm ci`.
  Package owner: `tools/agy-mcp-facade` (standalone package,
  name `agy-mcp-facade`), NOT part of the shadow build.
  Startup: cwd `agy-temporal-shadow/tools/agy-mcp-facade`,
  `node server.mjs`.

## Verification at the release source (local, by Muse)
- Release-tree typecheck: the base package + auth delta
  compiles clean (tsc --noEmit).
- Restriction tests: test/auth-actions.test.ts passes against
  the release tree (read-restricted identity cannot write /
  execute / qa / approve; allowlist narrows even
  platform-admin; unrestricted principals unchanged).
- Facade suite 11/11: bearer HTTP 3, OAuth flow 2, OAuth
  security (O1/O2) 3, OAuth negative HTTP 2, PG store 1.
- Raw PG proof (real local Postgres 18.6, Node v24.22.1):
  see the evidence block returned with this package (commands,
  DDL SHA256, full stdout). Root's own run had PG SKIP for
  lack of a local DB; this is LOCAL proof, NOT a hosted PASS.

## Deploy configuration (for the consent decision; NOT executed)
Exact environment names below are read verbatim from the
release's `tools/agy-mcp-facade/server.mjs` (full config
reference: that file's header + the facade README in the
release). The deploy is TWO steps at the SAME release pin:

- STEP 1 — existing runtime, auth-only (required, and NOT
  "untouched"): redeploy the EXISTING app service
  `9c9f2634-...` pinned to this release commit. Against its
  current base `14f06677` the only runtime change is the
  auth.ts actions restriction. Its predeploy provision-cli
  simply reruns the hash-tracked EXISTING migrations — this
  release adds NO new migrations, the existing initialization
  marker skips re-initialization, and nothing is a provider
  or table reset. In the same step, add ONE identity to that
  service's AGY_IDENTITIES_JSON: subject `agy-facade-read`,
  role operator, actions ["read"], scopes
  [gl/legacy-workspace/GEMINI_UI_STAGING], with a fresh token.
- STEP 2 — new standalone facade (created only at consent):
  NEW Railway service in the EXISTING project (AGY Core
  Staging), source = this repo @ the release pin,
  rootDirectory `agy-temporal-shadow/tools/agy-mcp-facade`,
  build `npm ci`, start `node server.mjs`, one public HTTPS
  domain. Environment (exact names):
    AGY_AUTH_MODE=oauth
    AGY_PUBLIC_BASE_URL=https://<facade-domain>
    AGY_UPSTREAM_URL=https://agy-temporal-staging-staging.up.railway.app
    AGY_UPSTREAM_TOKEN=<the agy-facade-read token from step 1>
    AGY_FACADE_ALLOWED_SCOPES=gl/legacy-workspace/GEMINI_UI_STAGING
    AGY_MCP_OPERATOR_TOKEN=<generated at deploy>
    AGY_OAUTH_SIGNING_SECRET=<generated at deploy>
    AGY_OAUTH_CLIENTS_JSON=<one manual client, redirect_uris []
      per the capture flow>
    AGY_OAUTH_STORE=pg
    AGY_OAUTH_DATABASE_URL=<connection string for the
      facade's own DB role on the EXISTING Postgres
      `f84bdcee-...`>
  Database: no new database. Apply
  `tools/agy-mcp-facade/migrations/001_oauth_store.sql`
  (creates schema `agy_oauth` and its three tables only) and
  give the facade its OWN DB role with rights only in that
  schema. The schema name is the store's BUILT-IN DEFAULT
  constant `agy_oauth` — this release's server does not take
  a schema config knob; do not set one.
- Explicitly NOT in this release/consent: no GL_QUALIFICATION
  window, no callback-driver repoint, no video changes, no
  Manus executor wiring (separate, after host proof + real
  resource authority), no Grok API (dormant by owner decision),
  no merge of PR #19.

## The one owner action this package asks for
Approve the two deploy steps above, exactly as configured,
and completing the Gemini custom-app connect (dialog URL =
https://<facade-domain>/mcp, Advanced OAuth client id/secret
from deploy-time generation, owner consent on the facade's
own page, redirect URI registered via the capture flow).
This consent covers ONLY these privileges and this hosting,
funded by the remaining Railway TRIAL credit (fresh UI at
review time: 6 days or $3.48 left) — no plan upgrade and no
card purchase is inferred, requested, or required.
Verification after deploy: @-mention agy.health in Gemini
(read-only host proof) + one agy.callback_lookup.
Rollback (no data destruction): redeploy the existing app
service to its previous deployment (the pre-release
deployment on base `14f06677`); restore the prior identity
config, removing ONLY the `agy-facade-read` identity; revoke
the MCP client and its token families in the `agy_oauth`
tables (revoked flags — the OAuth evidence is RETAINED);
stop/remove the new facade service. No blanket DROP, no
business-data deletion.
