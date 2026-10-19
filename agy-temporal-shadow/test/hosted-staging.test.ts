import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {temporalConfig} from '../src/temporal/config.js';
import {gatewayListenConfig} from '../src/temporal/hosting.js';
import {createGatewayHttpServer} from '../src/temporal/http-server.js';
import {authorize} from '../src/platform/auth.js';
import {startSupervised} from '../src/temporal/supervision.js';
const hosted={AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW',AGY_STAGE_ONLY:'true',AGY_HOSTED_STAGING:'true',TEMPORAL_ADDRESS:'temporal.railway.internal:7233',TEMPORAL_NAMESPACE:'agy-staging',PORT:'8080'};
const scope={tenantId:'gl',workspaceId:'staging',projectId:'AGY_ACCEPTANCE'};
test('Temporal worker startup sanitizes invalid database connection values',async()=>{
 const base=Object.fromEntries(Object.entries(process.env).filter(([k])=>['SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','COMSPEC'].includes(k.toUpperCase())));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/temporal/worker.js',import.meta.url))],{windowsHide:true,
  env:{...base,AGY_STAGE_ONLY:'true',AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW',DATABASE_URL:'postgres://tester:CONTROLLED_PRIVATE_VALUE@127.0.0.1:bad/db'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const [code]=await once(child,'close');assert.equal(code,1);assert.match(output,/TEMPORAL_WORKER_BLOCKED/);
 assert.doesNotMatch(output,/CONTROLLED_PRIVATE_VALUE|postgres:\/\//);
});
test('hosted opt-in accepts only private backend and staging namespace',()=>{
 assert.equal(temporalConfig({}).mode,'LEGACY');
 assert.equal(temporalConfig(hosted).address,'temporal.railway.internal:7233');
 for(const patch of [{AGY_STAGE_ONLY:'false'},{TEMPORAL_NAMESPACE:'production'},{TEMPORAL_ADDRESS:'example.com:7233'},{TEMPORAL_ADDRESS:'127.0.0.1:7233'},{TEMPORAL_ADDRESS:'temporal.railway.internal:0'},{TEMPORAL_ADDRESS:'temporal.railway.internal:65536'},{TEMPORAL_ADDRESS:'user@temporal.railway.internal:7233'}])
  assert.throws(()=>temporalConfig({...hosted,...patch}),/PRIVATE_HOSTED_STAGING_ONLY/);
 assert.throws(()=>temporalConfig({...hosted,AGY_HOSTED_STAGING:undefined}),/LOCAL_STAGING_ONLY/);
});
test('hosted listen uses PORT and 0.0.0.0; local default stays loopback',()=>{
 assert.deepEqual(gatewayListenConfig(hosted),{host:'0.0.0.0',port:8080,hosted:true});
 assert.deepEqual(gatewayListenConfig({}),{host:'127.0.0.1',port:8798,hosted:false});
 for(const port of ['0','65536','1.5','8080oops','Infinity',''])assert.throws(()=>gatewayListenConfig({...hosted,PORT:port}),/INVALID_GATEWAY_PORT/);
 assert.throws(()=>gatewayListenConfig({...hosted,AGY_ORCHESTRATION_MODE:'LEGACY'}),/HOSTED_STAGING_ONLY/);
 assert.throws(()=>gatewayListenConfig({...hosted,AGY_HOSTED_STAGING:'yes'}),/INVALID_HOSTED_STAGING_FLAG/);
});
test('real HTTP requires auth, enforces scope, and truthfully reports dependency failures',async t=>{
 let deps={postgres:true,temporal:true,worker:true},healthThrows=false,calls=0;
 const identities=[{subject:'staging-test',role:'operator' as const,scopes:[scope],token:'controlled-token'}];
 const server=createGatewayHttpServer({identities,health:async()=>{if(healthThrows)throw Error('private_connection_string');return deps;},
  execute:async(m,p,action)=>{calls++;authorize(p,m,'read');return {action,mission:m.mission_id};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+(server.address() as any).port;
 const post=(mission:any,token?:string)=>fetch(url+'/v1/agy/bootstrap',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify({mission})});
 assert.equal((await post(scope)).status,401);assert.equal((await post(scope,'wrong-token')).status,401);assert.equal(calls,0);
 assert.equal((await post({...scope,projectId:'OTHER'},'controlled-token')).status,403);
 const valid=await post({...scope,mission_id:'fresh-read-contract'},'controlled-token');assert.equal(valid.status,200);
 assert.deepEqual(await valid.json(),{action:'bootstrap',mission:'fresh-read-contract'});
 assert.equal((await fetch(url+'/health')).status,200);
 for(const key of ['postgres','temporal','worker'] as const){
  deps={postgres:true,temporal:true,worker:true};deps[key]=false;
  const res=await fetch(url+'/health');assert.equal(res.status,503);
  assert.equal((await res.json() as any).dependencies[key],false);
 }
 healthThrows=true;const unavailable=await fetch(url+'/health');assert.equal(unavailable.status,503);
 assert.doesNotMatch(await unavailable.text(),/private_connection_string|controlled-token/);
 assert.equal((await fetch(url+'/v1/agy/missing')).status,401);
});
test('HTTP caps authenticated request body and sanitizes internal errors',async t=>{
 const server=createGatewayHttpServer({identities:[{subject:'test',role:'operator',scopes:[scope],token:'controlled-token'}],
  health:async()=>({postgres:true,temporal:true,worker:false}),execute:async()=>{throw Error('postgres://private:password@host');}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+(server.address() as any).port;
 const send=(body:string)=>fetch(url+'/v1/agy/bootstrap',{method:'POST',headers:{authorization:'Bearer controlled-token'},body});
 const error=await send('{}');assert.equal(error.status,400);assert.deepEqual(await error.json(),{error:'REQUEST_FAILED'});
 assert.equal((await send('x'.repeat(65537))).status,413);
});
test('supervisor terminates sibling and fails if a child exits zero unexpectedly',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'agy-supervise-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const worker=join(dir,'worker.cjs'),gateway=join(dir,'gateway.cjs');
 await writeFile(worker,"process.send({type:'worker-ready'});setTimeout(()=>process.exit(0),300);");
 await writeFile(gateway,"setInterval(()=>{},1000);");
 const runtime=startSupervised([{name:'worker',file:worker},{name:'gateway',file:gateway}],500);
 const deadline=setTimeout(()=>runtime.stop(1),5000);t.after(()=>clearTimeout(deadline));
 assert.equal(await runtime.done,1);
 assert.ok(runtime.children.every(c=>c.exitCode!==null||c.signalCode!==null));
});

test('late gateway readiness handshake receives the already-running worker state',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'agy-ready-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const worker=join(dir,'worker.cjs'),gateway=join(dir,'gateway.cjs');
 await writeFile(worker,"process.send({type:'worker-ready'});setInterval(()=>{},1000);");
 await writeFile(gateway,"setTimeout(()=>{process.on('message',m=>{if(m.type==='worker-ready'&&m.ready)process.send({gotReady:true});});process.send({type:'gateway-listening'});},200);setInterval(()=>{},1000);");
 const runtime=startSupervised([{name:'worker',file:worker},{name:'gateway',file:gateway}],500);
 const deadline=setTimeout(()=>runtime.stop(1),5000);t.after(()=>clearTimeout(deadline));
 t.after(()=>runtime.stop(1));
 const received=new Promise<boolean>(resolve=>runtime.children[1].on('message',(m:any)=>{if(m.gotReady===true)resolve(true);}));
 const result=await Promise.race([received,runtime.done]);
 assert.equal(result,true);
 runtime.stop(0);assert.equal(await runtime.done,0);
});
test('missing child entrypoint fails the supervisor and stops the sibling',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'agy-missing-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const worker=join(dir,'worker.cjs');await writeFile(worker,"process.send({type:'worker-ready'});setInterval(()=>{},1000);");
 const runtime=startSupervised([{name:'worker',file:worker},{name:'gateway',file:join(dir,'missing.cjs')}],500);
 const deadline=setTimeout(()=>runtime.stop(1),5000);t.after(()=>clearTimeout(deadline));
 assert.equal(await runtime.done,1);assert.ok(runtime.children.every(c=>c.exitCode!==null||c.signalCode!==null));
});
test('supervisor graceful stop terminates both live children',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'agy-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const worker=join(dir,'worker.cjs'),gateway=join(dir,'gateway.cjs');
 await writeFile(worker,"process.send({type:'worker-ready'});setInterval(()=>{},1000);");
 await writeFile(gateway,"setInterval(()=>{},1000);");
 const runtime=startSupervised([{name:'worker',file:worker},{name:'gateway',file:gateway}],500);
 await once(runtime.children[0],'message');runtime.stop(0);
 assert.equal(await runtime.done,0);
 assert.ok(runtime.children.every(c=>c.exitCode!==null||c.signalCode!==null));
});
