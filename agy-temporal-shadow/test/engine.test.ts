import assert from "node:assert/strict";
import test from "node:test";
import { WorkerEngine } from "../src/engine.js";
import { routeTasks } from "../src/scheduler.js";
import type { ExecutionResult, WorkerAdapter } from "../src/types.js";
import { InMemoryStore } from "./in-memory-store.js";

class Adapter implements WorkerAdapter {
  name="test";capabilities=["text"];constructor(private results:ExecutionResult[]){}
  async execute(){return{externalId:"x"}} async check_status(){return this.results[0]} async cancel(){} async collect_result(){return this.results.shift()!} async health(){return{ready:true}}
}
const task=(key="a",extra:any={})=>({idempotencyKey:key,name:key,taskType:"text",requiredCapabilities:["text"],...extra});

test("duplicate prevention and job idempotency",async()=>{const s=new InMemoryStore();const input={tenantId:"gl",idempotencyKey:"job-1",objective:"x",mode:"SINGLE_WORKFLOW" as const,passThreshold:.8,tasks:[task()]};const a=await s.createJob(input);const b=await s.createJob(input);assert.equal(a.duplicate,false);assert.equal(b.duplicate,true);assert.equal(a.jobId,b.jobId);assert.equal(s.tasks.size,1)});

test("atomic claim gives a task to only one worker",async()=>{const s=new InMemoryStore();await s.createJob({tenantId:"gl",idempotencyKey:"j",objective:"x",mode:"SINGLE_WORKFLOW",passThreshold:.8,tasks:[task()]});const [a,b]=await Promise.all([s.claim({workerId:"w1",capabilities:["text"],leaseSeconds:30}),s.claim({workerId:"w2",capabilities:["text"],leaseSeconds:30})]);assert.equal([a,b].filter(Boolean).length,1)});

test("expired lease is reclaimed",async()=>{const s=new InMemoryStore();let clock=1000;s.now=()=>clock;await s.createJob({tenantId:"gl",idempotencyKey:"j",objective:"x",mode:"SINGLE_WORKFLOW",passThreshold:.8,tasks:[task("a",{maxRetry:2})]});const first=await s.claim({workerId:"w1",capabilities:["text"],leaseSeconds:2});clock=4001;assert.equal(await s.reclaimExpired(),1);const second=await s.claim({workerId:"w2",capabilities:["text"],leaseSeconds:2});assert.ok(second);assert.equal(second!.taskId,first!.taskId);assert.equal(second!.attempt,2)});

test("retry is bounded and ends BLOCKED",async()=>{const s=new InMemoryStore();await s.createJob({tenantId:"gl",idempotencyKey:"j",objective:"x",mode:"SINGLE_WORKFLOW",passThreshold:.8,tasks:[task("a",{maxRetry:1})]});const adapter=new Adapter([{state:"FAILED",error:{code:"TEMP",message:"x",retryable:true}},{state:"FAILED",error:{code:"TEMP",message:"x",retryable:true}}]);const e=new WorkerEngine(s,adapter,"w");assert.equal(await e.tick(),"FAIL");assert.equal(await e.tick(),"BLOCKED");assert.equal([...s.tasks.values()][0].attempt,2);assert.equal([...s.tasks.values()][0].status,"BLOCKED")});

test("single vs parallel routing is not mechanical",()=>{assert.equal(routeTasks([task()]).mode,"SINGLE_WORKFLOW");assert.equal(routeTasks([task("a"),task("b")]).mode,"PARALLEL_BATCH");assert.equal(routeTasks([task("a"),task("b",{dependsOn:["a"]})]).mode,"DAG");assert.equal(routeTasks([task("a"),task("b")],"SINGLE_WORKFLOW").mode,"SINGLE_WORKFLOW")});

test("failure isolation leaves independent task claimable",async()=>{const s=new InMemoryStore();await s.createJob({tenantId:"gl",idempotencyKey:"j",objective:"x",mode:"PARALLEL_BATCH",passThreshold:.8,tasks:[task("bad",{maxRetry:0,priority:2}),task("good",{priority:1})]});const failed=new WorkerEngine(s,new Adapter([{state:"FAILED",error:{code:"NO",message:"x",retryable:false}}]),"w1");assert.equal(await failed.tick(),"BLOCKED");const next=await s.claim({workerId:"w2",capabilities:["text"],leaseSeconds:30});assert.equal(next?.idempotencyKey,"good")});

test("DAG dependency blocks child until parent PASS",async()=>{const s=new InMemoryStore();await s.createJob({tenantId:"gl",idempotencyKey:"j",objective:"x",mode:"DAG",passThreshold:.8,tasks:[task("parent"),task("child",{dependsOn:["parent"],priority:99})]});const parent=await s.claim({workerId:"w",capabilities:["text"],leaseSeconds:30});assert.equal(parent?.idempotencyKey,"parent");assert.equal(await s.claim({workerId:"w2",capabilities:["text"],leaseSeconds:30}),null);await s.transition(parent!.taskId,parent!.leaseToken,["CLAIMED"],"PASS");assert.equal((await s.claim({workerId:"w2",capabilities:["text"],leaseSeconds:30}))?.idempotencyKey,"child")});
