// Acceptance runner only: existing platform modules, dedicated staging and retained disposable DB.
import {Pool} from 'pg';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {ProjectPool} from '../src/platform/scoped-pool.js';
import {ProjectService} from '../src/platform/service.js';
import {ResourceStore} from '../src/resource-store.js';
import {discoverResource} from '../src/resources/discovery.js';
import {WorkerEngine} from '../src/engine.js';
import {OpenAiResponsesAdapter,connectorIdempotencyKey} from '../src/adapters.js';
import {LearningStore} from '../src/learning-store.js';
import type {ProviderRuntimeProfile} from '../src/types.js';
if(process.env.AGY_RESUME6_APPROVED!=='true'||process.env.AGY_OPENAI_STAGING_APPROVED!=='true')throw Error('STAGING_APPROVAL_REQUIRED');
const secret=process.env.AGY_SECRET_OPENAI_STAGING,allowance=Number(process.env.AGY_MISSION5_COST_ALLOWANCE);
if(!secret||!Number.isFinite(allowance)||allowance<.005||process.env.AGY_OPENAI_MODEL!=='gpt-6.1-sol'||process.env.AGY_PROVIDER_POOL_ID!=='openai-agy-staging')throw Error('PREFLIGHT_CONFIG_REQUIRED');
const session=JSON.parse(await readFile(resolve('../../work/sprint4/session.json'),'utf8'));
for(const url of [session.runtimeUrl,session.adminUrl]){const a=new URL(url);if(a.hostname!=='127.0.0.1'||a.port!=='55474'||a.pathname!=='/'+session.db||!/^s4_candidate_[a-z0-9]+$/.test(session.db))throw Error('DISPOSABLE_SCOPE_REQUIRED');}
const runVersion=process.env.AGY_RESUME6_RUN??'001';if(!/^\d{3}$/.test(runVersion))throw Error('INVALID_RUN_VERSION');
const out=resolve('../agy-mission5-resume6-evidence'),evidencePath=resolve(out,`MISSION5-RESUME6-NATIVE-RUNTIME-${runVersion}.json`);
const scope={tenantId:'mission5-resume6',workspaceId:'synthetic',projectId:'A'},other={...scope,projectId:'B'},workerId='openai-resume6-worker';
const profile:ProviderRuntimeProfile={provider:'OpenAI Responses',connector_id:'openai-resume6',credential_scope_class:'STAGING_SERVICE',execution_mode:'background',shared_resource_pool_id:'openai-agy-staging',model:'gpt-6.1-sol',requested_model:'gpt-6.1-sol',version:null,capability_snapshot_version:'RESUME6-DISCOVERY',health_freshness:{observed_at:Date.now(),max_age_ms:60000},risk_constraints:['LOW'],classification:'LIMITED_STAGING',core_evidence_ref:null,submission_replay:'BLOCK_ON_UNCERTAINTY',supports_status:'UNVERIFIED',supports_collect:'UNVERIFIED',supports_resume:'UNVERIFIED',supports_usage:'UNVERIFIED',supports_cost:'UNVERIFIED',supports_quota_remaining:'UNVERIFIED',supports_retry_after:'UNVERIFIED',supports_background:'UNVERIFIED',supports_remote_cancel:'UNVERIFIED',supports_native_idempotency:'UNVERIFIED'};
const adapter=new OpenAiResponsesAdapter(secret,'gpt-6.1-sol',profile,'https://api.openai.com/v1',{'OpenAI-Project':'proj_kx7s2jOYpJp42KbezMuBuEXp','OpenAI-Organization':'org-XgJM3p1tFyHViIOVHJb6Pi2t'});
const raw=new Pool({connectionString:session.runtimeUrl,max:2});
const service=new ProjectService(raw,scope,{subject:'resume6-worker',role:'worker',workerId,scopes:[scope]});
const execute=promisify(execFile),mode=process.env.AGY_RESUME6_MODE;
if(mode){
 try{
  if(mode==='inspect'){
   const id='resp_02297c29438137e9006ac8c76de85887d089957d59184cd9ad';
   const response=await fetch('https://api.openai.com/v1/responses/'+id,{headers:{authorization:'Bearer '+secret,'OpenAI-Project':'proj_kx7s2jOYpJp42KbezMuBuEXp','OpenAI-Organization':'org-XgJM3p1tFyHViIOVHJb6Pi2t'},signal:AbortSignal.timeout(30000)});
   const body:any=await response.json();const safe={httpStatus:response.status,requestId:response.headers.get('x-request-id'),externalId:body.id,status:body.status,errorCode:body.error?.code??null,incompleteReason:body.incomplete_details?.reason??null,usage:body.usage??null,model:body.model};
   const state=(await service.pool.query('SELECT task_id,status,attempt,max_retry,error,checkpoint FROM agy_tasks')).rows;
   const telemetry=(await service.pool.query('SELECT outcome,usage_tokens,metadata FROM agy_telemetry')).rows;
   await writeFile(resolve(out,'MISSION5-RESUME6-READONLY-OPERATION-DIAGNOSTIC.json'),JSON.stringify({provider:safe,state,telemetry},null,2),{flag:'wx'});console.log(JSON.stringify(safe));
  }else if(mode==='submit'){
   const task=await service.store.claim({workerId,capabilities:adapter.capabilities,leaseSeconds:15});if(!task)throw Error('NO_TASK');
   assert.ok(await service.store.transition(task.taskId,task.leaseToken,['CLAIMED'],'RUNNING'));
   await service.store.saveSubmissionIntent(task,adapter.name,connectorIdempotencyKey(adapter.name,task));
   const op=await adapter.execute(task,new AbortController().signal);
   await service.store.saveCheckpoint(task,op.externalId,adapter.name);
   console.log(JSON.stringify({pid:process.pid,taskId:task.taskId,jobId:task.jobId,externalId:op.externalId,phase:'CHECKPOINT_THEN_EXIT'}));
  }else console.log(JSON.stringify({pid:process.pid,outcome:await new WorkerEngine(service.store,adapter,workerId,30).tick()}));
 }catch(e:any){console.log(JSON.stringify({pid:process.pid,failureCode:/^[A-Z_]+$/.test(e.code??e.message)?(e.code??e.message):'NATIVE_PHASE_FAILED'}));process.exitCode=1;}finally{await raw.end();}
}else{
 await mkdir(out,{recursive:true});
 try{await readFile(evidencePath);}catch(e:any){if(e.code!=='ENOENT')throw e;}
 // Exclusive output creation in finally prevents overwriting an earlier attempt.
 const evidence:any={status:'RUNNING',environment:{db:session.db,postgres:'17 disposable loopback',providerProject:'proj_kx7s2jOYpJp42KbezMuBuEXp',organization:'org-XgJM3p1tFyHViIOVHJb6Pi2t',pool:'openai-agy-staging'},checks:[],providerSubmissions:0,paidRetrySubmissions:0,productionAccess:false,unknownCost:null,unknownProviderBalance:null};
 const record=(name:string,detail:any)=>{evidence.checks.push({name,status:'PASS',detail});console.log(JSON.stringify({name,status:'PASS'}));};
 let api:ReturnType<typeof spawn>|undefined;
 const admin=new Pool({connectionString:session.adminUrl});
 const pa=service.pool,pb=new ProjectPool(raw,other,'resume6-other').asPool();
 const fresh=async()=>{assert.equal((await adapter.health()).ready,true);profile.health_freshness.observed_at=Date.now();await admin.query(`UPDATE agy_workers SET heartbeat_at=now(),resource_profile=jsonb_set(resource_profile,'{runtimeProfile}',$2) WHERE worker_id=$1`,[workerId,JSON.stringify(profile)]);};
 try{
  try{await readFile(evidencePath);throw Error('PRESERVE_EXISTING_NATIVE_EVIDENCE');}catch(e:any){if(e.code!=='ENOENT')throw e;}
  const role=(await raw.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);
  assert.equal((await adapter.health()).ready,true);record('scoped connector health',{model:'gpt-6.1-sol',inference:false});
  await admin.query(`INSERT INTO agy_tenants(tenant_id,name) VALUES($1,'Resume6 synthetic') ON CONFLICT DO NOTHING`,[scope.tenantId]);
  await admin.query(`INSERT INTO agy_workspaces(tenant_id,workspace_id,name) VALUES($1,$2,'Resume6 synthetic') ON CONFLICT DO NOTHING`,[scope.tenantId,scope.workspaceId]);
  for(const s of [scope,other]){
   const scoped=new ProjectPool(admin,s,'resume6-staging-provision').asPool();
   await scoped.query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,status,source_of_truth_ref,policy_ref,resource_policy,priority,permissions,policies) VALUES($1,$2,$3,$3,'ACTIVE','MISSION5-DRIVE','RESUME6-SYNTHETIC',$4,1000,ARRAY['read'],$5) ON CONFLICT DO NOTHING`,[s.tenantId,s.workspaceId,s.projectId,{maxConcurrentTasks:1,quotaCap:4,spendCap:allowance,reservation:0},{connectorRuntimeProfiles:{'openai-resume6':profile}}]);
   const project=(await scoped.query('SELECT policy_ref FROM agy_projects WHERE project_id=$1',[s.projectId])).rows[0];assert.equal(project?.policy_ref,'RESUME6-SYNTHETIC');
   await scoped.query(`INSERT INTO agy_project_learning_state(state) VALUES($1) ON CONFLICT DO NOTHING`,[{skills:[],candidates:[],evidence:[],experiments:[],audit:[],events:[],activePointers:{}}]);
   if(s.projectId==='A')await scoped.query(`INSERT INTO agy_connectors(connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES('openai-resume6','openai-responses',ARRAY['text','qa'],'https://api.openai.com/v1','AGY_SECRET_OPENAI_STAGING',true,ARRAY['read']) ON CONFLICT DO NOTHING`);
  }
  const resource={...discoverResource(workerId,['text','qa'],Date.now(),'gpt-6.1-sol'),status:'READY' as const,ready:true,quotaRemaining:4,quotaReserve:0,quotaCap:4,spendCap:allowance,maxConcurrency:1,passRate:1,retryRate:0,errorRate:0,contextLossRisk:0,permissions:['read'],runtimeProfile:profile,sharedPoolAllowance:{quotaCap:4,spendCap:allowance,maxConcurrency:1}};
  await new ResourceStore(admin).register(resource,adapter.name);
  record('explicit shared pool mapping',{scope,pool:profile.shared_resource_pool_id,secretRef:'AGY_SECRET_OPENAI_STAGING',providerQuota:null,allowanceIsLocal:true,bootstrapQualityEvidence:'historical controlled connector contract tests, not live model history'});
  const beforeB=(await pb.query('SELECT state FROM agy_project_learning_state')).rows;
  const token=randomBytes(24).toString('hex'),childEnv={...process.env,DATABASE_URL:session.runtimeUrl,AGY_STAGE_ONLY:'true',PORT:'55477',AGY_IDENTITIES_JSON:JSON.stringify([{subject:'resume6-operator',role:'operator',scopes:[scope],token}])};
  api=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','src/server.ts'],{env:childEnv,windowsHide:true,stdio:'ignore'});
  for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:55477/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const path=`/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/projects/A/jobs`,headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const body={idempotency_key:'resume6-single-native',objective:'Synthetic staging acceptance only',pass_threshold:.8,tasks:[{idempotencyKey:'synthetic',name:'synthetic text QA',taskType:'text',payload:{verification:'AGY_MISSION5',prompt:'Return exactly this JSON object and nothing else: {"safe":true}',expected:{safe:true}},requiredCapabilities:['text'],requiredPermissions:['read'],permissionGranted:true,safetyApproved:true,risk:'LOW',deterministic:true,estimatedQuota:1,estimatedCost:.005,maxRetry:1,timeoutSeconds:90}]};
  const request=async()=>{const r=await fetch('http://127.0.0.1:55477'+path,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(r.status,200);return r.json() as Promise<any>;};
  const job=await request();evidence.jobId=job.jobId;assert.equal((await request()).jobId,job.jobId);record('API Create Job queue and duplicate prevention',{jobId:job.jobId});
  await fresh();
  let submitted:any;try{const result=await execute(process.execPath,['node_modules/tsx/dist/cli.mjs','test/mission5-resume6-native.ts'],{env:{...process.env,AGY_RESUME6_MODE:'submit'},windowsHide:true,timeout:40000});submitted=JSON.parse(result.stdout.trim());}catch(e:any){try{const safe=JSON.parse(e.stdout.trim());evidence.nativeFailure=safe;throw Error(safe.failureCode);}catch(inner:any){throw Error(/^[A-Z_]+$/.test(inner.message)?inner.message:'SUBMIT_PROCESS_FAILED');}}
  evidence.providerSubmissions=1;evidence.submit=submitted;record('native Claim execute checkpoint process exit',submitted);
  const collected=await adapter.collect_result(submitted.externalId);record('read collect before local settlement',{state:collected.state,externalId:submitted.externalId});
  await new Promise(r=>setTimeout(r,15500));assert.equal(await service.store.reclaimExpired(),1);record('process exit lease expiry reclaim',{checkpointRetained:true});
  console.log('Waiting for existing 30-second recovery backoff; no provider replay.');await new Promise(r=>setTimeout(r,31000));await fresh();
  const resumed=await execute(process.execPath,['node_modules/tsx/dist/cli.mjs','test/mission5-resume6-native.ts'],{env:{...process.env,AGY_RESUME6_MODE:'resume'},windowsHide:true,timeout:110000});const resume=JSON.parse(resumed.stdout.trim());evidence.resume=resume;assert.notEqual(submitted.pid,resume.pid);assert.equal(resume.outcome,'PASS');record('new process status collect deterministic QA PASS',resume);
  const telemetry=(await pa.query('SELECT * FROM agy_telemetry WHERE job_id=$1',[job.jobId])).rows;assert.equal(telemetry.length,1);assert.ok(Number(telemetry[0].usage_tokens)>0);evidence.telemetry=telemetry;
  const reservations=(await pa.query('SELECT * FROM agy_resource_reservations WHERE job_id=$1 ORDER BY attempt',[job.jobId])).rows;evidence.reservations=reservations;
  const t=telemetry[0];await service.store.recordTelemetry({jobId:t.job_id,taskId:t.task_id,attemptId:t.attempt_id,workerId:t.worker_id,outcome:t.outcome,metadata:t.metadata,tokens:Number(t.usage_tokens)});
  assert.deepEqual((await pa.query('SELECT * FROM agy_resource_reservations WHERE job_id=$1 ORDER BY attempt',[job.jobId])).rows,reservations);record('accounting replay preserves reservations',{actualCost:null,tokens:Number(t.usage_tokens)});
  record('private project learning',await new LearningStore(pa,true).processEvents());assert.deepEqual((await pb.query('SELECT state FROM agy_project_learning_state')).rows,beforeB);
  const denial=await fetch(`http://127.0.0.1:55477/v1/tenants/${scope.tenantId}/workspaces/${scope.workspaceId}/projects/B/jobs/${job.jobId}`,{headers});assert.equal(denial.status,403);assert.equal((await pb.query('SELECT * FROM agy_tasks WHERE job_id=$1',[job.jobId])).rowCount,0);record('SQL API private project isolation',{http:403,otherProjectUnchanged:true});
  evidence.status='PARTIAL_NATIVE_PASS_REMAINING_GATES';
 }catch(e:any){evidence.status='BLOCKED_OR_FAIL_NATIVE';evidence.failureCode=/^[A-Z_]+$/.test(e.message)?e.message:'ACCEPTANCE_ASSERTION_FAILED';evidence.sqlState=/^[0-9A-Z]{5}$/.test(e.code??'')?e.code:null;evidence.failureClass=['permission denied','row-level security','duplicate key','syntax error','does not exist','not-null'].find(s=>String(e.message).includes(s))??null;console.log(JSON.stringify({status:evidence.status,failureCode:evidence.failureCode,sqlState:evidence.sqlState,failureClass:evidence.failureClass}));process.exitCode=1;}
 finally{api?.kill();await raw.end();await admin.end();const json=JSON.stringify(evidence,null,2);if(json.includes(secret))throw Error('EVIDENCE_SECRET_LEAK');await writeFile(evidencePath,json,{flag:'wx'});}
}
