import type { ScheduleMode, TaskSpec } from "./types.js";

export interface RoutingDecision { mode: ScheduleMode; tasks: TaskSpec[]; rationale: string }

/**
 * Rule-based V1 routing. Parallelism is earned by useful capability and quality gain;
 * it is never created merely to use more workers.
 */
export function routeTasks(tasks: TaskSpec[], requested?: ScheduleMode, options: { preserveWholeTask?: boolean; parallelQualityGain?: number; contextLossRisk?: number; coordinationCost?: number } = {}): RoutingDecision {
  if (tasks.length <= 1 || options.preserveWholeTask) return { mode: "SINGLE_WORKFLOW", tasks, rationale: "Keep cohesive work with one capable worker when splitting has no evidenced benefit." };
  const hasDependencies = tasks.some((task) => (task.dependsOn?.length ?? 0) > 0);
  if (hasDependencies || requested === "DAG") return { mode: "DAG", tasks, rationale: "Explicit dependencies require dependency-aware scheduling." };
  const independent = new Set(tasks.map((task) => task.idempotencyKey)).size === tasks.length;
  const sharedKeys = tasks.map(t => t.sharedStateKey).filter(Boolean);
  const conflict = new Set(sharedKeys).size < sharedKeys.length;
  const usefulGain = (options.parallelQualityGain ?? 1) > (options.contextLossRisk ?? 0) + (options.coordinationCost ?? 0);
  if (independent && !conflict && usefulGain && requested !== "SINGLE_WORKFLOW") return { mode: requested === "MULTI_JOB_CONCURRENT" ? requested : "PARALLEL_BATCH", tasks, rationale: "Independent useful work can use available capacity while preserving quality and reserve." };
  return { mode: "SINGLE_WORKFLOW", tasks, rationale: "Preserve context and avoid mechanical worker splitting." };
}

export interface WorkerProfile {
  workerId: string; capabilities: string[]; ready: boolean; centralBrain: boolean;
  activeCount: number; maxConcurrency: number; quotaRemaining: number | null; quotaReserve: number;
  passRate: number; retryRate: number; errorRate: number; contextLossRisk: number;
  costPerTask: number | null; learningValue: number;
}
const centralTypes = new Set(["strategy", "orchestration", "architecture", "difficult_reasoning", "conflict_resolution", "difficult_qa", "final_judgment", "high_risk_qa"]);
/** Latency is telemetry only. Hard constraints are evaluated before utility. */
export function allocateTask(task: TaskSpec, workers: WorkerProfile[], passThreshold: number, excludedWorkers: string[] = []) {
  const evaluated = workers.map(w => {
    let reason = "eligible";
    if (task.permissionGranted !== true || task.safetyApproved !== true) reason = "permission/safety evidence missing";
    else if (excludedWorkers.includes(w.workerId)) reason = "failed worker excluded for recovery";
    else if (!w.ready) reason = "not READY";
    else if (w.activeCount >= w.maxConcurrency) reason = "concurrency bottleneck";
    else if (!(task.requiredCapabilities ?? []).every(c => w.capabilities.includes(c))) reason = "capability mismatch";
    else if (w.passRate < passThreshold) reason = "PASS history below threshold";
    else if (w.quotaRemaining === null || task.estimatedQuota === undefined) reason = "quota estimate unavailable";
    else if (w.quotaRemaining - task.estimatedQuota < w.quotaReserve) reason = "protect recovery/high-priority reserve";
    if (reason !== "eligible") return { workerId: w.workerId, score: null as number | null, reason };
    const usefulCapacity = 1 - w.activeCount / w.maxConcurrency;
    const quotaEfficiency = 1 - (task.estimatedQuota ?? 0) / Math.max(1, w.quotaRemaining! - w.quotaReserve);
    const centralLoad = w.centralBrain && !centralTypes.has(task.taskType) ? 2 + w.activeCount / w.maxConcurrency : 0;
    const score = 4*w.passRate + usefulCapacity + quotaEfficiency + .25*w.learningValue
      - 2*w.retryRate - 2*w.errorRate - 2*w.contextLossRisk - .1*(w.costPerTask ?? 0) - centralLoad;
    return { workerId: w.workerId, score, reason };
  });
  const best = evaluated.filter(e => e.score !== null).sort((a,b) => b.score! - a.score! || a.workerId.localeCompare(b.workerId))[0];
  return { workerId: best?.workerId ?? null, score: best?.score ?? null, rationale: best ? "Highest useful resource allocation after hard gates" : "BLOCKED: no eligible resource", evaluated };
}
export function queuePriority(task: TaskSpec): number {
  return (task.priority ?? 0) + Math.round(10*Math.min(1,Math.max(0,task.importance ?? .5)) + 5*Math.min(1,Math.max(0,task.expectedValue ?? .5)));
}

export function needsIndependentQa(task: TaskSpec, score: number | undefined, threshold: number): boolean {
  return task.risk === "HIGH" || score === undefined || score < threshold;
}
