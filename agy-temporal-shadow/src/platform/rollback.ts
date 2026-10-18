import { scopeKey,type ProjectScope } from './scope.js';
/** Old code cannot safely resume once multiple projects share a legacy tenant key. */
export function legacyRollbackPreflight(jobs:Array<ProjectScope&{idempotencyKey:string}>) {
 const seen=new Map<string,string>();
 for(const job of jobs){const key=JSON.stringify([job.tenantId,job.idempotencyKey]);const project=scopeKey(job);
  if(seen.has(key)&&seen.get(key)!==project)return {safe:false,reason:'LEGACY_IDEMPOTENCY_COLLISION'};
  seen.set(key,project);
 }
 return {safe:true,reason:'RESTORE_ONLY_IN_ISOLATED_DATABASE; KEEP_NEW_DATA_ARCHIVE'};
}
