# AGY Gemini on Steel — scoped connection adapter 0.1.0

This adapter repairs the missing Gemini-specific route without editing the
existing demo/benchmark gateway or existing Chrome connection. It uses the
installed official Steel SDK and Chromium CDP, then applies an exact-origin
policy for Gemini and Google login/static resources. Owner explicitly requested
this Steel route. Other browser providers and websites are not fallback routes.

Machine entrypoint: `node bin/connection.mjs --help`. Supply external private
`--state`, `--config` and `--dependencies` paths. Dependencies points to an
installed package root resolving pinned `steel-sdk 0.18.0` and `playwright 1.64.0`.
Node >=24 with built-in SQLite is required. Existing `STEEL_API_KEY` remains in
environment; never place its value or session viewer URL in release/evidence.

Operations: `connect`, `status`, `refresh`, `guest-app`, `probe --nonce TOKEN`, `collect --nonce TOKEN`,
`release`. A trusted host must supply an unexpired owner-bound policy with
current eligible existing credits. One task binds one session, maximum15min;
one probe submission. Each invocation records a fresh bounded local adapter
lease/ACK before PLAN. This adapter ACK is not Gemini model ACK or result.
Durable SQLite WAL/FULL stores intent before create/fill/send/release. Any
uncertain mutation blocks replay. Reconcile the same session/provider state;
do not erase private journal, rotate identities or create replacement sessions
to conceal uncertainty. Closed sessions are historical evidence, not live auth.

The first live connection is ephemeral (`persistProfile=false`). No local
Chrome cookies, passwords, token files or profiles are read/imported. Google
login/password/OTP/CAPTCHA is performed directly by the owner in the remote
session if required. The adapter never types into Google auth pages. Persisting
auth in Steel requires explicit owner approval and its own tested profile flow;
it is not silently enabled by this prototype. Google/account restrictions are
external limits; do not bypass them. Proxy and automatic CAPTCHA solving are off.

`viewer.private.json` is written ONLY outside the package and contains temporary
access URLs. The host may open the official viewer privately for owner takeover.
Do not post viewer/debug/CDP URLs to GitHub, Drive, screenshots or ordinary chat.
Screenshots of login/QA must be reviewed for secrets before export.

`probe` only requests a synthetic nonce and19+23 arithmetic, no tools/actions.
`collect` examines the assistant response element only, not the echoed prompt.
Exact output is a candidate requiring independent QA. Authentication, connection,
actual model execution, native callback and AGY acceptance have separate evidence.
Unvalidated DOM selectors, login, persistent reuse or blocked provider navigation
remain UNVERIFIED; unit tests are not a LIVE PASS.

## Observed repair checkpoint

The required exact `gemini.gstatic.com` static origin is allowed as a resource,
never as an agent navigation destination. Refresh/guest-app are once-only safe
GET recovery before any FILL/SEND. They cannot erase or replay a sent task.

Google rejected sign-in in the tested Steel Chromium154 session with "This
browser or app may not be secure" before any credential entry. Authenticated
Google/Pro access on Steel remains EXTERNAL_LIMIT. No protection bypass or
Chrome cookie transfer was attempted. Keep the existing signed-in Chrome route
for account functions.

Explicit external policy `allow_guest_probe: true` enables ONLY a public guest
nonce/arithmetic probe. It can fill one visible contenteditable at exact
Gemini/app, with no query/hash; send rechecks that gate. This does not grant
account access, Google apps, image tools or arbitrary browser actions. A real
guest response was observed in a distinct bounded phase after the first
connection/repair session was confirmed released with zero FILL/SEND. Its
original response and first collector result are retained in evidence.

Rollback: release only the adapter-owned session; preserve private journal and
sanitized checkpoints. Remove/stop this additive route if needed; the existing
gateway, accepted tasks and Chrome route remain available. No scheduler, boot
service, production rights or global skill promotion is installed.
