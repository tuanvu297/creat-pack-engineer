// Standalone acceptance probe. Uses only the retained disposable integration schema.
import {spawn,type ChildProcess} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {Client,Connection} from '@temporalio/client';
import {TemporalBridge,workflowId} from '../src/temporal/bridge.js';
import {TemporalGateway} from '../src/temporal/gateway.js';
import type {Mission} from '../src/temporal/contracts.js';
const receipt=JSON.parse(await readFile('runtime-evidence/temporal-acceptance.json','utf8'));
if(!/^agy_temporal_test_[a-f0-9]{32}$/.test(receipt.schema)||!/^agy_temporal_role_[a-f0-9]{32}$/.test(receipt.role)||!process.env.AGY_TEST_TEMPORAL_CLI||!process.env.AGY_TEST_DATABASE_URL)throw new Error('DISPOSABLE_FIXTURE_REQUIRED');
const db=new URL(process.env.AGY_TEST_DATABASE_URL);if(db.hostname!=='127.0.0.1'||db.port!=='55438')throw new Error('LOCAL_TEST_DATABASE_REQUIRED');
db.searchParams.set('options',`-c search_path=${receipt.schema},public -c role=${receipt.role}`);
const pool=new Pool({connectionString:db.toString()}),bridge=new TemporalBridge(pool),suffix=randomUUID();
const sqlite=resolve('runtime-evidence/server-restart-'+suffix+'.sqlite');
const address='127.0.0.1:7248',queue='agy-server-restart-'+suffix;
let server:ChildProcess|undefined,worker:ChildProcess|undefined,conn:Connection|undefined,logs='';
const startServer=()=>{const p=spawn(process.env.AGY_TEST_TEMPORAL_CLI!,['server','start-dev','--ip','127.0.0.1','--port','7248','--namespace','agy-local','--headless','--db-filename',sqlite],{stdio:['ignore','pipe','pipe'],windowsHide:true});p.stdout?.on('data',d=>{logs+=d;});p.stderr?.on('data',d=>{logs+=d;});return p;};
const kill=async(p:ChildProcess|undefined)=>{if(!p||p.exitCode!==null)return;const done=new Promise<void>(r=>p.once('exit',()=>r()));p.kill('SIGKILL');await done;};
const connect=async()=>{for(let i=0;i<80;i++){try{return await Connection.connect({address,connectTimeout:'1 second'});}catch{await new Promise(r=>setTimeout(r,250));}}throw new Error('SERVER_START_TIMEOUT');};
try{
 server=startServer();conn=await connect();let client=new Client({connection:conn,namespace:'agy-local'});let gateway=new TemporalGateway(bridge,client,queue,'TEMPORAL_SHADOW');
 worker=spawn(process.execPath,[fileURLToPath(new URL('../dist/src/temporal/worker.js',import.meta.url))],{env:{...process.env,DATABASE_URL:db.toString(),AGY_STAGE_ONLY:'true',AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW',TEMPORAL_ADDRESS:address,TEMPORAL_NAMESPACE:'agy-local',TEMPORAL_TASK_QUEUE:queue},stdio:['ignore','pipe','pipe'],windowsHide:true});worker.stderr?.on('data',d=>{logs+=d;});
 const m:Mission={...receipt.scope_ids,mission_id:'server-restart-'+suffix,task_id:'task',attempt:1,idempotency_key:'server-restart-'+suffix,objective:'Persist server state through restart',executor_worker_id:'AGY_TEMPORAL_SYNTHETIC',source_ref:'test:server-restart',qa_contract_version:'1.1',mode:'TEMPORAL_SHADOW',payload:{value:42,delay_ms:0,fixture:'normal'},ack_timeout_ms:5000,result_timeout_ms:60000,qa_timeout_ms:120000,max_corrections:0};
 const operator={subject:'restart-controller',role:'operator' as const,scopes:[receipt.scope_ids]},reviewer={subject:'restart-reviewer',role:'reviewer' as const,scopes:[receipt.scope_ids]};
 await gateway.execute(m,operator,'dispatch');const row=async()=>(await bridge.pool(m).query('SELECT * FROM agy_temporal_missions WHERE workflow_id=$1',[workflowId(m)])).rows[0];
 const end=Date.now()+30000;while((await row())?.state!=='WAIT_QA'){if(Date.now()>end)throw new Error('WAIT_QA_TIMEOUT');await new Promise(r=>setTimeout(r,100));}
 const before=await row();await kill(server);server=undefined;await conn.close();conn=undefined;
 server=startServer();conn=await connect();client=new Client({connection:conn,namespace:'agy-local'});gateway=new TemporalGateway(bridge,client,queue,'TEMPORAL_SHADOW');
 const restored=await client.workflow.getHandle(workflowId(m)).describe();assert.equal(restored.runId,before.run_id);
 await gateway.execute(m,reviewer,'submit_qa',{verdict:'PASS',attempt:1,qa_contract_version:'1.1',evidence_refs:before.result.evidence_refs});
 const result:any=await client.workflow.getHandle(workflowId(m)).result();assert.equal(result.state,'COMPLETE');assert.equal((await row()).state,'COMPLETE');
 assert.equal(Number((await bridge.pool(m).query('SELECT count(*) n FROM agy_temporal_synthetic_operations WHERE workflow_id=$1',[workflowId(m)])).rows[0].n),1);
 await writeFile('runtime-evidence/temporal-server-restart.json',JSON.stringify({status:'PASS',test:'SIGKILL Temporal server and restart same persistent SQLite store',workflow_id:workflowId(m),run_id:restored.runId,same_run:true,side_effect_count:1,domain_state:'COMPLETE',scope:'LOCAL_CONTROLLED_SYNTHETIC'},null,2));
 process.stdout.write('TEMPORAL_SERVER_RESTART_PASS\n');
}finally{await kill(worker);await kill(server);await conn?.close();await pool.end();await writeFile('runtime-evidence/temporal-server-restart.log',logs);}
