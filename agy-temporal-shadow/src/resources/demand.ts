import { queuePriority } from "../scheduler.js";
import type { TaskSpec } from "../types.js";
import type { ReservePurpose, Resource } from "./types.js";
export interface Demand extends TaskSpec { jobId: string; estimatedCost?: number; requiredPermissions?: string[]; purpose?: ReservePurpose }
export function orderBacklog(backlog: Demand[], passedDependencies: Set<string>): Demand[] {
  return backlog.filter(task=>(task.dependsOn??[]).every(dep=>passedDependencies.has(dep)))
    .sort((a,b)=>queuePriority(b)-queuePriority(a)||a.idempotencyKey.localeCompare(b.idempotencyKey));
}
export function protectedReserve(resource: Resource, purpose?: ReservePurpose): number {
  const pools = Object.values(resource.reserveByPurpose).reduce((a,b)=>a+b,0);
  return Math.max(resource.quotaReserve,pools) - (purpose ? Math.min(Math.max(resource.quotaReserve,pools),resource.reserveByPurpose[purpose]) : 0);
}
