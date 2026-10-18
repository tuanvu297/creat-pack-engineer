import { allocateDemand } from "./allocation.js";
import { availability } from "./discovery.js";
import { failurePolicy, type FailureKind } from "./recovery.js";
import type { Demand } from "./demand.js";
import type { AttemptUsage, Reservation, Resource, ResourceState } from "./types.js";

export class ResourceManager {
  private resources=new Map<string,Resource>();
  private reservations=new Map<string,Reservation>();
  private usage=new Map<string,AttemptUsage>();
  constructor(private readonly now=()=>Date.now(), state?:ResourceState) {
    for(const r of state?.resources??[])this.resources.set(r.workerId,structuredClone(r));
    for(const r of state?.reservations??[])this.reservations.set(r.reservationId,structuredClone(r));
    for(const u of state?.usage??[])this.usage.set(u.attemptId,structuredClone(u));
  }
  snapshot():ResourceState {return structuredClone({resources:[...this.resources.values()],reservations:[...this.reservations.values()],usage:[...this.usage.values()]});}
  register(resource:Resource) {
    if(!resource.workerId || resource.maxConcurrency<1 || !Number.isInteger(resource.maxConcurrency))throw new Error("INVALID_RESOURCE");
    for(const n of [resource.quotaReserve,resource.spendUsed,resource.quotaUsed,...Object.values(resource.reserveByPurpose)])if(!Number.isFinite(n)||n<0)throw new Error("INVALID_RESOURCE_ACCOUNTING");
    for(const n of [resource.passRate,resource.retryRate,resource.errorRate,resource.contextLossRisk,resource.learningValue])if(!Number.isFinite(n)||n<0||n>1)throw new Error("INVALID_RESOURCE_PROFILE");
    for(const n of [resource.spendCap,resource.quotaCap,resource.quotaRemaining])if(n!==null&&(!Number.isFinite(n)||n<0))throw new Error("INVALID_CAP");
    if(!['READY','BUSY','DEGRADED','RATE_LIMITED','OFFLINE'].includes(resource.status)||!Array.isArray(resource.permissions)||!Array.isArray(resource.capabilities))throw new Error("INVALID_RESOURCE_STATE");
    const current=this.resources.get(resource.workerId);
    this.resources.set(resource.workerId,structuredClone({...resource,activeCount:current?.activeCount??resource.activeCount,
      spendUsed:current?.spendUsed??resource.spendUsed,quotaUsed:current?.quotaUsed??resource.quotaUsed,
      rateLimitedUntil:current?.rateLimitedUntil??resource.rateLimitedUntil,circuitOpenUntil:current?.circuitOpenUntil??resource.circuitOpenUntil,
      consecutiveFailures:current?.consecutiveFailures??resource.consecutiveFailures,
      reservedQuota:current?.reservedQuota??resource.reservedQuota,version:(current?.version??0)+1}));
  }
  updateHealth(workerId:string, healthy:boolean, capabilities?:string[], model?:string) {
    const r=this.get(workerId);r.lastHealthAt=this.now();
    if(capabilities)r.capabilities=[...capabilities];if(model)r.model=model;
    // Health does not close a live rate-limit/circuit breaker.
    r.status=healthy?"READY":"OFFLINE";r.ready=healthy;r.version++;
    if(healthy && r.circuitOpenUntil<=this.now()){r.consecutiveFailures=0;r.circuitOpenUntil=0;}
    return {status:availability(r,this.now()),version:r.version};
  }
  decide(demand:Demand,threshold:number,excluded:string[]=[]) {return allocateDemand(demand,[...this.resources.values()],this.now(),threshold,excluded);}
  reserve(attemptId:string,demand:Demand,threshold:number,ttlMs=30000,excluded:string[]=[]) {
    const existing=this.reservations.get(attemptId);
    if(existing) {if(existing.state!=="HELD")throw new Error("ATTEMPT_ALREADY_FINALIZED");return structuredClone(existing);}
    if(ttlMs<=0||!Number.isFinite(ttlMs))throw new Error("INVALID_TTL");
    const decision=this.decide(demand,threshold,excluded);if(!decision.workerId)throw new Error("NO_ELIGIBLE_RESOURCE");
    const r=this.get(decision.workerId);const quota=demand.estimatedQuota!;const cost=demand.estimatedCost!;
    const reservation:Reservation={reservationId:attemptId,attemptId,workerId:r.workerId,quota,cost,purpose:demand.purpose,expiresAt:this.now()+ttlMs,state:"HELD"};
    r.activeCount++;r.reservedQuota+=quota;r.quotaRemaining!-=quota;r.spendUsed+=cost;r.quotaUsed+=quota;
    this.reservations.set(attemptId,reservation);return structuredClone(reservation);
  }
  settle(attemptId:string,usage:AttemptUsage) {
    const held=this.reservations.get(attemptId);if(!held)throw new Error("UNKNOWN_RESERVATION");
    if(held.state==="SETTLED") {const prior=this.usage.get(attemptId);if(JSON.stringify(prior)!==JSON.stringify(usage))throw new Error("CONFLICTING_USAGE");return;}
    if(held.state!=="HELD" || usage.attemptId!==attemptId || usage.workerId!==held.workerId)throw new Error("STALE_OR_MISMATCHED_USAGE");
    for(const n of [usage.credit,usage.cost,usage.tokens])if(n!==undefined && (!Number.isFinite(n)||n<0))throw new Error("INVALID_USAGE");
    const r=this.get(held.workerId);const actualQuota=usage.credit??held.quota;const actualCost=usage.cost??held.cost;
    r.activeCount=Math.max(0,r.activeCount-1);r.reservedQuota-=held.quota;
    r.quotaRemaining!+=held.quota-actualQuota;r.quotaUsed+=actualQuota-held.quota;r.spendUsed+=actualCost-held.cost;
    if((r.spendCap!==null&&r.spendUsed>r.spendCap)||(r.quotaCap!==null&&r.quotaUsed>r.quotaCap)||r.quotaRemaining!<0){r.status="DEGRADED";r.ready=false;}
    held.state="SETTLED";held.actualQuota=actualQuota;held.actualCost=actualCost;this.usage.set(attemptId,structuredClone(usage));
  }
  expire() {
    let count=0;for(const held of this.reservations.values())if(held.state==="HELD"&&held.expiresAt<this.now()) {
      const r=this.get(held.workerId);r.activeCount=Math.max(0,r.activeCount-1);r.reservedQuota-=held.quota;
      // Unknown external usage stays conservatively charged until reconciliation.
      held.state="EXPIRED";r.status="DEGRADED";r.ready=false;count++;
    }return count;
  }
  failure(workerId:string,kind:FailureKind,attempt:number,maxRetry:number,retryAfterMs?:number) {return failurePolicy(this.get(workerId),kind,attempt,maxRetry,this.now(),retryAfterMs);}
  private get(id:string) {const r=this.resources.get(id);if(!r)throw new Error("UNKNOWN_RESOURCE");return r;}
}
