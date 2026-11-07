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

// digestOf(undefined) is REJECTED with a typed error. It must
// never be silently mapped to null: digestOf(null) is the real
// digest of a real null payload, so an undefined (missing)
// payload mapping to it would let absence verify as content -
// a collision. Every DEFINED value keeps its historical digest.
export const digestOf = (v: unknown): string => {
  const s = stableStringify(v);
  if (typeof s !== 'string') throw new Error('DIGEST_INPUT_INVALID');
  return createHash('sha256').update(s).digest('hex');
};

export const isDigestHex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
