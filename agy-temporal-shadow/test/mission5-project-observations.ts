// Explicit retained DISPOSABLE fixture only. This script submits no provider request.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {ProjectPool} from '../src/platform/scoped-pool.js';
import {LearningStore} from '../src/learning-store.js';
const session=JSON.parse(await readFile(process.argv[2],'utf8'));
const address=new URL(session.runtimeUrl);
if(address.hostname!=='127.0.0.1'||address.port!=='55474'||!/^s4_candidate_[a-z0-9]+$/.test(session.db)||address.pathname!=='/'+session.db)throw Error('DISPOSABLE_SCOPE_REQUIRED');
const raw=new Pool({connectionString:session.runtimeUrl,max:1});
try{
 const roles=(await raw.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(roles.rolsuper||roles.rolbypassrls)throw Error('NON_BYPASS_RUNTIME_REQUIRED');
 const a=new ProjectPool(raw,session.a,'mission5-observation'),b=new ProjectPool(raw,session.b,'mission5-observation');
 const store=new LearningStore(a.asPool(),true),other=new LearningStore(b.asPool(),true);
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 const before=await store.read(),otherBefore=hash(await other.read());
 const observations=[
  {trigger:'SKILL_GAP' as const,context:'MISSION5: dedicated non-production provider credential absent; connector acceptance BLOCKED; account login is not staging identity; LIVE-PREFLIGHT evidence'},
  {trigger:'NEW_EVIDENCE' as const,context:'MISSION5: controlled PostgreSQL crash B blocks uncertain replay; long Retry-After releases capacity; local accounting preserves unknown cost; provider-native acceptance still unverified; CONTROLLED-PG evidence'},
 ];
 await store.transact(engine=>{for(const item of observations)if(!before.events.some(e=>e.context===item.context))engine.trigger(item.trigger,item.context);});
 const after=await store.read(),otherAfter=hash(await other.read());
 if(otherBefore!==otherAfter||hash(before.activePointers)!==hash(after.activePointers))throw Error('LEARNING_SCOPE_OR_PROMOTION_CHANGED');
 const evidence={layer:'REAL_POSTGRESQL_PRIVATE_PROJECT_OBSERVATION',database:session.db,project:session.a.projectId,
  beforeEvents:before.events.length,afterEvents:after.events.length,observations:observations.map(x=>x.context),
  otherProjectHashUnchanged:true,activePointersUnchanged:true,globalPromotions:0,providerRequestsSent:0};
 await writeFile('../agy-mission5-evidence/MISSION5-PROJECT-LEARNING.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await raw.end();}
