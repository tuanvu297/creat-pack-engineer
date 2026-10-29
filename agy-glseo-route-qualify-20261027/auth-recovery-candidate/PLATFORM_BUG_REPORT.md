# Platform Bug Report — Hosted API-Key Capture Cannot Be Completed or Renewed

Status: DRAFT for owner review. Do not send externally from this file.
Sanitized: contains no keys, capture links, session identifiers,
account data, or private code.

## Summary

For a custom connector registered through the official API-key
connection flow (api_key scheme, bearer-header placement, one
public HTTPS API host), the hosted capture page rejects the save
with a generic "could not connect, please check the API key"
message — even though, by the platform's own documented contract,
saving performs no credential check at all. Worse, the platform
pins exactly one pending capture per provider: repeat connection
requests, including the documented reconnect mode, return the
identical pending capture, so a user whose save fails has no way
to retry with a fresh session. The connection is unrecoverable
from the user's side.

## Documented contract (what should happen)

- The connection tool's own result states that nothing checks
  the credential when it is saved; the connector is marked
  connected the moment setup finishes, and the first real API
  call is the proof.
- The custom-connector setup guide states the same: nothing
  checks the credential when the user saves it.
- The reconnect option is documented only for replacing a
  credential the connector already holds (expired, revoked,
  rotated, or proven wrong by a rejected request).

## Observed behavior

1. A connection request for a new custom provider returned a
   capture page. The API host is a healthy public HTTPS service
   (its public health endpoint returns 200; independently
   verified at the time of the failed saves).
2. Entering a known-correct key (its correctness is established
   independently of this flow, on the server side) and saving
   produced the generic failure message above.
3. Server-side request logs for the API host show no validation
   request arriving around the failed saves — consistent with
   the documented no-check-at-save contract, and inconsistent
   with the page's "check your API key" wording.
4. Repeating the connection request returned the same pending
   capture, byte for byte. Repeating it with the reconnect
   option also returned the same pending capture. No new
   session is ever minted while a pending capture exists.
5. The provider consequently never appears in the connected
   connectors list, and the stored-credentials UI offers no
   surface for API-key credentials and no reset control for a
   pending capture.

## Why this is a platform defect

- The error message blames the API key for a step that, per
  contract, never evaluates the key. Users are sent to rotate
  keys that were never tested.
- A single wedged pending capture permanently blocks the
  provider name: no TTL, no reset, no renewal path is exposed
  in the UI, the connection tool, or the docs.
- The only documented recovery (reconnect) is defined solely
  for already-held credentials and silently no-ops here.

## Requested platform behavior

- Surface the real save failure (a specific error or receipt)
  instead of a generic key-blaming message.
- Allow a pending capture to be reset/renewed (or expire it),
  so one failed save cannot permanently pin a provider.
- Align the capture page's wording with the no-validation
  contract, or actually perform and report the validation.

## Impact

One custom-connector integration is fully blocked at the
connection gate despite a healthy target service, a correct
credential, and a contract-exact registration (scheme,
placement, and host all as documented). All downstream work
that depends on the connection is paused; server-side
preparation is complete and idle.
