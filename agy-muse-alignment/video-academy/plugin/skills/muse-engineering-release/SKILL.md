---
name: muse-engineering-release
description: "Implement and package scoped AGY adapters, scripts and reusable skills with regression, idempotency and evidence checks. Use for Muse engineering handoff; no deployment, account grants or purchases are implied."
---

# Engineering and release

Read ../../knowledge/06-engineering-and-learning.md. Inspect the actual repository, project instructions and pinned deployed source before changing code. Extend the existing canonical controller; do not build a second queue/database just to obtain a green demo.

Define the defect or required behavior and a meaningful acceptance test. Implement the smallest scoped change, exercise positive and denied cases, and close the verifier that found the issue. Mocks validate adapter logic, not provider-owned behavior. Never label a local/synthetic test as live Muse, video or callback acceptance.

Preserve existing idempotency and operation state through interruption/restart. Treat source commits, dependency locks, schema/transport/auth interfaces and user scopes as part of the handoff. Store no secrets in code or packages. A tool broker must authorize server-side project/worker/action and validate artifact/receipt identities.

Use drafts and isolated staging inside the owner's authorization. A generated plugin needs valid manifests, complete references, reproducible archive/hash, structural validation and an honest capability description. Installation/connection and production promotion remain separate from packaging.

