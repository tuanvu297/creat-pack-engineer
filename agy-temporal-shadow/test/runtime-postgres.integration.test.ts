import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ProjectPool} from '../src/platform/scoped-pool.js';
import {PostgresStore} from '../src/postgres-store.js';
import {ResourceStore} from '../src/resource-store.js';
import {discoverResource} from '../src/resources/discovery.js';
import {runtimeStatus} from '../src/platform/runtime-status.js';

const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>Promise<boolean>,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await f())return;await delay(75);}throw new Error('RUNTIME_TEST_TIMEOUT');}
test('durable process: disconnected client, concurrent lanes, retry/failover, queryable health, killed worker resume without duplicate provider effects',
 {skip:!process.env.AGY_TEST_DATABASE_URL,timeout:90000},async()=>{
 const suffix=randomUUID().replaceAll('-',''),schema=`agy_runtime_test_${suffix}`,role=`agy_runtime_role_${suffix}`;
 const admin=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL});
 const owner=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
 let runtime:Pool|undefined,child:ChildProcess|undefined;
 const operations=new Map<string,any>(),keys=new Map<string,string>(),submissions=new Map<string,number>();
 let clientOpen=true;
 const provider=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  const route=req.url!;let body:any={};
  if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);body=JSON.parse(Buffer.concat(chunks).toString());}
  if(route.endsWith('/health')){res.end('{"ready":true}');return;}
  if(route.endsWith('/execute')) {
   const key=body.idempotency_key,task=body.task;
   if(keys.has(key)){res.end(JSON.stringify({externalId:keys.get(key)}));return;}
   const id=randomUUID(),name=task.name,first=name==='retry'&&!operationsHas(name);
   keys.set(key,id);submissions.set(name,(submissions.get(name)??0)+1);
   operations.set(id,{name,worker:task.payload,clientWasOpen:clientOpen,started:Date.now(),
    ready:Date.now()+(name==='crash'?3500:700),failed:first,expected:task.payload.expected});
   res.end(JSON.stringify({externalId:id}));return;
  }
  const id=route.split('/').at(-1)!,op=operations.get(id);
  if(!op){res.statusCode=404;res.end('{}');return;}
  if(route.includes('/usage/')){res.end('{"quotaUnits":0,"costAmount":0}');return;}
  if(route.includes('/cancel/')){res.end('{"terminal":true}');return;}
  const result=Date.now()<op.ready?{state:'RUNNING'}:op.failed?{state:'FAILED',error:{code:'TRANSIENT',message:'controlled',retryable:true}}:
   {state:'SUCCEEDED',output:op.expected,quotaUnits:0,costAmount:0,qa:{deterministicPassed:true,score:1,confidence:1,evidenceSufficient:true}};
  res.end(JSON.stringify(result));
 });
 function operationsHas(name:string){return [...operations.values()].some(o=>o.name===name);}
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
 const port=(provider.address() as any).port;
 const scope={tenantId:'gl',workspaceId:'legacy-workspace',projectId:'GL_AUTOMATION'};
 let stderr='';
 try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  for(const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql',
   '005_platform_dispatch.sql','006_global_approval_audit.sql','007_runtime_capability_projection.sql','008_durable_runtime.sql'])
   await owner.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
  await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  const database=new URL(process.env.AGY_TEST_DATABASE_URL!);database.searchParams.set('options',`-c search_path=${schema},public -c role=${role}`);
  runtime=new Pool({connectionString:database.toString()});
  const project=new ProjectPool(runtime,scope,'runtime-test').asPool(),store=new PostgresStore(project,scope);
  await project.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read'],resource_policy='{"maxConcurrentTasks":4,"quotaCap":100,"spendCap":0,"reservation":0}'`);
  for(const [i,capabilities] of [['a',['text']],['b',['text']],['c',['parallel']]] as const) {
   await project.query(`INSERT INTO agy_connectors(connector_id,kind,capabilities,endpoint,secret_ref,enabled)
    VALUES($1,'controlled-runtime',$2,$3,'AGY_SECRET_CONTROLLED',true)`,[i,[...capabilities],`http://127.0.0.1:${port}/${i}`]);
   await new ResourceStore(owner).register({...discoverResource(i,[...capabilities],Date.now()),status:'READY',ready:true,
    quotaRemaining:100,maxConcurrency:1,passRate:.99,retryRate:0,errorRate:0,contextLossRisk:0,
    spendCap:0,quotaCap:100,permissions:['read']},'controlled-runtime');
  }
  const identities=['a','b','c'].map(i=>({subject:i,role:'worker',scopes:[scope],workerId:i,token:'test-'+i}));
  const launch=()=>{
   // Do not inherit live provider keys/approval/credentials into synthetic children.
   const env:Record<string,string>={SystemRoot:process.env.SystemRoot??'',PATH:process.env.PATH??'',AGY_STAGE_ONLY:'true',
    DATABASE_URL:database.toString(),AGY_IDENTITIES_JSON:JSON.stringify(identities),AGY_SECRET_CONTROLLED:'test-only',
    AGY_RUNTIME_CONCURRENCY:'3',AGY_RUNTIME_POLL_MS:'75',AGY_RUNTIME_HEARTBEAT_MS:'100',AGY_RUNTIME_LEASE_SECONDS:'1',
    AGY_RUNTIME_LANES_JSON:JSON.stringify(['a','b','c'].map(i=>({scope,workerTokenRef:'AGY_TEST_'+i.toUpperCase(),connectorId:i}))),
    AGY_TEST_A:'test-a',AGY_TEST_B:'test-b',AGY_TEST_C:'test-c'};
   child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/platform/daemon.ts',import.meta.url))],{env,stdio:['ignore','ignore','pipe']});
   child.stderr!.on('data',d=>{stderr+=d.toString();});
  };
  const task=(name:string,cap='text',extra:any={})=>({idempotencyKey:name,name,taskType:'text',risk:'LOW' as const,
   deterministic:true,requiredCapabilities:[cap],permissionGranted:true,safetyApproved:true,requiredPermissions:['read'],
   estimatedQuota:0,estimatedCost:0,maxRetry:3,payload:{verification:'AGY_MISSION5',expected:{name}},...extra});
  const input={tenantId:'gl',idempotencyKey:'offline',objective:'controlled daemon acceptance',mode:'DAG' as const,passThreshold:.8,
   tasks:[task('blocked','unavailable',{maxRetry:0}),task('dependent','text',{dependsOn:['blocked']}),task('retry'),task('independent','parallel')]};
  const job=await store.createJob(input);
  // A real BLOCKED task and its descendant remain isolated from independent work.
  await project.query(`UPDATE agy_tasks SET status='BLOCKED',error='{"code":"APPROVAL_REQUIRED"}' WHERE name='blocked'`);
  launch();clientOpen=false; // caller disconnected; child owns the queue with no client heartbeat requirement.
  await until(async()=> (await project.query(`SELECT count(*) n FROM agy_tasks WHERE name IN ('retry','independent') AND status='PASS'`)).rows[0].n==='2');
  assert.equal([...operations.values()].find(o=>o.name==='independent').clientWasOpen,false);
  const firstRetry=[...operations.values()].find(o=>o.name==='retry'),independent=[...operations.values()].find(o=>o.name==='independent');
  assert.ok(Math.abs(firstRetry.started-independent.started)<700,'independent lanes overlapped');
  assert.equal(submissions.get('retry'),2);
  const retryEvents=(await project.query(`SELECT worker_id,to_status FROM agy_task_events WHERE event_type='DURABLE_RUNTIME' AND task_id IN(SELECT task_id FROM agy_tasks WHERE name='retry') ORDER BY event_id`)).rows;
  assert.ok(retryEvents.some(r=>r.to_status==='RETRY'));
  assert.equal(new Set(retryEvents.filter(r=>r.to_status==='CLAIMED').map(r=>r.worker_id)).size,2,'rerouted to another worker');
  const status=await runtimeStatus(project);
  assert.equal(status.dispatcherHealthy,true);assert.equal(status.tasks.find(t=>t.name==='dependent')!.status,'BLOCKED');
  assert.equal(status.tasks.find(t=>t.name==='independent')!.status,'PASS');
  const restart=await store.createJob({...input,idempotencyKey:'restart',tasks:[task('crash')]});
  await until(async()=>!!(await project.query(`SELECT checkpoint FROM agy_tasks WHERE job_id=$1 AND status='RUNNING'`,[restart.jobId])).rows[0]?.checkpoint?.externalId);
  const crashedId=(await project.query('SELECT checkpoint FROM agy_tasks WHERE job_id=$1',[restart.jobId])).rows[0].checkpoint.externalId;
  const crashed=child!;crashed.kill('SIGKILL');await new Promise(r=>crashed.once('exit',r));child=undefined;
  await delay(1250);
  assert.equal((await runtimeStatus(project)).dispatcherHealthy,false,'stale heartbeat cannot report healthy');
  // Test fast expiry of the documented 30-second worker cooldown, without erasing checkpoint.
  launch();
  await until(async()=> (await project.query('SELECT status FROM agy_tasks WHERE job_id=$1',[restart.jobId])).rows[0].status==='RETRY');
  await project.query(`UPDATE agy_project_worker_health SET blocked_until=now()-interval '1 second'`);
  await until(async()=> (await project.query('SELECT status FROM agy_tasks WHERE job_id=$1',[restart.jobId])).rows[0].status==='PASS');
  assert.equal(submissions.get('crash'),1,'restart collected same operation without duplicate execute');
  assert.equal((await project.query('SELECT checkpoint FROM agy_tasks WHERE job_id=$1',[restart.jobId])).rows[0].checkpoint.externalId,crashedId);
  assert.equal((await store.createJob({...input,idempotencyKey:'restart',tasks:[task('crash')]})).duplicate,true);
  assert.equal((await runtime.query('SELECT * FROM agy_runtime_workers')).rowCount,0,'runtime status forced RLS');
  assert.equal(stderr,'');
  await mkdir(new URL('../runtime-evidence/',import.meta.url),{recursive:true});
  await writeFile(new URL('../runtime-evidence/process-acceptance.json',import.meta.url),JSON.stringify({
   observedAt:new Date().toISOString(),layer:'REAL_POSTGRESQL_AND_CHILD_DAEMON_CONTROLLED_HTTP_PROVIDER',
   clientDisconnectedContinuation:true,independentConcurrentExecution:true,blockedDependencyIsolation:true,
   transientRetryAndDifferentWorker:true,queryableStatus:true,staleHeartbeatTruthful:true,
   killedProcessRecovery:true,providerResubmissionsAfterRestart:0,jobIdempotency:true,forcedRls:true,
   actualChatClosedTest:false,hostedDeploymentVerified:false,nativeProviderDispatchVerified:false,
   cooldownAcceleratedInTest:true,productionReady:false},null,2));
 }catch(error){
  console.error('controlled daemon diagnostic',stderr,await owner.query('SELECT name,status,error,attempt FROM agy_tasks').then(r=>r.rows),[...operations.values()]);throw error;
 }finally {
  if(child){const c=child;c.kill('SIGKILL');await new Promise(r=>c.once('exit',r));}
  provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));
  await runtime?.end();await owner.end();
  // Only validated random disposable test objects, no application data removal.
  if(!/^agy_runtime_test_[a-f0-9]{32}$/.test(schema)||!/^agy_runtime_role_[a-f0-9]{32}$/.test(role))throw new Error('INVALID_TEST_TARGET');
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();
 }
});
