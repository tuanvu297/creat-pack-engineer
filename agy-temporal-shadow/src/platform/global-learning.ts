import { createHash } from 'node:crypto';
import type { Principal } from './auth.js';
export interface GeneralizationEvidence {projectRef:string;context:string;controlled:boolean;pass:boolean;safetyPassed:boolean;sampleCount:number}
export interface GlobalCandidate {candidateId:string;content:{name:string;instruction:string;version:string};evidence:GeneralizationEvidence[];redactionAttestedBy:string;createdBy:string}
export function globalFingerprint(candidate:GlobalCandidate){return createHash('sha256').update(JSON.stringify(candidate)).digest('hex');}
export function validateGeneralization(candidate:GlobalCandidate) {
 if(!candidate.candidateId||!candidate.createdBy||!candidate.redactionAttestedBy||!candidate.content.name||!candidate.content.instruction||!candidate.content.version)throw new Error('INVALID_GLOBAL_CANDIDATE');
 if(Object.keys(candidate.content).some(k=>!['name','instruction','version'].includes(k)))throw new Error('PRIVATE_FIELDS_DENIED');
 if(new Set(candidate.evidence.map(e=>e.projectRef)).size<2||new Set(candidate.evidence.map(e=>e.context)).size<2||candidate.evidence.length<3||candidate.evidence.some(e=>!e.controlled||!e.pass||!e.safetyPassed||!Number.isInteger(e.sampleCount)||e.sampleCount<1)||candidate.evidence.reduce((n,e)=>n+e.sampleCount,0)<30)throw new Error('CROSS_CONTEXT_EVIDENCE_REQUIRED');
 return globalFingerprint(candidate);
}
/** Explicit release only. No project LearningEngine hook publishes to this library. */
export class GlobalSkillLibrary {
 private readonly releases=new Map<string,{content:GlobalCandidate['content'];approvedBy:string;fingerprint:string}>();
 publish(candidate:GlobalCandidate,principal:Principal,fingerprint:string) {
  if(principal.role!=='platform-admin'||principal.subject===candidate.createdBy||principal.subject===candidate.redactionAttestedBy)throw new Error('INDEPENDENT_GLOBAL_APPROVAL_REQUIRED');
  if(validateGeneralization(candidate)!==fingerprint)throw new Error('REPORT_CHANGED');
  this.releases.set(candidate.candidateId,{content:structuredClone(candidate.content),approvedBy:principal.subject,fingerprint});
 }
 consume(skillId:string){const item=this.releases.get(skillId);return item?structuredClone(item):null;}
}
