import type { WorkerAdapter } from "../types.js";
import type { Resource, ResourceStatus } from "./types.js";

export const builtInResourceKinds = ["ChatGPT","Gemini","Muse","Codex","Flow/Veo","CLI/scripts","MCP/API/connectors"];
// Names are discovery hints only: registration never restricts future providers.
export function discoverResource(workerId: string, capabilities: string[], now: number, model?: string): Resource {
  return { workerId,capabilities:[...capabilities],model,status:"OFFLINE",ready:false,centralBrain:false,
    activeCount:0,maxConcurrency:1,quotaRemaining:null,quotaReserve:0,passRate:0,retryRate:1,errorRate:1,
    contextLossRisk:1,costPerTask:null,learningValue:0,permissions:[],lastHealthAt:now,
    rateLimitedUntil:0,consecutiveFailures:0,circuitOpenUntil:0,spendUsed:0,spendCap:null,
    quotaUsed:0,quotaCap:null,reservedQuota:0,reserveByPurpose:{RETRY:0,RECOVERY:0,HIGH_PRIORITY:0,FINAL_QA:0,UNEXPECTED:0},version:1 };
}
export async function probeAdapter(adapter: WorkerAdapter, timeoutMs = 1000): Promise<{status:ResourceStatus;detail?:string}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const health = await Promise.race([adapter.health(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("HEALTH_TIMEOUT")),timeoutMs);})]);
    return { status:health.ready ? "READY" : "OFFLINE",detail:health.detail };
  } catch(error) {return {status:"DEGRADED",detail:String(error)};} finally {if(timer)clearTimeout(timer);}
}
export function availability(resource: Resource, now: number): ResourceStatus {
  if (resource.lastHealthAt < now - 60000) return "OFFLINE";
  if (resource.rateLimitedUntil > now) return "RATE_LIMITED";
  if (resource.circuitOpenUntil > now) return "DEGRADED";
  if (resource.status === "OFFLINE" || resource.status === "DEGRADED") return resource.status;
  return resource.activeCount >= resource.maxConcurrency ? "BUSY" : "READY";
}
