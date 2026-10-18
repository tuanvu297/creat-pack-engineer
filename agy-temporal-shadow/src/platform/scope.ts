export interface ProjectScope {tenantId:string;workspaceId:string;projectId:string}
export const scopeKey=(s:ProjectScope)=>JSON.stringify([s.tenantId,s.workspaceId,s.projectId]);
export function validateScope(s:ProjectScope):ProjectScope {
  if(!s || [s.tenantId,s.workspaceId,s.projectId].some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)))throw new Error('INVALID_PROJECT_SCOPE');
  return {...s};
}
export function assertScope(expected:ProjectScope,actual:ProjectScope){if(scopeKey(expected)!==scopeKey(actual))throw new Error('PROJECT_SCOPE_DENIED');}
export interface Project extends ProjectScope {
  name:string;status:'ACTIVE'|'PAUSED'|'ARCHIVED';sourceOfTruthRef:string;policyRef:string;
  defaultSkillPack:string;resourcePolicy:{maxConcurrentTasks:number;quotaCap:number;spendCap:number;reservation:number};
  priority:number;permissions:string[];policies:Record<string,unknown>;createdAt:number;updatedAt:number;
}
