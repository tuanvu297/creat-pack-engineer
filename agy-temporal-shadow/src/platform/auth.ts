import { timingSafeEqual,createHash } from 'node:crypto';
import { assertScope,validateScope,type ProjectScope } from './scope.js';
export type Role='operator'|'worker'|'reviewer'|'approver'|'platform-admin';
export interface Principal {subject:string;role:Role;scopes:ProjectScope[];workerId?:string}
export interface IdentityConfig extends Principal {token:string}
export function authenticate(authorization:string|undefined,identities:IdentityConfig[]):Principal {
  const token=authorization?.startsWith('Bearer ')?authorization.slice(7):'';
  if(!token)throw new Error('UNAUTHORIZED');const digest=createHash('sha256').update(token).digest();
  const config=identities.find(i=>timingSafeEqual(digest,createHash('sha256').update(i.token).digest()));
  if(!config)throw new Error('UNAUTHORIZED');const {token:_,...principal}=config;return structuredClone(principal);
}
export function authorize(principal:Principal,scope:ProjectScope,action:'read'|'write'|'execute'|'qa'|'approve'|'platform') {
  validateScope(scope);
  if(principal.role==='platform-admin')return;
  if(!principal.scopes.some(s=>{try{assertScope(scope,s);return true;}catch{return false;}}))throw new Error('PROJECT_SCOPE_DENIED');
  const roles:Record<string,Role[]>={read:['operator','worker','reviewer','approver'],write:['operator'],execute:['worker'],qa:['reviewer'],approve:['approver'],platform:[]};
  if(!roles[action].includes(principal.role))throw new Error('ACTION_DENIED');
}
export function identitiesFromEnv(env=process.env):IdentityConfig[] {
  if(env.AGY_IDENTITIES_JSON){const list=JSON.parse(env.AGY_IDENTITIES_JSON) as IdentityConfig[];
    if(!Array.isArray(list)||!list.length||list.some(i=>!i.subject||!i.token||!['operator','worker','reviewer','approver','platform-admin'].includes(i.role)||!Array.isArray(i.scopes)))throw new Error('INVALID_IDENTITIES');
    for(const i of list)for(const s of i.scopes)validateScope(s);
    if(new Set(list.map(i=>i.token)).size!==list.length)throw new Error('IDENTITY_TOKEN_COLLISION');return list;
  }
  if(env.AGY_API_TOKEN&&env.AGY_DEV_SCOPE){const scope=validateScope(JSON.parse(env.AGY_DEV_SCOPE));return [{subject:'dev-scoped-operator',role:'operator',scopes:[scope],token:env.AGY_API_TOKEN}];}
  throw new Error('Configure scoped identities; a shared API token alone is not authorized');
}
