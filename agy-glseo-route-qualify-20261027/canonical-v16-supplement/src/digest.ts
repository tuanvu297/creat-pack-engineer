import { createHash } from 'node:crypto';

// Shared canonical JSON digest (candidate,
// AGY-GLSEO-ROUTE-QUALIFY-20261027): stable key-sorted stringify +
// sha256 hex. Used by the worker surface (result/checkpoint digests)
// AND by the callback receiver, which recomputes the digest of the
// immutable outbox payload instead of trusting a caller's claim.
export const stableStringify = (v: unknown): string => JSON.stringify(v, (_k, val) =>
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : val);

export const digestOf = (v: unknown): string => createHash('sha256').update(stableStringify(v)).digest('hex');

export const isDigestHex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
