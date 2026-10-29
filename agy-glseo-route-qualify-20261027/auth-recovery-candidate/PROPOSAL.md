# Auth-Recovery Candidate — Proposal (PREPARED ONLY, not a connection grant)

AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1 / key
AGY|GLSEO|ROUTE-QUALIFY|20261027|A1.

## Why this exists

The accepted connector `custom.agy-worker` (provider `agy-worker`)
cannot complete its hosted connection: the platform's api-key
capture page fails at save with a generic error, and the platform
pins exactly one pending capture per provider — repeat requests
(including the documented reconnect mode, which only covers
replacing an already-held credential) return the identical pending
session. Diagnosis (sanitized summary in PLATFORM_BUG_REPORT.md):
the vendor contract performs NO credential validation at save, so
the failure is not evidence against the worker key; the blocked
step is the hosted page's save, and no reset/renew control for a
pending capture is exposed. The original provider, its pending
capture, and its connector files are left completely untouched.

## The candidate

A client-side credential-binding ALIAS, prepared for review only:

- Provider slug: `agy-worker-qual`; connector id:
  `custom.agy-worker-qual`; display title: "AGY Worker Qual
  (canonical gateway)".
- IDENTICAL in every operative respect to `custom.agy-worker`:
  same canonical gateway host, same worker identity
  (claude-qual-worker / MUSE-QUAL-WORKER), same scope
  (gl / legacy-workspace / GL_QUALIFICATION), same owner-issued
  worker key, same api_key scheme with bearer_header placement,
  same helper logic (requests, lease handling, recovery) —
  byte-identical except the binding/label lines proven in
  DIFF.md.
- It is NOT a new server endpoint, host, worker, route, or
  deployment. Server code, staging deployment, env, and the
  Railway identity configuration do not change.
- Local candidate folder (not registered, not connected):
  `~/workspace/custom-connectors/custom.agy-worker-qual/`
  (connector.yaml, CONNECTOR.md, bin/agy_worker.py). The copies
  under `connector/` in this package are byte-identical to it.

## What approval is needed before anything else happens

The OWNER must approve the exact new connection name
(`agy-worker-qual` / `custom.agy-worker-qual`) as a distinct
decision. This package is preparation under the standing PR15
QA write permission only; it is NOT an implicit connection
grant and NOT a silent fallback. No `credentials.request_api_access`
call for the new provider has been made, and none may be made
before that approval. If approved later, the flow is the same
bounded one as before: one official capture, owner enters the
SAME worker key, first real call is `health` only, no G2
actions without root's go.

## Honest limits

- There is NO proof a new provider name fixes the platform
  save failure. The failure is inside the hosted page's save
  step; a fresh provider registration MAY take a different
  path (a brand-new pending capture rather than the pinned
  one) — that is the entire rationale, and it is a hypothesis
  for the owner to weigh, not a claim.
- The candidate changes nothing about the gateway contract:
  if connected later, its first call is verified exactly like
  the original's would be (health → authority EXISTING_POSTGRES_D049).

## Rollback

Delete the unconnected candidate only: remove the local folder
`~/workspace/custom-connectors/custom.agy-worker-qual/` and this
package folder from the review branch. Nothing else references
it; the original connector, its pending capture, PR17 and the
activation branch are unaffected. No deletion is performed by
this package.
