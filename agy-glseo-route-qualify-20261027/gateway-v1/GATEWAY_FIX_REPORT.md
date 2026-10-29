# AGY–GLSEO Route Qualification A1 — Gateway Supplement Fix Package

TASK_ID: AGY-GLSEO-ROUTE-QUALIFY-20261027 · ATTEMPT: A1 · KEY: AGY|GLSEO|ROUTE-QUALIFY|20261027|A1
Status: **CANDIDATE COMPLETE, NOTHING DEPLOYED.** No deploy, Connect, grant, spend, publish, or business execution happened. The deployed gateway was never called; all evidence below is local.

## 1. Supplement intake (verified by Muse's own tools)

`AGY-gateway-source-supplement-20261027.zip`: 6,522 bytes, SHA-256 `d3d5d61a283f2e80f06fc29ee69e57c4e41c9c74e4636d15729e5d069bb20e63` — exact match with the owner's stated values. Three files, extracted read-only to `gateway-supplement-20261027/`: the deployed Railway Function source (4,793 bytes), the three RPC definitions from `pg_get_functiondef` (21,868 bytes), and `GATEWAY-SUPPLEMENT-RECEIPT.json` (Railway project `45e66534…`, environment `792d1b9e…`, service `27be7aa3…`, deployment `f3305b2d…`, collected 2026-10-27 14:11 UTC, no secret values).

**Provenance discovery:** the deployed Function source is **byte-identical** to the repo's own fixture `agy-temporal-shadow/test/fixtures/railway-gateway-20261018.txt` at the pinned commit (both 4,793 bytes, git blob `908b8696cfb8d9f631ed2dc80dc3c6ecf74a6a93`). The deployed gateway and the pinned repo therefore agree exactly on the HTTP layer. The RPC definitions exist only in the supplement — no repo migration defines schema `agy_shadow` or these functions (verified by grep over all 11 fetched migrations).

## 2. GitHub gate change — verified in this continuation (permission-changed retry)

The owner's material change is real: GitHub App installation **175841494** now selects exactly `tuanvu297/creat-pack-engineer`, and Muse's GitHub connector **reads the repo at the pinned commit `36516473f4e41578bb5ee11e33273ce66f9d173d`** (the same call returned 404 in phases 1–3). Receipt: `repo-36516473/tree-listing.json` (full tree, 223 files) and `repo-36516473/fetch-receipt.json`.

Fetched and **blob-verified byte-exact: all 223 files in the tree** (final on-disk verification: 223/223 match size + git blob), including everything the phase-3 report had to list as missing: the whole `agy-temporal-shadow/test/` suite, `pnpm-lock.yaml`, all 6 docs under `agy-temporal-shadow/docs/`, `config/r11-gateway.env.example` + `config/temporal.env.example`, `VERSION`, `README.md`, migrations **001–011** (the architecture doc said 001–008; the repo actually carries 001–011), plus the repo-root release-toolkit product and role docs such as `docs/PROJECT-ROLE-LOCK.md` (blob `ffba96d2…`) and `skills/ai-release-engineer/SKILL.md` (blob `6f40091e…`). Snapshot reconciliation is now closed: **all 68 snapshot source files are identical to the repo pin after LF/CRLF normalization**; the only snapshot-only file is `SOURCE-RECEIPT.json` itself.

Two corrections to my phase-3 report: the lockfile is **`pnpm-lock.yaml`** (61,987 bytes, blob `81c7182a…`), not `package-lock.json`; and `agy-temporal-shadow/VERSION` reads **0.1.1-shadow**, not 0.1.0-shadow. No branch was created and nothing was pushed — the owner permitted a candidate/review branch *if needed*; the package below is reviewable as files + patches, so no repo write was necessary.

Example receipt rows (path @ ref → blob):
- `AGENTS.md` @ `36516473…` → `0618627c6ac082a2bd8b51a05ca7470faf01a1d9`
- `agy-temporal-shadow/pnpm-lock.yaml` @ `36516473…` → `81c7182a36fa266431306a8b87bf7c2525cad2c8`
- `agy-temporal-shadow/test/gateway-shadow.test.ts` @ `36516473…` → `285c24da3286bffd6536c0b8a3dcccd1a1518968`
- `agy-temporal-shadow/migrations/011_hosted_r11.sql` @ `36516473…` → `9420f73934b4d7c5fe65644ab16956959ca15df3`

Dependencies for test runs were installed with `pnpm install --frozen-lockfile` against the fetched lockfile (pnpm 9.15.9, ~31s, free packages only).

## 3. The three QA findings — confirmed on the real source, and what else the source shows

All three findings from the supplement receipt are confirmed by my own read of the deployed code:
1. **No caller authentication (HTTP).** The Bun Function forwards `/workers/register` and `/tasks/create` bodies verbatim to the RPCs, and `/tasks/claim` checks only that an `x-agy-worker-id` header *exists*. Identity is entirely self-asserted; the bearer that protects the state plane is the service-role key held by the Function itself, which authenticates the Function, not the caller.
2. **Unscoped claim (RPC).** Both claim implementations (`agy_gateway_claim_rpc` and the duplicate `claim` branch inside `agy_gateway_rpc` — the drift itself is a fourth defect) take the first pgmq message from the shared queue `agy_tasks_shadow` regardless of target provider, required capabilities, project, or mission; they also **auto-provision** the worker row from caller-supplied provider/role and stamp `last_validated_at = now()`, so any caller can mint or re-label a worker (e.g. register as `R11-HOSTED`) and then claim. Because claim returns the lease token and fence, the (otherwise sound) lease validation on ack/heartbeat/checkpoint/result cannot compensate.
3. **Mutable callback (RPC).** Both callback implementations accept `target` and `callback_status` from the payload and use `ON CONFLICT DO UPDATE` — a later call can rewrite an existing callback's status, payload, evidence, and `delivered_at`, and can set `delivered_at` merely by claiming status DELIVERED/ACKED. The HTTP `/callback` route does not even require the worker/lease headers the other actions require.

What the deployed code already does right (preserved unchanged in the candidate): lease validation on ack/heartbeat/checkpoint/result (attempt + worker + token + fence + expiry, row locks), task identity checks (trace + idempotency key), idempotent `create_task` with identity-conflict detection, and state-transition guards.

## 4. Candidate fixes (files in `gateway-candidate/`)

**`agy-gateway.candidate.ts`** (HTTP layer):
- Bearer caller authentication on every POST route. Callers are provisioned server-side in `AGY_GATEWAY_CALLERS_JSON` as `{worker_id, provider, role: WORKER|CONTROL, token_sha256}`; the token is hashed and compared in constant time. Identity comes only from this mapping.
- Identity headers/body that disagree with the authenticated caller → 403 IDENTITY_MISMATCH. `/tasks/create` requires role CONTROL. Claim payloads are built server-side (`worker_id`, `provider` from the caller), and `_caller` is injected into every RPC payload after stripping all client-supplied `_`-prefixed keys.
- `/callback` now requires the full lease header set, and `target` / `callback_status` / `status` are stripped from the body.
- `/health` stays public and read-only, as deployed.

**`agy-gateway-rpc.candidate.sql`** (state plane; `CREATE OR REPLACE` only, no schema changes):
- New guards: `agy_shadow.assert_shadow_staging_()` refuses every mutating action unless `schema_meta.state_plane.mode = 'SHADOW_STAGING'` (the shadow can never silently act as canonical D049), and `agy_shadow.assert_caller_()` cross-checks the gateway-injected `_caller` against the claimed identity (a CONTROL caller may act for provisioning; a WORKER caller only as itself). Mutating actions without `_caller` raise CALLER_REQUIRED.
- `register_worker`: an existing worker's provider can no longer be overwritten (WORKER_PROVIDER_MISMATCH); `last_validated_at` is refreshed only by a CONTROL caller.
- Claim is a **single implementation**: the duplicate `claim` and `callback` branches inside `agy_gateway_rpc` now raise and point at the dedicated RPCs.
- `agy_gateway_claim_rpc`: no auto-provisioning (unregistered → WORKER_NOT_REGISTERED); provider/capabilities read from the registered row, a disagreeing payload provider is rejected; eligibility scope before leasing — `payload.target_provider` must equal the worker provider, `payload.required_capabilities` must be a subset of registered capabilities, `missions.metadata.allowed_providers` must include the provider — otherwise NOT_ELIGIBLE with a reason, no attempt/lease/event created, message left in queue.
- `agy_gateway_callback_rpc`: worker identity required and must equal the task's `assigned_worker`; target derived from `task.payload.callback_target` (default CHATGPT_ASSISTANT_CONTROL_PLANE); stored status forced to PENDING and `delivered_at` never set on the worker path; the row is immutable — identical resubmission replays the stored row, different content under the same `callback_id` raises CALLBACK_CONFLICT (digest stored inside the payload jsonb).
- Lease actions keep the deployed validation verbatim and add the caller cross-check.

Phase-2/3 gateway-shadow candidate (provider labels + server bindings, `patch/muse-gemini-gateway-full.candidate.patch`) remains a separate, complementary candidate for the repo-side worker runtime; this package fixes the actually deployed gateway. The phase-3 connector helper (`custom.agy-runtime`) already speaks this HTTP contract (same routes, bearer via the credential surrogate) and needs no change beyond its gateway URL at connect time.

## 5. Tests actually run — classified

**Repo suite, pristine pin (baseline).** Repo tests fetched from GitHub, run against blob-verified repo files: unit subset (17 files, `*.test.ts` excluding `*.integration.test.ts`): **158 tests — 154 pass, 2 fail, 2 skipped**. Both failures reproduce on the pristine repo and are pre-existing at the pin, unrelated to this package:
- `no business hard-coded dependency in shared core` (platform.test.ts): the pinned `src/hosted/provision.ts` literally seeds project `GL_AUTOMATION` / tenant `gl`, which the test forbids in shared core.
- `Temporal worker startup sanitizes invalid database connection values` (hosted-staging.test.ts): in this environment the spawned child surfaces a module-loader error instead of the expected TEMPORAL_WORKER_BLOCKED line; environment-sensitive, fails identically on pristine files.

**Repo suite + candidate patch (regression).** The full candidate patch applied to the pristine tree (the 4 CRLF files LF-normalized first — the same normalization the snapshot used; patch application onto raw CRLF files fails on `transport.ts` and is documented as such): **176 tests — 172 pass, same 2 pre-existing failures, 2 skipped**. My 18 gateway-shadow tests from phases 2–3 pass inside the repo layout. **No regressions.**

**Gateway HTTP candidate.** `test/agy-gateway-auth.test.ts`: **9/9 pass** (local, in-process module with stubbed `Bun.env` and stubbed fetch standing in for PostgREST): unauthenticated and wrong-token rejection before any RPC, token-derived claim identity with body/`_caller` spoofing stripped, header-vs-token mismatch, CONTROL-only create, self-only register, lease-action identity, callback header set + target/status stripping, public health.

**Gateway RPC candidate.** `test/sql/run-rpc-tests.mjs`: **33/33 pass** against a **real local PostgreSQL 18.4** (embedded-postgres) with the candidate SQL installed. Harness honesty: the `agy_shadow` DDL is *inferred* from the RPC source (the real shadow schema is not in the repo), and `pgmq` is a minimal local test double for read/send/archive with visibility-timeout semantics — the tests prove the candidate functions' logic, not Supabase or the real pgmq. Two test-authoring defects were caught and fixed during the run (an archive-stub parameter collision; a wrong ALREADY_LEASED expectation — the deployed state machine answers NOT_CLAIMABLE/LEASED on a re-read, and the no-double-lease invariant is what is asserted), plus one real candidate refinement: `assert_caller_` now lets a CONTROL caller act for provisioning while still binding WORKER callers to themselves, which the relabel test exposed. Coverage: relabel attack, foreign caller, missing caller, self-validation, CONTROL-only create, unregistered claim, provider disagreement, target-provider / capability / mission scoping, no-side-effect ineligibility, lease token/fence validation, callback worker binding, derived target + forced PENDING + null delivered_at, immutable replay + CALLBACK_CONFLICT, duplicate-branch removal, staging guard, health contract.

**Not run, stated plainly:** the repo's `*.integration.test.ts` files (platform/runtime/temporal-shadow) need a live D049-class Postgres and Temporal services; nothing here claims them. No test touched the deployed gateway, Supabase, or Railway.

## 6. Remaining exact asks from the pinned repo

None — the full tree at the pin (223 files) is fetched and blob-verified (§2), including test/, the pnpm lockfile, docs, config examples, and migrations 001–011.

## 7. Exact final owner consent required for live (supersedes phase-3 items C2/C5 where they overlap)

Nothing below has been done. Each item needs the owner's explicit approval; Muse will not deploy, connect, or provision on a partial approval.

- **F1 — Deploy the fixed shadow gateway.** Approve applying `agy-gateway-rpc.candidate.sql` to the **shadow** Supabase and redeploying the Railway Function from `agy-gateway.candidate.ts`, with rollback to the supplement-preserved deployed sources. Shadow only; this does not touch D049.
- **F2 — Provision caller tokens.** Control plane generates one bearer token per caller (MUSE worker, GEMINI worker, CONTROL), stores only SHA-256 hashes in the Function env `AGY_GATEWAY_CALLERS_JSON`, and delivers Muse's raw token **only** through the hosted Secure Vault page for the `agy-runtime` connector (phase-3 item C3, unchanged). Gemini's token is Gemini's own route.
- **F3 — Register the bindings.** With the CONTROL token: register worker `MUSE` (worker ID as issued) with capabilities within [text, creative, planning, qa] and worker `GEMINI` likewise on its own side; confirm `schema_meta.state_plane.mode` stays SHADOW_STAGING.
- **F4 — First live qualification (shadow, synthetic).** Approve the §runbook smoke sequence with **one synthetic staging task** (not TSK-SEO-20261027-INTEL / PLAN14, not any business task): health → register → create (CONTROL) → claim → ack → heartbeat → result → callback, evidenced by the shadow rows + journal, QA'd independently. Only this can raise the shadow route above CANDIDATE.
- **F5 — Canonical decision (separate).** Decide whether the same contract is later ported to the canonical D049 Postgres (and by whom). Until F5 is separately approved and executed, the shadow plane must not carry real SEO tasks as if it were the authority, and the two ROUTED SEO tasks stay untouched.
- **F6 — Connector + cron (unchanged gates).** Phase-3 items C1 (reachable public HTTPS host for the gateway — the Railway Function URL satisfies this if F1 exposes it), C6 (cron-pull only after F4 evidence), C7 (revocation) remain as written.

Reply format that closes the gate: "Approve F1, F2, F3, F4" (F5/F6 decided separately). On that reply Muse's next actions are exactly: present the Secure Vault credential card for Muse's worker token, verify `health` + an unauthenticated-claim 401 against the deployed candidate, and report before any register or claim.
