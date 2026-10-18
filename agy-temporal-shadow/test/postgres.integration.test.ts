import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresStore } from "../src/postgres-store.js";
import { ResourceStore } from "../src/resource-store.js";
import { LearningStore } from "../src/learning-store.js";
import { discoverResource } from "../src/resources/discovery.js";

test("PostgreSQL migrations, claims, usage reconciliation, recovery and learning persistence",{skip:!process.env.AGY_TEST_DATABASE_URL},async()=>{
  const schema=`agy_test_${randomUUID().replaceAll('-','')}`;
  if(!/^agy_test_[a-f0-9]{32}$/.test(schema))throw new Error('INVALID_TEST_SCHEMA');
  const admin=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL});
  const pool=new Pool({connectionString:process.env.AGY_TEST_DATABASE_URL,options:`-c search_path=${schema},public`});
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for(const file of ['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql'])await pool.query(await readFile(new URL(`../migrations/${file}`,import.meta.url),'utf8'));
    const store=new PostgresStore(pool);const resources=new ResourceStore(pool);
    const resource={...discoverResource('worker',['text'],Date.now()),status:'READY' as const,ready:true,quotaRemaining:100,quotaReserve:20,maxConcurrency:1,passRate:.95,retryRate:0,errorRate:0,contextLossRisk:0,costPerTask:1,spendCap:10,quotaCap:200,permissions:['read']};
    await resources.register(resource,'fake');
    const input={tenantId:'gl',idempotencyKey:'job',objective:'test',mode:'SINGLE_WORKFLOW' as const,passThreshold:.8,tasks:[{name:'task',idempotencyKey:'task',taskType:'text',requiredCapabilities:['text'],permissionGranted:true,safetyApproved:true,requiredPermissions:['read'],estimatedQuota:10,estimatedCost:1,maxRetry:0}]};
    const first=await store.createJob(input);const duplicate=await store.createJob(input);assert.equal(first.jobId,duplicate.jobId);assert.equal(duplicate.duplicate,true);
    const claims=await Promise.all([store.claim({workerId:'worker',capabilities:['text'],leaseSeconds:30}),store.claim({workerId:'worker',capabilities:['text'],leaseSeconds:30})]);
    assert.equal(claims.filter(Boolean).length,1);const task=claims.find(Boolean)!;
    assert.equal(await store.transition(task.taskId,task.leaseToken,['CLAIMED'],'RUNNING'),true);
    await store.saveCheckpoint(task,'external-operation','fake');
    assert.equal(await store.transition(task.taskId,task.leaseToken,['RUNNING'],'QA'),true);
    assert.equal(await store.transition(task.taskId,task.leaseToken,['QA'],'PASS'),true);
    const telemetry={jobId:first.jobId,taskId:task.taskId,attemptId:task.leaseToken,workerId:'worker',outcome:'PASS',quotaUnits:5,costAmount:.5,tokens:100,metadata:{taskType:'text',promptVersion:'v1',qaFeedback:[],finalOutcome:'PASS'}};
    await store.recordTelemetry(telemetry);await store.recordTelemetry(telemetry);
    assert.equal(Number((await pool.query('SELECT count(*) AS n FROM agy_telemetry')).rows[0].n),1);
    const accounted=(await resources.list())[0];assert.equal(accounted.quotaRemaining,95);assert.equal(accounted.activeCount,0);
    const learning=new LearningStore(pool);assert.equal((await learning.processEvents()).processed,1);assert.equal((await learning.read()).events.length,1);assert.equal((await learning.processEvents()).processed,0);
    const second=await store.createJob({...input,idempotencyKey:'expire'});
    const expired=await store.claim({workerId:'worker',capabilities:['text'],leaseSeconds:1});assert.equal(expired!.jobId,second.jobId);
    await pool.query(`UPDATE agy_tasks SET lease_expires_at=now()-interval '1 second' WHERE task_id=$1`,[expired!.taskId]);
    assert.equal(await store.reclaimExpired(),1);
    assert.equal((await pool.query('SELECT status FROM agy_tasks WHERE task_id=$1',[expired!.taskId])).rows[0].status,'BLOCKED');
    assert.equal(await store.transition(expired!.taskId,expired!.leaseToken,['RUNNING'],'PASS'),false);
    await assert.rejects(()=>pool.query(`UPDATE agy_learning_audit SET action='tampered'`),/append-only/);
  } finally {
    await pool.end();
    // Only remove the validated, randomly generated test schema created above.
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();
  }
});
