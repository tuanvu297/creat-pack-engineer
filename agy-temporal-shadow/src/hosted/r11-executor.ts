import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,rename,readdir,open,unlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import ts from 'typescript';
import {GatewayJournal,digest} from '../gateway-shadow/journal.js';
import {GatewayTransport,identity} from '../gateway-shadow/transport.js';
import {GatewayShadowWorker} from '../gateway-shadow/worker.js';
import {R11GatewayConnector,gatewayWorkerSettings} from '../gateway-shadow/runtime.js';

async function durable(path:string,bytes:string,exclusive=false){
 const f=await open(path,exclusive?'wx':'w',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
}
async function syncDirectory(path:string){if(process.platform!=='win32'){const f=await open(path,'r');try{await f.sync();}finally{await f.close();}}}

async function main(){
 const {config,context}=gatewayWorkerSettings();
 const mode=process.argv[2];
 if(mode==='crash-probe'){
  const dir=process.argv[3];if(!/^\/data\/r11-probes\/[a-f0-9-]{36}\/crash$/.test(dir??''))throw new Error('PROBE_PATH_DENIED');
  const j=await GatewayJournal.acquire(dir,context);
  await j.once('accepted-response-lost',{effect:'one'},async()=>{
   await durable(join(dir,'effect.txt'),'one',true);await syncDirectory(dir);
   process.stdout.write('EFFECT_ACCEPTED\n');await new Promise(()=>{setInterval(()=>{},1000);});return null;
  });return {};
 }
 if(mode==='init'){
  await GatewayJournal.initialize(config.stateDir,context);
  return {status:'JOURNAL_INITIALIZED',network_requests:0};
 }
 if(mode==='inspect'||mode==='resume'){
  const before=await readFile(join(config.stateDir,'current.json'));
  const j=await GatewayJournal.acquire(config.stateDir,context);try{j.assertCertain();}finally{await j.close();}
  const state=JSON.parse(before.toString());
  const op=state.ops['external-submit']?.response?.externalId;
  const result=op?JSON.parse(await readFile(join(config.stateDir,'operations',op,'result.json'),'utf8')):null;
  return {status:'JOURNAL_VERIFIED',journal_sha256:createHash('sha256').update(before).digest('hex'),context:state.context,cycle:state.cycle,done:state.done,confirmed_operations:Object.keys(state.ops),operation_id:op??null,result_sha256:result?digest(result):null,typecheck:result?.typecheck??null,network_requests:0,submissions:0,archive_count:(await readdir(config.stateDir)).filter(n=>/^cycle-/.test(n)).length};
 }
 if(mode==='probe'){
  const dir=join('/data','r11-probes',randomUUID());await mkdir(dir,{recursive:true});
  const checks:Record<string,boolean>={};
  const rejects=async(name:string,fn:()=>Promise<unknown>,pattern:RegExp)=>{try{await fn();checks[name]=false;}catch(e){checks[name]=pattern.test(String(e));}};
  await rejects('missing_blocks',()=>GatewayJournal.acquire(dir,context),/JOURNAL_MISSING/);
  await GatewayJournal.initialize(dir,context);
  await rejects('reinit_blocks',()=>GatewayJournal.initialize(dir,context),/JOURNAL_NOT_EMPTY/);
  const j=await GatewayJournal.acquire(dir,context);
  await rejects('single_writer',()=>GatewayJournal.acquire(dir,context),/JOURNAL_LOCKED/);
  let submissions=0;
  await j.once('external-submit',{id:'probe'},async()=>{submissions++;return {externalId:'probe-accepted'};});await j.close();
  const resumed=await GatewayJournal.acquire(dir,context);
  await resumed.once('external-submit',{id:'probe'},async()=>{submissions++;return {externalId:'duplicate'};});
  checks.accepted_resume_no_duplicate=submissions===1;
  await rejects('changed_request_blocks',()=>resumed.once('external-submit',{id:'changed'},async()=>null),/IDEMPOTENCY_CONFLICT/);
  try{await resumed.once('uncertain',{id:'uncertain'},async()=>{throw new Error('ACCEPTED_RESPONSE_LOST');});}catch{}
  await resumed.close();
  const uncertain=await GatewayJournal.acquire(dir,context);
  await rejects('uncertain_no_retry',()=>uncertain.once('uncertain',{id:'uncertain'},async()=>{submissions++;return null;}),/RECONCILIATION_REQUIRED/);
  await uncertain.close();checks.no_blind_resubmit=submissions===1;
  await rejects('identity_context_blocks',()=>GatewayJournal.acquire(dir,{...context,worker:'other'}),/JOURNAL_CONTEXT_MISMATCH/);
  const bytes=await readFile(join(dir,'current.json'));
  await writeFile(join(dir,'retained.json'),bytes);await writeFile(join(dir,'current.json'),'{broken');
  await rejects('corruption_blocks',()=>GatewayJournal.acquire(dir,context),/JOURNAL_INVALID/);
  checks.corrupt_bytes_preserved=(await readFile(join(dir,'current.json'),'utf8'))==='{broken';
  const crash=join(dir,'crash');await GatewayJournal.initialize(crash,context);
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'crash-probe',crash],{env:process.env,stdio:['ignore','pipe','ignore']});
  const closed=new Promise<void>(ok=>child.once('close',()=>ok()));
  const accepted=await new Promise<boolean>(ok=>{const timeout=setTimeout(()=>ok(false),10000);child.once('error',()=>{clearTimeout(timeout);ok(false);});child.stdout.on('data',d=>{if(String(d).includes('EFFECT_ACCEPTED')){clearTimeout(timeout);ok(true);}});});
  await rejects('cross_process_single_writer',()=>GatewayJournal.acquire(crash,context),/JOURNAL_LOCKED/);
  child.kill('SIGKILL');await closed;checks.real_kill_after_accept=accepted&&child.signalCode==='SIGKILL';
  await rejects('crashed_writer_lock_blocks',()=>GatewayJournal.acquire(crash,context),/JOURNAL_LOCKED/);
  // Test-only operator reconciliation: the exact spawned PID is known and exit is observed.
  // Never remove an unknown or live runtime lock by this path.
  const pid=await readFile(join(crash,'worker.lock'),'utf8');
  if(pid!==String(child.pid)||child.exitCode===null&&child.signalCode===null)throw new Error('PROBE_WRITER_NOT_DEAD');
  await unlink(join(crash,'worker.lock'));
  const recovered=await GatewayJournal.acquire(crash,context);
  await rejects('crashed_accepted_effect_not_retried',()=>recovered.once('accepted-response-lost',{effect:'one'},async()=>{await durable(join(crash,'effect.txt'),'duplicate',true);return null;}),/RECONCILIATION_REQUIRED/);
  await recovered.close();checks.killed_effect_retained_once=(await readFile(join(crash,'effect.txt'),'utf8'))==='one';
  return {status:Object.values(checks).every(Boolean)?'PASS':'FAIL',checks,probe_dir:dir,network_requests:0};
 }
 if(mode)throw new Error('UNKNOWN_OFFLINE_COMMAND');
 let journal:GatewayJournal|undefined;
 const connector=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  try{
   if(req.method==='GET'&&req.url==='/health'){res.end('{"ready":true}');return;}
   if(req.method==='POST'&&req.url==='/execute'){
    const parts:Buffer[]=[];let size=0;for await(const p of req){size+=p.length;if(size>65536)throw new Error('BODY_LIMIT');parts.push(Buffer.from(p));}
    const request=JSON.parse(Buffer.concat(parts).toString()),task=request.task;
    if(task?.payload?.command!=='verify_gateway_contract'||task.risk!=='LOW'||task.estimatedCost!==0||!request.idempotency_key)throw new Error('COMMAND_DENIED');
    const op=task.payload.operation_id;if(!/^[a-f0-9-]{36}$/.test(op))throw new Error('OPERATION_ID_DENIED');
    const out=join(config.stateDir,'operations',op);await mkdir(out,{recursive:true});
    // The intent is durable before the effect. Existing intent never permits re-execution.
    await durable(join(out,'intent.json'),JSON.stringify({operation_id:op,request_hash:digest(request),idempotency_key:request.idempotency_key}),true);await syncDirectory(out);
    const parsed=ts.parseJsonConfigFileContent(ts.readConfigFile('tsconfig.json',ts.sys.readFile).config,ts.sys,process.cwd());
    const program=ts.createProgram(parsed.fileNames,{...parsed.options,noEmit:true});
    const diagnostics=[...parsed.errors,...ts.getPreEmitDiagnostics(program)];
    const files=await Promise.all(['src/gateway-shadow/journal.ts','src/gateway-shadow/worker.ts','src/gateway-shadow/runtime.ts','src/temporal/bridge.ts','src/hosted/r11-executor.ts'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
    const result={operation_id:op,executor_worker_id:'R11_HOSTED_ENGINEERING',route:'HOSTED_R11_FIXED_SOURCE_CHECK_NO_MODEL',typecheck:diagnostics.length?'FAIL':'PASS',diagnostic_count:diagnostics.length,files,pid:process.pid,database_environment_absent:!Object.keys(process.env).some(k=>/^DATABASE_URL$|^SUPABASE_|BOOTSTRAP|IDENTITIES/i.test(k)),effect_count:1,qa_state:'PENDING'};
    await durable(join(out,'result.tmp'),JSON.stringify(result));await rename(join(out,'result.tmp'),join(out,'result.json'));await syncDirectory(out);
    res.end(JSON.stringify({externalId:op}));return;
   }
   const match=/^\/(status|result)\/([a-f0-9-]{36})$/.exec(req.url??'');
   if(req.method!=='GET'||!match)throw new Error('ROUTE_DENIED');
   const result=JSON.parse(await readFile(join(config.stateDir,'operations',match[2],'result.json'),'utf8'));
   res.end(JSON.stringify({state:result.typecheck==='PASS'?'SUCCEEDED':'FAILED',output:result}));
  }catch{res.statusCode=409;res.end('{"error":"CONNECTOR_OUTCOME_RECONCILE_REQUIRED"}');}
 });
 await new Promise<void>((ok,no)=>{connector.once('error',no);connector.listen(8800,'127.0.0.1',ok);});
 const stop=new AbortController();const shutdown=()=>stop.abort();process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
 try{
  journal=await GatewayJournal.acquire(config.stateDir,context);
  const worker=new GatewayShadowWorker(new GatewayTransport(config.url,config.workerId,config.timeoutMs,process.env.AGY_GATEWAY_TOKEN),journal,new R11GatewayConnector(context.endpoint,context.capabilities),config);
  const outcome=await worker.tick(stop.signal);
  const state=JSON.parse(await readFile(join(config.stateDir,'current.json'),'utf8'));
  const lease=state.ops.claim?.response;
  const probes:Record<string,number>={};
  if(lease)for(const [name,change] of [['identity',{trace_id:'WRONG'}],['fence',{fence:lease.fence+1}],['worker',{worker_id:'WRONG'}]] as const){
   const response=await fetch(config.url+'/heartbeat',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+process.env.AGY_GATEWAY_TOKEN,...identity({...lease,...change})},body:'{}'});probes[name]=response.status;
  }
  return {outcome,negative_probes:probes};
 }finally{process.off('SIGTERM',shutdown);process.off('SIGINT',shutdown);await journal?.close();connector.closeAllConnections();await new Promise<void>(ok=>connector.close(()=>ok()));}
}
main().then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(JSON.stringify({status:'BLOCKED',code:/^[A-Z_]+$/.test(e?.message)?e.message:'R11_RECONCILIATION_REQUIRED'}));process.exitCode=1;});
