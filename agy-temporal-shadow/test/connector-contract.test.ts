import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type RequestListener} from 'node:http';
import {HttpJsonAdapter} from '../src/adapters.js';
import type {ClaimedTask} from '../src/types.js';

async function fixture(handler:RequestListener,run:(adapter:HttpJsonAdapter)=>Promise<void>){
 const server=createServer(handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 try{await run(new HttpJsonAdapter('contract',['text'],`http://127.0.0.1:${address.port}`));}
 finally{server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));}
}
test('connector health HTTP 200 with ready=false is not a healthy worker',async()=>{
 await fixture((_req,res)=>res.end(JSON.stringify({ready:false,detail:'credential not ready'})),async adapter=>assert.deepEqual(await adapter.health(),{ready:false,detail:'credential not ready'}));
});
test('ambiguous remote cancellation is rejected rather than permitting blind retry',async()=>{
 await fixture((_req,res)=>res.end(JSON.stringify({remoteCancellationConfirmed:false,terminal:false})),async adapter=>{
  await assert.rejects(()=>adapter.cancel('operation'),(e:any)=>e.code==='CANCELLATION_UNCONFIRMED'&&e.retryable===false);
 });
});
test('connector key is stable across lease/attempt restart and supplied in body/header',async()=>{
 const keys:string[]=[];
 await fixture(async(req,res)=>{const parts=[];for await(const chunk of req)parts.push(chunk);const body=JSON.parse(Buffer.concat(parts).toString());
  assert.equal(req.headers['idempotency-key'],body.idempotency_key);keys.push(body.idempotency_key);res.end(JSON.stringify({externalId:'one-operation'}));
 },async adapter=>{
  const task:ClaimedTask={taskId:'synthetic-task',jobId:'synthetic-job',name:'contract',taskType:'text',idempotencyKey:'synthetic-key',status:'CLAIMED',leaseExpiresAt:new Date(),payload:{safe:true},attempt:1,leaseToken:'lease-1'};
  await adapter.execute(task,new AbortController().signal);
  await adapter.execute({...task,attempt:2,leaseToken:'lease-2'},new AbortController().signal);
 });assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
});
test('connector permission failure is permanent and is not transport-retried',async()=>{
 let calls=0;await fixture((_req,res)=>{calls++;res.writeHead(403);res.end('{}');},async adapter=>{
  await assert.rejects(()=>adapter.usage('operation'),(e:any)=>e.code==='PERMISSION_DENIED'&&e.retryable===false);
 });assert.equal(calls,1);
});
