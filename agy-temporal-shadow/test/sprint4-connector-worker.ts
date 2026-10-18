import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProjectService } from '../src/platform/service.js';
import { WorkerEngine } from '../src/engine.js';
if(process.env.AGY_SPRINT4_DISPOSABLE!=='true')throw new Error('DISPOSABLE_ONLY');
const session=JSON.parse(await readFile(resolve('../../work/sprint4/session.json'),'utf8'));
const pool=new Pool({connectionString:session.runtimeUrl});
try {
 const service=new ProjectService(pool,session.a,{subject:'sprint4-worker',role:'worker',workerId:'codex-sprint4-pool',scopes:[session.a]});
 const adapter=await service.adapter('real-codex');
 if(process.env.AGY_SPRINT4_SUBMIT_ONLY==='true') {
  const task=await service.store.claim({workerId:'codex-sprint4-pool',capabilities:adapter.capabilities,leaseSeconds:2});if(!task)throw new Error('NO_TASK');
  await service.store.transition(task.taskId,task.leaseToken,['CLAIMED'],'RUNNING');
  const operation=await adapter.execute(task,new AbortController().signal);await service.store.saveCheckpoint(task,operation.externalId,adapter.name);
  console.log(JSON.stringify({pid:process.pid,task,external_operation_id:operation.externalId,checkpointSaved:true,exitingBeforeCollection:true}));
 }else console.log(JSON.stringify({pid:process.pid,outcome:await new WorkerEngine(service.store,adapter,'codex-sprint4-pool',30).tick()}));
}finally{await pool.end();}
