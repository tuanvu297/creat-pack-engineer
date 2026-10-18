import { allocateTask } from "../scheduler.js";
import { availability } from "./discovery.js";
import { protectedReserve, type Demand } from "./demand.js";
import type { Resource } from "./types.js";
import type { ProviderRuntimeProfile,TaskSpec } from '../types.js';
export function runtimeCapabilityAllows(profile:ProviderRuntimeProfile|undefined,task:TaskSpec,now=Date.now()) {
  if(!profile)return !(task.requiredRuntimeCapabilities?.length||task.minimumConnectorClass);
  if(!profile.risk_constraints.includes(task.risk??'MEDIUM'))return false;
  if(!Number.isFinite(profile.health_freshness.observed_at)||!Number.isFinite(profile.health_freshness.max_age_ms)||profile.health_freshness.max_age_ms<=0||now-profile.health_freshness.observed_at>profile.health_freshness.max_age_ms||profile.health_freshness.observed_at>now+1000)return false;
  if((task.requiredRuntimeCapabilities??[]).some(c=>profile[c]!=='SUPPORTED'))return false;
  const rank={VERIFICATION_ONLY:0,LIMITED_STAGING:1,ACCEPTED_STAGING:2};
  if(task.minimumConnectorClass==='ACCEPTED_STAGING'&&(profile.credential_scope_class!=='STAGING_SERVICE'||!profile.core_evidence_ref))return false;
  return !task.minimumConnectorClass||rank[profile.classification]>=rank[task.minimumConnectorClass];
}
// Shared allowance, NOT a provider balance. Only explicit administrator mappings are grouped.
export function sharedPoolProfiles(resources:Resource[]):Resource[]{
 return resources.map(resource=>{
  const id=resource.runtimeProfile?.shared_resource_pool_id;if(!id)return {...resource};
  const members=resources.filter(r=>r.runtimeProfile?.shared_resource_pool_id===id),allowances=members.map(r=>r.sharedPoolAllowance);
  if(allowances.some(a=>!a||Object.values(a).some(n=>!Number.isFinite(n)||n<0)))return {...resource,ready:false,status:'OFFLINE'};
  const quotaUsed=members.reduce((n,r)=>n+r.quotaUsed,0),spendUsed=members.reduce((n,r)=>n+r.spendUsed,0);
  const quotaCap=Math.min(...allowances.map(a=>a!.quotaCap)),spendCap=Math.min(...allowances.map(a=>a!.spendCap));
  return {...resource,quotaCap,quotaUsed,spendCap,spendUsed,quotaRemaining:Math.max(0,quotaCap-quotaUsed),
   activeCount:members.reduce((n,r)=>n+r.activeCount,0),maxConcurrency:Math.min(...allowances.map(a=>a!.maxConcurrency))};
 });
}
export function allocateDemand(demand: Demand, resources: Resource[], now: number, threshold: number, excluded: string[] = []) {
  const cost=demand.estimatedCost;
  const profiles=resources.map(r=>({...r,ready:runtimeCapabilityAllows(r.runtimeProfile,demand,now)&&availability(r,now)==="READY"
    && (demand.requiredPermissions??[]).every(p=>r.permissions.includes(p))
    && cost!==undefined && Number.isFinite(cost) && cost>=0
    && demand.estimatedQuota!==undefined && Number.isFinite(demand.estimatedQuota) && demand.estimatedQuota>=0
    && r.spendCap!==null && r.spendUsed+cost<=r.spendCap
    && r.quotaCap!==null && r.quotaUsed+(demand.estimatedQuota??0)<=r.quotaCap,
    quotaReserve:protectedReserve(r,demand.purpose)}));
  return allocateTask(demand,profiles,threshold,excluded);
}
