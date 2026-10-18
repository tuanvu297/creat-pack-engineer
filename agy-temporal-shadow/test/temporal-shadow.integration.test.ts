import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawn,type ChildProcess} from 'node:child_process';
import {Pool} from 'pg';
import {Client,Connection} from '@temporalio/client';
import {Worker} from '@temporalio/worker';
import {TemporalBridge,workflowId} from '../src/temporal/bridge.js';
import {TemporalGateway} from '../src/temporal/gateway.js';
import {temporalConfig} from '../src/temporal/config.js';
import type {Mission} from '../src/temporal/contracts.js';
import type {Principal} from '../src/platform/auth.js';
import {WorkerEngine} from '../src/engine.js';
import {InMemoryStore} from './in-memory-store.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>Promise<boolean>,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(100);}throw new Error('TEMPORAL_TEST_TIMEOUT');}
test('Temporal shadow: actual SDK/server/PostgreSQL durability and gateway contracts',
 {skip:!process.env.AGY_TEST_DATABASE_URL||!process.env.AGY_TEST_TEMPORAL_ADDRESS,timeout:180000},async t=>{
 const suffix=randomUUID().replaceAll('-',''),schema='agy_temporal_test_'+suffix,role='agy_temporal_role_'+suffix;
 const admin=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL});
 const owner=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
 let runtime:Pool|undefined,child:ChildProcess|undefined,httpChild:ChildProcess|undefined,connection:Connection|undefined;
 let logs='';const checks:Record<string,string>={};
 const scope={tenantId:'gl',workspaceId:'legacy-workspace',projectId:'GL_AUTOMATION'};
 const operator:Principal={subject:'shadow-controller',role:'operator',scopes:[scope]};
 const reviewer:Principal={subject:'independent-fixture-reviewer',role:'reviewer',scopes:[scope]};
 const fixture=(label:string,overrides:Partial<Mission>={}):Mission=>({...scope,mission_id:'mission-'+label+'-'+suffix,task_id:'task-'+label,attempt:1,
  idempotency_key:label+'-'+suffix,objective:'Bounded synthetic fixture '+label,executor_worker_id:'AGY_TEMPORAL_SYNTHETIC',source_ref:'test:temporal-shadow-v1',qa_contract_version:'1.1',mode:'TEMPORAL_SHADOW',
  payload:{value:42,delay_ms:100,fixture:'normal'},ack_timeout_ms:5000,result_timeout_ms:60000,qa_timeout_ms:60000,max_corrections:1,...overrides});
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  for(const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','009_temporal_shadow.sql'])await owner.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
  await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  const db=new URL(process.env.AGY_TEST_DATABASE_URL!);db.searchParams.set('options',`-c search_path=${schema},public -c role=${role}`);
  runtime=new Pool({connectionString:db.toString()});
  const bridge=new TemporalBridge(runtime),m0=fixture('setup');
  const project=bridge.pool(m0);await project.query(`UPDATE agy_projects SET status='ACTIVE',policies='{"temporalShadowOnly":true}',permissions=ARRAY['read'],resource_policy='{"maxConcurrentTasks":4,"quotaCap":0,"spendCap":0,"reservation":0}'`);
  connection=await Connection.connect({address:process.env.AGY_TEST_TEMPORAL_ADDRESS});
  const client=new Client({connection,namespace:'agy-local'}),queue='agy-shadow-test-'+suffix;
  const gateway=new TemporalGateway(bridge,client,queue,'TEMPORAL_SHADOW');
  const row=async(m:Mission)=>(await bridge.pool(m).query('SELECT * FROM agy_temporal_missions WHERE workflow_id=$1',[workflowId(m)])).rows[0];
  const count=async(m:Mission)=>Number((await bridge.pool(m).query('SELECT count(*) n FROM agy_temporal_synthetic_operations WHERE workflow_id=$1',[workflowId(m)])).rows[0].n);
  const waitQA=async(m:Mission)=>{await until(async()=>(await row(m))?.state==='WAIT_QA',65000);return row(m);};
  const qa=async(m:Mission,verdict='PASS')=>{const r=await row(m);return gateway.execute(m,reviewer,'submit_qa',{verdict,attempt:r.attempt,qa_contract_version:'1.1',evidence_refs:r.result.evidence_refs,...(verdict==='FAIL'?{corrective_instruction:'Recheck the supplied value and return the same deterministic fixture with a new evidence receipt.'}:{})});};
  const startWorker=()=>{const c=spawn(process.execPath,[fileURLToPath(new URL('../dist/src/temporal/worker.js',import.meta.url))],{env:{...process.env,DATABASE_URL:db.toString(),AGY_STAGE_ONLY:'true',AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW',TEMPORAL_ADDRESS:process.env.AGY_TEST_TEMPORAL_ADDRESS,TEMPORAL_NAMESPACE:'agy-local',TEMPORAL_TASK_QUEUE:queue},stdio:['ignore','pipe','pipe'],windowsHide:true});c.stdout?.on('data',d=>{logs+=d;});c.stderr?.on('data',d=>{logs+=d;});return c;};
  const kill=async(c:ChildProcess)=>{if(c.exitCode!==null)return;const done=new Promise<void>(r=>c.once('exit',()=>r()));c.kill('SIGKILL');await done;};
  child=startWorker();
  await t.test('bootstrap, B/C duplicate dispatch and conflicting payload fail closed',async()=>{
   const m=fixture('duplicate');const [a,b]=await Promise.all([gateway.execute(m,operator,'dispatch'),gateway.execute(m,operator,'dispatch')]);
   assert.equal(a.workflow_id,b.workflow_id);assert.equal([a,b].filter(x=>x.duplicate===false).length,1);
   await assert.rejects(()=>gateway.execute({...m,payload:{...m.payload,value:43}},operator,'dispatch'),/IDEMPOTENCY_CONFLICT/);
   await waitQA(m);assert.equal(await count(m),1);await qa(m);assert.equal((await client.workflow.getHandle(workflowId(m)).result() as any).state,'COMPLETE');
   checks.B='PASS';checks.C='PASS';
  });
  await t.test('A/D/H real worker SIGKILL, caller connection closed, restart same run and PostgreSQL evidence',async()=>{
   const m=fixture('crash',{payload:{value:42,delay_ms:4000,fixture:'normal'}});
   const callerConnection=await Connection.connect({address:process.env.AGY_TEST_TEMPORAL_ADDRESS});
   const caller=new TemporalGateway(bridge,new Client({connection:callerConnection,namespace:'agy-local'}),queue,'TEMPORAL_SHADOW');
   await caller.execute(m,operator,'dispatch');await until(async()=>!!(await row(m))?.ack);
   const before=await row(m);await callerConnection.close();await kill(child!);child=undefined;
   // Force expiry while the worker is down; recovery must reconcile and issue a NEW fence.
   await project.query("UPDATE agy_tasks SET lease_expires_at=now()-interval '1 second' WHERE task_id=$1",[before.task_id]);
   await delay(1200);child=startWorker();await waitQA(m);await qa(m);
   const result:any=await client.workflow.getHandle(workflowId(m)).result();assert.equal(result.state,'COMPLETE');
   const after=await row(m);assert.equal(after.run_id,before.run_id);assert.equal(after.operation_id,before.operation_id);assert.equal(after.task_id,before.task_id);assert.equal(await count(m),1);
   assert.notEqual(after.lease_token,before.lease_token);assert.equal(after.lease_attempt,before.lease_attempt+1);assert.equal(after.attempt,before.attempt);
   assert.equal((await project.query('SELECT status FROM agy_tasks WHERE task_id=$1',[after.task_id])).rows[0].status,'PASS');
   const callback=(await project.query("SELECT payload FROM agy_temporal_receipts WHERE workflow_id=$1 AND kind='CALLBACK'",[workflowId(m)])).rows[0].payload;
   assert.equal(callback.state,'COMPLETE');assert.equal(callback.native_chat_ingestion,'UNVERIFIED');checks.A='PASS';checks.D='PASS';checks.H='PASS';
  });
  await t.test('E executor unavailable never falls back to Work; ACK/evidence missing blocks QA',async()=>{
   const m=fixture('no-executor',{executor_worker_id:'CODEX-NATIVE-UNAVAILABLE'});await gateway.execute(m,operator,'dispatch');
   const out:any=await client.workflow.getHandle(workflowId(m)).result();assert.equal(out.state,'BLOCKED_ROUTE');assert.equal(out.qa_state,'QA_NOT_STARTED');assert.equal(await count(m),0);
   await assert.rejects(()=>gateway.execute(m,reviewer,'submit_qa',{attempt:1,qa_contract_version:'1.1',verdict:'PASS',evidence_refs:['fabricated']}),/QA_NOT_STARTED/);checks.E='PASS';
  });
  await t.test('F uncertain submission reconciles same operation or blocks; no blind retry',async()=>{
   const m=fixture('uncertain',{payload:{value:42,delay_ms:0,fixture:'uncertain_after_accept'}});await gateway.execute(m,operator,'dispatch');await waitQA(m);assert.equal(await count(m),1);await qa(m);await client.workflow.getHandle(workflowId(m)).result();
   assert.equal(Number((await project.query("SELECT count(*) n FROM agy_temporal_receipts WHERE workflow_id=$1 AND kind='RECONCILIATION'",[workflowId(m)])).rows[0].n),1);
   const missing=fixture('uncertain-missing',{payload:{value:42,delay_ms:0,fixture:'uncertain_without_accept'}});await gateway.execute(missing,operator,'dispatch');
   const out:any=await client.workflow.getHandle(workflowId(missing)).result();assert.equal(out.state,'BLOCKED');assert.match(out.reason,/SUBMISSION_UNCERTAIN/);assert.equal(await count(missing),0);checks.F='PASS';
  });
  await t.test('QA-only boundary: self review rejected, missing evidence rejected, FAIL redispatches executor with instruction',async()=>{
   const m=fixture('correction');await gateway.execute(m,operator,'dispatch');await waitQA(m);
   await assert.rejects(()=>gateway.execute(m,{...reviewer,subject:m.executor_worker_id},'submit_qa',{}),/SELF_QA_DENIED/);
   await assert.rejects(()=>gateway.execute(m,reviewer,'submit_qa',{attempt:1,verdict:'PASS',qa_contract_version:'1.1',evidence_refs:[]}),/CONTRACT_DENIED/);
   await qa(m,'FAIL');await until(async()=>{const r=await row(m);return r.attempt===2&&r.state==='WAIT_QA';});await qa(m);assert.equal((await client.workflow.getHandle(workflowId(m)).result() as any).state,'COMPLETE');
   assert.equal(await count(m),2);const r=await row(m);assert.equal(r.executor_worker_id,'AGY_TEMPORAL_SYNTHETIC');assert.notEqual(r.reviewer_id,r.executor_worker_id);checks.WORK_QA_ONLY='PASS';
  });
  await t.test('G replay recorded Temporal history using official SDK replayer',async()=>{
   const m=fixture('replay');await gateway.execute(m,operator,'dispatch');await waitQA(m);await qa(m);await client.workflow.getHandle(workflowId(m)).result();
   const history=await client.workflow.getHandle(workflowId(m)).fetchHistory();
   await Worker.runReplayHistory({workflowsPath:fileURLToPath(new URL('../dist/src/temporal/workflow.js',import.meta.url))},history);
   await mkdir('runtime-evidence',{recursive:true});await writeFile('runtime-evidence/temporal-history.json',JSON.stringify(history));checks.G='PASS';
  });
  await t.test('I rollback defaults LEGACY and shadow comparison preserves legacy deterministic output',async()=>{
   assert.equal(temporalConfig({} as any).mode,'LEGACY');assert.throws(()=>temporalConfig({AGY_ORCHESTRATION_MODE:'TEMPORAL_PRODUCTION'} as any),/INVALID/);
   const m=fixture('compare');const legacy=new TemporalGateway(bridge,client,queue,'LEGACY');assert.equal((await legacy.execute(m,operator,'dispatch')).routing,'LEGACY');assert.equal(await row(m),undefined);
   const memory=new InMemoryStore();await memory.createJob({tenantId:'gl',idempotencyKey:'compare',objective:'compare',mode:'SINGLE_WORKFLOW',passThreshold:1,tasks:[{idempotencyKey:'t',name:'fixture',taskType:'text',risk:'LOW',deterministic:true}]});
   const result={state:'SUCCEEDED' as const,output:{value:42},qa:{deterministicPassed:true,score:1,confidence:1,evidenceSufficient:true}};
   const engine=new WorkerEngine(memory,{name:'fixture',capabilities:[],health:async()=>({ready:true}),execute:async()=>({externalId:'legacy-fixture'}),check_status:async()=>result,collect_result:async()=>result,cancel:async()=>{}},'legacy-fixture');
   assert.equal(await engine.tick(),'PASS');await gateway.execute(m,operator,'dispatch');await waitQA(m);await qa(m);await client.workflow.getHandle(workflowId(m)).result();assert.deepEqual((await row(m)).result.output,result.output);checks.I='PASS';checks.SHADOW_COMPARE='PASS';
  });
  await t.test('gateway HTTP contract authenticates/scopes identities and safe stop retains operation',async()=>{
   const token=randomUUID();httpChild=spawn(process.execPath,[fileURLToPath(new URL('../dist/src/temporal/server.js',import.meta.url))],{env:{...process.env,DATABASE_URL:db.toString(),AGY_STAGE_ONLY:'true',AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW',TEMPORAL_ADDRESS:process.env.AGY_TEST_TEMPORAL_ADDRESS,TEMPORAL_NAMESPACE:'agy-local',TEMPORAL_TASK_QUEUE:queue,AGY_TEMPORAL_GATEWAY_PORT:'18798',AGY_IDENTITIES_JSON:JSON.stringify([{...operator,token}])},stdio:['ignore','pipe','pipe'],windowsHide:true});httpChild.stderr?.on('data',d=>{logs+=d;});
   await until(async()=>{try{return (await fetch('http://127.0.0.1:18798/v1/agy/current_state',{method:'POST'})).status===401;}catch{return false;}});
   const m=fixture('http-stop',{payload:{value:42,delay_ms:10000,fixture:'normal'}});
   const request=(action:string,mission=m)=>fetch('http://127.0.0.1:18798/v1/agy/'+action,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({mission})});
   assert.equal((await request('dispatch')).status,200);await until(async()=>!!(await row(m))?.ack);
   assert.equal((await request('current_state',{...m,projectId:'OTHER'})).status,403);
   assert.equal((await request('stop')).status,200);const out:any=await client.workflow.getHandle(workflowId(m)).result();assert.equal(out.state,'BLOCKED');assert.equal(await count(m),1);
   const receipt=(await gateway.execute(m,operator,'get_run')).postgres;assert.ok(receipt.operation_id);checks.HTTP_GATEWAY='PASS';
  });
  await mkdir('runtime-evidence',{recursive:true});await writeFile('runtime-evidence/temporal-acceptance.json',JSON.stringify({checks,scope:'LOCAL_CONTROLLED_SYNTHETIC',schema,role,scope_ids:scope,temporal_address:process.env.AGY_TEST_TEMPORAL_ADDRESS,production:false,native_executor:'UNVERIFIED',peer_qa:'PENDING_ORIGINATING_CONTROLLER',chat_surface:'UNVERIFIED'},null,2));
 }finally{
  for(const c of [httpChild,child])if(c&&c.exitCode===null){const done=new Promise<void>(r=>c.once('exit',()=>r()));c.kill('SIGKILL');await done;}
  await mkdir('runtime-evidence',{recursive:true});await writeFile('runtime-evidence/temporal-worker.log',logs);
  await connection?.close();await runtime?.end();await owner.end();
  // Retain isolated test schema/role as durable evidence; no hard-delete in this mission.
  await admin.end();
 }
});
