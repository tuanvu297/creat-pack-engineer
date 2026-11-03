import type { Pool,PoolClient } from 'pg';
import { validateScope,type ProjectScope } from './scope.js';
/** Transaction-local settings prevent scope leakage when a pooled connection is reused. */
// Transaction control classification. The old wrapper matched
// only the exact string 'BEGIN', so 'BEGIN;', 'BEGIN ISOLATION
// LEVEL ...' and 'START TRANSACTION' fell into the auto-wrap
// path: the caller's BEGIN became a no-op warning inside the
// wrapper's own transaction, its isolation was silently dropped,
// and its COMMIT ended the wrapper transaction early - atomicity
// silently broken. Classification is now by normalized prefix.
// 'ROLLBACK TO SAVEPOINT' is NOT a transaction end (it is a
// partial rollback inside a live transaction) and SAVEPOINT /
// RELEASE require a live transaction - wrapping them in their
// own auto-transaction would destroy them.
export function classifyTx(sql: string): 'BEGIN' | 'END' | 'TX_STATEMENT' | 'STATEMENT' {
  const n = sql.trim().replace(/;+\s*$/, '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (n === 'BEGIN' || n.startsWith('BEGIN ') || n === 'START TRANSACTION' || n.startsWith('START TRANSACTION ')) return 'BEGIN';
  if (n === 'COMMIT' || n.startsWith('COMMIT ')) return 'END';
  if (n.startsWith('ROLLBACK TO')) return 'TX_STATEMENT';
  if (n === 'ROLLBACK' || n.startsWith('ROLLBACK ')) return 'END';
  if (n === 'SAVEPOINT' || n.startsWith('SAVEPOINT ') || n === 'RELEASE' || n.startsWith('RELEASE ')) return 'TX_STATEMENT';
  return 'STATEMENT';
}

export class ProjectPool {
  readonly scope:ProjectScope;
  constructor(private readonly raw:Pool,scope:ProjectScope,private readonly subject:string){this.scope=validateScope(scope);}
  async connect():Promise<PoolClient> {
    const client=await this.raw.connect();const original=client.query.bind(client);let transaction=false;
    const context=async()=>{await original(`SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true),set_config('agy.subject',$4,true)`,[this.scope.tenantId,this.scope.workspaceId,this.scope.projectId,this.subject]);};
    const wrapped=new Proxy(client,{get:(target,key)=>{
      if(key!=='query')return typeof (target as any)[key]==='function'?(target as any)[key].bind(target):(target as any)[key];
      return async(sql:string,values?:unknown[])=>{
        const kind=classifyTx(sql);
        if(kind==='BEGIN'){if(transaction)return original(sql,values);const r=await original(sql);transaction=true;try{await context();return r;}catch(e){await original('ROLLBACK');transaction=false;throw e;}}
        if(kind==='END'){try{return await original(sql,values);}finally{transaction=false;}}
        if(kind==='TX_STATEMENT'){if(!transaction)throw new Error('TX_REQUIRED');return original(sql,values);}
        if(transaction)return original(sql,values);
        await original('BEGIN');try{await context();const r=await original(sql,values);await original('COMMIT');return r;}catch(e){await original('ROLLBACK');throw e;}
      };
    }});
    return wrapped as PoolClient;
  }
  async query(sql:string,values?:unknown[]) {const client=await this.connect();try{return await client.query(sql,values);}finally{client.release();}}
  asPool():Pool{return this as unknown as Pool;}
}
