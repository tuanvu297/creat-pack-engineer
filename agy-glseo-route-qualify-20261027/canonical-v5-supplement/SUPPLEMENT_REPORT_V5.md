# Canonical v5 Supplement — AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1

OFFLINE candidate supplement responding to independent-QA findings
U1–U3 on the new modules of the v4 supplement (T2/T3 are being
cross-checked separately by QA). PR #15 and all earlier supplements
stay frozen; nothing here is on GitHub. No new features beyond the
three fixes. No deploy, Connect, credential, or grant. Activation is
NOT requested; ACTIVATION_PLAN_CANDIDATE.md is included as a draft
for the owner's final close-out, per the owner's instruction.

## Test evidence (all LOCAL, real local PostgreSQL 18.4, migrations
001–008 + candidate 012 (revised again: SENDING state), RLS-bound
NOSUPERUSER runtime role)

- test/worker-surface-v3.integration.test.ts — 1/1 PASS, now covering
  S1–S3, S6, T1, T3, U1, U2, U3.
- test/worker-ui.integration.test.ts — 1/1 PASS (unchanged this round).
- Canonical repo DB integrations — 3/3 PASS. Repo unit suite — 154
  pass / 2 fail / 9 skipped (pre-existing pin inconsistencies).
  `tsc --noEmit` clean.
- Stack verification: pin + PR #15 canonical patch + supplement
  patches 01–04 reproduces the tested tree byte-for-byte on all 10
  touched/new source files.

Two genuine defects were found BY the new tests and fixed in the
source (not in the tests): the stale-intent sweep originally fenced
on exact timestamp equality, which can never match because
timestamptz microseconds do not survive a JS Date round-trip (the
sweep now fences on status + staleness, which a refreshed live intent
also defeats); and the crash-simulation writes in the test needed the
project scope GUCs to satisfy the fill trigger — the production code
was correct there, the harness now sets them explicitly.

## U1 — Receiver authorization and tuple validation

Fix (worker-callback-receiver.ts): the role label is no longer the
only check. receive() requires operator/platform-admin AND
authorize(principal, scope, 'write'); lookup() requires the same role
AND authorize(principal, scope, 'read') — the scope comes from the
path, but authority over it must be the principal's own, enforced
before any read or write. Tuple validation: callback_id/task_id must
be UUIDs, the digest must be 64-hex, attempt an integer ≥ 1,
worker/target non-empty. A first delivery is receipted ONLY when an
agy_worker_callbacks outbox row exists with exactly matching
(task_id, attempt, worker_id, target) AND its stored content_digest
recomputes from the outbox payload itself (shared digest module,
src/platform/digest.ts, now used by both the surface and the
receiver) AND the body's payload is canonically identical to the
outbox payload. A replay under the same callback_id compares the
STORED receipt tuple: any drift in attempt/task/worker/target/digest
is CALLBACK_TUPLE_CONFLICT (HTTP 409), unknown ids are 404, malformed
digests 400 — the gateway route maps all three explicitly.
Asserts: two projects share the test schema — the same operator
token scoped to GL_AUTOMATION gets 403 on POST and GET under
OTHER_PROJECT, with the receipts table count unchanged (zero rows);
non-hex digest → 400 CALLBACK_DIGEST_INVALID; unknown callback_id →
404; attempt+1 → 409; forged payload → 409; no receipt exists after
any fabricated attempt; the genuine tuple receipts (effect_count 1),
an identical replay returns duplicate with effect_count still 1, a
target-drifted replay → 409; a worker-role principal calling the
receiver directly rejects with ACTION_DENIED; afterwards the
dispatcher still confirms the outbox row DELIVERED against the
pre-recorded receipt.

## U2 — Crash-safe delivery state machine

Fix (worker-callbacks.ts + migration 012): the outbox status set is
now PENDING / SENDING / DELIVERED / UNKNOWN. The dispatcher's intent
step is a state transition BEFORE any network call:
PENDING → SENDING with delivery_intent_at stamped; the confirm and
classify writes are fenced on (status='SENDING', the exact intent
timestamp via JS-side comparison of the values the same process read
and returned). A crash after intent therefore leaves SENDING, never
PENDING. recoverStaleCallbackIntents (exported, and run at the start
of every dispatcher pass) moves SENDING rows with intents older than
60 s to UNKNOWN with a CALLBACK_INTENT_STALE event — a restarted
dispatcher reconciles them; it never resends them. A FRESH intent is
another dispatcher's fence: the sweep and the candidate selection
both leave it untouched.
Asserts (crash simulation): the row is put in SENDING with a
120-second-old intent and the send is performed directly against the
receiver (effect recorded, effect_count 1) — exactly a dispatcher
that died before confirming. A restarted dispatcher pass reports
swept ≥ 1 and sends NOTHING (counting transport: 0 calls); the row is
UNKNOWN with the stale-intent event; reconcile settles it DELIVERED
and the receiver effect_count is still exactly 1. Separately, a row
with a FRESH intent survives a dispatcher pass untouched (still
SENDING), and only the explicit recovery call ages it to UNKNOWN.

## U3 — HTTP bounds and readback identity

Fix: the send path and the readback path both run under
AbortController timeouts (dispatcher-provided signal for sends, with
the race retained as a backstop for non-cooperative transports and
the timer always cleared; a bounded per-lookup timeout in
createHttpCallbackLookup, default 10 s, cap 30 s). Both adapters use
fetch redirect:'error', so a redirect can never carry the payload or
the readback off the exact allowlisted host. Reconciliation no longer
trusts a digest-only answer: the lookup receives the full expectation
(callback_id, task_id, attempt, content_digest) and the receiver's
readback returns the full receipt identity; identity-incomplete or
ambiguous answers hold the row UNKNOWN
(CALLBACK_RECONCILE_UNVALIDATED), a digest mismatch is a conflict, a
lookup failure is recorded as CALLBACK_RECONCILE_LOOKUP_FAILED —
distinct from a clean not-found. Malformed JSON readbacks throw into
the same failure path.
Asserts: a server that 302-redirects every request receives the send
attempt but the redirect target receives ZERO requests (payload never
follows), and the row lands UNKNOWN; a readback server that never
responds makes reconcile return within the bound (<8 s at a 200 ms
timeout, including all other UNKNOWN rows), reports lookup_failed ≥ 1
— not not_found — and holds the rows UNKNOWN.

Gate kept separate, per QA: the receiver receipt is a backend
persisted receipt on the canonical host. It proves durable recording
+ control-plane readback. It does NOT prove native ingestion by the
ChatGPT client; that remains its own unproven gate, and neither this
supplement nor the activation plan claims it.

## Included: ACTIVATION_PLAN_CANDIDATE.md

A concrete, unexecuted activation draft built on the owner-relayed
compare (pin 36516473 → deployed tip f40c15b9: ahead 2, only 8
checkpoint/evidence files, no runtime source difference): f40c15b9 is
the canon/evidence base; PR #15 is NOT merged into any deployment.
The plan lists the exact source/migration delta, env NAMES (never
values), the 3 identities with roles/scopes/bindings, rollback at
every step, and a bounded G2 (ONE synthetic GL_QUALIFICATION task,
60-minute timebox, no paid API). Safe qualification under quota
UNKNOWN / worker OFFLINE+UNVERIFIED is explicit: no seeded
quota/passRate anywhere; the allocator's mechanically required
profile values are stated as CAPS sized to the single task
(maxConcurrency 1, quotaCap = the task estimate, spendCap 0), never
as measurements; bindings during G2 name only GL_QUALIFICATION, so no
business allocation is possible; the two SEO tasks are never claimed
or replayed. The final owner steps follow D-054 and are listed in
the plan as approvals to give later — none is requested by this
package.

Peer note: Gemini (Argon) has quota again and returned peer-QA logic
for this round; it did not read source and did not call the gateway.
Its input stands as peer review only; nothing in this package relies
on it, and Gemini's own route qualification remains a separate track.

## Boundaries

Offline candidate only. No GitHub write, deploy, Connect, credential,
or grant happened for this round. Migration 012 (revised) is still
unapplied anywhere. Live hosted behaviour remains UNPROVEN and the
live callback route remains BLOCKED_TRANSPORT until the owner steps
in the activation plan are approved and executed.
