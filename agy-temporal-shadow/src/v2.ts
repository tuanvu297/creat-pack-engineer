import { createHash } from "node:crypto";
import type { TaskSpec } from "./types.js";

export type Known<T> = { value: T | null; source: string | null; observedAt: number | null; confidence: number | null };
export type V2State = "DESIGNED"|"INSTRUCTED"|"IMPLEMENTING"|"TESTED"|"PASS"|"INTEGRATED"|"BLOCKED"|"FAIL";
export type WorkerFeedbackCode = "READY"|"NEEDS_CONTEXT"|"AMBIGUOUS_SPEC"|"MISSING_INPUT"|"CAPABILITY_MISMATCH"|"UNSAFE_TO_EXECUTE";
export type FailureCause = "WORKER_CAPABILITY"|"TASK_SPEC_DEFICIENCY"|"WORKER_INSTRUCTION_MISMATCH"|"TOOL_PROVIDER_FAILURE"|"ROUTING_ERROR"|"QA_RULE_ERROR"|"CONTEXT_LOSS"|"USER_REQUIREMENT_CHANGE"|"QUOTA_RESOURCE_ISSUE";

export interface ResourceRecord {
  resourceId:string; provider:string; sharedResourcePoolId:string|null; credentialClass:string;
  capabilities:string[]; permissions:string[]; health:"READY"|"DEGRADED"|"OFFLINE"|"UNKNOWN";
  quotaTotal:Known<number>; quotaRemaining:Known<number>; resetAt:Known<number>; rateLimitRemaining:Known<number>;
  creditBalance:Known<number>; marginalCost:Known<number>; activeSlots:Known<number>; reserveRequirement:number;
  acceptedClass:"DISCOVERED"|"CONTROLLED_TESTED"|"LIMITED_STAGING"|"ACCEPTED_STAGING"|"OPTIONAL_FALLBACK"|"BLOCKED";
}

export class ResourceRegistry {
  private records=new Map<string,ResourceRecord>();
  upsert(record:ResourceRecord){
    if(!record.resourceId||!record.provider)throw new Error("INVALID_RESOURCE");
    if(record.reserveRequirement<0||!Number.isFinite(record.reserveRequirement))throw new Error("INVALID_RESERVE");
    for(const field of [record.quotaTotal,record.quotaRemaining,record.resetAt,record.rateLimitRemaining,record.creditBalance,record.marginalCost,record.activeSlots]){
      if(field.value!==null&&(!Number.isFinite(field.value)||field.value<0))throw new Error("INVALID_TELEMETRY");
      if(field.value!==null&&(!field.source||field.observedAt===null||field.confidence===null))throw new Error("UNSOURCED_TELEMETRY");
    }
    this.records.set(record.resourceId,structuredClone(record));
  }
  snapshot(){return structuredClone([...this.records.values()]);}
}

export interface CanonicalTaskContract {
  missionId:string; jobId:string; taskId:string; intent:string; inputs:Record<string,unknown>; expectedOutput:string;
  constraints:string[]; passCriteria:string[]; context:Record<string,unknown>; risk:"LOW"|"MEDIUM"|"HIGH";
  dependencies:string[]; checkpoint:{idempotencyKey:string;digest:string}; requiredCapabilities:string[];
}
export function canonicalTask(input:Omit<CanonicalTaskContract,"checkpoint">&{idempotencyKey:string}):CanonicalTaskContract{
  if(!input.missionId||!input.jobId||!input.taskId||!input.intent||!input.expectedOutput||!input.passCriteria.length)throw new Error("INVALID_TASK_CONTRACT");
  const digest=createHash("sha256").update(JSON.stringify({intent:input.intent,inputs:input.inputs,expectedOutput:input.expectedOutput,constraints:input.constraints,passCriteria:input.passCriteria,context:input.context,risk:input.risk,dependencies:input.dependencies,requiredCapabilities:input.requiredCapabilities})).digest("hex");
  const {idempotencyKey,...rest}=input;return {...rest,checkpoint:{idempotencyKey,digest}};
}
export function compileForWorker(task:CanonicalTaskContract,worker:{id:string;capabilities:string[];style:"STRUCTURED"|"CONVERSATIONAL"}){
  const missing=task.requiredCapabilities.filter(c=>!worker.capabilities.includes(c));
  if(missing.length)return {feedback:"CAPABILITY_MISMATCH" as WorkerFeedbackCode,missing,instruction:null};
  const body={identity:{missionId:task.missionId,jobId:task.jobId,taskId:task.taskId,idempotencyKey:task.checkpoint.idempotencyKey},intent:task.intent,inputs:task.inputs,expectedOutput:task.expectedOutput,constraints:task.constraints,passCriteria:task.passCriteria,context:task.context,risk:task.risk,dependencies:task.dependencies};
  return {feedback:"READY" as WorkerFeedbackCode,missing:[],instruction:worker.style==="STRUCTURED"?JSON.stringify(body):`Intent: ${task.intent}\nExpected: ${task.expectedOutput}\nPASS: ${task.passCriteria.join("; ")}\nContext: ${JSON.stringify(task.context)}`};
}

export interface EligibilityContext {task:TaskSpec; requiredPermissions:string[]; now:number; maxFreshnessMs:number; chatGptWorkerApproved:boolean}
export function eligibilityGate(resource:ResourceRecord,ctx:EligibilityContext){
  const reasons:string[]=[];
  if(resource.health!=="READY")reasons.push("HEALTH");
  if(!ctx.task.requiredCapabilities?.every(c=>resource.capabilities.includes(c)))reasons.push("CAPABILITY");
  if(!ctx.requiredPermissions.every(p=>resource.permissions.includes(p)))reasons.push("PERMISSION");
  const observations=[resource.quotaRemaining,resource.marginalCost];
  if(observations.some(x=>x.observedAt!==null&&ctx.now-x.observedAt>ctx.maxFreshnessMs))reasons.push("STALE_TELEMETRY");
  if(resource.provider==="chatgpt-expert"&&!ctx.chatGptWorkerApproved)reasons.push("CHATGPT_APPROVAL_REQUIRED");
  if(resource.quotaRemaining.value!==null&&(ctx.task.estimatedQuota??0)>resource.quotaRemaining.value-resource.reserveRequirement)reasons.push("RESERVE");
  return {eligible:reasons.length===0,reasons};
}
export function optimizeResources(resources:ResourceRecord[],ctx:EligibilityContext,competency:Record<string,number>={}){
  const evaluated=resources.map(resource=>{const gate=eligibilityGate(resource,ctx);if(!gate.eligible)return {resourceId:resource.resourceId,score:null,reasons:gate.reasons};
    const quota=resource.quotaRemaining.value,reset=resource.resetAt.value,cost=resource.marginalCost.value;
    const score=4*(competency[resource.resourceId]??.5)+(quota===null?0:Math.min(1,quota/Math.max(1,resource.reserveRequirement+1)))+(reset===null?0:1/Math.max(1,reset-ctx.now))-(cost===null?0:cost);
    return {resourceId:resource.resourceId,score,reasons:[]};});
  const winner=evaluated.filter(x=>x.score!==null).sort((a,b)=>b.score!-a.score!||a.resourceId.localeCompare(b.resourceId))[0];
  return {resourceId:winner?.resourceId??null,evaluated};
}

export interface RouteAttempt {missionId:string;jobId:string;taskId:string;attemptId:string;routeId:string;workerId:string;status:"RUNNING"|"RETRY"|"BLOCKED"|"PASS"}
export function reroute(previous:RouteAttempt,nextWorkerId:string,sequence:number):RouteAttempt{
  if(previous.status==="PASS")throw new Error("TERMINAL_ATTEMPT");
  return {...previous,attemptId:`${previous.taskId}:attempt:${sequence}`,routeId:`${previous.taskId}:route:${sequence}`,workerId:nextWorkerId,status:"RETRY"};
}
export function attributeFailure(input:{feedback?:WorkerFeedbackCode;providerCode?:string;qaRuleConflict?:boolean;contextLoss?:boolean;requirementsChanged?:boolean}):FailureCause{
  if(input.requirementsChanged)return "USER_REQUIREMENT_CHANGE";if(input.contextLoss)return "CONTEXT_LOSS";if(input.qaRuleConflict)return "QA_RULE_ERROR";
  if(input.feedback==="NEEDS_CONTEXT"||input.feedback==="AMBIGUOUS_SPEC"||input.feedback==="MISSING_INPUT")return "TASK_SPEC_DEFICIENCY";
  if(input.feedback==="CAPABILITY_MISMATCH")return "ROUTING_ERROR";if(input.feedback==="UNSAFE_TO_EXECUTE")return "WORKER_INSTRUCTION_MISMATCH";
  if(input.providerCode?.includes("QUOTA")||input.providerCode?.includes("RATE_LIMIT"))return "QUOTA_RESOURCE_ISSUE";
  if(input.providerCode)return "TOOL_PROVIDER_FAILURE";return "WORKER_CAPABILITY";
}

export function concurrencyLimit(input:{providerSlots:Known<number>;localCapacity:number;qaCapacity:number;reserveSlots:number;dependencyReady:number}){
  if([input.localCapacity,input.qaCapacity,input.reserveSlots,input.dependencyReady].some(x=>!Number.isInteger(x)||x<0))throw new Error("INVALID_CONCURRENCY_INPUT");
  const provider=input.providerSlots.value; if(provider===null)return 0;
  return Math.max(0,Math.min(provider,input.localCapacity,input.qaCapacity,input.dependencyReady)-input.reserveSlots);
}
export function chatGptWorkerApproval(input:{quotaRemaining:Known<number>;resetAt:Known<number>;estimatedImpact:Known<number>;reserve:number;alternatives:string[];approved:boolean}){
  return {allowed:input.approved,approvalRequired:!input.approved,disclosure:{quotaRemaining:input.quotaRemaining.value,resetAt:input.resetAt.value,estimatedImpact:input.estimatedImpact.value,reserve:input.reserve,alternatives:input.alternatives,unknown:[input.quotaRemaining.value===null?"quotaRemaining":null,input.resetAt.value===null?"resetAt":null,input.estimatedImpact.value===null?"estimatedImpact":null].filter(Boolean)}};
}

export interface ChatGptWeeklyUtilizationPolicy {
  policyId:"CHATGPT_WEEKLY_L2_BALANCED"; enabled:boolean; fiveHourFloorPercent:number; weeklyFloorPercent:number;
  reservePercent:number; nearResetHours:number; nearResetPreferAbovePercent:number; maxConcurrentJobs:1;
  allowedRisk:("LOW"|"MEDIUM")[]; allowedTaskTypes:string[]; paidCreditsAllowed:false;
}
export interface ChatGptQuotaSnapshot {ordinaryUsageAllowed:boolean;fiveHourRemainingPercent:number|null;weeklyRemainingPercent:number|null;weeklyResetAt:number|null;creditsBalance:number|null;observedAt:number}
export const chatGptWeeklyL2Policy:ChatGptWeeklyUtilizationPolicy={policyId:"CHATGPT_WEEKLY_L2_BALANCED",enabled:true,fiveHourFloorPercent:35,weeklyFloorPercent:30,reservePercent:20,nearResetHours:24,nearResetPreferAbovePercent:45,maxConcurrentJobs:1,allowedRisk:["LOW","MEDIUM"],allowedTaskTypes:["difficult_reasoning","diagnostic_qa","code_review","synthesis","architecture"],paidCreditsAllowed:false};
export function evaluateChatGptWeeklyJob(input:{policy:ChatGptWeeklyUtilizationPolicy;quota:ChatGptQuotaSnapshot;task:{risk:"LOW"|"MEDIUM"|"HIGH";taskType:string};activeJobs:number;now:number}){
  const {policy,quota,task}=input,reasons:string[]=[];
  if(!policy.enabled)reasons.push("POLICY_DISABLED");if(!quota.ordinaryUsageAllowed)reasons.push("ORDINARY_USAGE_BLOCKED");
  if(quota.fiveHourRemainingPercent===null||quota.weeklyRemainingPercent===null||quota.weeklyResetAt===null)reasons.push("QUOTA_UNKNOWN");
  if(quota.creditsBalance!==0)reasons.push("PAID_CREDIT_STATE_NOT_ZERO");
  if(!policy.allowedRisk.includes(task.risk as "LOW"|"MEDIUM"))reasons.push("RISK_REQUIRES_EXPLICIT_APPROVAL");
  if(!policy.allowedTaskTypes.includes(task.taskType))reasons.push("TASK_TYPE_NOT_ELIGIBLE");
  if(input.activeJobs>=policy.maxConcurrentJobs)reasons.push("CONCURRENCY_RESERVE");
  if(quota.fiveHourRemainingPercent!==null&&quota.fiveHourRemainingPercent<policy.fiveHourFloorPercent)reasons.push("FIVE_HOUR_RESERVE");
  if(quota.weeklyRemainingPercent!==null&&quota.weeklyRemainingPercent<policy.weeklyFloorPercent)reasons.push("WEEKLY_RESERVE");
  const hoursToReset=quota.weeklyResetAt===null?null:Math.max(0,(quota.weeklyResetAt-input.now)/3600000);
  const nearResetPreference=hoursToReset!==null&&hoursToReset<=policy.nearResetHours&&(quota.weeklyRemainingPercent??0)>=policy.nearResetPreferAbovePercent;
  return {allowed:reasons.length===0,reasons,priorityBoost:reasons.length===0&&nearResetPreference?25:0,nearResetPreference,hoursToReset};
}
