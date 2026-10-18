import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { authenticate,authorize,identitiesFromEnv,type Principal } from '../src/platform/auth.js';
import { validateScope,scopeKey,type Project } from '../src/platform/scope.js';
import { ProjectPool } from '../src/platform/scoped-pool.js';
import { ProjectService } from '../src/platform/service.js';
import { selectProjectDemand,type ProjectDemand } from '../src/platform/allocation.js';
import { GlobalSkillLibrary,globalFingerprint,type GlobalCandidate } from '../src/platform/global-learning.js';
import { legacyRollbackPreflight } from '../src/platform/rollback.js';
import { discoverResource } from '../src/resources/discovery.js';
import { LearningEngine } from '../src/learning-engine.js';
import type { Pool } from 'pg';
import { WorkerEngine } from '../src/engine.js';
import { PostgresStore } from '../src/postgres-store.js';
import { InMemoryStore } from './in-memory-store.js';
import type { WorkerAdapter,ExecutionResult } from '../src/types.js';
const a={tenantId:'tenant',workspaceId:'workspace',projectId:'alpha'},b={...a,projectId:'beta'};
const principal:Principal={subject:'operator-a',role:'operator',scopes:[a]};
const project=(scope=a,extra:Partial<Project>={}):Project=>({...scope,name:scope.projectId,status:'ACTIVE',sourceOfTruthRef:'repo:'+scope.projectId,policyRef:'policy:'+scope.projectId,defaultSkillPack:'generic',resourcePolicy:{maxConcurrentTasks:2,quotaCap:100,spendCap:10,reservation:1},priority:1,permissions:['read'],policies:{},createdAt:0,updatedAt:0,...extra});
const demand=(p=project(),extra:Partial<ProjectDemand>={}):ProjectDemand=>({project:p,jobId:p.projectId,task:{name:'text',idempotencyKey:'same',taskType:'text',requiredCapabilities:['text'],requiredPermissions:['read'],permissionGranted:true,safetyApproved:true,estimatedQuota:1,estimatedCost:1},active:0,quotaUsed:0,spendUsed:0,passThreshold:.8,...extra});
const resources=()=>[{...discoverResource('shared',['text'],Date.now()),status:'READY' as const,ready:true,passRate:.99,retryRate:0,errorRate:0,contextLossRisk:0,maxConcurrency:2,quotaRemaining:100,quotaReserve:10,quotaCap:100,spendCap:100,permissions:['read']}];
test('identity cannot read or mutate another project, including worker/approval authority',()=>{
 for(const action of ['read','write','execute','qa','approve'] as const)assert.throws(()=>authorize(principal,b,action),/SCOPE_DENIED/);
 authorize(principal,a,'write');assert.throws(()=>authorize(principal,a,'approve'),/ACTION_DENIED/);
 assert.throws(()=>authorize({...principal,role:'worker'},a,'write'),/ACTION_DENIED/);
 assert.throws(()=>new ProjectService({} as Pool,b,principal),/SCOPE_DENIED/);
 assert.throws(()=>validateScope({...a,projectId:'../beta'}),/INVALID/);
});
test('shared token alone is denied; dev token fixed to one scope; token not returned',()=>{
 assert.throws(()=>identitiesFromEnv({AGY_API_TOKEN:'x'}),/shared API token/);
 const identities=identitiesFromEnv({AGY_API_TOKEN:'x',AGY_DEV_SCOPE:JSON.stringify(a)});
 const user=authenticate('Bearer x',identities);assert.equal('token' in user,false);assert.throws(()=>authorize(user,b,'read'));
 assert.throws(()=>authenticate('Bearer wrong',identities),/UNAUTHORIZED/);
});
test('scope is transaction-local and reused pool cannot inherit another project; SQL error rolls back',async()=>{
 const calls:any[]=[];const client={query:async(sql:string,values?:unknown[])=>{calls.push({sql,values});if(sql==='BAD')throw new Error('bad');return {rows:[],rowCount:0};},release:()=>{calls.push({sql:'release'});}};
 const raw={connect:async()=>client} as unknown as Pool;
 await new ProjectPool(raw,a,'a').query('SELECT 1');await new ProjectPool(raw,b,'b').query('SELECT 2');
 const contexts=calls.filter(c=>c.sql.startsWith('SELECT set_config'));assert.deepEqual(contexts.map(c=>c.values.slice(0,3)),[[a.tenantId,a.workspaceId,a.projectId],[b.tenantId,b.workspaceId,b.projectId]]);
 assert.equal(calls.filter(c=>c.sql==='COMMIT').length,2);await assert.rejects(()=>new ProjectPool(raw,a,'a').query('BAD'));
 assert.equal(calls.at(-2).sql,'ROLLBACK');assert.equal(calls.at(-1).sql,'release');
});
test('body scope override rejected before issuing SQL',async()=>{const service=new ProjectService({} as Pool,a,principal);await assert.rejects(()=>service.execute('/jobs','POST',{project_id:'beta'}),/OVERRIDE_DENIED/);});
test('shared allocator selects higher project priority rather than submission order',()=>{
 const selected=selectProjectDemand([demand(project(a)),demand(project(b,{priority:10}))],resources());assert.equal(selected?.scope,scopeKey(b));
});
test('project reservation at equal priority, concurrency and project budgets enforce separate policy',()=>{
 const selected=selectProjectDemand([demand(project(a),{active:1}),demand(project(b),{active:0})],resources());assert.equal(selected?.scope,scopeKey(b));
 assert.equal(selectProjectDemand([demand(project(a),{active:2})],resources()),null);
 assert.equal(selectProjectDemand([demand(project(a),{quotaUsed:100})],resources()),null);
 assert.equal(selectProjectDemand([demand(project(a,{permissions:[]}))],resources()),null);
});
test('unavailable/high-risk/capability demand cannot monopolize shared resources',()=>{
 const high=demand(project(a,{priority:100}));high.task.requiredCapabilities=['video'];
 assert.equal(selectProjectDemand([high,demand(project(b))],resources())?.scope,scopeKey(b));
 const limited=resources();limited[0].quotaRemaining=10;assert.equal(selectProjectDemand([demand()],limited),null);
});
test('connector binding and project-local worker exclusions isolate shared allocation',()=>{
 assert.equal(selectProjectDemand([demand(project(a),{allowedWorkers:[]}),demand(project(b))],resources())?.scope,scopeKey(b));
 assert.equal(selectProjectDemand([demand(project(a),{excluded:['shared']}),demand(project(b))],resources())?.scope,scopeKey(b));
});
test('scoped worker failure uses project health, not global provider status (SQL contract)',async()=>{
 const calls:string[]=[];const pool={query:async(sql:string)=>{calls.push(sql);return{rows:[],rowCount:1};}} as unknown as Pool;
 await new PostgresStore(pool,a).recordWorkerFailure('shared','INVALID_INPUT',1,0);
 assert.equal(calls.length,1);assert.match(calls[0],/agy_project_worker_health/);assert.doesNotMatch(calls[0],/UPDATE agy_workers/);
});
test('two-project WorkerEngine regression simulation: same job key, concurrent success/failure and private state',async()=>{
 // Test-only partitioned memory fixtures, not proof that PostgreSQL RLS works.
 const stores=new Map([[scopeKey(a),new InMemoryStore()],[scopeKey(b),new InMemoryStore()]]);
 const [sa,sb]=[stores.get(scopeKey(a))!,stores.get(scopeKey(b))!];
 authorize(principal,a,'write');authorize({...principal,scopes:[b]},b,'write');
 const input={tenantId:'tenant',idempotencyKey:'same',objective:'simulation',mode:'SINGLE_WORKFLOW' as const,passThreshold:.8,tasks:[{...demand().task,risk:'LOW' as const,deterministic:true,maxRetry:0}]};
 const [ja,jb]=await Promise.all([sa.createJob(input),sb.createJob(input)]);assert.notEqual(ja.jobId,jb.jobId);
 const good:ExecutionResult={state:'SUCCEEDED',output:{private:'b'},qa:{deterministicPassed:true,score:1,confidence:1,evidenceSufficient:true}};
 const bad:ExecutionResult={state:'FAILED',error:{code:'INVALID_INPUT',message:'a failed',retryable:false}};
 const adapter=(result:ExecutionResult):WorkerAdapter=>({name:'simulation',capabilities:['text'],execute:async()=>({externalId:'x'}),check_status:async()=>result,collect_result:async()=>result,cancel:async()=>{},health:async()=>({ready:true})});
 assert.deepEqual(await Promise.all([new WorkerEngine(sa,adapter(bad),'shared').tick(),new WorkerEngine(sb,adapter(good),'shared').tick()]),['BLOCKED','PASS']);
 assert.equal(sa.tasks.has([...sb.tasks.keys()][0]),false);assert.equal(sa.telemetry[0].jobId,ja.jobId);assert.equal(sb.telemetry[0].jobId,jb.jobId);
});
test('project learning remains private and cannot automatically become global skill',()=>{
 const engineA=new LearningEngine(),engineB=new LearningEngine();engineA.trigger('SKILL_GAP','private-a');
 assert.equal(engineB.snapshot().events.length,0);assert.equal(new GlobalSkillLibrary().consume('private-a'),null);
});
const candidate=():GlobalCandidate=>({candidateId:'generic-qa-v1',content:{name:'Generic QA',instruction:'Check outputs against explicit acceptance criteria.',version:'1'},createdBy:'collector',redactionAttestedBy:'redactor',evidence:[{projectRef:'opaque-1',context:'code',controlled:true,pass:true,safetyPassed:true,sampleCount:10},{projectRef:'opaque-2',context:'text',controlled:true,pass:true,safetyPassed:true,sampleCount:10},{projectRef:'opaque-2',context:'text',controlled:true,pass:true,safetyPassed:true,sampleCount:10}]});
test('global release needs cross-context evidence, independent approval and exact report fingerprint',()=>{
 const library=new GlobalSkillLibrary(),c=candidate(),admin:Principal={subject:'approver',role:'platform-admin',scopes:[]};
 assert.throws(()=>library.publish(c,principal,globalFingerprint(c)),/APPROVAL/);
 const single=candidate();single.evidence.forEach(e=>e.projectRef='one');assert.throws(()=>library.publish(single,admin,globalFingerprint(single)),/CROSS_CONTEXT/);
 assert.throws(()=>library.publish(c,admin,'stale'),/REPORT_CHANGED/);
 library.publish(c,admin,globalFingerprint(c));authorize({...principal,scopes:[b]},b,'read');
 const consumed=library.consume(c.candidateId)!;assert.equal(consumed.content.name,'Generic QA');assert.equal('evidence' in consumed,false);assert.equal('projectRef' in consumed,false);
 consumed.content.name='tamper';assert.equal(library.consume(c.candidateId)!.content.name,'Generic QA');
});
test('rollback preflight prevents restoring tenant-only uniqueness over project duplicates',()=>{
 assert.equal(legacyRollbackPreflight([{...a,idempotencyKey:'same'},{...b,idempotencyKey:'same'}]).safe,false);
 assert.equal(legacyRollbackPreflight([{...a,idempotencyKey:'same'}]).safe,true);
});
test('migration contract contains scoped operational tables, GL mapping, quarantine and no destructive DDL',async()=>{
 const sql=await readFile(new URL('../migrations/004_platform_projects.sql',import.meta.url),'utf8');
 for(const name of ['agy_artifacts','agy_task_attempts','agy_qa_results','agy_lessons','agy_experiments','agy_connectors','agy_project_learning_state'])assert.ok(sql.includes(name));
 assert.ok(sql.includes('GL_AUTOMATION'));assert.ok(sql.includes('migration-quarantine'));assert.ok(sql.includes('FORCE ROW LEVEL SECURITY'));assert.ok(sql.includes('security_invoker=true'));
 assert.doesNotMatch(sql,/\b(?:DROP TABLE|TRUNCATE|DELETE FROM)\b/i);
});
test('no business hard-coded dependency in shared core',async()=>{
 const scan=async(dir:URL):Promise<void>=>{for(const item of await readdir(dir,{withFileTypes:true})){const path=new URL(item.name+(item.isDirectory()?'/':''),dir);if(item.isDirectory())await scan(path);else if(item.name.endsWith('.ts'))assert.doesNotMatch(await readFile(path,'utf8'),/\b(?:GL_AUTOMATION|Greenlife|LUME|William)\b|tenantId\s*[:=]\s*['"]gl['"]/i,item.name);}};
 await scan(new URL('../src/',import.meta.url));
});
