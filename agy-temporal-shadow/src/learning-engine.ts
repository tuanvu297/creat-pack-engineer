export type SkillStatus = "RAW" | "CANDIDATE" | "WORTH_TESTING" | "ACTIVE" | "DEPRECATED" | "REVALIDATION_REQUIRED";
export type ExplorationKind = string; // Intentionally open: future tools, patterns, methods, architectures.
export type LearningTrigger = "JOB_OUTCOME" | "FAILURE_PATTERN" | "SKILL_GAP" | "MODEL_TOOL_CHANGE" | "PERFORMANCE_DRIFT" | "REPEATED_RETRIES" | "QA_CONFLICT" | "NEW_EVIDENCE" | "ARCHITECTURE_CANDIDATE" | "UTILIZATION_ANOMALY";
export interface Skill {
  skillId:string;version:string;status:SkillStatus;destination:string;whenToUse:string[];whenNotToUse:string[];
  requiredInputs:string[];workflow:string[];passCriteria:string[];failCriteria:string[];failureModes:string[];
  evidenceIds:string[];sources:string[];confidence:number;affectedToolsModels:string[];
  rollbackPointer:string|null;updatedAt:number;validUntil:number;modelVersions:Record<string,string>;
  packId:string;capabilitySystem:string;
}
export interface Evidence {
  evidenceId:string;source:string;kind:string;context:string;taskType:string;trialId:string;
  sampleCount:number;baselinePassRate:number;candidatePassRate:number;reproducible:boolean;
  regressionPassed:boolean;qaPassed:boolean;safetyPassed:boolean;permissionPassed:boolean;stabilityPassed:boolean;
  contextLossDelta:number;costDelta:number;quotaDelta:number;throughputDelta:number;centralLoadDelta:number;
  verdict:"SUPPORT"|"CONTRADICT"|"INCONCLUSIVE";observedAt:number;
}
export interface Experiment {
  experimentId:string;candidateId:string;context:string;stage:"PLANNED"|"SANDBOX_TEST"|"COMPARED"|"REPORTED";
  hypothesis:string;baselineRef:string;evidenceIds:string[];
}
export interface LearningCandidate {
  candidateId:string;kind:ExplorationKind;skillKey?:string;destination:string;context:string;stage:string;
  evidenceIds:string[];confidence:number;approval?:{actor:string;reportFingerprint:string;approvedAt:number};
  report?:PromotionReport;rollbackPointer:string|null;
}
export interface PromotionReport {
  candidateId:string;eligible:boolean;sampleCount:number;independentTrials:number;
  reasons:string[];evidenceIds:string[];fingerprint:string;approvalRequired:boolean;
  passThreshold:number;
}
export interface LearningAudit {sequence:number;at:number;actor:string;action:string;target:string;detail:unknown}
export interface LearningState {skills:Skill[];candidates:LearningCandidate[];evidence:Evidence[];experiments:Experiment[];audit:LearningAudit[];events:{trigger:LearningTrigger;context:string;at:number}[];activePointers:Record<string,string>}

const key=(s:Pick<Skill,"skillId"|"version">)=>`${s.skillId}@${s.version}`;
export class LearningEngine {
  private state:LearningState;
  constructor(private readonly now=()=>Date.now(),state?:LearningState) {
    this.state=structuredClone(state??{skills:[],candidates:[],evidence:[],experiments:[],audit:[],events:[],activePointers:{}});
  }
  snapshot():LearningState {return structuredClone(this.state);}
  skillPacks() {
    const packs=new Map<string,{packId:string;capabilitySystem:string;destinations:string[];skills:string[]}>();
    for(const s of this.state.skills){const pack=packs.get(s.packId)??{packId:s.packId,capabilitySystem:s.capabilitySystem,destinations:[],skills:[]};
      if(pack.capabilitySystem!==s.capabilitySystem)throw new Error("PACK_SYSTEM_CONFLICT");
      if(!pack.destinations.includes(s.destination))pack.destinations.push(s.destination);pack.skills.push(key(s));packs.set(s.packId,pack);}
    return structuredClone([...packs.values()]);
  }
  ingestSkill(skill:Skill) {
    if(skill.status!=="RAW"||!skill.skillId||!skill.version||!skill.destination||!skill.packId||!skill.capabilitySystem||!skill.workflow.length||!skill.passCriteria.length||!skill.failCriteria.length||skill.validUntil<=this.now())throw new Error("INVALID_RAW_SKILL");
    if(this.state.skills.some(s=>key(s)===key(skill)))throw new Error("IMMUTABLE_SKILL_VERSION");
    this.state.skills.push(structuredClone({...skill,confidence:0,updatedAt:this.now(),rollbackPointer:null,evidenceIds:[]}));
    this.audit("learning","RAW_SKILL",key(skill),{destination:skill.destination});
  }
  explore(input:{candidateId:string;kind:ExplorationKind;destination:string;context:string;skillKey?:string;baselineRef:string;hypothesis:string}) {
    if(!input.candidateId||!input.kind||!input.destination||!input.context||!input.baselineRef||!input.hypothesis)throw new Error("INVALID_CANDIDATE");
    if(this.state.candidates.some(c=>c.candidateId===input.candidateId))throw new Error("DUPLICATE_CANDIDATE");
    if(input.skillKey) {const skill=this.skill(input.skillKey);if(skill.status!=="RAW"&&skill.status!=="WORTH_TESTING")throw new Error("INVALID_SKILL_TRANSITION");skill.status="CANDIDATE";}
    const candidate:LearningCandidate={candidateId:input.candidateId,kind:input.kind,skillKey:input.skillKey,destination:input.destination,context:input.context,stage:"CANDIDATE",evidenceIds:[],confidence:0,rollbackPointer:null};
    this.state.candidates.push(candidate);
    this.state.experiments.push({experimentId:`experiment:${input.candidateId}:1`,candidateId:input.candidateId,context:input.context,stage:"PLANNED",hypothesis:input.hypothesis,baselineRef:input.baselineRef,evidenceIds:[]});
    this.audit("learning","EXPLORE",input.candidateId,input);
  }
  trigger(trigger:LearningTrigger,context:string) {this.state.events.push({trigger,context,at:this.now()});this.audit("learning","TRIGGER",context,{trigger});}
  startTest(candidateId:string) {
    const c=this.candidate(candidateId);if(!["CANDIDATE","REJECTED","REPORT"].includes(c.stage))throw new Error("INVALID_CANDIDATE_TRANSITION");
    c.stage="TEST";delete c.approval;delete c.report;
    if(c.skillKey)this.skill(c.skillKey).status="WORTH_TESTING";
    for(const e of this.state.experiments.filter(e=>e.candidateId===candidateId))e.stage="SANDBOX_TEST";
    this.audit("learning","START_SANDBOX_TEST",candidateId,{});
  }
  addEvidence(candidateId:string,evidence:Evidence) {
    const c=this.candidate(candidateId);if(!["TEST","COLLECT_EVIDENCE","REPORT"].includes(c.stage))throw new Error("TEST_REQUIRED");
    if(this.state.evidence.some(e=>e.evidenceId===evidence.evidenceId))throw new Error("DUPLICATE_EVIDENCE");
    if(!evidence.source||!evidence.trialId||evidence.context!==c.context||!Number.isInteger(evidence.sampleCount)||evidence.sampleCount<1)throw new Error("INVALID_CONTEXT_OR_SOURCE");
    for(const rate of [evidence.baselinePassRate,evidence.candidatePassRate])if(!Number.isFinite(rate)||rate<0||rate>1)throw new Error("INVALID_PASS_RATE");
    for(const delta of [evidence.contextLossDelta,evidence.costDelta,evidence.quotaDelta,evidence.throughputDelta,evidence.centralLoadDelta])if(!Number.isFinite(delta))throw new Error("INVALID_IMPACT");
    if(evidence.observedAt>this.now()||evidence.observedAt<this.now()-30*86400000)throw new Error("STALE_EVIDENCE");
    this.state.evidence.push(structuredClone(evidence));c.evidenceIds.push(evidence.evidenceId);c.stage="COLLECT_EVIDENCE";delete c.approval;delete c.report;
    const evidenceSet=this.evidenceFor(c);const conflict=evidenceSet.some(e=>e.verdict==="CONTRADICT");
    c.confidence=conflict?.25:Math.min(.95,evidenceSet.reduce((n,e)=>n+e.sampleCount,0)/100);
    if(c.skillKey){const s=this.skill(c.skillKey);s.evidenceIds=[...c.evidenceIds];s.confidence=c.confidence;}
    if(conflict) {this.trigger("QA_CONFLICT",c.context);this.state.experiments.push({experimentId:`conflict:${candidateId}:${evidence.evidenceId}`,candidateId,context:c.context,stage:"PLANNED",hypothesis:"Resolve contradictory evidence in this task context",baselineRef:"current-active",evidenceIds:[...c.evidenceIds]});}
    this.audit("learning","ADD_EVIDENCE",candidateId,evidence);
  }
  report(candidateId:string,threshold=.8):PromotionReport {
    const c=this.candidate(candidateId);if(!["COLLECT_EVIDENCE","REPORT"].includes(c.stage))throw new Error("TEST_EVIDENCE_REQUIRED");
    const all=this.evidenceFor(c);const trials=new Set(all.map(e=>e.trialId));
    // Count each trial once; duplicating publications of a single trial adds no evidence weight.
    const unique=[...new Map(all.filter(e=>e.kind==='experiment').map(e=>[e.trialId,e])).values()];
    const samples=unique.reduce((n,e)=>n+e.sampleCount,0);const reasons:string[]=[];
    if(samples<30)reasons.push("INSUFFICIENT_SAMPLES");if(trials.size<3)reasons.push("INSUFFICIENT_INDEPENDENT_TRIALS");
    if(unique.length<3)reasons.push("CONTROLLED_EXPERIMENT_REQUIRED");
    if(all.some(e=>e.verdict!=="SUPPORT"))reasons.push("CONFLICTING_OR_INCONCLUSIVE_EVIDENCE");
    if(all.some(e=>e.observedAt<this.now()-30*86400000))reasons.push("STALE_EVIDENCE");
    if(all.some(e=>!e.reproducible))reasons.push("NOT_REPRODUCIBLE");
    if(all.some(e=>!e.regressionPassed))reasons.push("REGRESSION");
    if(all.some(e=>!e.qaPassed||!e.safetyPassed||!e.permissionPassed||!e.stabilityPassed))reasons.push("QA_SAFETY_PERMISSION_STABILITY_GATE");
    if(all.some(e=>e.candidatePassRate<threshold||e.candidatePassRate<e.baselinePassRate))reasons.push("PASS_REGRESSION");
    if(all.some(e=>e.contextLossDelta>0||e.costDelta>0||e.quotaDelta>0||e.throughputDelta<0||e.centralLoadDelta>0))reasons.push("RESOURCE_OR_CONTEXT_REGRESSION");
    if(!all.some(e=>e.candidatePassRate>e.baselinePassRate||e.throughputDelta>0||e.centralLoadDelta<0||e.costDelta<0||e.quotaDelta<0))reasons.push("NO_MEASURED_IMPROVEMENT");
    if(c.skillKey && this.skill(c.skillKey).validUntil<=this.now())reasons.push("STALE_SKILL");
    const fingerprint=JSON.stringify({candidateId,threshold,evidence:all});
    c.report={candidateId,eligible:reasons.length===0,sampleCount:samples,independentTrials:trials.size,reasons,evidenceIds:[...c.evidenceIds],fingerprint,approvalRequired:true,passThreshold:threshold};c.stage="REPORT";
    for(const e of this.state.experiments.filter(e=>e.candidateId===candidateId&&e.stage==="SANDBOX_TEST"))e.stage="REPORTED";
    this.audit("learning","EVIDENCE_REPORT",candidateId,c.report);return structuredClone(c.report);
  }
  approve(candidateId:string,actor:string,fingerprint:string) {
    const c=this.candidate(candidateId);if(!actor.trim()||c.stage!=="REPORT"||!c.report?.eligible||c.report.fingerprint!==fingerprint)throw new Error("APPROVAL_GATE_FAILED");
    c.approval={actor,reportFingerprint:fingerprint,approvedAt:this.now()};this.audit(actor,"APPROVAL",candidateId,{fingerprint});
  }
  promote(candidateId:string,actor:string) {
    const c=this.candidate(candidateId);if(!c.approval||c.approval.actor!==actor)throw new Error("USER_APPROVAL_REQUIRED");
    const approval=structuredClone(c.approval);const report=this.report(candidateId,c.report?.passThreshold??.8);
    if(!report.eligible||report.fingerprint!==approval.reportFingerprint)throw new Error("EVIDENCE_CHANGED");
    const pointer=`${c.kind}:${c.destination}:${c.context}`;c.rollbackPointer=this.state.activePointers[pointer]??null;
    if(c.skillKey){const s=this.skill(c.skillKey);s.rollbackPointer=c.rollbackPointer;s.status="ACTIVE";s.updatedAt=this.now();}
    this.state.activePointers[pointer]=candidateId;c.stage="PROMOTED";this.audit(actor,"PROMOTE",candidateId,{pointer,previous:c.rollbackPointer});
    // This updates the knowledge/policy library pointer, never deploys infrastructure or invokes a worker.
  }
  reject(candidateId:string,reason:string) {const c=this.candidate(candidateId);if(c.stage==="PROMOTED")throw new Error("ROLLBACK_REQUIRED");c.stage="REJECTED";delete c.approval;this.audit("learning","REJECT",candidateId,{reason});}
  revalidate(tool:string,version:string) {
    for(const skill of this.state.skills)if(skill.status==="ACTIVE" && ((skill.modelVersions[tool]!==undefined && skill.modelVersions[tool]!==version)||skill.validUntil<=this.now())) {
      skill.status="REVALIDATION_REQUIRED";skill.confidence=Math.min(skill.confidence,.5);skill.updatedAt=this.now();this.audit("learning","REVALIDATION_REQUIRED",key(skill),{tool,version});
    }
    this.trigger("MODEL_TOOL_CHANGE",tool);
  }
  failRevalidation(skillKey:string,deprecate=false) {const s=this.skill(skillKey);if(s.status!=="REVALIDATION_REQUIRED")throw new Error("REVALIDATION_NOT_REQUIRED");s.status=deprecate?"DEPRECATED":"WORTH_TESTING";this.audit("learning","FAILED_REVALIDATION",skillKey,{deprecate});}
  observeRegression(candidateId:string,reason:string) {
    const c=this.candidate(candidateId);if(c.stage!=="PROMOTED")throw new Error("NOT_ACTIVE_CANDIDATE");
    if(c.skillKey){const skill=this.skill(c.skillKey);skill.status="REVALIDATION_REQUIRED";skill.confidence=Math.min(.5,skill.confidence);}
    this.trigger("PERFORMANCE_DRIFT",c.context);this.audit("learning","REGRESSION_OBSERVED",candidateId,{reason});return this.proposeRollback(candidateId,reason);
  }
  activeSkill(skillKey:string) {const s=this.skill(skillKey);if(s.status!=="ACTIVE"||s.validUntil<=this.now())throw new Error("SKILL_NOT_FRESH_ACTIVE");return structuredClone(s);}
  proposeRollback(candidateId:string,reason:string) {const c=this.candidate(candidateId);return {candidateId,reason,rollbackTo:c.rollbackPointer,approvalRequired:true,executed:false};}
  rollback(candidateId:string,actor:string,approved:boolean) {
    const c=this.candidate(candidateId);const pointer=`${c.kind}:${c.destination}:${c.context}`;
    if(!approved||!actor.trim()||c.stage!=="PROMOTED"||this.state.activePointers[pointer]!==candidateId||!c.rollbackPointer)throw new Error("ROLLBACK_APPROVAL_OR_POINTER_REQUIRED");
    const old=this.candidate(c.rollbackPointer);if(old.skillKey)this.activeSkill(old.skillKey);
    this.state.activePointers[pointer]=old.candidateId;if(c.skillKey)this.skill(c.skillKey).status="DEPRECATED";
    c.stage="ROLLED_BACK";this.audit(actor,"ROLLBACK",candidateId,{to:old.candidateId});
  }
  private candidate(id:string){const c=this.state.candidates.find(c=>c.candidateId===id);if(!c)throw new Error("UNKNOWN_CANDIDATE");return c;}
  private skill(id:string){const s=this.state.skills.find(s=>key(s)===id);if(!s)throw new Error("UNKNOWN_SKILL");return s;}
  private evidenceFor(c:LearningCandidate){return this.state.evidence.filter(e=>c.evidenceIds.includes(e.evidenceId));}
  private audit(actor:string,action:string,target:string,detail:unknown){this.state.audit.push({sequence:this.state.audit.length+1,at:this.now(),actor,action,target,detail:structuredClone(detail)});}
}
