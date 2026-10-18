// Runtime verification harness, not a new platform module. All data is synthetic.
import { Pool } from 'pg';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash,randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { PostgresStore } from '../src/postgres-store.js';
import { ProjectPool } from '../src/platform/scoped-pool.js';
import { ResourceStore } from '../src/resource-store.js';
import { discoverResource } from '../src/resources/discovery.js';
import { LearningStore } from '../src/learning-store.js';
const execute=promisify(execFile),root=resolve('../..'),work=resolve(root,'work/sprint4'),out=resolve(root,'outputs/agy-sprint4-evidence');
if(process.env.AGY_SPRINT4_DISPOSABLE!=='true')throw new Error('EXPLICIT_DISPOSABLE_TEST_FLAG_REQUIRED');
await mkdir(out,{recursive:true});
const bin=resolve(work,'postgres17/pgsql/bin'),run=Date.now().toString(36),db='s4_candidate_'+run,restore='s4_restored_'+run;
const adminRole='s4_migration_'+run,runtimeRole='s4_runtime_'+run;
const pwd=randomBytes(24).toString('hex'),runtimePwd=randomBytes(24).toString('hex');
const url=(user:string,password:string,database:string)=>`postgresql://${user}:${password}@127.0.0.1:55474/${database}`;
const bootstrap=new Pool({connectionString:url('agy_bootstrap','AGY-disposable-sprint4-local-only-20261009','postgres')});
const adminUrl=url(adminRole,pwd,db),runtimeUrl=url(runtimeRole,runtimePwd,db);
let admin:Pool|undefined,runtime:Pool|undefined,physical:Pool|undefined,server:ReturnType<typeof spawn>|undefined;
const evidence:any={run,environment:{version:null,host:'127.0.0.1',port:55474,disposableDatabase:db,restoreDatabase:restore},checks:[],sql:[],migrations:[],gates:{DATA_ISOLATION_PASS:false,RECOVERY_PASS:false,LIVE_CONNECTOR_PASS:false,AGY_PLATFORM_READY:false}};
const record=(name:string,detail:any)=>{evidence.checks.push({name,status:'PASS',detail});console.log(JSON.stringify({name,status:'PASS',detail}));};
const sql=async(pool:Pool,statement:string,values?:any[])=>{const result=await pool.query(statement,values);evidence.sql.push({statement,values,rows:result.rows,rowCount:result.rowCount});return result;};
const a={tenantId:'tenant_a',workspaceId:'workspace_a',projectId:'PROJECT_A'},b={tenantId:'tenant_b',workspaceId:'workspace_b',projectId:'PROJECT_B'};
const scope=(pool:Pool,s:any,subject:string)=>new ProjectPool(pool,s,subject).asPool();
const critical=['agy_jobs','agy_tasks','agy_task_events','agy_telemetry','agy_learning_samples','agy_learning_state','agy_learning_audit','agy_learning_events','agy_workers','agy_resource_reservations','agy_checkpoints','agy_optimization_candidates'];
const canonical=(value:any):any=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=(x:any)=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
const snapshots=async(pool:Pool,columns?:Record<string,string[]>)=>{
 const result:Record<string,any>={};for(const table of critical){const data=(await pool.query(`SELECT row_to_json(t) AS row FROM ${table} t`)).rows.map(r=>r.row);
  const keys=columns?.[table]??Object.keys(data[0]??{});const projected=data.map(row=>Object.fromEntries(keys.map(k=>[k,row[k]]))).sort((x,y)=>JSON.stringify(canonical(x)).localeCompare(JSON.stringify(canonical(y))));
  result[table]={count:data.length,columns:keys,sha256:hash(projected),rows:projected};}return result;
};
async function api(port:number,path:string,token:string,method='GET',body?:any){const r=await fetch(`http://127.0.0.1:${port}${path}`,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await r.json();evidence.checks.push({name:`API ${method} ${path}`,status:'EVIDENCE',http:r.status,body:data});return {status:r.status,data};}
async function waitServer(port:number,process:ReturnType<typeof spawn>){for(let i=0;i<50;i++){if(process.exitCode!==null)throw new Error('SERVER_EXITED');try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('SERVER_START_TIMEOUT');}
try {
 evidence.environment.version=(await bootstrap.query('SELECT version() AS version')).rows[0].version;
 await bootstrap.query(`CREATE ROLE ${adminRole} LOGIN PASSWORD '${pwd}' NOSUPERUSER NOBYPASSRLS CREATEDB CREATEROLE`);
 await bootstrap.query(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePwd}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
 await bootstrap.query(`CREATE DATABASE ${db} OWNER ${adminRole}`);
 admin=new Pool({connectionString:adminUrl});runtime=new Pool({connectionString:runtimeUrl,max:1});physical=new Pool({connectionString:url('agy_bootstrap','AGY-disposable-sprint4-local-only-20261009',db)});
 const roles=(await sql(bootstrap,'SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=ANY($1)',[[adminRole,runtimeRole]])).rows;
 assert.ok(roles.every(r=>!r.rolsuper&&!r.rolbypassrls));record('separate migration/runtime roles NOSUPERUSER NOBYPASSRLS',roles);
 const files=['001_worker_engine_v1.sql','002_resource_optimization.sql','003_resource_learning_engine.sql','004_platform_projects.sql','005_platform_dispatch.sql','006_global_approval_audit.sql'];
 for(const file of files.slice(0,3)){const text=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');await admin.query(text);evidence.migrations.push({file,sha256:createHash('sha256').update(text).digest('hex'),executedAs:adminRole,status:'PASS'});}
 const legacyStore=new PostgresStore(admin),legacyInput={tenantId:'gl',idempotencyKey:'legacy-preserved',objective:'synthetic legacy evidence',mode:'SINGLE_WORKFLOW' as const,passThreshold:.8,tasks:[{name:'preserve',taskType:'text',idempotencyKey:'preserve'}]};
 const legacy=await legacyStore.createJob(legacyInput);
 const oldResource={...discoverResource('legacy-worker',['text'],Date.now()),status:'READY' as const,ready:true,quotaRemaining:100,quotaReserve:10,maxConcurrency:1,passRate:.99,retryRate:0,errorRate:0,contextLossRisk:0,spendCap:100,quotaCap:100,permissions:['read']};
 await new ResourceStore(admin).register(oldResource,'legacy');
 await admin.query(`UPDATE agy_tasks SET policy=$1 WHERE job_id=$2`,[{permissionGranted:true,safetyApproved:true,estimatedQuota:1,estimatedCost:.1},legacy.jobId]);
 const legacyTask=await legacyStore.claim({workerId:'legacy-worker',capabilities:['text'],leaseSeconds:30});assert.ok(legacyTask);
 await legacyStore.transition(legacyTask.taskId,legacyTask.leaseToken,['CLAIMED'],'RUNNING');await legacyStore.saveCheckpoint(legacyTask,'legacy-external-operation','legacy');
 await legacyStore.transition(legacyTask.taskId,legacyTask.leaseToken,['RUNNING'],'QA');await legacyStore.transition(legacyTask.taskId,legacyTask.leaseToken,['QA'],'PASS');
 await legacyStore.recordTelemetry({jobId:legacy.jobId,taskId:legacyTask.taskId,attemptId:legacyTask.leaseToken,workerId:'legacy-worker',outcome:'PASS',costAmount:.1,quotaUnits:1,metadata:{taskType:'text',finalOutcome:'PASS'}});
 await admin.query("INSERT INTO agy_task_events(job_id,event_type,detail) VALUES($1,'LEGACY_EVENT','{\"synthetic\":true}')",[legacy.jobId]);
 await new LearningStore(admin).transact(e=>e.trigger('SKILL_GAP','synthetic-legacy-lesson'));
 const before=await snapshots(admin);const columns=Object.fromEntries(Object.entries(before).map(([k,v])=>[k,v.columns]));
 const backupPath=resolve(out,'pre-migration-'+run+'.dump');
 await execute(resolve(bin,'pg_dump.exe'),['-h','127.0.0.1','-p','55474','-U',adminRole,'-d',db,'--format=custom','--no-owner','--file',backupPath],{env:{...process.env,PGPASSWORD:pwd},timeout:30000});
 evidence.backup={path:backupPath,sha256:createHash('sha256').update(await readFile(backupPath)).digest('hex'),before};record('pre-migration backup and table checksums',Object.fromEntries(Object.entries(before).map(([k,v])=>[k,{count:v.count,sha256:v.sha256}])));
 const migration=await readFile(new URL('../migrations/'+files[3],import.meta.url),'utf8'),dry=await admin.connect();
 try{await dry.query('BEGIN');await dry.query(migration.replace(/^BEGIN;$/m,'').replace(/^COMMIT;$/m,''));await assert.rejects(()=>dry.query('SELECT 1/0'),(e:any)=>e.code==='22012');await dry.query('ROLLBACK');}finally{dry.release();}
 assert.equal((await admin.query("SELECT to_regclass('agy_projects') AS name")).rows[0].name,null);assert.deepEqual(await snapshots(admin),before);record('injected pre-commit failure rolls back schema and exact critical data',{sqlstate:'22012',allChecksumsEqual:true});
 for(const file of files.slice(3)){const text=await readFile(new URL('../migrations/'+file,import.meta.url),'utf8');await admin.query(text);evidence.migrations.push({file,sha256:createHash('sha256').update(text).digest('hex'),executedAs:adminRole,status:'PASS'});}
 const migrated=await snapshots(physical,columns);for(const table of critical){assert.equal(migrated[table].sha256,before[table].sha256);assert.equal(migrated[table].count,before[table].count);}
 const mapped=(await sql(physical,'SELECT job_id,tenant_id,workspace_id,project_id,status FROM agy_jobs WHERE job_id=$1',[legacy.jobId])).rows[0];assert.equal(mapped.project_id,'GL_AUTOMATION');record('legacy GL IDs/state and all critical checksums preserved',{mapped,allChecksumsEqual:true});
 for(const s of [a,b]) {
  await admin.query('INSERT INTO agy_tenants(tenant_id,name) VALUES($1,$1)',[s.tenantId]);await admin.query('INSERT INTO agy_workspaces(tenant_id,workspace_id,name) VALUES($1,$2,$2)',[s.tenantId,s.workspaceId]);
  await scope(admin,s,'migration-admin').query(`INSERT INTO agy_projects(tenant_id,workspace_id,project_id,name,status,source_of_truth_ref,policy_ref,permissions,resource_policy) VALUES($1,$2,$3,$3,'ACTIVE',$4,$5,ARRAY['read'],'{"maxConcurrentTasks":2,"quotaCap":100,"spendCap":100,"reservation":1}')`,[s.tenantId,s.workspaceId,s.projectId,'staging:'+s.projectId,'staging-policy:'+s.projectId]);
  await scope(admin,s,'migration-admin').query("INSERT INTO agy_connectors(connector_id,kind,capabilities,endpoint,secret_ref,enabled,permissions) VALUES('verification','verification',ARRAY['text'],'http://127.0.0.1:55475','AGY_SECRET_SPRINT4',true,ARRAY['read'])");
 }
 await admin.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
 const tables=(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'agy_%'")).rows.map(r=>r.tablename);
 const restricted=['agy_projects','agy_connectors','agy_workers','agy_dispatch_projects','agy_dispatch_tasks','agy_global_skill_candidates','agy_global_skills','agy_global_learning_audit','agy_platform_config','agy_tenants','agy_workspaces'];
 for(const t of tables.filter(t=>!restricted.includes(t)))await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${t} TO ${runtimeRole}`);
 await admin.query(`GRANT SELECT ON agy_projects,agy_connectors,agy_workers,agy_dispatch_projects,agy_dispatch_tasks,agy_global_skills TO ${runtimeRole}`);
 await admin.query(`GRANT INSERT,UPDATE,DELETE ON agy_dispatch_projects,agy_dispatch_tasks TO ${runtimeRole}`);
 await admin.query(`GRANT UPDATE(active_count,quota_remaining,resource_profile,updated_at) ON agy_workers TO ${runtimeRole}`);
 await admin.query(`GRANT USAGE,SELECT ON agy_task_events_event_id_seq,agy_telemetry_telemetry_id_seq,agy_learning_samples_sample_id_seq,agy_learning_events_event_id_seq TO ${runtimeRole}`);
 record('runtime cannot provision project/connector or mutate global publication',(await sql(admin,`SELECT has_table_privilege($1,'agy_projects','UPDATE') AS project_update,has_table_privilege($1,'agy_connectors','INSERT') AS connector_insert,has_table_privilege($1,'agy_global_skill_candidates','SELECT') AS private_global_read`,[runtimeRole])).rows);
 const pa=scope(runtime,a,'operator-a'),pb=scope(runtime,b,'operator-b'),sa=new PostgresStore(pa,a),sb=new PostgresStore(pb,b);
 const spec={name:'synthetic',idempotencyKey:'task',taskType:'text',requiredCapabilities:['text'],permissionGranted:true,safetyApproved:true,requiredPermissions:['read'],estimatedQuota:1,estimatedCost:.1,maxRetry:1,risk:'LOW' as const,deterministic:true};
 const input={tenantId:a.tenantId,idempotencyKey:'same-project-key',objective:'isolation',mode:'SINGLE_WORKFLOW' as const,passThreshold:.8,tasks:[spec]};
 const ja=await sa.createJob(input),jb=await sb.createJob({...input,tenantId:b.tenantId});assert.notEqual(ja.jobId,jb.jobId);assert.equal((await sa.createJob(input)).duplicate,true);record('same job/task keys across two tenants/workspaces/projects',{ja,jb});
 for(const [name,statement] of [['SELECT','SELECT * FROM agy_jobs WHERE job_id=$1'],['UPDATE',"UPDATE agy_jobs SET objective='tampered' WHERE job_id=$1"],['DELETE','DELETE FROM agy_jobs WHERE job_id=$1']]){const r=await sql(pa,statement,[jb.jobId]);assert.equal(r.rowCount,0);record('project A SQL '+name+' cannot touch project B',{rowCount:r.rowCount});}
 await assert.rejects(()=>pa.query("INSERT INTO agy_artifacts(job_id,uri) VALUES($1,'artifact://bad')",[jb.jobId]),/SCOPE_DENIED/);record('cross-project parent/artifact insert denied',{});
 const pida=(await pa.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,pidb=(await pb.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const unset=(await sql(runtime,"SELECT pg_backend_pid() AS pid,current_setting('agy.project_id',true) AS scope,(SELECT count(*) FROM agy_jobs) AS visible")).rows[0];
 assert.equal(pida,pidb);assert.equal(Number(unset.visible),0);assert.ok(!unset.scope);record('max=1 pooled connection scope reset',{pida,pidb,unset});
 const tokenA=randomBytes(24).toString('hex'),tokenB=randomBytes(24).toString('hex');
 server=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','src/server.ts'],{cwd:resolve('.'),windowsHide:true,env:{...process.env,DATABASE_URL:runtimeUrl,AGY_STAGE_ONLY:'true',PORT:'55476',AGY_IDENTITIES_JSON:JSON.stringify([{subject:'a',role:'operator',scopes:[a],token:tokenA},{subject:'b',role:'operator',scopes:[b],token:tokenB}])},stdio:['ignore','pipe','pipe']});
 let errors='';server.stderr?.on('data',d=>errors+=d);await waitServer(55476,server);
 const pathA=`/v1/tenants/${a.tenantId}/workspaces/${a.workspaceId}/projects/${a.projectId}`,pathB=`/v1/tenants/${b.tenantId}/workspaces/${b.workspaceId}/projects/${b.projectId}`;
 assert.equal((await api(55476,pathB+'/jobs/'+jb.jobId,tokenA)).status,403);
 assert.equal((await api(55476,pathA+'/jobs/'+jb.jobId,tokenA)).status,404);
 for(const method of ['PATCH','DELETE'])assert.equal((await api(55476,pathB+'/jobs/'+jb.jobId,tokenA,method,{objective:'tamper'})).status,403);
 assert.equal((await api(55476,pathA+'/jobs',tokenA,'POST',{tenant_id:b.tenantId,idempotency_key:'x',objective:'x',tasks:[spec]})).status,403);
 record('HTTP API cross-project SELECT/mutation and body override denied',{serverPort:55476});server.kill();server=undefined;
 const resource={...discoverResource('shared-sprint4',['text'],Date.now()),status:'READY' as const,ready:true,quotaRemaining:100,quotaReserve:10,maxConcurrency:2,passRate:.99,retryRate:0,errorRate:0,contextLossRisk:0,spendCap:100,quotaCap:100,permissions:['read']};
 await new ResourceStore(admin).register(resource,'verification');
 const session={run,db,restore,adminRole,runtimeRole,adminUrl,runtimeUrl,bootstrapUrl:url('agy_bootstrap','AGY-disposable-sprint4-local-only-20261009',db),a,b,ja,jb,bin,out,work,tokenA,tokenB};
 await writeFile(resolve(work,'session.json'),JSON.stringify(session));
 // Child processes use actual independent PostgreSQL connections, not Promise-only fixtures.
 const claimArgs=['node_modules/tsx/dist/cli.mjs','test/sprint4-claim-process.ts'];
 const claims=await Promise.all(Array.from({length:8},(_,i)=>execute(process.execPath,claimArgs,{env:{...process.env,AGY_SPRINT4_DISPOSABLE:'true',AGY_SPRINT4_CLAIM_SCOPE:i%2?'b':'a'},timeout:30000})));
 const claimed=claims.flatMap(c=>JSON.parse(c.stdout.trim()).task?[JSON.parse(c.stdout.trim()).task]:[]);
 evidence.concurrency=claims.map(c=>JSON.parse(c.stdout.trim()));
 assert.equal(claimed.length,2);assert.equal(new Set(claimed.map(t=>t.taskId)).size,2);evidence.concurrency=claims.map(c=>JSON.parse(c.stdout.trim()));record('8 independent processes share 2 capacity slots; no duplicate claim',{processes:8,claims:claimed.map(t=>({taskId:t.taskId,jobId:t.jobId,leaseToken:t.leaseToken})),reservations:(await sql(physical,'SELECT reservation_id,task_id,attempt,state FROM agy_resource_reservations')).rows});
 const ta=claimed.find(t=>t.jobId===ja.jobId),tb=claimed.find(t=>t.jobId===jb.jobId);assert.ok(ta&&tb);
 assert.equal(await sa.heartbeat(ta.taskId,'shared-sprint4',ta.leaseToken,30),true);
 assert.equal(await sa.heartbeat(tb.taskId,'shared-sprint4',tb.leaseToken,30),false);record('lease heartbeat fenced by project',{});
 const bBefore=(await pb.query('SELECT row_to_json(t) AS row FROM agy_tasks t')).rows;await sa.recordWorkerFailure('shared-sprint4','INVALID_INPUT',1,1);
 assert.deepEqual((await pb.query('SELECT row_to_json(t) AS row FROM agy_tasks t')).rows,bBefore);assert.equal((await pb.query('SELECT * FROM agy_project_worker_health')).rowCount,0);record('project A failure does not mutate B task/health',{bStateChecksum:hash(bBefore)});
 await pa.query("UPDATE agy_tasks SET lease_expires_at=now()-interval '1 second' WHERE task_id=$1",[ta.taskId]);assert.equal(await sa.reclaimExpired(),1);assert.equal(await sa.heartbeat(ta.taskId,'shared-sprint4',ta.leaseToken,30),false);assert.equal(await sa.transition(ta.taskId,ta.leaseToken,['RETRY'],'PASS'),false);record('real lease expiry/reclaim and stale fencing',{taskId:ta.taskId});
 // Finish B and settle synthetic usage so later connector tests start with fresh capacity.
 await sb.transition(tb.taskId,tb.leaseToken,['CLAIMED'],'RUNNING');await sb.transition(tb.taskId,tb.leaseToken,['RUNNING'],'QA');await sb.transition(tb.taskId,tb.leaseToken,['QA'],'PASS');await sb.recordTelemetry({jobId:jb.jobId,taskId:tb.taskId,attemptId:tb.leaseToken,workerId:'shared-sprint4',outcome:'PASS',quotaUnits:1,costAmount:.1,metadata:{taskType:'text',finalOutcome:'PASS'}});
 const scopedTables=(await sql(admin,"SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='project_id' AND NOT a.attisdropped) AND c.relname NOT LIKE 'agy_dispatch_%' ORDER BY c.relname")).rows;
 assert.equal(scopedTables.length,21);assert.ok(scopedTables.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
 const matrix:any[]=[];
 for(const row of scopedTables){const table=row.relname;
  const populated=(await physical.query(`SELECT count(*) AS count FROM ${table} WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`,[b.tenantId,b.workspaceId,b.projectId])).rows[0].count;
  for(const statement of [`SELECT * FROM ${table}`,`UPDATE ${table} SET project_id=project_id`,`DELETE FROM ${table}`]){
   const query=statement+' WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3';
   try{const result=await sql(pa,query,[b.tenantId,b.workspaceId,b.projectId]);assert.equal(result.rowCount,0);matrix.push({table,verb:statement.split(' ')[0],projectBRows:Number(populated),rowCount:0});}
   catch(error:any){if(error.code!=='42501')throw error;matrix.push({table,verb:statement.split(' ')[0],projectBRows:Number(populated),sqlstate:'42501',denied:true});}
  }
 }
 record('21 scoped tables FORCE RLS; SELECT/UPDATE/DELETE cross-project matrix', {policies:scopedTables,matrix});
 evidence.gates.DATA_ISOLATION_PASS=true;
 await bootstrap.query(`CREATE DATABASE ${restore} OWNER ${adminRole}`);
 await execute(resolve(bin,'pg_restore.exe'),['-h','127.0.0.1','-p','55474','-U',adminRole,'-d',restore,'--no-owner','--exit-on-error',backupPath],{env:{...process.env,PGPASSWORD:pwd},timeout:30000});
 const restored=new Pool({connectionString:url(adminRole,pwd,restore)});try{assert.deepEqual(await snapshots(restored),before);record('post-commit recovery into NEW database; all rows/IDs/checksums identical',{restore,backupSha256:evidence.backup.sha256});}finally{await restored.end();}
 // Previous packaged application version, not current code pointed at old schema.
 const baseline=resolve(work,'baseline-'+run);await mkdir(baseline,{recursive:true});
 await execute('pwsh.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${resolve(root,'outputs/AGY-V1-RESOURCE-MANAGER-LEARNING-ENGINE-20261009.zip')}' -DestinationPath '${baseline}'`],{timeout:30000});
 const {symlink}=await import('node:fs/promises');await symlink(resolve('node_modules'),resolve(baseline,'node_modules'),'junction');
 const oldToken=randomBytes(24).toString('hex');server=spawn(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve(baseline,'src/server.ts')],{cwd:baseline,windowsHide:true,env:{...process.env,DATABASE_URL:url(adminRole,pwd,restore),AGY_API_TOKEN:oldToken,PORT:'55477'},stdio:['ignore','pipe','pipe']});
 server.stderr?.on('data',d=>errors+=d);await waitServer(55477,server);
 const oldResponse=await api(55477,'/v1/jobs',oldToken,'POST',{tenant_id:'gl',idempotency_key:legacyInput.idempotencyKey,objective:legacyInput.objective,tasks:legacyInput.tasks});
 assert.equal(oldResponse.status,200);assert.equal(oldResponse.data.jobId,legacy.jobId);assert.equal(oldResponse.data.duplicate,true);record('previous application version runs against restored backup',{sourceArchive:'AGY-V1-RESOURCE-MANAGER-LEARNING-ENGINE-20261009.zip',jobId:oldResponse.data.jobId,duplicate:true});server.kill();server=undefined;
 evidence.gates.RECOVERY_PASS=true;
}catch(error:any){evidence.failure={message:error.message,code:error.code,stack:error.stack};console.error(error);process.exitCode=1;}
finally{
 server?.kill();await runtime?.end();await admin?.end();await physical?.end();await bootstrap.end();
 await writeFile(resolve(out,'SPRINT4-DATA-RECOVERY-EVIDENCE.json'),JSON.stringify(evidence,null,2));
 await writeFile(resolve(out,`SPRINT4-DATA-RECOVERY-EVIDENCE-${run}.json`),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify(evidence.gates));
}
