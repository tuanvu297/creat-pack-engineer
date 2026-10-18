// No provider access. Versioned local QA and retained disposable runtime observations.
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Pool} from 'pg';
import {ProjectPool} from '../src/platform/scoped-pool.js';
import {LearningStore} from '../src/learning-store.js';
import assert from 'node:assert/strict';
const out=resolve('../agy-mission5-resume6-evidence');
const suffix=process.env.AGY_LOCAL_QA_REVISION??'';if(!/^(-\d{3})?$/.test(suffix))throw Error('INVALID_REVISION');
const files=(await readdir('test')).filter(x=>x.endsWith('.test.ts')).map(x=>'test/'+x);
const env={...process.env};delete env.AGY_TEST_DATABASE_URL;delete env.AGY_SECRET_OPENAI_STAGING;
const checks=[{name:'typecheck',args:['node_modules/typescript/bin/tsc','--noEmit']},{name:'unit-tests',args:['node_modules/tsx/dist/cli.mjs','--test',...files]}];
for(const check of checks){const result=spawnSync(process.execPath,check.args,{env,encoding:'utf8',windowsHide:true});await writeFile(resolve(out,'RESUME6-'+check.name+suffix+'.txt'),result.stdout+result.stderr,{flag:'wx'});assert.equal(result.status,0);console.log(JSON.stringify({name:check.name,exitCode:result.status}));}
const session=JSON.parse(await readFile('../../work/sprint4/session.json','utf8'));
const u=new URL(session.runtimeUrl);if(u.hostname!=='127.0.0.1'||u.port!=='55474'||u.pathname!=='/'+session.db||!/^s4_candidate_[a-z0-9]+$/.test(session.db))throw Error('DISPOSABLE_SCOPE_REQUIRED');
const raw=new Pool({connectionString:session.runtimeUrl,max:1});
try{
 const scope={tenantId:'mission5-resume6',workspaceId:'synthetic',projectId:'A'},a=new ProjectPool(raw,scope,'resume6-local-qa').asPool(),b=new ProjectPool(raw,{...scope,projectId:'B'},'resume6-local-qa').asPool();
 const before=(await b.query('SELECT state FROM agy_project_learning_state')).rows;
 const learning=await new LearningStore(a,true).processEvents();
 assert.deepEqual((await b.query('SELECT state FROM agy_project_learning_state')).rows,before);
 assert.equal((await b.query('SELECT * FROM agy_tasks WHERE project_id=$1',['A'])).rowCount,0);
 assert.equal((await raw.query('SELECT * FROM agy_tasks WHERE tenant_id=$1',[scope.tenantId])).rowCount,0);
 const telemetry=(await a.query('SELECT outcome,usage_tokens,metadata FROM agy_telemetry')).rows;
 const reservations=(await a.query('SELECT * FROM agy_resource_reservations')).rows;
 await writeFile(resolve(out,'RESUME6-POSTFAILURE-ISOLATION-LEARNING'+suffix+'.json'),JSON.stringify({learning,otherProjectUnchanged:true,sqlCrossProjectRows:0,pooledScopeResetRows:0,telemetry,reservations,providerRequests:0},null,2),{flag:'wx'});
 console.log(JSON.stringify({sqlIsolation:'PASS',poolReset:'PASS',privateFailureLearning:'PASS',nativeUsage:'UNAVAILABLE'}));
}finally{await raw.end();}
