import type { Resource } from "./types.js";
export type FailureKind = "RATE_LIMIT" | "TRANSIENT" | "PERMISSION" | "INVALID_INPUT" | "TIMEOUT";
export function failurePolicy(resource: Resource, kind: FailureKind, attempt: number, maxRetry: number, now: number, retryAfterMs=1000) {
  resource.consecutiveFailures++;
  if(kind==="RATE_LIMIT") {resource.rateLimitedUntil=now+Math.max(1000,retryAfterMs);resource.status="RATE_LIMITED";}
  else if(kind==="PERMISSION") resource.status="OFFLINE";
  else resource.status="DEGRADED";
  if(resource.consecutiveFailures>=3) resource.circuitOpenUntil=now+30000;
  resource.ready=false;
  const retryable=kind!=="PERMISSION" && kind!=="INVALID_INPUT" && attempt<=maxRetry;
  return { action:retryable?"REROUTE":"BLOCKED", availableAt:now+Math.max(retryAfterMs,Math.min(30000,1000*2**Math.max(0,attempt-1))), circuitOpen:resource.circuitOpenUntil>now };
}
export interface Checkpoint { taskId:string; attemptId:string; version:number; data:Record<string,unknown>; digest:string; externalId?:string; writtenAt:number }
export function resumeCheckpoint(checkpoint:Checkpoint, taskId:string, digest:string) {
  if(checkpoint.taskId!==taskId || checkpoint.digest!==digest)throw new Error("CHECKPOINT_CONTEXT_MISMATCH");
  return structuredClone(checkpoint);
}
