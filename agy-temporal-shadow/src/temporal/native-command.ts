import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import type {TemporalBridge} from './bridge.js';
import type {Mission,Binding,WorkerReceipt} from './contracts.js';
import {randomUUID,createHash} from 'node:crypto';
// Exactly one fixed non-Work command lane; no shell, model turn, caller argv or endpoint.
export async function nativeCommand(bridge:TemporalBridge,m:Mission,b:Binding){
 const pool=bridge.pool(m),operation=randomUUID();
 const inserted=await pool.query(`INSERT INTO agy_temporal_native_operations(workflow_id,attempt,operation_id,request_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,[b.workflow_id,b.attempt,operation,'command-'+operation]);
 if(!inserted.rowCount)return {state:'UNCERTAIN' as const}; // reconcile, never launch again
 const receipt:WorkerReceipt={task_id:m.task_id,attempt:b.attempt,idempotency_key:m.idempotency_key,executor_worker_id:m.executor_worker_id,operation_id:operation};
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^AGY_|TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL/i.test(k)));
 const script=fileURLToPath(new URL('./native-check.js',import.meta.url));
 let p:ReturnType<typeof spawn>;
 try{p=spawn(process.env.AGY_CODEX_EXECUTABLE??'codex',['-a','never','app-server','--stdio'],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});}
 catch(e){await pool.query("UPDATE agy_temporal_native_operations SET state='BLOCKED_ROUTE',error=$3,updated_at=now() WHERE workflow_id=$1 AND attempt=$2",[b.workflow_id,b.attempt,{code:(e as NodeJS.ErrnoException).code,stage:'SPAWN_BEFORE_COMMAND'}]);return {state:'BLOCKED_ROUTE' as const};}
 let stderr='',chain=Promise.resolve(),commandSent=false,rpcError:unknown;
 const send=(v:unknown)=>p.stdin!.write(JSON.stringify(v)+'\n');
 return new Promise<{state:'ACKED'|'UNCERTAIN'|'BLOCKED_ROUTE';receipt?:WorkerReceipt}>(resolveDone=>{
  let finished=false;
  const heartbeat=setInterval(()=>{void bridge.activities().heartbeat_checkpoint(m,b).catch(()=>{});},5000);
  const finish=async(state:'ACKED'|'UNCERTAIN'|'BLOCKED_ROUTE')=>{
   if(finished)return;finished=true;clearTimeout(timer);clearInterval(heartbeat);lines.close();p.stdin?.end();p.kill();await chain.catch(()=>{});
   if(state!=='ACKED')await pool.query('UPDATE agy_temporal_native_operations SET state=$3,error=$4,updated_at=now() WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt,state,{stage:commandSent?'COMMAND_OUTCOME_UNCERTAIN':'BEFORE_COMMAND',rpc_error:rpcError??null,stderr:stderr.slice(-2048)}]);
   resolveDone({state,...(state==='ACKED'?{receipt}:{})});
  };
  const timer=setTimeout(()=>{void finish(commandSent?'UNCERTAIN':'BLOCKED_ROUTE');},Math.min(m.ack_timeout_ms-500,55000));
  p.on('error',()=>{void finish(commandSent?'UNCERTAIN':'BLOCKED_ROUTE');});
  p.on('exit',()=>{if(!finished)void finish(commandSent?'UNCERTAIN':'BLOCKED_ROUTE');});
  p.stderr?.on('data',d=>{stderr=(stderr+d).slice(-4096);});
  const lines=createInterface({input:p.stdout!});
  lines.on('line',line=>{chain=chain.then(async()=>{
   if(finished)return;const msg=JSON.parse(line);
   if(msg.id===1){
    if(msg.error){rpcError=msg.error;setImmediate(()=>{void finish('BLOCKED_ROUTE');});return;}
    send({method:'initialized',params:{}});commandSent=true;
    send({id:2,method:'command/exec',params:{command:[process.execPath,script,operation,String(m.payload.command)],cwd:process.cwd(),timeoutMs:50000,sandboxPolicy:{type:'workspaceWrite',writableRoots:[process.cwd()],networkAccess:false,excludeSlashTmp:true,excludeTmpdirEnvVar:true}}});
   }
   if(msg.id===2){
    if(msg.error){rpcError=msg.error;setImmediate(()=>{void finish([-32600,-32601,-32602].includes(msg.error.code)?'BLOCKED_ROUTE':'UNCERTAIN');});return;}
    stderr=String(msg.result?.stderr??'').slice(-4096);
    if(msg.result?.exitCode!==0){rpcError={exit_code:msg.result?.exitCode};setImmediate(()=>{void finish('UNCERTAIN');});return;}
    const stdout=String(msg.result.stdout??'');if(stdout.length>32768)throw new Error('NATIVE_OUTPUT_CAP');
    for(const raw of stdout.split(/\r?\n/).filter(Boolean)){
     const e=JSON.parse(raw);if(e.operation_id!==operation||!Number.isInteger(e.pid))throw new Error('NATIVE_IDENTITY_DENIED');
     if(e.kind==='ACK'){
      await pool.query("UPDATE agy_temporal_native_operations SET state='ACKED',ack=$3,updated_at=now() WHERE workflow_id=$1 AND attempt=$2 AND ack IS NULL",[b.workflow_id,b.attempt,{...receipt,...e}]);
      await bridge.activities().record_executor_ack(m,b,receipt);
     }
     if(e.kind==='CHECKPOINT')await pool.query('UPDATE agy_temporal_native_operations SET checkpoint=$3,updated_at=now() WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt,e]);
    }
    const file=resolve('runtime-evidence/native',operation,'result.json'),bytes=await readFile(file),result=JSON.parse(bytes.toString());
    if(result.operation_id!==operation||result.typecheck!=='PASS'||result.executor_worker_id!==m.executor_worker_id)throw new Error('NATIVE_RESULT_DENIED');
    const row=(await pool.query('SELECT ack,checkpoint FROM agy_temporal_native_operations WHERE workflow_id=$1 AND attempt=$2',[b.workflow_id,b.attempt])).rows[0];
    if(!row.ack||!row.checkpoint)throw new Error('NATIVE_ACK_CHECKPOINT_REQUIRED');
    await pool.query("UPDATE agy_temporal_native_operations SET state='COMPLETE',result=$3,updated_at=now() WHERE workflow_id=$1 AND attempt=$2",[b.workflow_id,b.attempt,{...result,artifact_ref:file,artifact_sha256:createHash('sha256').update(bytes).digest('hex')}]);
    await pool.query("SELECT pg_notify('agy_temporal_result',$1)",[b.workflow_id]);
    // Finish outside the serial event callback so it can await the drained chain.
    setImmediate(()=>{void finish('ACKED');});
   }
  }).catch(()=>{setImmediate(()=>{void finish('UNCERTAIN');});});});
  send({id:1,method:'initialize',params:{clientInfo:{name:'agy_temporal_native_command',version:'0.2.0'},capabilities:{experimentalApi:true}}});
 });
}
