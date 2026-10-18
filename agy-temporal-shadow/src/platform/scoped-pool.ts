import type { Pool,PoolClient } from 'pg';
import { validateScope,type ProjectScope } from './scope.js';
/** Transaction-local settings prevent scope leakage when a pooled connection is reused. */
export class ProjectPool {
  readonly scope:ProjectScope;
  constructor(private readonly raw:Pool,scope:ProjectScope,private readonly subject:string){this.scope=validateScope(scope);}
  async connect():Promise<PoolClient> {
    const client=await this.raw.connect();const original=client.query.bind(client);let transaction=false;
    const context=async()=>{await original(`SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true),set_config('agy.subject',$4,true)`,[this.scope.tenantId,this.scope.workspaceId,this.scope.projectId,this.subject]);};
    const wrapped=new Proxy(client,{get:(target,key)=>{
      if(key!=='query')return typeof (target as any)[key]==='function'?(target as any)[key].bind(target):(target as any)[key];
      return async(sql:string,values?:unknown[])=>{
        if(sql.trim().toUpperCase()==='BEGIN'){const r=await original(sql);transaction=true;try{await context();return r;}catch(e){await original('ROLLBACK');transaction=false;throw e;}}
        if(['COMMIT','ROLLBACK'].includes(sql.trim().toUpperCase())){try{return await original(sql);}finally{transaction=false;}}
        if(transaction)return original(sql,values);
        await original('BEGIN');try{await context();const r=await original(sql,values);await original('COMMIT');return r;}catch(e){await original('ROLLBACK');throw e;}
      };
    }});
    return wrapped as PoolClient;
  }
  async query(sql:string,values?:unknown[]) {const client=await this.connect();try{return await client.query(sql,values);}finally{client.release();}}
  asPool():Pool{return this as unknown as Pool;}
}
