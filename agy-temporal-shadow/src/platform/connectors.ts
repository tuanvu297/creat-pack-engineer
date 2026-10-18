import type { ProjectScope } from './scope.js';
import { HttpJsonAdapter,StubAdapter,OpenAiResponsesAdapter } from '../adapters.js';
import type { WorkerAdapter,ProviderRuntimeProfile } from '../types.js';
export interface ConnectorBinding extends ProjectScope {connectorId:string;kind:string;capabilities:string[];endpoint:string;secretRef:string;enabled:boolean;permissions:string[];runtimeProfile?:ProviderRuntimeProfile}
export function connectorAdapter(binding:ConnectorBinding,resolveSecret:(ref:string)=>string|undefined):WorkerAdapter {
  const token=resolveSecret(binding.secretRef);
  if(!binding.enabled||!token)return new StubAdapter(binding.kind,binding.capabilities,'Project connector disabled or secret unavailable');
  if(binding.kind==='openai-responses'){
    const budget=Number(process.env.AGY_MISSION5_COST_ALLOWANCE);
    if(process.env.AGY_OPENAI_STAGING_APPROVED!=='true'||!Number.isFinite(budget)||budget<=0||binding.endpoint!=='https://api.openai.com/v1'||!binding.runtimeProfile?.requested_model||binding.runtimeProfile.credential_scope_class!=='STAGING_SERVICE')return new StubAdapter(binding.kind,binding.capabilities,'Dedicated staging scope/model/approval/budget required');
    return new OpenAiResponsesAdapter(token,binding.runtimeProfile.requested_model,binding.runtimeProfile);
  }
  return new HttpJsonAdapter(binding.kind,binding.capabilities,binding.endpoint,token,binding.runtimeProfile);
}
