// Fail-closed worker routing gate for the QUALIFICATION namespace
// (candidate, AGY-GLSEO-ROUTE-QUALIFY-20261027; tightened in v4 per QA
// finding T3). One implementation, used inside PostgresStore.claim's
// scoped selection, BEFORE any task row is mutated.
//
// This namespace is deliberately strict — stricter than the legacy
// engine route, which passes no gate and keeps its original semantics:
//  - The worker's bindings must be fully provisioned by the control
//    plane: missions, task_types AND reply_targets, each a non-empty
//    list. (The surface validates the shape before a gate is built;
//    this predicate independently treats absent/empty lists as deny.)
//  - A task is claimable only when it EXPLICITLY carries all three
//    routing attributes and they match the worker:
//      payload.mission_id       present and listed in bindings.missions
//      payload.target_worker_id present and equal to this worker
//      payload.callback_target  present and listed in
//                               bindings.reply_targets (the immutable
//                               reply target — never defaulted)
//    plus payload.auto_dispatch !== false and the task type listed in
//    bindings.task_types. Missing, null, or malformed attributes deny
//    the task: zero attempts, zero reservations.
export interface WorkerGate {
  workerId: string;
  missions?: string[] | null;
  taskTypes?: string[] | null;
  replyTargets?: string[] | null;
}

const nonEmpty = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);

export function bindingsComplete(b: { missions?: unknown; task_types?: unknown; reply_targets?: unknown } | null | undefined): boolean {
  return !!b && nonEmpty(b.missions) && nonEmpty(b.task_types) && nonEmpty(b.reply_targets);
}

export function workerGatePasses(gate: WorkerGate, spec: { taskType?: string; payload?: Record<string, unknown> | null }): boolean {
  const p = (spec?.payload ?? {}) as Record<string, unknown>;
  if (p.auto_dispatch === false) return false;
  if (!nonEmpty(gate.missions) || !nonEmpty(gate.taskTypes) || !nonEmpty(gate.replyTargets)) return false;
  if (typeof p.mission_id !== 'string' || !p.mission_id || !gate.missions!.includes(p.mission_id)) return false;
  if (p.target_worker_id !== gate.workerId) return false;
  if (typeof p.callback_target !== 'string' || !p.callback_target || !gate.replyTargets!.includes(p.callback_target)) return false;
  if (!spec?.taskType || !gate.taskTypes!.includes(spec.taskType)) return false;
  return true;
}
