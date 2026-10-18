import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { ProjectPool } from '../src/platform/scoped-pool.js';
import { PostgresStore } from '../src/postgres-store.js';
if(process.env.AGY_SPRINT4_DISPOSABLE!=='true')throw new Error('DISPOSABLE_ONLY');
const session=JSON.parse(await readFile(resolve('../../work/sprint4/session.json'),'utf8'));
const scope=process.env.AGY_SPRINT4_CLAIM_SCOPE==='b'?session.b:session.a;
const pool=new Pool({connectionString:session.runtimeUrl});
try {const store=new PostgresStore(new ProjectPool(pool,scope,'test-process').asPool(),scope);let task=null;for(let i=0;i<20&&!task;i++){task=await store.claim({workerId:'shared-sprint4',capabilities:['text'],leaseSeconds:30});if(!task)await new Promise(r=>setTimeout(r,50));}console.log(JSON.stringify({pid:process.pid,scope,task}));}finally{await pool.end();}
