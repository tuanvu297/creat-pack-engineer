import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InMemoryStore } from "./in-memory-store.js";
import { WorkerEngine } from "../src/engine.js";
test("worker resumes checkpoint external operation without submitting duplicate execution",async()=>{
  const s=new InMemoryStore();await s.createJob({tenantId:'gl',idempotencyKey:'j',objective:'x',mode:'SINGLE_WORKFLOW',passThreshold:.8,tasks:[{name:'t',taskType:'text',idempotencyKey:'t',payload:{x:1},risk:'LOW',deterministic:true}]});
  const task=[...s.tasks.values()][0];task.checkpoint={externalId:'already-submitted',adapter:'fake',digest:createHash('sha256').update(JSON.stringify(task.payload)).digest('hex')};let submitted=0;
  const engine=new WorkerEngine(s,{name:'fake',capabilities:[],execute:async()=>{submitted++;return{externalId:'new'};},check_status:async(id)=>{assert.equal(id,'already-submitted');return{state:'SUCCEEDED'};},collect_result:async()=>({state:'SUCCEEDED',qa:{deterministicPassed:true,score:1,confidence:1,evidenceSufficient:true}}),cancel:async()=>{},health:async()=>({ready:true})},'w');
  assert.equal(await engine.tick(),'PASS');assert.equal(submitted,0);
});
test("checkpoint for different provider blocks recovery before execution",async()=>{
  const s=new InMemoryStore();await s.createJob({tenantId:'gl',idempotencyKey:'j',objective:'x',mode:'SINGLE_WORKFLOW',passThreshold:.8,tasks:[{name:'t',taskType:'text',idempotencyKey:'t',maxRetry:2}]});
  [...s.tasks.values()][0].checkpoint={externalId:'old',adapter:'other',digest:'unknown'};let submitted=false;
  const engine=new WorkerEngine(s,{name:'fake',capabilities:[],execute:async()=>{submitted=true;return{externalId:'new'};},check_status:async()=>({state:'RUNNING'}),collect_result:async()=>({state:'SUCCEEDED'}),cancel:async()=>{},health:async()=>({ready:true})},'w');
  assert.equal(await engine.tick(),'BLOCKED');assert.equal(submitted,false);
});
