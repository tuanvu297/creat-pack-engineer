type Json = Record<string, unknown>;

const json = (body: Json, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
});

const statePlaneReady = () => Boolean(Bun.env.SUPABASE_URL && Bun.env.SUPABASE_SERVICE_ROLE_KEY);

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

    if (req.method !== "POST") return json({ status: "METHOD_NOT_ALLOWED" }, 405);

    const body = await bodyJson(req);

    if (url.pathname === "/workers/register") {
      return rpc("agy_gateway_rpc", { p_action: "register_worker", p_payload: body });
    }

    if (url.pathname === "/tasks/create") {
      return rpc("agy_gateway_rpc", { p_action: "create_task", p_payload: body });
    }

    if (url.pathname === "/tasks/claim") {
      const missing = requireHeaders(req, ["x-agy-worker-id"]);
      if (missing.length) return json({ status: "BLOCKED_CONTRACT", missing_headers: missing }, 400);
      const payload = { ...body, worker_id: req.headers.get("x-agy-worker-id") };
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
      const payload = { ...body, ...contractFromHeaders(req) };
      return rpc("agy_gateway_rpc", { p_action: actionMap[url.pathname], p_payload: payload });
    }

    if (url.pathname === "/callback") {
      const required = ["x-agy-task-id", "x-agy-attempt-id", "x-agy-idempotency-key", "x-agy-trace-id"];
      const missing = requireHeaders(req, required);
      if (missing.length) return json({ status: "BLOCKED_CONTRACT", missing_headers: missing }, 400);
      const headers = contractFromHeaders(req);
      const payload = { ...body, task_id: headers.task_id, attempt_id: headers.attempt_id, idempotency_key: headers.idempotency_key, trace_id: headers.trace_id };
      return rpc("agy_gateway_callback_rpc", { p_payload: payload });
    }

    return json({ status: "NOT_FOUND" }, 404);
  },
};
