// Server-side dispatch controls for the agy.dispatch tool
// (execution-grant package v1.2.1, section 6.1 - MANDATORY
// design requirements for the facade change D-G7).
//
// This module is the facade-side enforcement point for the
// write tool. It implements, in one place, the controls the
// grant package requires IN ADDITION to OAuth scope checks:
//
//   6.1.1  server-side allowlist of dispatch clients - a token
//          carrying the agy.dispatch scope is NOT sufficient;
//          the client_id must also be on this allowlist.
//   6.1.2  role / task-class / run limits, all server-side:
//          (i) only clients whose registered role is
//          'dispatcher' may dispatch; (ii) only the task
//          classes listed for the open phase (P0/P1:
//          provider-less HELLO) may be created; (iii) dispatch
//          is valid only inside an opened run window
//          (run_id + scope + opens_at/closes_at).
//   6.1.3  per-identity rate limit (the concrete number is a
//          PROVISIONING parameter set by the Control Plane in
//          the P0 run sheet - it arrives via configuration,
//          it is not hardcoded as if already decided).
//   6.1.4  anti-replay: every dispatch carries a unique
//          idempotency_key + nonce + timestamp. A verbatim
//          replay (same key AND same nonce) inside the
//          timestamp window reconciles to the ORIGINAL result
//          and never creates a second task; the same key with
//          a different nonce is an IDEMPOTENCY_CONFLICT; a
//          timestamp outside the allowed skew is rejected.
//   6.1.7  revocation modes, facade side: a client whose
//          registered status is 'drain' cannot create new work
//          (dispatch denied - dispatch IS new-work creation);
//          a client whose status is 'revoked' is denied here
//          too, as defence in depth (its tokens are already
//          rejected in verifyAccessToken - HARD_REVOKE).
//
// State note: the ledger and rate buckets are in-memory in
// this candidate. The facade runs as ONE Railway service
// instance, so this is sufficient for the P0 proof; a move to
// multi-instance or restart-durable anti-replay requires
// persisting the ledger (e.g. in the OAuth Postgres store)
// and is listed as a deploy-time decision in the plan. A
// facade restart clears the ledger - the upstream gateway
// remains the second line of defence: its dispatch action
// reserves by workflow id derived from the mission contract
// and returns duplicate:true instead of starting twice
// (src/temporal/gateway.ts, bridge.reserve).

function deny(code) { const e = new Error(code); e.code = code; return e; }

export function createDispatchControl(cfg, now = Date.now) {
  if (!cfg || !Array.isArray(cfg.allowlist) || !Array.isArray(cfg.taskTypes) || !Array.isArray(cfg.runs))
    throw new Error('dispatch-control: allowlist, taskTypes and runs arrays are required');
  const rateLimitMax = cfg.rateLimitMax ?? 6;
  const rateLimitWindowMs = cfg.rateLimitWindowMs ?? 60_000;
  const timestampSkewMs = cfg.timestampSkewMs ?? 300_000;
  if (!(rateLimitMax >= 1) || !(rateLimitWindowMs > 0) || !(timestampSkewMs > 0))
    throw new Error('dispatch-control: rate limit and skew parameters must be positive');
  for (const r of cfg.runs) {
    if (!r.run_id || !r.scope || !Number.isFinite(r.opens_at) || !Number.isFinite(r.closes_at) || r.closes_at <= r.opens_at)
      throw new Error('dispatch-control: every run needs run_id, scope and a valid opens_at < closes_at window');
  }
  const ledger = new Map();   // `${clientId}\n${idempotencyKey}` -> { nonce, result }
  const buckets = new Map();  // clientId -> number[] (ms timestamps of admitted NEW dispatches)

  return {
    // Runs every 6.1 check for one dispatch attempt. Returns
    // { replay:false, record(result) } when the caller may
    // proceed to the upstream, or { replay:true, result }
    // when the attempt is a verbatim replay of an already
    // recorded dispatch. Throws an Error whose message is the
    // machine-readable denial code otherwise.
    check({ clientId, role, status, scope, taskType, runId, idempotencyKey, nonce, timestamp }) {
      if (status === 'revoked') throw deny('CLIENT_HARD_REVOKED');
      if (status === 'drain') throw deny('CLIENT_IN_DRAIN');
      if (!cfg.allowlist.includes(clientId)) throw deny('DISPATCH_NOT_ALLOWLISTED');
      if (role !== 'dispatcher') throw deny('DISPATCH_ROLE_DENIED');
      if (!cfg.taskTypes.includes(taskType)) throw deny('TASK_TYPE_NOT_ALLOWLISTED');
      const t = now();
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || Math.abs(t - timestamp) > timestampSkewMs)
        throw deny('TIMESTAMP_OUT_OF_WINDOW');
      const lkey = `${clientId}\n${idempotencyKey}`;
      const prev = ledger.get(lkey);
      if (prev) {
        if (prev.nonce !== nonce) throw deny('IDEMPOTENCY_CONFLICT');
        return { replay: true, result: prev.result };
      }
      const run = cfg.runs.find((r) => r.run_id === runId);
      if (!run) throw deny('RUN_NOT_OPEN');
      if (run.scope !== scope) throw deny('RUN_SCOPE_MISMATCH');
      if (t < run.opens_at || t > run.closes_at) throw deny('RUN_NOT_OPEN');
      const arr = (buckets.get(clientId) ?? []).filter((x) => t - x < rateLimitWindowMs);
      if (arr.length >= rateLimitMax) { buckets.set(clientId, arr); throw deny('RATE_LIMITED'); }
      arr.push(t); buckets.set(clientId, arr);
      return { replay: false, record(result) { ledger.set(lkey, { nonce, result }); } };
    },
  };
}
