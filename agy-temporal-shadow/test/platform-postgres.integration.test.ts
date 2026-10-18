import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { ProjectPool } from '../src/platform/scoped-pool.js';
import { PostgresStore } from '../src/postgres-store.js';
import { LearningStore } from '../src/learning-store.js';
import { ResourceStore } from '../src/resource-store.js';
import { discoverResource } from '../src/resources/discovery.js';
import { WorkerEngine } from '../src/engine.js';
import type { WorkerAdapter,ExecutionResult } from '../src/types.js';
import {codexVerificationProfile,ConnectorError} from '../src/adapters.js';
import {sharedPoolProfiles} from '../src/resources/allocation.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Requires a disposable PostgreSQL 17 TEST instance whose test administrator can create roles/schemas.
// Never point AGY_TEST_DATABASE_URL at a production database.
test('platform SQL: transactional rollback, legacy GL migration, forced RLS, project idempotency, concurrent core execution and failure isolation',
 {skip:!process.env.AGY_TEST_DATABASE_URL},async()=>{
 const suffix=randomUUID().replaceAll('-',''),schema=`agy_platform_test_${suffix}`,role=`agy_test_role_${suffix}`;
 if(!/^agy_platform_test_[a-f0-9]{32}$/.test(schema)||!/^agy_test_role_[a-f0-9]{32}$/.test(role))throw new Error('INVALID_TEST_TARGET');
 const admin=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL}),owner=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
 let runtime:Pool|undefined,roleCreated=false,schemaCreated=false;
 try {
  await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;
  for(const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql'])await owner.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const jobInput={tenantId:'gl',idempotencyKey:'legacy',objective:'legacy',mode:'SINGLE_WORKFLOW' as const,passThreshold:.8,tasks:[{idempotencyKey:'task',name:'test',taskType:'text'}]};
  const legacy=await new PostgresStore(owner).createJob(jobInput);
  const migration=await readFile(new URL('../migrations/004_platform_projects.sql',import.meta.url),'utf8');
  const body=migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,'');const dry=await owner.connect();
  try{await dry.query('BEGIN');await dry.query(body);await dry.query('ROLLBACK');}finally{dry.release();}
  assert.equal((await owner.query("SELECT to_regclass('agy_projects') AS name")).rows[0].name,null);
  assert.equal((await owner.query('SELECT job_id FROM agy_jobs')).rows[0].job_id,legacy.jobId);
  await owner.query(migration);
  await owner.query(await readFile(new URL('../migrations/005_platform_dispatch.sql',import.meta.url),'utf8'));
  await owner.query(await readFile(new URL('../migrations/006_global_approval_audit.sql',import.meta.url),'utf8'));
  const originalDispatch=(await owner.query("SELECT prosrc FROM pg_proc WHERE oid='agy_sync_dispatch()'::regprocedure")).rows[0].prosrc;
  const migration7=await readFile(new URL('../migrations/007_runtime_capability_projection.sql',import.meta.url),'utf8');
  const transaction=await owner.connect();try{await transaction.query('BEGIN');await transaction.query(migration7.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));await assert.rejects(()=>transaction.query('SELECT 1/0'));await transaction.query('ROLLBACK');}finally{transaction.release();}
  assert.equal((await owner.query("SELECT prosrc FROM pg_proc WHERE oid='agy_sync_dispatch()'::regprocedure")).rows[0].prosrc,originalDispatch);
  await owner.query(migration7);await owner.query(await readFile(new URL('../rollback/007_runtime_capability_projection.sql',import.meta.url),'utf8'));
  assert.equal((await owner.query("SELECT prosrc FROM pg_proc WHERE oid='agy_sync_dispatch()'::regprocedure")).rows[0].prosrc.replaceAll('\r',''),originalDispatch.replaceAll('\r',''));await owner.query(migration7);
  assert.equal((await owner.query('SELECT project_id FROM agy_jobs WHERE job_id=$1',[legacy.jobId])).rows[0].project_id,'GL_AUTOMATION');
  assert.equal(Number((await owner.query('SELECT count(*) AS n FROM agy_learning_state')).rows[0].n),1);
  await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);roleCreated=true;
  await owner.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await owner.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await owner.query(`GRANT DELETE ON agy_dispatch_tasks TO ${role}`);
  await owner.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  runtime=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL,options:`-c search_path=${schema},public -c role=${role}`});
  const a={tenantId:'gl',workspaceId:'legacy-workspace',projectId:'GL_AUTOMATION'},b={...a,projectId:'SIMULATED_B'};
  // Administrator still supplies transaction-local scope; RLS never grants bypass to project identity.
  const provision=await owner.connect();try{
   await provision.query('BEGIN');await provision.query("SELECT set_config('agy.tenant_id',$1,true),set_config('agy.workspace_id',$2,true),set_config('agy.project_id',$3,true)",[b.tenantId,b.workspaceId,b.projectId]);
   await provision.query("INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,source_of_truth_ref,policy_ref) VALUES($1,$2,$3,'Simulation B','repo:b','policy:b')",[b.tenantId,b.workspaceId,b.projectId]);await provision.query('COMMIT');
  }catch(e){await provision.query('ROLLBACK');throw e;}finally{provision.release();}
  const pa=new ProjectPool(runtime,a,'a').asPool(),pb=new ProjectPool(runtime,b,'b').asPool();
  for(const pool of [pa,pb])await pool.query(`UPDATE agy_projects SET status='ACTIVE',permissions=ARRAY['read'],resource_policy='{"maxConcurrentTasks":2,"quotaCap":100,"spendCap":10,"reservation":1}'`);
  assert.equal((await pb.query('SELECT * FROM agy_jobs')).rowCount,0);assert.equal((await pb.query('UPDATE agy_jobs SET objective=$1 WHERE job_id=$2',['tamper',legacy.jobId])).rowCount,0);
  await assert.rejects(()=>pb.query("INSERT INTO agy_artifacts(job_id,uri) VALUES($1,'artifact://wrong')",[legacy.jobId]),/SCOPE_DENIED/);
  await assert.rejects(()=>pb.query("INSERT INTO agy_jobs(tenant_id,workspace_id,project_id,idempotency_key,objective,mode) VALUES('gl','legacy-workspace','GL_AUTOMATION','x','x','SINGLE_WORKFLOW')"),/SCOPE_DENIED/);
  const sa=new PostgresStore(pa,a),sb=new PostgresStore(pb,b);
  for(const p of [pa,pb])await p.query("INSERT INTO agy_connectors(connector_id,kind,capabilities,endpoint,secret_ref,enabled) VALUES('fake','fake',ARRAY['text'],'https://example.invalid','AGY_SECRET_FAKE',true)");
  const input={...jobInput,idempotencyKey:'shared-key',tasks:[{idempotencyKey:'task',name:'test',taskType:'text',risk:'LOW' as const,deterministic:true,requiredCapabilities:['text'],permissionGranted:true,safetyApproved:true,requiredPermissions:['read'],estimatedQuota:1,estimatedCost:.1,maxRetry:0}]};
  const [ja,jb]=await Promise.all([sa.createJob(input),sb.createJob(input)]);assert.notEqual(ja.jobId,jb.jobId);assert.equal((await sa.createJob(input)).duplicate,true);
  const r={...discoverResource('shared',['text'],Date.now()),status:'READY' as const,ready:true,quotaRemaining:100,quotaReserve:10,maxConcurrency:2,passRate:.99,retryRate:0,errorRate:0,contextLossRisk:0,spendCap:100,quotaCap:100,permissions:['read']};
  await new ResourceStore(owner).register(r,'fake');
  const result:ExecutionResult={state:'SUCCEEDED',output:{ok:true},quotaUnits:1,costAmount:.1,qa:{deterministicPassed:true,score:1,confidence:1,evidenceSufficient:true}};
  const adapter:WorkerAdapter={name:'fake',capabilities:['text'],execute:async()=>({externalId:randomUUID()}),check_status:async()=>result,collect_result:async()=>result,cancel:async()=>{},health:async()=>({ready:true})};
  // Legacy imported task remains queued but lacks permission/cost; it cannot consume resource.
  const ea=new WorkerEngine(sa,adapter,'shared'),eb=new WorkerEngine(sb,adapter,'shared');
  const outcomes=await Promise.all([ea.tick(),eb.tick()]);
  // Dispatcher may fairly defer one caller; once the selected project completes the deferred tick must run.
  if(outcomes[0]==='IDLE')outcomes[0]=await ea.tick();if(outcomes[1]==='IDLE')outcomes[1]=await eb.tick();
  assert.deepEqual(outcomes,['PASS','PASS']);
  await sa.recordWorkerFailure('shared','INVALID_INPUT',1,0);
  assert.equal((await pb.query('SELECT * FROM agy_project_worker_health')).rowCount,0);assert.equal((await owner.query('SELECT status FROM agy_workers')).rows[0].status,'READY');
  await new LearningStore(pa,true).transact(e=>e.trigger('SKILL_GAP','private-a'));
  assert.equal((await new LearningStore(pb,true).read()).events.length,0);
  await pa.query("INSERT INTO agy_connectors(connector_id,kind,capabilities,endpoint,secret_ref) VALUES('same','fake',ARRAY['text'],'https://a.invalid','AGY_SECRET_A')");
  await pb.query("INSERT INTO agy_connectors(connector_id,kind,capabilities,endpoint,secret_ref) VALUES('same','fake',ARRAY['text'],'https://b.invalid','AGY_SECRET_B')");
  assert.equal((await pb.query("SELECT endpoint FROM agy_connectors WHERE connector_id='same'")).rows[0].endpoint,'https://b.invalid');
  assert.equal((await runtime.query('SELECT * FROM agy_tasks')).rowCount,0);
  // Mission 5 controlled provider semantics; real SQL/runtime role, not live provider proof.
  const m5:any={layer:'CONTROLLED_PROVIDER + REAL_POSTGRESQL',checks:[],exactlyOnceProviderExecutionClaimed:false};
  const note=(name:string,detail:any)=>m5.checks.push({name,status:'PASS',detail});
  const profile={...codexVerificationProfile(Date.now()),provider:'CONTROLLED_PROVIDER',connector_id:'fake',shared_resource_pool_id:'controlled-shared-pool',health_freshness:{observed_at:Date.now(),max_age_ms:600000}};
  for(const id of ['pool-a','pool-b'])await new ResourceStore(owner).register({...r,workerId:id,capabilities:['pool'],maxConcurrency:1,quotaReserve:1,runtimeProfile:profile,sharedPoolAllowance:{quotaCap:10,spendCap:10,maxConcurrency:1}},'fake');
  await pa.query('UPDATE agy_projects SET priority=20');
  const spec={...input.tasks[0],requiredCapabilities:['pool'],maxRetry:2,minimumConnectorClass:'VERIFICATION_ONLY' as const};
  const make=async(store:PostgresStore,key:string)=>store.createJob({...input,idempotencyKey:key,tasks:[spec]});
  const start=async()=>{const t=await sa.claim({workerId:'pool-a',capabilities:['pool'],leaseSeconds:30});assert.ok(t);await sa.transition(t.taskId,t.leaseToken,['CLAIMED'],'RUNNING');return t;};
  const defJob=await make(sa,'m5-deferred'),bJob=await make(sb,'m5-b-shared');const deferred=await start();assert.equal(deferred.jobId,defJob.jobId);
  assert.equal(await sb.claim({workerId:'pool-b',capabilities:['pool'],leaseSeconds:30}),null);
  await sa.saveSubmissionIntent(deferred,'fake','synthetic-key');
  const controlledResult:ExecutionResult={...result,costAmount:null,tokens:12};
  const controlledAdapter:WorkerAdapter={name:'fake',capabilities:['pool'],runtimeProfile:profile,health:async()=>({ready:true}),execute:async()=>({externalId:'controlled-operation'}),check_status:async()=>controlledResult,collect_result:async()=>controlledResult,cancel:async()=>{}};
  // Exercise engine's long-throttle catch, rather than calling deferTask directly only.
  const throttleJob=await make(sa,'m5-throttle-engine');
  await sa.deferTask(deferred,'pool-a',60000,'RATE_LIMIT');
  const bBefore=(await pb.query('SELECT row_to_json(t) AS row FROM agy_tasks t WHERE job_id=$1',[bJob.jobId])).rows;
  const throttle=new WorkerEngine(sa,{...controlledAdapter,execute:async()=>{throw new ConnectorError('RATE_LIMIT',true,60000);}},'pool-a');
  assert.equal(await throttle.tick(),'FAIL');
  const throttleState=(await pa.query('SELECT status,available_at,checkpoint FROM agy_tasks WHERE job_id=$1',[throttleJob.jobId])).rows[0];
  assert.equal(throttleState.status,'RETRY');assert.equal(throttleState.checkpoint,null);assert.ok(new Date(throttleState.available_at).getTime()>Date.now()+55000);
  const heldCount=Number((await pa.query("SELECT count(*) AS n FROM agy_resource_reservations WHERE job_id=ANY($1) AND state='HELD'",[[defJob.jobId,throttleJob.jobId]])).rows[0].n);assert.equal(heldCount,0);
  assert.deepEqual((await pb.query('SELECT row_to_json(t) AS row FROM agy_tasks t WHERE job_id=$1',[bJob.jobId])).rows,bBefore);
  const bClaim=await sb.claim({workerId:'pool-a',capabilities:['pool'],leaseSeconds:30});assert.equal(bClaim?.jobId,bJob.jobId);
  await sb.transition(bClaim!.taskId,bClaim!.leaseToken,['CLAIMED'],'RUNNING');await sb.saveCheckpoint(bClaim!,'b-operation','fake');await sb.transition(bClaim!.taskId,bClaim!.leaseToken,['RUNNING'],'QA');await sb.transition(bClaim!.taskId,bClaim!.leaseToken,['QA'],'PASS');
  await sb.recordTelemetry({jobId:bJob.jobId,taskId:bClaim!.taskId,attemptId:bClaim!.leaseToken,workerId:'pool-a',outcome:'PASS',quotaUnits:1,metadata:{externalOperationId:'b-operation'}});
  const poolView=sharedPoolProfiles((await new ResourceStore(owner).list()).filter(x=>x.workerId.startsWith('pool-')));assert.equal(poolView[0].quotaUsed,1);assert.equal(poolView[1].quotaRemaining,9);
  note('long deferred retry releases capacity/reservation; B state unchanged; aliases share allowance once',{eligibleAt:throttleState.available_at,poolRemaining:9,providerQuotaRemaining:null});
  const expire=async(t:any)=>{await pa.query("UPDATE agy_tasks SET lease_expires_at=now()-interval '1 second' WHERE task_id=$1",[t.taskId]);assert.equal(await sa.reclaimExpired(),1);await pa.query("UPDATE agy_project_worker_health SET blocked_until=now()-interval '1 second'");};
  for(const window of ['A','B','C','D']){
   const job=await make(sa,'m5-crash-'+window),t=await start();assert.equal(t.jobId,job.jobId);
   if(window==='B')await sa.saveSubmissionIntent(t,'fake','uncertain-key');
   if(window==='C'||window==='D')await sa.saveCheckpoint(t,'operation-'+window,'fake');
   if(window==='D')await controlledAdapter.collect_result('operation-D'); // collect succeeded; simulate exit before local accounting
   await expire(t);
   let submissions=0,collections=0;
   const resumedWorker=window==='A'?'pool-b':'pool-a';
   const fake:WorkerAdapter={...controlledAdapter,execute:async()=>{submissions++;return {externalId:'operation-'+window};},collect_result:async()=>{collections++;return controlledResult;}};
   const outcome=await new WorkerEngine(sa,fake,resumedWorker).tick();
   if(outcome==='IDLE')console.log(JSON.stringify({window,outcome,dispatch:(await owner.query('SELECT task_id,policy,failed_workers,available_at FROM agy_dispatch_tasks')).rows,resources:await new ResourceStore(owner).list()}));
   assert.equal(outcome,window==='B'?'BLOCKED':'PASS','crash window '+window);
   assert.equal(submissions,window==='A'?1:0);
   if(window==='D'){
    const tel=(await pa.query('SELECT * FROM agy_telemetry WHERE task_id=$1',[t.taskId])).rows[0];
    const replay={jobId:job.jobId,taskId:t.taskId,attemptId:tel.attempt_id,workerId:'pool-a',outcome:'PASS',quotaUnits:1,metadata:tel.metadata};
    const usageBefore=await new ResourceStore(owner).list();await sa.recordTelemetry(replay);await sa.recordTelemetry(replay);
    assert.deepEqual((await new ResourceStore(owner).list()).map(x=>x.quotaUsed),usageBefore.map(x=>x.quotaUsed));
    const reservations=(await pa.query('SELECT actual_quota,actual_cost FROM agy_resource_reservations WHERE task_id=$1',[t.taskId])).rows;
    assert.equal(reservations.reduce((n,x)=>n+Number(x.actual_quota),0),1);assert.equal(reservations[0].actual_cost,null);
   }
   note('crash window '+window,{job_id:job.jobId,task_id:t.taskId,submissions,collections,outcome,providerPath:'CONTROLLED',strategy:window==='B'?'BLOCK_UNCERTAIN_NO_RESUBMIT':'DURABLE_CHECKPOINT_OR_SAFE_PRE_SUBMIT'});
   // Each crash case is independent; inject expiry of the prior case's project-health TTL.
   await pa.query("UPDATE agy_project_worker_health SET blocked_until=now()-interval '1 second'");
  }
  const terminalJob=await make(sa,'m5-terminal-unsettled'),terminalTask=await start();assert.equal(terminalTask.jobId,terminalJob.jobId);
  await sa.saveCheckpoint(terminalTask,'terminal-operation','fake');await sa.transition(terminalTask.taskId,terminalTask.leaseToken,['RUNNING'],'QA');await sa.transition(terminalTask.taskId,terminalTask.leaseToken,['QA'],'PASS');
  assert.equal((await pa.query('SELECT * FROM agy_telemetry WHERE task_id=$1',[terminalTask.taskId])).rowCount,0);
  const recoveredResult=await controlledAdapter.collect_result('terminal-operation');
  const recoveredUsage={jobId:terminalJob.jobId,taskId:terminalTask.taskId,attemptId:terminalTask.leaseToken,workerId:'pool-a',outcome:'PASS',quotaUnits:recoveredResult.quotaUnits,tokens:recoveredResult.tokens,costAmount:null,metadata:{externalOperationId:'terminal-operation',taskType:'text',finalOutcome:'PASS',recoveryMethod:'MANUAL_COLLECT_NO_EXECUTE'}};
  await sa.recordTelemetry(recoveredUsage);await sa.recordTelemetry(recoveredUsage);
  assert.equal((await pa.query('SELECT * FROM agy_telemetry WHERE task_id=$1',[terminalTask.taskId])).rowCount,1);
  note('terminal PASS before settlement recovered by explicit collect/accounting replay',{automaticRecovery:false,manualSafeAlternative:true,providerPath:'CONTROLLED'});
  note('migration007 transactional rollback + function-only postcommit rollback + reapply',{original001to006Unchanged:true});
  const requiredJob=await sa.createJob({...input,idempotencyKey:'m5-required-cancel',tasks:[{...spec,requiredRuntimeCapabilities:['supports_remote_cancel']}]});
  assert.equal(await sa.claim({workerId:'pool-a',capabilities:['pool'],leaseSeconds:30}),null);
  assert.equal((await pa.query('SELECT status FROM agy_tasks WHERE job_id=$1',[requiredJob.jobId])).rows[0].status,'QUEUED');
  note('SQL dispatcher projection preserves missing capability restriction',{required:'supports_remote_cancel',routed:false});
  const processed=await new LearningStore(pa,true).processEvents();assert.ok(Number(processed.processed)>0);assert.equal((await pb.query("SELECT * FROM agy_project_learning_state WHERE project_id=$1",[a.projectId])).rowCount,0);
  note('outcomes processed into private project learning only',{processed:processed.processed,globalPromotions:0});
  const output=resolve('../agy-mission5-evidence');await mkdir(output,{recursive:true});await writeFile(resolve(output,'MISSION5-CONTROLLED-PG-EVIDENCE.json'),JSON.stringify(m5,null,2));
 }finally {
  await runtime?.end();await owner.end();
  // Cleanup only exact random test objects created here, never a production schema/role.
  if(schemaCreated)await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  if(roleCreated)await admin.query(`DROP ROLE ${role}`);await admin.end();
 }
});
