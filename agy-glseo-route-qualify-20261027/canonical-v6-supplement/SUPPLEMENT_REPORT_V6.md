# Canonical v6 Supplement — AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1

OFFLINE candidate supplement responding to independent-QA findings
V1–V3 on GitHub head df2d4a15 (v5). QA confirmed on that head: U1
scope check correct, SENDING→UNKNOWN crash recovery present,
redirect:'error' present. Earlier supplements and PR snapshots stay
frozen. No deploy, Connect, credential, or grant. This package will
be written into PR #15 as its own version folder under the owner's
existing approval for QA updates to that PR.

## Test evidence (all LOCAL, real local PostgreSQL 18.4, migrations
001–008 + candidate 012, RLS-bound NOSUPERUSER runtime role)

- test/worker-surface-v3.integration.test.ts — 1/1 PASS, now covering
  S1–S3, S6, T1, T3, U1–U3, V1–V3.
- test/worker-ui.integration.test.ts — 1/1 PASS (regression).
- Canonical repo DB integrations — 3/3 PASS. Repo unit suite — 154
  pass / 2 fail / 9 skipped (pre-existing pin inconsistencies).
  `tsc --noEmit` clean.
- Stack verification: pin + PR #15 canonical patch + supplement
  patches 01–04 reproduces the tested tree byte-for-byte on all 10
  touched/new source files.

## V1 — Canonical validation on every delivery, replay included

Fix (worker-callback-receiver.ts): the existing-receipt fast path no
longer returns before validation. receive() now loads the immutable
outbox row FIRST and runs the full canonical check on every call —
tuple equality, digest recomputed from the outbox payload, and the
body's payload canonically identical to the outbox payload — and only
then lets an existing receipt decide duplicate-vs-conflict.
Asserts: after a genuine delivery (receipt effect_count 1), a replay
with the same callback_id/tuple/digest but a MUTATED payload returns
409 CALLBACK_TUPLE_CONFLICT and the receipts table still holds exactly
one row with effect_count 1 — zero added effect. (First-delivery
fabrication was already covered in U1.)

## V2 — Full receipt identity; lookup timer spans the body

Fixes (worker-callbacks.ts, worker-callback-receiver.ts):
- The receiver's receipts now carry task_id and attempt in addition
  to idempotency_key/content_digest, and the dispatcher's direct
  receipt validation requires ALL of them (accepted, idempotency_key,
  task_id, attempt, content_digest) — a partial receipt classifies
  UNKNOWN, never DELIVERED.
- reconcileWorkerCallbacks requires the FULL typed identity from the
  readback (callback_id string equal, task_id string equal, attempt
  integer equal, content_digest non-empty string). The former
  `callback_id === undefined` allowance is deleted: a partial
  readback is CALLBACK_RECONCILE_UNVALIDATED and holds the row
  UNKNOWN.
- createHttpCallbackLookup keeps its AbortController timer across
  the entire exchange — headers AND body read/parse — clearing it
  only in the finally after parsing; a body-phase abort surfaces as
  LOOKUP_TIMEOUT → lookup_failed.
Asserts: a stub readback returning {found:true, content_digest} with
NO identity fields reconciles nothing (unvalidated ≥ 1) and the row
stays UNKNOWN; a server that sends 200 headers plus a partial JSON
body and then holds it forever makes reconcile return within the
bound (<8 s at a 200 ms timeout), report lookup_failed ≥ 1, and hold
the row UNKNOWN (the pre-fix code cleared the timer after headers
and would have hung on res.json()).

## V3 — Activation plan circularity + legacy-route guard

Code guard (postgres-store.ts): an UNGATED claim (the legacy
daemon/engine route) now filters out any dispatch demand whose task
payload addresses a worker (target_worker_id present) or is marked
auto_dispatch=false — in every project. Addressed tasks are leasable
only through the gated namespace, so the generic allocator can never
silently pick the qualifying worker's tasks (or assign work to that
route). Untargeted tasks keep exact legacy semantics; canonical DB
integrations and the unit suite confirm no regression.
Asserts: a qualification-shaped task (explicit mission/target/reply,
capability-unique to Muse, priority 999) is invisible to a direct
ungated PostgresStore.claim — the daemon claim returns another,
untargeted task and the addressed task stays QUEUED at attempt 0 —
while the gated surface claim leases that same task immediately
after.

Plan (ACTIVATION_PLAN_CANDIDATE.md, rewritten as candidate v2):
- Isolation: business project GL_AUTOMATION stays dormant (worker
  OFFLINE, connector disabled, bindings incomplete); the transition
  happens only in a new GL_QUALIFICATION project containing exactly
  one task — registration is project-scoped, so a READY profile there
  is invisible to business allocation, and the code guard above
  covers addressed tasks everywhere else.
- The constraint is stated exactly: canonical allocation has NO
  null-quota path, so G2 requires a bounded OWNER POLICY EXCEPTION —
  a cap-only profile for the 60-minute window (quotaRemaining =
  quotaCap = the task's estimate of 1, maxConcurrency 1, spendCap 0;
  scoring fields at engine defaults, recorded DEFAULT_NOT_MEASURED;
  ceilings only, never evidence). Without the exception, G2 is
  BLOCKED_RESOURCE_PROFILE — approving "G1, G2" alone does not make
  it run, and the plan now says so.
- Exact P0 preflight (7 checks, stop on any failure), P1 transition
  (5 ordered steps), P2 run (≤60 min, 1 task, no retries), P3
  rollback (worker OFFLINE, connector disabled, bindings cleared,
  project suspended, evidence preserved).
- Identities corrected: the receiver/dispatcher run under the
  EXISTING control-plane operator identity — no new operator is
  created. The three provisioned identities are worker-plane only
  (claude-worker, gemini-worker, gemini-reviewer). Secrets stay
  server-side (AGY_IDENTITIES_JSON) or in the Secure Vault
  (custom.agy-worker); the worker never carries server secrets.

## Boundaries

Offline candidate only; the PR write is the previously approved
review-branch update and nothing more. Migration 012 is still
unapplied anywhere. Live hosted behaviour remains UNPROVEN; the live
route remains BLOCKED_TRANSPORT; G2 remains not runnable until the
owner steps in the plan — including the Option A exception or a
BLOCKED_RESOURCE_PROFILE record — are decided.
