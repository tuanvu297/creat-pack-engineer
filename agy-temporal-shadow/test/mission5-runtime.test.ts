import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {codexVerificationProfile,stagingClassification,HttpJsonAdapter,OpenAiResponsesAdapter} from '../src/adapters.js';
import {runtimeCapabilityAllows,sharedPoolProfiles,allocateDemand} from '../src/resources/allocation.js';
import {discoverResource} from '../src/resources/discovery.js';
import {routeTasks} from '../src/scheduler.js';
import type {ClaimedTask,TaskSpec} from '../src/types.js';
const task:TaskSpec={name:'synthetic',taskType:'text',idempotencyKey:'key',risk:'LOW',deterministic:true,permissionGranted:true,safetyApproved:true,estimatedQuota:1,estimatedCost:0};
test('CONTROLLED explicit staging scope headers and exhausted quota stop without retry',async()=>{
 let calls=0;const server=createServer((req,res)=>{calls++;assert.equal(req.headers['openai-project'],'synthetic-project');assert.equal(req.headers['openai-organization'],'synthetic-org');if(req.method==='GET'){res.end(JSON.stringify({id:'controlled',status:'failed',error:{code:'credit_balance_exhausted'}}));return;}res.statusCode=429;res.end(JSON.stringify({error:{code:'insufficient_quota'}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 try{const adapter=new OpenAiResponsesAdapter('synthetic-not-secret','controlled-model',codexVerificationProfile(Date.now()),`http://127.0.0.1:${a.port}`,{'OpenAI-Project':'synthetic-project','OpenAI-Organization':'synthetic-org'});
 await assert.rejects(()=>adapter.execute({...task,taskId:'task',jobId:'job',attempt:1,status:'CLAIMED',leaseToken:'lease',leaseExpiresAt:new Date(),payload:{verification:'AGY_MISSION5',prompt:'synthetic'}},new AbortController().signal),(e:any)=>e.code==='PROVIDER_QUOTA_EXHAUSTED'&&e.retryable===false);assert.equal(calls,1);assert.equal((await adapter.check_status('controlled')).error?.code,'PROVIDER_QUOTA_EXHAUSTED');assert.equal(calls,2);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('remote_cancel required rejects UNVERIFIED/UNSUPPORTED; optional absence may route',()=>{
 const p=codexVerificationProfile(Date.now());p.supports_remote_cancel='UNSUPPORTED';
 assert.equal(runtimeCapabilityAllows(p,{...task,requiredRuntimeCapabilities:['supports_remote_cancel']}),false);
 assert.equal(runtimeCapabilityAllows(p,task),true);
});
test('background/resume requirements and unknown/stale profiles fail closed',()=>{
 const p=codexVerificationProfile(Date.now());assert.equal(runtimeCapabilityAllows(p,{...task,requiredRuntimeCapabilities:['supports_background']}),false);
 assert.equal(runtimeCapabilityAllows(p,{...task,requiredRuntimeCapabilities:['supports_resume']}),true);
 assert.equal(runtimeCapabilityAllows(undefined,{...task,requiredRuntimeCapabilities:['supports_resume']}),false);
 p.health_freshness.observed_at=0;assert.equal(runtimeCapabilityAllows(p,task),false);
});
test('account login cannot become accepted staging even with every other mocked gate true',()=>{
 const p=codexVerificationProfile(Date.now()),all={core:true,realExecution:true,credentialBoundary:true,crashRecovery:true,accounting:true,isolation:true};
 assert.equal(stagingClassification(p,all),'VERIFICATION_ONLY');
 assert.equal(runtimeCapabilityAllows(p,{...task,minimumConnectorClass:'ACCEPTED_STAGING'}),false);
 p.credential_scope_class='STAGING_SERVICE';assert.equal(stagingClassification(p,{...all,realExecution:false}),'LIMITED_STAGING');
 assert.equal(stagingClassification(p,all),'ACCEPTED_STAGING'); // application gate only, NOT live acceptance evidence
});
test('verified alias mappings aggregate allowance once, protect reserve, and unknown mapping blocks',()=>{
 const profile=codexVerificationProfile(Date.now()),make=(id:string,used:number)=>({...discoverResource(id,['text'],Date.now()),status:'READY' as const,ready:true,
  quotaCap:10,quotaUsed:used,quotaRemaining:10-used,quotaReserve:2,spendCap:10,spendUsed:used,permissions:['read'],passRate:.99,
  runtimeProfile:profile,sharedPoolAllowance:{quotaCap:10,spendCap:10,maxConcurrency:2}});
 const grouped=sharedPoolProfiles([make('a',3),make('b',4)]);assert.equal(grouped[0].quotaRemaining,3);assert.equal(grouped[1].quotaRemaining,3);
 assert.equal(allocateDemand({...task,jobId:'job',estimatedQuota:2},grouped,Date.now(),.8).workerId,null);
 const missing=make('c',0);delete (missing as any).sharedPoolAllowance;assert.equal(sharedPoolProfiles([missing])[0].ready,false);
});
test('deterministic code/rule path and cohesive vs justified parallel modes remain explicit',()=>{
 const deterministic={...task,requiredCapabilities:['deterministic-code']};const code={...discoverResource('code',['deterministic-code'],Date.now()),status:'READY' as const,ready:true,quotaRemaining:10,quotaReserve:0,quotaCap:10,spendCap:10,permissions:['read'],passRate:1};
 assert.equal(allocateDemand({...deterministic,jobId:'job'},[code],Date.now(),.8).workerId,'code');
 assert.equal(routeTasks([task,{...task,idempotencyKey:'second'}],undefined,{parallelQualityGain:1,coordinationCost:2}).mode,'SINGLE_WORKFLOW');
 assert.equal(routeTasks([task,{...task,idempotencyKey:'second'}],undefined,{parallelQualityGain:3,coordinationCost:1}).mode,'PARALLEL_BATCH');
});
test('ambiguous POST submission is not replayed without verified safe deduplication',async()=>{
 let calls=0;const server=createServer((_req,res)=>{calls++;res.destroy();});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 try{const adapter=new HttpJsonAdapter('unknown',['text'],`http://127.0.0.1:${address.port}`);
 await assert.rejects(()=>adapter.execute({...task,taskId:'task',jobId:'job',attempt:1,status:'CLAIMED',leaseToken:'lease',leaseExpiresAt:new Date()} as ClaimedTask,new AbortController().signal),(e:any)=>e.code==='SUBMISSION_UNCERTAIN'&&!e.retryable);assert.equal(calls,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
test('native reference connector contract against CONTROLLED HTTP, not provider evidence',async()=>{
 const seen:string[]=[];const server=createServer(async(req,res)=>{seen.push(req.method+' '+req.url);res.setHeader('x-request-id','controlled-request');
  if(req.url?.startsWith('/models/')){res.end('{}');return;}
  const parts:Buffer[]=[];for await(const chunk of req)parts.push(chunk);
  if(req.method==='POST'&&req.url==='/responses'){const body=JSON.parse(Buffer.concat(parts).toString());assert.equal(body.background,true);assert.equal(body.tools,undefined);assert.equal(body.max_output_tokens,128);}
  res.end(JSON.stringify({id:'controlled-operation',status:req.url?.endsWith('/cancel')?'cancelled':'completed',model:'controlled-model',usage:{total_tokens:7},output:[{content:[{type:'output_text',text:'{"safe":true}'}]}]}));
 });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 try{const profile={...codexVerificationProfile(Date.now()),submission_replay:'BLOCK_ON_UNCERTAINTY' as const};const adapter=new OpenAiResponsesAdapter('synthetic-not-secret','controlled-model',profile,`http://127.0.0.1:${a.port}`);
  assert.equal((await adapter.health()).ready,true);const response=await adapter.execute({...task,taskId:'task',jobId:'job',attempt:1,status:'CLAIMED',leaseToken:'lease',leaseExpiresAt:new Date(),payload:{verification:'AGY_MISSION5',prompt:'synthetic',expected:{safe:true}}},new AbortController().signal);
  assert.equal(response.externalId,'controlled-operation');assert.equal((await adapter.check_status(response.externalId)).providerRequestId,'controlled-request');
  assert.deepEqual((await adapter.collect_result(response.externalId)).output,{safe:true});assert.equal((await adapter.usage(response.externalId)).tokens,7);await adapter.cancel(response.externalId);
  assert.ok(seen.includes('POST /responses/controlled-operation/cancel'));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('CONTROLLED transient 503 retries only with safe gateway replay and respects bound',async()=>{
 let calls=0;const server=createServer((_req,res)=>{calls++;res.statusCode=503;res.setHeader('retry-after','0');res.end('{}');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 try{const adapter=new HttpJsonAdapter('controlled',['text'],`http://127.0.0.1:${a.port}`,undefined,codexVerificationProfile(Date.now()));
 await assert.rejects(()=>adapter.execute({...task,taskId:'task',jobId:'job',attempt:1,status:'CLAIMED',leaseToken:'lease',leaseExpiresAt:new Date()} as ClaimedTask,new AbortController().signal),(e:any)=>e.code==='CONNECTOR_TEMPORARY_FAILURE'&&e.retryable);assert.equal(calls,3);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('CONTROLLED short 429 retries; long Retry-After returns immediately; aborted read times out',async()=>{
 let calls=0,long=false;const server=createServer((_req,res)=>{calls++;if(long||calls===1){res.statusCode=429;res.setHeader('retry-after',long?'60':'0');res.end('{}');}else res.end('{"externalId":"controlled"}');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
 try{const adapter=new HttpJsonAdapter('controlled',['text'],`http://127.0.0.1:${a.port}`),t={...task,taskId:'task',jobId:'job',attempt:1,status:'CLAIMED',leaseToken:'lease',leaseExpiresAt:new Date()} as ClaimedTask;
 assert.equal((await adapter.execute(t,new AbortController().signal)).externalId,'controlled');assert.equal(calls,2);
 long=true;await assert.rejects(()=>adapter.execute(t,new AbortController().signal),(e:any)=>e.code==='RATE_LIMIT'&&e.retryAfterMs===60000);assert.equal(calls,3);
 const abort=new AbortController();abort.abort();
 const bounded=new HttpJsonAdapter('controlled',['text'],`http://127.0.0.1:${a.port}`,undefined,codexVerificationProfile(Date.now()));
 await assert.rejects(()=>bounded.execute(t,abort.signal),(e:any)=>e.code==='CONNECTOR_TIMEOUT');assert.equal(calls,3);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
