import type { Pool } from 'pg';
import type { Principal } from './auth.js';
import { GlobalSkillLibrary,validateGeneralization,type GlobalCandidate } from './global-learning.js';
/** Separate approval DB role: never reuse worker/project runtime privileges for global writes. */
export class GlobalLearningStore {
 constructor(private readonly pool:Pool,private readonly principal:Principal){if(principal.role!=='platform-admin')throw new Error('GLOBAL_APPROVAL_DENIED');}
 async propose(candidate:GlobalCandidate) {
  if(candidate.createdBy!==this.principal.subject)throw new Error('CREATOR_IDENTITY_DENIED');
  const fingerprint=validateGeneralization(candidate);
  await this.pool.query('INSERT INTO agy_global_skill_candidates(candidate_id,content,evidence,report_fingerprint,created_by) VALUES($1,$2,$3,$4,$5)',[candidate.candidateId,candidate,candidate.evidence,fingerprint,this.principal.subject]);
  return {candidateId:candidate.candidateId,fingerprint,approvalRequired:true,productionDeployed:false};
 }
 async promote(candidateId:string,fingerprint:string) {
  const client=await this.pool.connect();try{
   await client.query('BEGIN');const row=(await client.query('SELECT * FROM agy_global_skill_candidates WHERE candidate_id=$1 FOR UPDATE',[candidateId])).rows[0];
   if(!row)throw new Error('CANDIDATE_NOT_FOUND');const candidate=row.content as GlobalCandidate;
   const library=new GlobalSkillLibrary();library.publish(candidate,this.principal,fingerprint);
   if(row.report_fingerprint!==fingerprint)throw new Error('REPORT_CHANGED');
   const existing=(await client.query('SELECT report_fingerprint FROM agy_global_skills WHERE skill_id=$1',[candidateId])).rows[0];
   if(existing&&existing.report_fingerprint!==fingerprint)throw new Error('IMMUTABLE_GLOBAL_RELEASE');
   if(!existing){await client.query('INSERT INTO agy_global_skills(skill_id,content,report_fingerprint,approved_by) VALUES($1,$2,$3,$4)',[candidateId,library.consume(candidateId)!.content,fingerprint,this.principal.subject]);
    await client.query('INSERT INTO agy_global_learning_audit(actor,action,candidate_id,fingerprint) VALUES($1,$2,$3,$4)',[this.principal.subject,'PROMOTE',candidateId,fingerprint]);}
   await client.query('COMMIT');return {released:true,duplicate:!!existing,productionDeployed:false};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
}
