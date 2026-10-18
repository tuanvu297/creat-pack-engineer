// Fresh slice acceptance. Fixed native operation is resumed on repeat, never resubmitted.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {Client,Connection} from '@temporalio/client';
import {Worker} from '@temporalio/worker';
import {TemporalBridge,workflowId} from '../src/temporal/bridge.js';
import {TemporalGateway} from '../src/temporal/gateway.js';
import type {Mission} from '../src/temporal/contracts.js';
const out=resolve('../../../outputs/temporal-staging-02');await mkdir(out,{recursive:true});
const adminUrl=process.env.AGY_TEST_DATABASE_URL;
if(!adminUrl||new URL(adminUrl).hostname!=='127.0.0.1'||new URL(adminUrl).port!=='55438')throw new Error('RETAINED_LOCAL_DB_REQUIRED');
const admin=new Pool({connectionString:adminUrl});let binding:any;
try{binding=JSON.parse(await readFile(out+'/slice2-binding.local.json','utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
const fresh=!binding;
if(fresh){const id=randomUUID().replaceAll('-','');binding={schema:'agy_temporal_slice2_'+id,role:'agy_temporal_slice2_'+id,queue:'agy-temporal-slice2-'+id,sqlite:resolve('../slice2.sqlite')};await writeFile(out+'/slice2-binding.local.json',JSON.stringify(binding,null,2),{flag:'wx'});}
if(!/^agy_temporal_slice2_[a-f0-9]{32}$/.test(binding.schema)||!/^agy_temporal_slice2_[a-f0-9]{32}$/.test(binding.role))throw new Error('INVALID_RETAINED_BINDING');
const owner=new Pool({connectionString:adminUrl,options:`-c search_path=${binding.schema},public`});
if(!(await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[binding.schema])).rowCount){
 await admin.query(`CREATE SCHEMA ${binding.schema}`);
 for(const f of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql','009_temporal_shadow.sql','010_temporal_native_command.sql'])await owner.query(await readFile('migrations/'+f,'utf8'));
 await admin.query(`CREATE ROLE ${binding.role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
 await owner.query(`GRANT USAGE ON SCHEMA ${binding.schema} TO ${binding.role}`);
 await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${binding.schema} TO ${binding.role}`);
 await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${binding.schema} TO ${binding.role}`);
}
const db=new URL(adminUrl);db.searchParams.set('options',`-c search_path=${binding.schema},public -c role=${binding.role}`);
// Existing queue-maintenance trigger requires this on its derived dispatch table.
await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${binding.role}`);
const pool=new Pool({connectionString:db.toString()}),bridge=new TemporalBridge(pool);
const scope={tenantId:'gl',workspaceId:'legacy-workspace',projectId:'GL_AUTOMATION'};
const principal={subject:'CODEX-SLICE2-TEST-CONTROLLER',role:'operator' as const,scopes:[scope]};
// A distinct gateway-contract artifact task on the corrected buffered route.
// The old source-verification streaming operation stays UNCERTAIN and is never resubmitted.
const m:Mission={...scope,mission_id:'AGY-TEMPORAL-20261018',task_id:'AGY-TEMPORAL-NATIVE-GATEWAY-CONTRACT-SLICE2-R2',attempt:1,idempotency_key:'AGY|TEMPORAL|NATIVE-GATEWAY-CONTRACT|20261018|SLICE2|R2|A1',objective:'Verify gateway action coverage and compiler diagnostics through buffered native Codex command; producer QA1 only',executor_worker_id:'CODEX_ENGINEERING_COMMAND',source_ref:'42ed424fd0ab77e541a808cb1a1c9c1381ac01a1+slice2-working-source',qa_contract_version:'1.1',mode:'TEMPORAL_SHADOW',payload:{command:'verify_gateway_contract'},ack_timeout_ms:60000,result_timeout_ms:60000,qa_timeout_ms:3600000,max_corrections:0};
await bridge.pool(m).query(`UPDATE agy_projects SET status='ACTIVE',policies='{"temporalShadowOnly":true}',resource_policy='{"maxConcurrentTasks":4,"quotaCap":0,"spendCap":0,"reservation":0}'`);
await writeFile(out+'/MISSION.json',JSON.stringify(m,null,2));
let server:ChildProcess|undefined,worker:ChildProcess|undefined,conn:Connection|undefined,logs='';
const startServer=()=>{const c=spawn(resolve('../tools/temporal.exe'),['server','start-dev','--ip','127.0.0.1','--port','7258','--namespace','agy-local','--headless','--db-filename',binding.sqlite],{windowsHide:true,stdio:['ignore','pipe','pipe']});c.stdout?.on('data',d=>{logs+=d;});c.stderr?.on('data',d=>{logs+=d;});return c;};
const startWorker=()=>{const c=spawn(process.execPath,['dist/src/temporal/worker.js'],{windowsHide:true,env:{...process.env,DATABASE_URL:db.toString(),AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW',AGY_STAGE_ONLY:'true',TEMPORAL_ADDRESS:'127.0.0.1:7258',TEMPORAL_NAMESPACE:'agy-local',TEMPORAL_TASK_QUEUE:binding.queue},stdio:['ignore','pipe','pipe']});c.stderr?.on('data',d=>{logs+=d;});return c;};
const kill=async(c:ChildProcess|undefined)=>{if(c&&c.exitCode===null){const done=new Promise<void>(r=>c.once('exit',()=>r()));c.kill('SIGKILL');await done;}};
const connect=async()=>{for(let n=0;n<60;n++){try{return await Connection.connect({address:'127.0.0.1:7258',connectTimeout:'1 second'});}catch{await new Promise(r=>setTimeout(r,250));}}throw new Error('TEMPORAL_START_TIMEOUT');};
const until=async(fn:()=>Promise<boolean>,ms=70000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('SLICE2_TIMEOUT');};
const row=async(mission=m)=>(await bridge.pool(mission).query('SELECT * FROM agy_temporal_missions WHERE workflow_id=$1',[workflowId(mission)])).rows[0];
const checks:Record<string,unknown>={};
try{
 server=startServer();conn=await connect();let client=new Client({connection:conn,namespace:'agy-local'}),gateway=new TemporalGateway(bridge,client,binding.queue,'TEMPORAL_SHADOW');worker=startWorker();
 // New synthetic regression identity only. No prior fixture is dispatched/replayed.
 const f:Mission={...m,mission_id:'slice2-event-regression-'+randomUUID(),task_id:'event-regression',idempotency_key:'event-regression-'+randomUUID(),executor_worker_id:'AGY_TEMPORAL_SYNTHETIC',payload:{value:42,delay_ms:2500,fixture:'normal'},ack_timeout_ms:5000,qa_timeout_ms:10000};
 await gateway.execute(f,principal,'dispatch');await until(async()=>!!(await row(f))?.ack);
 await kill(worker);worker=undefined;
 await bridge.pool(f).query("UPDATE agy_tasks SET lease_expires_at=now()-interval '1 second' WHERE task_id=$1",[(await row(f)).task_id]);
 worker=startWorker();await until(async()=>(await row(f))?.state==='WAIT_QA');
 const h=client.workflow.getHandle(workflowId(f));
 await new Promise(r=>setTimeout(r,1500));
 const history=await h.fetchHistory(),types=history.events??[];
 const timers=types.filter(e=>e.timerStartedEventAttributes).map(e=>e.timerStartedEventAttributes!.startToFireTimeout);
 const scheduled=types.filter(e=>e.activityTaskScheduledEventAttributes).map(e=>e.activityTaskScheduledEventAttributes!.activityType?.name);
 assert.equal(scheduled.filter(x=>x==='wait_result_event').length,1);
 assert.equal(scheduled.filter(x=>x==='heartbeat_checkpoint').length,0);
 assert.equal(scheduled.filter(x=>x==='submit_result_evidence').length,0);
 assert.equal(timers.length,2); // result deadline cancelled + one QA deadline
 await gateway.execute(f,principal,'stop');await h.result();
 await Worker.runReplayHistory({workflowsPath:resolve('dist/src/temporal/workflow.js')},await h.fetchHistory());
 checks.EVENT_DRIVEN_PASS={status:'PASS_LOCAL',activity_schedule:scheduled,timers,worker_restart:true,same_operation_count:Number((await bridge.pool(f).query('SELECT count(*) n FROM agy_temporal_synthetic_operations WHERE workflow_id=$1',[workflowId(f)])).rows[0].n)};
 // The fixed native mission is protected by both Temporal and PostgreSQL idempotency.
 const prior=await row();if(prior&&prior.state!=='WAIT_QA')throw new Error('EXISTING_NATIVE_MISSION_RECONCILE_WITHOUT_DISPATCH');
 const callerConn=await Connection.connect({address:'127.0.0.1:7258'});
 const caller=new TemporalGateway(bridge,new Client({connection:callerConn,namespace:'agy-local'}),binding.queue,'TEMPORAL_SHADOW');
 const dispatch=await caller.execute(m,principal,'dispatch');
 await until(async()=>{const r=await row();if(['BLOCKED','BLOCKED_ROUTE'].includes(r?.state)){await callerConn.close();throw new Error('NATIVE_TERMINAL_READ_JOURNAL_NO_RETRY');}return !!r?.ack;});const acked=await row();await callerConn.close();
 await until(async()=>(await row())?.state==='WAIT_QA');
 const before=await row();const callbackBefore=await gateway.execute(m,principal,'callback_status');
 assert.equal(callbackBefore.receipts.length,1);assert.equal(callbackBefore.receipts[0].payload.qa_state,'PENDING');
 const op=(await bridge.pool(m).query('SELECT * FROM agy_temporal_native_operations WHERE workflow_id=$1',[workflowId(m)])).rows[0];
 assert.equal(op.state,'COMPLETE');assert.ok(op.ack.pid);assert.ok(op.checkpoint);assert.equal(op.result.typecheck,'PASS');
 const bytes=await readFile(op.result.artifact_ref);assert.equal(createHash('sha256').update(bytes).digest('hex'),op.result.artifact_sha256);
 const evidence=JSON.parse(bytes.toString());assert.equal(evidence.operation_id,op.operation_id);
 await assert.rejects(()=>gateway.execute(m,{...principal,subject:m.executor_worker_id,role:'reviewer'},'submit_qa',{attempt:1,qa_contract_version:'1.1',verdict:'PASS',evidence_refs:before.result.evidence_refs}),/SELF_QA_DENIED/);
 // Restart BOTH worker and Temporal; no command is relaunched and pending QA remains pending.
 await kill(worker);worker=undefined;await kill(server);server=undefined;await conn.close();conn=undefined;
 server=startServer();conn=await connect();client=new Client({connection:conn,namespace:'agy-local'});gateway=new TemporalGateway(bridge,client,binding.queue,'TEMPORAL_SHADOW');worker=startWorker();
 const bootstrap=await gateway.execute(m,principal,'bootstrap');const readback=await gateway.execute(m,principal,'callback_status');const status=await gateway.execute(m,principal,'get_run');
 assert.equal(status.postgres.run_id,before.run_id);assert.equal(status.postgres.operation_id,acked.operation_id);assert.equal(status.postgres.qa_state,'PENDING');
 assert.deepEqual(readback,callbackBefore);assert.equal(bootstrap.missions.find((x:any)=>x.task_key===m.task_id).workflow_id,workflowId(m));
 assert.equal(Number((await bridge.pool(m).query('SELECT count(*) n FROM agy_temporal_native_operations WHERE workflow_id=$1',[workflowId(m)])).rows[0].n),1);
 await writeFile(out+'/CALLBACK-RECEIPT.json',JSON.stringify(readback.receipts[0].payload,null,2));
 await writeFile(out+'/SHARED-STATE-READBACK.json',JSON.stringify({transport:'DIRECT_LOCAL_GATEWAY_CLASS_AFTER_NEW_CONNECTION_AND_PROCESS_RESTART',store:'POSTGRESQL_SCOPED_STAGING',schema:binding.schema,role:binding.role,dispatch,bootstrap,readback,status,native_operation:op,actual_chat_surface:false,native_chat_ingestion:'UNVERIFIED',production:false},null,2));
 checks.NATIVE_EXECUTOR_ACK_PASS='PASS_NATIVE_CODEX_COMMAND_NO_MODEL';checks.CALLBACK_RECEIPT_PASS='PASS_LOCAL_POSTGRES_SHARED_STORE';checks.LOCAL_PROCESS_RESTART_PASS='PASS_SAME_RUN_ONE_NATIVE_OPERATION';checks.SELF_QA_REJECTION='PASS';
 console.log('SLICE2_LOCAL_ACCEPTANCE_PASS; NATIVE_COMMAND_PASS; QA_PENDING; HOSTED_AND_CHAT_SURFACE_UNVERIFIED');
}catch(e){checks.failure=String(e);throw e;}finally{
 await kill(worker);await kill(server);await conn?.close();await pool.end();await owner.end();await admin.end();
 await writeFile(out+'/acceptance.json',JSON.stringify({checks,production:false,qa:'PRODUCER_QA1_ONLY',native_chat_ingestion:'UNVERIFIED'},null,2));await writeFile(out+'/runtime.log',logs);
}
