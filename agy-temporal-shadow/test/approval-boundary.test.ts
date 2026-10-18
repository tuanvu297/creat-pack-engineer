import test from "node:test";
import assert from "node:assert/strict";
import { operationsApi } from "../src/operations-api.js";
import { LearningEngine } from "../src/learning-engine.js";
test("worker service path cannot invoke promotion or rollback without separate authority",async()=>{
  const fakePool={query:async()=>{throw new Error('DB should not be touched');},connect:async()=>{throw new Error('DB should not be touched');}} as any;
  await assert.rejects(()=>operationsApi('/v1/approvals/promote','POST',{candidate_id:'candidate'},fakePool),/APPROVAL_AUTHORITY_REQUIRED/);
  await assert.rejects(()=>operationsApi('/v1/approvals/rollback','POST',{candidate_id:'candidate'},fakePool),/APPROVAL_AUTHORITY_REQUIRED/);
});
test("famous external documentation is evidence to explore, not automatic proof",()=>{
  const e=new LearningEngine(()=>1000);e.explore({candidateId:'doc',kind:'novel-skill',destination:'quality',context:'research',baselineRef:'baseline',hypothesis:'validate external claim'});e.startTest('doc');
  for(let i=0;i<3;i++)e.addEvidence('doc',{evidenceId:`doc-${i}`,source:'famous expert / official documentation',kind:'documentation',context:'research',taskType:'research',trialId:`doc-${i}`,sampleCount:1000,baselinePassRate:.8,candidatePassRate:1,reproducible:true,regressionPassed:true,qaPassed:true,safetyPassed:true,permissionPassed:true,stabilityPassed:true,contextLossDelta:0,costDelta:0,quotaDelta:0,throughputDelta:1,centralLoadDelta:0,verdict:'SUPPORT',observedAt:1000});
  const r=e.report('doc');assert.equal(r.eligible,false);assert.equal(r.sampleCount,0);assert.ok(r.reasons.includes('CONTROLLED_EXPERIMENT_REQUIRED'));
});
