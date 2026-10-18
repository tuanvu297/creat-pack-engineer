import { randomUUID } from "node:crypto";
import type { ClaimRequest, ClaimedTask, EngineStore, ScheduleMode, TaskSpec, TaskStatus } from "../src/types.js";

type Internal = ClaimedTask & { tenantId:string; availableAt:number; leaseExpiresAt:Date; order:number; result?:unknown; error?:unknown };
export class InMemoryStore implements EngineStore {
  jobs=new Map<string,{jobId:string;tenantId:string;idempotencyKey:string;mode:ScheduleMode}>(); tasks=new Map<string,Internal>(); telemetry:any[]=[]; now=()=>Date.now(); private order=0;
  async createJob(input:{tenantId:string;idempotencyKey:string;objective:string;mode:ScheduleMode;passThreshold:number;tasks:TaskSpec[]}){
    const key=`${input.tenantId}:${input.idempotencyKey}`; const existing=this.jobs.get(key); if(existing)return{jobId:existing.jobId,duplicate:true};
    const jobId=randomUUID();this.jobs.set(key,{jobId,tenantId:input.tenantId,idempotencyKey:input.idempotencyKey,mode:input.mode});const ids=new Map(input.tasks.map(t=>[t.idempotencyKey,randomUUID()]));
    for(const spec of input.tasks){const taskId=ids.get(spec.idempotencyKey)!;this.tasks.set(taskId,{...spec,taskId,jobId,tenantId:input.tenantId,status:"QUEUED",attempt:0,leaseToken:"",leaseExpiresAt:new Date(0),availableAt:this.now(),order:this.order++,dependsOn:(spec.dependsOn??[]).map(k=>ids.get(k)!)})}return{jobId,duplicate:false};
  }
  async claim(req:ClaimRequest){const candidates=[...this.tasks.values()].filter(t=>(t.status==="QUEUED"||t.status==="RETRY")&&t.availableAt<=this.now()&&(t.requiredCapabilities??[]).every(c=>req.capabilities.includes(c))&&(t.dependsOn??[]).every(id=>this.tasks.get(id)?.status==="PASS")).sort((a,b)=>(b.priority??0)-(a.priority??0)||a.order-b.order);const task=candidates[0];if(!task)return null;task.status="CLAIMED";task.attempt++;task.leaseToken=randomUUID();task.leaseExpiresAt=new Date(this.now()+req.leaseSeconds*1000);return structuredClone(task);}
  async heartbeat(taskId:string,workerId:string,leaseToken:string,leaseSeconds:number){const t=this.tasks.get(taskId);if(!t||t.leaseToken!==leaseToken||t.leaseExpiresAt.getTime()<=this.now()||!["CLAIMED","RUNNING"].includes(t.status))return false;t.leaseExpiresAt=new Date(this.now()+leaseSeconds*1000);return true;}
  async transition(taskId:string,leaseToken:string,from:TaskStatus[],to:TaskStatus,patch:Record<string,unknown>={}){const t=this.tasks.get(taskId);if(!t||t.leaseToken!==leaseToken||!from.includes(t.status))return false;t.status=to;if("result" in patch)t.result=patch.result;if("error" in patch)t.error=patch.error;return true;}
  async reclaimExpired(){let count=0;for(const t of this.tasks.values())if(["CLAIMED","RUNNING"].includes(t.status)&&t.leaseExpiresAt.getTime()<this.now()){t.status=t.attempt<=Number(t.maxRetry??0)?"RETRY":"BLOCKED";t.leaseToken="";count++;}return count;}
  async recordTelemetry(input:Record<string,unknown>){this.telemetry.push(input)}
}
