import { allocateDemand } from '../resources/allocation.js';
import type { Resource } from '../resources/types.js';
import type { TaskSpec } from '../types.js';
import { scopeKey,type Project } from './scope.js';
export interface ProjectDemand {project:Project;jobId:string;task:TaskSpec;taskId?:string;excluded?:string[];allowedWorkers?:string[];active:number;quotaUsed:number;spendUsed:number;passThreshold:number}
/** Policy only. A database dispatcher must atomically recheck and reserve the selected demand. */
export function selectProjectDemand(demand:ProjectDemand[],resources:Resource[],now=Date.now()) {
 const sorted=demand.filter(d=>d.project.status==='ACTIVE').sort((a,b)=>b.project.priority-a.project.priority || Number(b.active<b.project.resourcePolicy.reservation)-Number(a.active<a.project.resourcePolicy.reservation) || (b.task.priority??0)-(a.task.priority??0) || a.jobId.localeCompare(b.jobId));
 for(const d of sorted) {
  const p=d.project.resourcePolicy;
  if([p.maxConcurrentTasks,p.quotaCap,p.spendCap,p.reservation,d.quotaUsed,d.spendUsed,d.active].some(n=>!Number.isFinite(n)||n<0))continue;
  if(d.active>=p.maxConcurrentTasks||d.task.estimatedQuota===undefined||d.task.estimatedCost===undefined||d.quotaUsed+d.task.estimatedQuota>p.quotaCap||d.spendUsed+d.task.estimatedCost>p.spendCap||(d.task.requiredPermissions??[]).some(permission=>!d.project.permissions.includes(permission)))continue;
  const result=allocateDemand({...d.task,jobId:d.jobId},d.allowedWorkers?resources.filter(r=>d.allowedWorkers!.includes(r.workerId)):resources,now,d.passThreshold,d.excluded);
  if(result.workerId)return {scope:scopeKey(d.project),jobId:d.jobId,taskId:d.taskId,task:d.task,allocation:result};
 }
 return null;
}
