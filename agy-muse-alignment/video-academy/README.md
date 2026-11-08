# AGY Muse Video Academy 0.1.0

Portable handoff for Muse to become the project's primary video producer and engineering executor. Extends the existing AGY Muse Alignment repository; it does not replace AGY's queue/database or grant accounts.

## Actual state

PACKAGE=PREPARED_AND_LOCAL_TESTED. MUSE_ACCESS=AUTHENTICATED on Chrome profile Vũ; profile Your Chrome separately shows a regional waitlist. TRAINING_DELIVERY=INITIAL_SOURCE_TASK_SUBMITTED_ONCE; side chat https://muse.ai/thread/c6e477b8-9e16-4c35-a054-a6a321af8de2. MASTERY=NOT_EVALUATED. HOSTED_AGY_CONNECTOR=NOT_CONNECTED. PRODUCTION_AUTONOMY=NOT_ACCEPTED.
An archive, plugin creation, a text ACK, and a schema-valid receipt each prove different things. None proves a finished video or durable worker integration.

## Start

1. Read OWNER-DIRECTIVE.md, SOURCES.json and plugin/skills/muse-video-producer/SKILL.md.
2. Read only the lessons needed under plugin/knowledge/.
3. After legitimate Muse access, grant its own project-scoped GitHub/Drive connection and read this repository. Existing ChatGPT connections cannot simply be transferred.
4. Use prompts/MUSE-BOOTSTRAP.md once, retain task/attempt IDs, then run the curriculum.
5. Use tools/academy.py for offline job compilation, gate checks and receipt contract checks.
6. Complete actual media tests, independent QA and native AGY callback acceptance before retiring ChatGPT from routine production.

No network or generation is performed by these Python tools. Python 3.10+ standard library only.
```text
python tools/academy.py doctor .
python tools/academy.py compile examples/brief.json --policy config/delegation.json --out task.json
python tools/academy.py check-receipt --job examples/job.json --receipt examples/receipt-unknown.json
python -m unittest discover -s tests -v
```

The plugin is skills-only. It does not attach an MCP server, carry credentials, control another product's permissions, or circumvent Muse regional access. connector/contract.json is a design for an adapter to the existing canonical AGY controller, not an invented live endpoint.

## Acceptance

Knowledge delivery requires an actual Muse receipt citing source revisions. Learning requires observed correct execution on calibration and separately held-out tasks. Video acceptance requires exported media, full-duration viewing/listening, scene/identity/contact/continuity checks, source provenance, trace and cost evidence. Unattended acceptance additionally requires client-disconnect completion and independent result/callback readback without duplicate effects.

Publishing, purchases, additional paid usage, destructive data actions and canon/IP changes remain excluded by the owner. New plugin Connect/Install is performed by the account owner. No public release is requested.
