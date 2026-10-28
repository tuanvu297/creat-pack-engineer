// AGY gateway — CANDIDATE v2 (phase: AGY-GLSEO-ROUTE-QUALIFY-20261027 / A1)
// Supersedes agy-gateway.candidate.ts (v1) after Control Plane QA.
// Derived from the deployed Railway Function source collected 2026-10-27
// (deployment f3305b2d-96ea-4a5a-a332-013735300eb6). NOT DEPLOYED.
// v2 changes: caller registry parsing fails closed on any malformed entry
// (missing/unknown provider or role, non-hex token hash, duplicate worker),
// and a new authenticated GET /tasks/{task_id}/readback route exposes the
// stored task/result/callback rows via the RPC readback action — a recorded
// PENDING callback is never presented as delivered or accepted.
// Canonical authority remains EXISTING_POSTGRES_D049. This gateway fronts the
// Supabase SHADOW state plane only; nothing here makes the shadow canonical.
//
// Changes vs the deployed source:
//  1. Caller authentication on every POST route. Callers are provisioned
//     server-side in AGY_GATEWAY_CALLERS_JSON as
//     [{worker_id, provider, role: "WORKER"|"CONTROL", token_sha256}].
//     The presented bearer token is hashed and compared in constant time.
//     Identity (worker_id, provider, role) comes ONLY from this mapping —
//     never from request headers or body, which are self-asserted there.
//  2. Identity headers/body fields that disagree with the authenticated
//     caller are rejected (403 IDENTITY_MISMATCH) instead of trusted.
//  3. /tasks/create requires a CONTROL caller.
//  4. The server injects payload._caller = {worker_id, provider, role} into
//     every RPC payload after stripping any client-supplied "_" keys; the
//     RPC layer cross-checks it against the claimed identity.
//  5. /callback now requires the full lease identity header set, and the
//     client-supplied `target` and `callback_status` body fields are
//     stripped: the target is derived server-side and the stored status is
//     forced to PENDING by the callback RPC (immutable reply).
//  6. /health stays public and read-only, as in the deployed source.
import { createHash, timingSafeEqual } from "node:crypto";

type Json = Record<string, unknown>;

type Caller = { worker_id: string; provider: string; role: "WORKER" | "CONTROL"; token_sha256: string };

const json = (body: Json, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

const statePlaneReady = () => Boolean(Bun.env.SUPABASE_URL && Bun.env.SUPABASE_SERVICE_ROLE_KEY);

const PROVIDERS = ["R11", "MUSE", "GEMINI"];
const ROLES = ["WORKER", "CONTROL"];

function callers(): Caller[] {
  // Fail closed: any malformed registry content means NO caller is trusted,
  // never a partial or defaulted identity set.
  let parsed: unknown;
  try { parsed = JSON.parse(Bun.env.AGY_GATEWAY_CALLERS_JSON ?? "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const valid: Caller[] = [];
  for (const c of parsed as Caller[]) {
    if (!c || typeof c.worker_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(c.worker_id)) return [];
    if (!PROVIDERS.includes(c.provider) || !ROLES.includes(c.role)) return [];
    if (typeof c.token_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(c.token_sha256)) return [];
    if (seen.has(c.worker_id)) return [];
    seen.add(c.worker_id);
    valid.push(c);
  }
  return valid;
}

function authenticate(req: Request): Caller | null {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const digest = createHash("sha256").update(match[1], "utf8").digest();
  for (const caller of callers()) {
    let expected: Buffer;
    try { expected = Buffer.from(caller.token_sha256, "hex"); } catch { continue; }
    if (expected.length === digest.length && timingSafeEqual(expected, digest)) return caller;
  }
  return null;
}

async function bodyJson(req: Request): Promise<Json> {
  if (!req.body) return {};
  try { return await req.json() as Json; } catch { return {}; }
}

function requireHeaders(req: Request, names: string[]) {
  return names.filter((name) => !req.headers.get(name));
}

function contractFromHeaders(req: Request): Json {
  const fenceRaw = req.headers.get("x-agy-fence");
  return {
    task_id: req.headers.get("x-agy-task-id") ?? undefined,
    attempt_id: req.headers.get("x-agy-attempt-id") ?? undefined,
    idempotency_key: req.headers.get("x-agy-idempotency-key") ?? undefined,
    trace_id: req.headers.get("x-agy-trace-id") ?? undefined,
    worker_id: req.headers.get("x-agy-worker-id") ?? undefined,
    lease_token: req.headers.get("x-agy-lease-token") ?? undefined,
    fence: fenceRaw ? Number(fenceRaw) : undefined,
  };
}

// Client bodies may not carry server-owned fields ("_"-prefixed) and may not
// override identity the server derives. Returns a sanitized copy.
function sanitizeBody(body: Json, strip: string[] = []): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith("_") || strip.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

function withCaller(payload: Json, caller: Caller): Json {
  return { ...payload, _caller: { worker_id: caller.worker_id, provider: caller.provider, role: caller.role } };
}

async function rpc(name: string, payload: Json): Promise<Response> {
  const base = Bun.env.SUPABASE_URL;
  const key = Bun.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return json({ status: "BLOCKED_STATE_PLANE_CREDENTIAL", retryable: false }, 503);

  const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json",
      "apikey": key,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 1000) }; }
  if (!res.ok) {
    return json({ status: "STATE_PLANE_ERROR", http_status: res.status, error: data }, res.status >= 500 ? 502 : 409);
  }
  return json((data ?? { status: "PASS" }) as Json, 200);
}

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      if (!statePlaneReady()) {
        return json({ service: "agy-gateway", mode: "STAGING", status: "BLOCKED_CREDENTIAL", canonical_authority: "EXISTING_POSTGRES_D049" }, 503);
      }
      const state = await rpc("agy_gateway_rpc", { p_action: "health", p_payload: {} });
      if (!state.ok) return state;
      const body = await state.json() as Json;
      return json({ service: "agy-gateway", gateway: "PASS", state_plane: body, canonical_authority: "EXISTING_POSTGRES_D049", shadow_state_plane: "SUPABASE_AGY_SHADOW" });
    }

    const readbackMatch = req.method === "GET" ? /^\/tasks\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/readback$/.exec(url.pathname) : null;
    if (readbackMatch) {
      const caller = authenticate(req);
      if (!caller) return json({ status: "UNAUTHENTICATED", retryable: false }, 401);
      const payload = withCaller({ task_id: readbackMatch[1], worker_id: caller.worker_id }, caller);
      return rpc("agy_gateway_rpc", { p_action: "readback", p_payload: payload });
    }

    if (req.method !== "POST") return json({ status: "METHOD_NOT_ALLOWED" }, 405);

    const caller = authenticate(req);
    if (!caller) return json({ status: "UNAUTHENTICATED", retryable: false }, 401);

    const body = sanitizeBody(await bodyJson(req));

    if (url.pathname === "/workers/register") {
      const targetWorker = typeof body.worker_id === "string" ? body.worker_id : caller.worker_id;
      if (caller.role !== "CONTROL" && targetWorker !== caller.worker_id) {
        return json({ status: "IDENTITY_MISMATCH", reason: "workers may only register themselves" }, 403);
      }
      if (caller.role !== "CONTROL" && typeof body.provider === "string" && body.provider !== caller.provider) {
        return json({ status: "IDENTITY_MISMATCH", reason: "provider must match the authenticated caller" }, 403);
      }
      const payload = withCaller({ ...body, worker_id: targetWorker, provider: caller.role === "CONTROL" && typeof body.provider === "string" ? body.provider : caller.provider, role: caller.role === "CONTROL" && typeof body.role === "string" ? body.role : "WORKER" }, caller);
      return rpc("agy_gateway_rpc", { p_action: "register_worker", p_payload: payload });
    }

    if (url.pathname === "/tasks/create") {
      if (caller.role !== "CONTROL") return json({ status: "FORBIDDEN_ROLE", reason: "task creation is control-plane only" }, 403);
      return rpc("agy_gateway_rpc", { p_action: "create_task", p_payload: withCaller(body, caller) });
    }

    if (url.pathname === "/tasks/claim") {
      const headerWorker = req.headers.get("x-agy-worker-id");
      if (headerWorker && headerWorker !== caller.worker_id) {
        return json({ status: "IDENTITY_MISMATCH", reason: "x-agy-worker-id does not match the authenticated caller" }, 403);
      }
      // worker_id and provider are server-derived from the caller identity;
      // any body-supplied routing fields are ignored on purpose.
      const payload = withCaller({ lease_seconds: typeof body.lease_seconds === "number" ? body.lease_seconds : undefined, worker_id: caller.worker_id, provider: caller.provider }, caller);
      return rpc("agy_gateway_claim_rpc", { p_payload: payload });
    }

    const actionMap: Record<string, string> = {
      "/ack": "ack",
      "/heartbeat": "heartbeat",
      "/checkpoint": "checkpoint",
      "/result": "result",
    };

    if (url.pathname in actionMap) {
      const required = ["x-agy-task-id", "x-agy-attempt-id", "x-agy-idempotency-key", "x-agy-trace-id", "x-agy-worker-id", "x-agy-lease-token", "x-agy-fence"];
      const missing = requireHeaders(req, required);
      if (missing.length) return json({ status: "BLOCKED_CONTRACT", missing_headers: missing }, 400);
      const contract = contractFromHeaders(req);
      if (contract.worker_id !== caller.worker_id) {
        return json({ status: "IDENTITY_MISMATCH", reason: "lease identity does not match the authenticated caller" }, 403);
      }
      const payload = withCaller({ ...body, ...contract }, caller);
      return rpc("agy_gateway_rpc", { p_action: actionMap[url.pathname], p_payload: payload });
    }

    if (url.pathname === "/callback") {
      // Callback is a lease action: the full identity header set is required,
      // and target/status are NOT accepted from the caller. The RPC derives
      // the target from the task record and stores the reply as PENDING.
      const required = ["x-agy-task-id", "x-agy-attempt-id", "x-agy-idempotency-key", "x-agy-trace-id", "x-agy-worker-id", "x-agy-lease-token", "x-agy-fence"];
      const missing = requireHeaders(req, required);
      if (missing.length) return json({ status: "BLOCKED_CONTRACT", missing_headers: missing }, 400);
      const contract = contractFromHeaders(req);
      if (contract.worker_id !== caller.worker_id) {
        return json({ status: "IDENTITY_MISMATCH", reason: "lease identity does not match the authenticated caller" }, 403);
      }
      const clean = sanitizeBody(body, ["target", "callback_status", "status"]);
      const payload = withCaller({
        ...clean,
        task_id: contract.task_id,
        attempt_id: contract.attempt_id,
        idempotency_key: contract.idempotency_key,
        trace_id: contract.trace_id,
        worker_id: contract.worker_id,
        lease_token: contract.lease_token,
        fence: contract.fence,
      }, caller);
      return rpc("agy_gateway_callback_rpc", { p_payload: payload });
    }

    return json({ status: "NOT_FOUND" }, 404);
  },
};
