// Readback only: never dispatches, reconciles or submits QA for existing operations.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
const out=resolve('../../../outputs/temporal-staging-02'),binding=JSON.parse(await readFile(out+'/slice2-binding.local.json','utf8')),m=JSON.parse(await readFile(out+'/MISSION.json','utf8'));
const db=new URL(process.env.AGY_TEST_DATABASE_URL!);if(db.hostname!=='127.0.0.1'||db.port!=='55438')throw new Error('LOCAL_DB_REQUIRED');
db.searchParams.set('options',`-c search_path=${binding.schema},public -c role=${binding.role}`);
const token=randomUUID();let temporal:ChildProcess|undefined,server:ChildProcess|undefined,log='';
const kill=async(c:ChildProcess|undefined)=>{if(c&&c.exitCode===null){const done=new Promise<void>(r=>c.once('exit',()=>r()));c.kill('SIGKILL');await done;}};
try{
 temporal=spawn(resolve('../tools/temporal.exe'),['server','start-dev','--ip','127.0.0.1','--port','7258','--namespace','agy-local','--headless','--db-filename',binding.sqlite],{windowsHide:true,stdio:['ignore','pipe','pipe']});temporal.stderr?.on('data',d=>{log+=d;});
 // Gateway status can read completed/pending domain state without a worker.
 await new Promise(r=>setTimeout(r,1500));
 server=spawn(process.execPath,['dist/src/temporal/server.js'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DATABASE_URL:db.toString(),AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW',AGY_STAGE_ONLY:'true',TEMPORAL_ADDRESS:'127.0.0.1:7258',TEMPORAL_NAMESPACE:'agy-local',TEMPORAL_TASK_QUEUE:binding.queue,AGY_TEMPORAL_GATEWAY_PORT:'18799',AGY_IDENTITIES_JSON:JSON.stringify([{subject:'CODEX-LOCAL-READBACK-ONLY',role:'operator',scopes:[{tenantId:m.tenantId,workspaceId:m.workspaceId,projectId:m.projectId}],token}])}});server.stderr?.on('data',d=>{log+=d;});
 let ready=false;for(let n=0;n<60;n++){try{if((await fetch('http://127.0.0.1:18799/v1/agy/callback_status',{method:'POST'})).status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const call=(action:string,mission=m)=>fetch('http://127.0.0.1:18799/v1/agy/'+action,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({mission})});
 const responses:Record<string,unknown>={};
 for(const action of ['bootstrap','current_state','active_missions','callback_status']){const r=await call(action);assert.equal(r.status,200);responses[action]=await r.json();}
 assert.equal((await call('callback_status',{...m,projectId:'OTHER'})).status,403);
 const got:any=responses.callback_status,expected=JSON.parse(await readFile(out+'/CALLBACK-RECEIPT.json','utf8'));
 assert.deepEqual(got.receipts.find((x:any)=>x.payload.task_id===m.task_id).payload,expected);
 await writeFile(out+'/HTTP-GATEWAY-READBACK.json',JSON.stringify({scope:'LOOPBACK_HTTP_ONLY_NOT_NATIVE_CHAT_OR_CROSS_ENTRYPOINT_ACCEPTANCE',auth_401:true,scope_403:true,responses,production:false},null,2));
 console.log('HTTP_CALLBACK_READBACK_PASS_LOCAL_ONLY');
}finally{await kill(server);await kill(temporal);await writeFile(out+'/http-readback.log',log);}
