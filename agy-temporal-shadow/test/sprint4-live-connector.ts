// Existing generic adapter + real read-only Codex process, isolated test gateway and synthetic job.
import { Pool } from 'pg';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { ProjectPool } from '../src/platform/scoped-pool.js';
import { ResourceStore } from '../src/resource-store.js';
import { discoverResource } from '../src/resources/discovery.js';
import { PostgresStore } from '../src/postgres-store.js';
import { LearningStore } from '../src/learning-store.js';
import { HttpJsonAdapter,ConnectorError } from '../src/adapters.js';
if(process.env.AGY_SPRINT4_DISPOSABLE!=='true')throw new Error('DISPOSABLE_ONLY');
const execute=promisify(execFile),session=JSON.parse(await readFile(resolve('../../work/sprint4/session.json'),'utf8'));
session.connectorToken??=randomBytes(24).toString('hex');session.connectorAdminToken??=randomBytes(24).toString('hex');await writeFile(resolve(session.work,'session.json'),JSON.stringify(session));
const raw=new Pool({connectionString:session.runtimeUrl}),admin=new Pool({connectionString:session.adminUrl});
const pa=new ProjectPool(raw,session.a,'connector-worker').asPool(),provision=new ProjectPool(admin,session.a,'staging-admin').asPool();
const evidence:any={environment:{database:session.db,connector:'real Codex CLI / ChatGPT auth',network:'gateway 127.0.0.1:55475, inference to OpenAI',productionPublishingConnected:false},checks:[],gates:{LIVE_CONNECTOR_PASS:false,AGY_PLATFORM_READY:false},limitations:['ChatGPT account credential is not a dedicated project-scoped service credential','CLI process cancellation does not prove remote inference cancellation','Provider quota balance/cost API unavailable; unknown values remain null']};
const priorEvidence=process.env.AGY_SPRINT4_RESUME_EXISTING==='true'?JSON.parse(await readFile(resolve(session.out,'SPRINT4-LIVE-CONNECTOR-EVIDENCE.json'),'utf8')):undefined;
const record=(name:string,detail:any)=>{evidence.checks.push({name,status:'PASS',detail});console.log(JSON.stringify({name,status:'PASS',detail}));};
let gateway:ReturnType<typeof spawn>|undefined,apiServer:ReturnType<typeof spawn>|undefined,transport='';
const env={...process.env,AGY_SPRINT4_DISPOSABLE:'true',AGY_SECRET_SPRINT4_CODEX:session.connectorToken};
async function wait(port:number){for(let i=0;i<50;i++){try{const r=await fetch(`http://127.0.0.1:${port}/health`,{headers:{authorization:'Bearer '+session.connectorToken}});if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('STARTUP_FAILED');}
async function control(path:string,status:number,count:number,delay=0){await fetch('http://127.0.0.1:55475/test/control',{method:'POST',headers:{authorization:'Bearer '+session.connectorAdminToken,'content-type':'application/json'},body:JSON.stringify({path,status,count,delay})});}
try {
 // Existing disposable candidate only: apply a corrected existing function, no new architecture/migration.
 const dispatch=await readFile(new URL('../migrations/005_platform_dispatch.sql',import.meta.url),'utf8');
 const functionSql=dispatch.match(/CREATE FUNCTION agy_sync_dispatch\(\)[\s\S]*?END \$\$;/)?.[0];if(!functionSql)throw new Error('FUNCTION_NOT_FOUND');
 await admin.query(functionSql.replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
 await provision.query('UPDATE agy_projects SET updated_at=updated_at');
 await provision.query(`INSERT INTO agy_connectors(connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES('real-codex','sprint4-codex',ARRAY['sprint4-text'],'http://127.0.0.1:55475','AGY_SECRET_SPRINT4_CODEX',true,ARRAY['read']) ON CONFLICT(tenant_id,workspace_id,project_id,connector_id) DO UPDATE SET enabled=true`);
 const resource={...discoverResource('codex-sprint4-pool',['sprint4-text'],Date.now()),status:'READY' as const,ready:true,quotaRemaining:3,quotaReserve:0,maxConcurrency:1,passRate:.99,retryRate:0,errorRate:0,contextLossRisk:0,spendCap:0,quotaCap:3,permissions:['read'],sharedResourcePoolId:'codex-chatgpt-account-sprint4'};
 await new ResourceStore(admin).register(resource,'sprint4-codex');
 gateway=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','test/sprint4-codex-connector.ts'],{cwd:resolve('.'),windowsHide:true,env,stdio:['ignore','pipe','pipe']});gateway.stdout?.on('data',d=>transport+=d);gateway.stderr?.on('data',d=>transport+=d);await wait(55475);
 const adapter=new HttpJsonAdapter('sprint4-codex',['sprint4-text'],'http://127.0.0.1:55475',session.connectorToken);
 assert.equal((await adapter.health()).ready,true);record('real connector health/authentication',{auth:'existing ChatGPT CLI login; token not read/exported',sandbox:'read-only',pool:'codex-chatgpt-account-sprint4'});
 apiServer=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','src/server.ts'],{cwd:resolve('.'),windowsHide:true,env:{...env,DATABASE_URL:session.runtimeUrl,AGY_STAGE_ONLY:'true',PORT:'55476',AGY_IDENTITIES_JSON:JSON.stringify([{subject:'operator-a',role:'operator',scopes:[session.a],token:session.tokenA}])},stdio:['ignore','pipe','pipe']});await wait(55476);
 const path=`/v1/tenants/${session.a.tenantId}/workspaces/${session.a.workspaceId}/projects/${session.a.projectId}/jobs`;
 const response=await fetch('http://127.0.0.1:55476'+path,{method:'POST',headers:{authorization:'Bearer '+session.tokenA,'content-type':'application/json'},body:JSON.stringify({idempotency_key:'sprint4-real-codex-job',objective:'Synthetic text-only non-production inference',tasks:[{idempotencyKey:'controlled-task',name:'real codex contract',taskType:'text',payload:{verification:'AGY_SPRINT4'},requiredCapabilities:['sprint4-text'],requiredPermissions:['read'],permissionGranted:true,safetyApproved:true,risk:'LOW',deterministic:true,estimatedQuota:1,estimatedCost:0,maxRetry:1,timeoutSeconds:120}]})});
 assert.equal(response.status,200);const job=await response.json();session.connectorJobId=job.jobId;await writeFile(resolve(session.work,'session.json'),JSON.stringify(session));record('Create Job via scoped HTTP API → queue',job);
 let submit:any;
 if(priorEvidence){submit=priorEvidence.submit;record('retry verification with existing real operation; no additional inference',submit);}
 else {const submitted=await execute(process.execPath,['node_modules/tsx/dist/cli.mjs','test/sprint4-connector-worker.ts'],{env:{...env,AGY_SPRINT4_SUBMIT_ONLY:'true'},windowsHide:true,timeout:30000});submit=JSON.parse(submitted.stdout.trim());record('independent worker process Claim → connector execute → durable checkpoint → process exit',submit);}
 evidence.submit=submit;
 const checkpoint=(await pa.query('SELECT checkpoint,status,lease_token FROM agy_tasks WHERE task_id=$1',[submit.task.taskId])).rows[0];assert.equal(checkpoint.checkpoint.externalId,submit.external_operation_id);record('external_operation_id persisted before collection',checkpoint);
 const store=new PostgresStore(pa,session.a);
 if(process.env.AGY_SPRINT4_RESUME_EXISTING!=='true'){await new Promise(r=>setTimeout(r,2500));assert.equal(await store.reclaimExpired(),1);record('worker process exited; lease expiry reclaimed; checkpoint retained',{});}
 if(process.env.AGY_SPRINT4_RESUME_EXISTING!=='true'){console.log('Waiting for 30-second project recovery backoff; real inference gateway remains alive.');await new Promise(r=>setTimeout(r,31000));}
 await admin.query("UPDATE agy_workers SET heartbeat_at=now() WHERE worker_id='codex-sprint4-pool'");
 let resumedResult:any;
 if(checkpoint.status==='PASS'&&priorEvidence?.resume?.outcome==='PASS') {
  resumedResult=priorEvidence.resume;record('retained prior runtime resume PASS; terminal task is not re-executed',resumedResult);
  const prior=(await pa.query('SELECT * FROM agy_telemetry WHERE task_id=$1',[submit.task.taskId])).rows[0];
  await store.recordTelemetry({jobId:prior.job_id,taskId:prior.task_id,attemptId:prior.attempt_id,workerId:prior.worker_id,outcome:prior.outcome,quotaUnits:Number(prior.quota_units),metadata:prior.metadata,tokens:Number(prior.usage_tokens)});
 }else{
  const resumed=await execute(process.execPath,['node_modules/tsx/dist/cli.mjs','test/sprint4-connector-worker.ts'],{env,windowsHide:true,timeout:120000});resumedResult=JSON.parse(resumed.stdout.trim());assert.equal(resumedResult.outcome,'PASS');record('NEW worker process → resume/poll/collect → QA → PASS',resumedResult);
 }
 evidence.resume=resumedResult;
 const task=(await pa.query('SELECT * FROM agy_tasks WHERE task_id=$1',[submit.task.taskId])).rows[0],telemetry=(await pa.query('SELECT * FROM agy_telemetry WHERE task_id=$1',[submit.task.taskId])).rows;
 assert.equal(task.status,'PASS');assert.equal(task.attempt,2);assert.equal(telemetry.length,1);assert.ok(Number(telemetry[0].usage_tokens)>0);
 assert.equal((await pa.query('SELECT status FROM agy_jobs WHERE job_id=$1',[job.jobId])).rows[0].status,'PASS');record('job and task terminal states both PASS',{jobId:job.jobId,taskId:task.task_id});
 const events=await new LearningStore(pa,true).processEvents();record('telemetry / usage / learning event',{telemetry,processedEvents:events});
 const duplicate=await adapter.execute(submit.task,new AbortController().signal);assert.equal(duplicate.externalId,submit.external_operation_id);record('connector-level duplicate submission prevention across attempts',{external_operation_id:duplicate.externalId});
 await control('/execute',503,1);assert.equal((await adapter.execute(submit.task,new AbortController().signal)).externalId,duplicate.externalId);record('controlled temporary connector failure → bounded retry → same operation',{});
 const start=Date.now();await control('/execute',429,1);assert.equal((await adapter.execute(submit.task,new AbortController().signal)).externalId,duplicate.externalId);assert.ok(Date.now()-start>=180);record('controlled gateway rate limit honors Retry-After',{elapsedMs:Date.now()-start,providerNative429:false});
 await control('/execute',503,3);await assert.rejects(()=>adapter.execute(submit.task,new AbortController().signal),(e:any)=>e instanceof ConnectorError&&e.code==='CONNECTOR_TEMPORARY_FAILURE'&&e.retryable);record('retry bound exhausted with error taxonomy',{maxTransportRetries:2});
 await control('/execute',200,1,200);const abort=new AbortController();setTimeout(()=>abort.abort(),30);await assert.rejects(()=>adapter.execute(submit.task,abort.signal),(e:any)=>e.code==='CONNECTOR_TIMEOUT');record('real HTTP timeout with AbortSignal',{});
 await adapter.cancel(duplicate.externalId);record('cancel contract for already terminal completed operation',{terminal:true});
 const usage=await adapter.usage(duplicate.externalId);assert.ok(usage.tokens>0);assert.equal(usage.sharedResourcePoolId,'codex-chatgpt-account-sprint4');record('usage contract with actual CLI token counts',usage);
 const rows=await (await fetch('http://127.0.0.1:55475/test/ledger',{headers:{authorization:'Bearer '+session.connectorToken}})).json();assert.equal(rows.length,1);assert.equal(rows[0].submissions,1);assert.equal(rows[0].state,'SUCCEEDED');evidence.operationLedger=rows;record('one external live inference only despite restart/duplicates/fault retries',{externalId:rows[0].externalId,submissions:1});
 const reservations=(await pa.query('SELECT * FROM agy_resource_reservations WHERE task_id=$1',[submit.task.taskId])).rows;evidence.reservations=reservations;
 assert.equal(reservations.reduce((n,r)=>n+Number(r.actual_quota??r.expected_quota),0),1);record('checkpoint resume usage charged exactly once',reservations);
 await store.recordTelemetry({jobId:telemetry[0].job_id,taskId:telemetry[0].task_id,attemptId:telemetry[0].attempt_id,workerId:telemetry[0].worker_id,outcome:'PASS',quotaUnits:1,metadata:telemetry[0].metadata,tokens:Number(telemetry[0].usage_tokens)});
 assert.deepEqual((await pa.query('SELECT * FROM agy_resource_reservations WHERE task_id=$1',[submit.task.taskId])).rows,reservations);record('usage settlement replay is idempotent',{});
 evidence.endToEndPass=true;
}catch(error:any){evidence.failure={message:error.message,code:error.code,stack:error.stack};console.error(error);process.exitCode=1;}
finally{apiServer?.kill();gateway?.kill();await raw.end();await admin.end();await writeFile(resolve(session.out,'SPRINT4-LIVE-CONNECTOR-EVIDENCE.json'),JSON.stringify(evidence,null,2));await writeFile(resolve(session.out,'SPRINT4-LIVE-CONNECTOR-EVIDENCE-'+Date.now()+'.json'),JSON.stringify(evidence,null,2));await writeFile(resolve(session.out,'SPRINT4-CONNECTOR-TRANSPORT.txt'),transport);console.log(JSON.stringify(evidence.gates));}
