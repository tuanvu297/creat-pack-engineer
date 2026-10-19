import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {provisionStaging} from '../src/hosted/provision.js';

test('provisioning refuses implicit, incomplete and non-staging configuration before connecting',async()=>{
 await assert.rejects(provisionStaging({}),/EXPLICIT_STAGING_PROVISION_REQUIRED/);
 const explicit={AGY_STAGE_ONLY:'true',AGY_HOSTED_STAGING:'true',AGY_PROVISION_STAGING:'true'};
 await assert.rejects(provisionStaging(explicit),/AGY_BOOTSTRAP_DATABASE_URL_REQUIRED/);
 await assert.rejects(provisionStaging({...explicit,AGY_BOOTSTRAP_DATABASE_URL:'unused'}),/AGY_DB_RUNTIME_PASSWORD_REQUIRED/);
 await assert.rejects(provisionStaging({...explicit,AGY_BOOTSTRAP_DATABASE_URL:'unused',AGY_DB_RUNTIME_PASSWORD:'x'.repeat(32),AGY_HOSTED_SCHEMA:'public'}),/STAGING_SCHEMA_REQUIRED/);
});

test('real PostgreSQL provisioning is idempotent, scoped and rejects changed migration history',{skip:!process.env.AGY_PROVISION_TEST_DATABASE_URL},async()=>{
 const suffix=randomBytes(8).toString('hex'),schema='agy_hosted_staging_'+suffix,role='agy_staging_runtime_'+suffix;
 const admin=new Pool({connectionString:process.env.AGY_PROVISION_TEST_DATABASE_URL});
 const env={AGY_STAGE_ONLY:'true',AGY_HOSTED_STAGING:'true',AGY_PROVISION_STAGING:'true',
  AGY_BOOTSTRAP_DATABASE_URL:process.env.AGY_PROVISION_TEST_DATABASE_URL,AGY_DB_RUNTIME_PASSWORD:randomBytes(32).toString('hex'),AGY_HOSTED_SCHEMA:schema,AGY_HOSTED_RUNTIME_ROLE:role};
 try{
  const first=await provisionStaging(env);assert.equal(first.migrations,10);assert.equal(first.production,false);
  await admin.query(`SET search_path TO ${schema},public`);
  await admin.query("SELECT set_config('agy.tenant_id','gl',false),set_config('agy.workspace_id','legacy-workspace',false),set_config('agy.project_id','GL_AUTOMATION',false)");
  assert.equal((await admin.query('SELECT count(*)::int n FROM agy_hosted_migrations')).rows[0].n,11);
  await admin.query("UPDATE agy_projects SET status='PAUSED' WHERE project_id='GL_AUTOMATION'");
  await provisionStaging(env);
  assert.equal((await admin.query("SELECT status FROM agy_projects WHERE project_id='GL_AUTOMATION'")).rows[0].status,'PAUSED');
  const flags=(await admin.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  assert.ok(Object.values(flags).every(v=>v===false));
  const permissions=(await admin.query("SELECT has_table_privilege($1,$2,'UPDATE') ledger,has_table_privilege($1,$3,'DELETE') history,has_table_privilege($1,$4,'UPDATE') runtime",[role,schema+'.agy_hosted_migrations',schema+'.agy_jobs',schema+'.agy_temporal_missions'])).rows[0];
  assert.deepEqual(permissions,{ledger:false,history:false,runtime:true});
  await admin.query("UPDATE agy_hosted_migrations SET sha256='conflict' WHERE name='001_worker_engine_v1.sql'");
  await assert.rejects(provisionStaging(env),/MIGRATION_HASH_CONFLICT/);
  assert.equal((await admin.query("SELECT sha256 FROM agy_hosted_migrations WHERE name='001_worker_engine_v1.sql'")).rows[0].sha256,'conflict');
 }finally{
  // These validated random identifiers belong only to this fresh local test.
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.query(`DROP ROLE IF EXISTS ${role}`);await admin.end();
 }
});

test('real PostgreSQL untracked schema blocks without changing its data',{skip:!process.env.AGY_PROVISION_TEST_DATABASE_URL},async()=>{
 const schema='agy_hosted_staging_'+randomBytes(8).toString('hex');
 const admin=new Pool({connectionString:process.env.AGY_PROVISION_TEST_DATABASE_URL});
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);await admin.query(`CREATE TABLE ${schema}.untouched(value text)`);
  await admin.query(`INSERT INTO ${schema}.untouched VALUES('preserve')`);
  await assert.rejects(provisionStaging({AGY_STAGE_ONLY:'true',AGY_HOSTED_STAGING:'true',AGY_PROVISION_STAGING:'true',AGY_BOOTSTRAP_DATABASE_URL:process.env.AGY_PROVISION_TEST_DATABASE_URL,AGY_DB_RUNTIME_PASSWORD:'x'.repeat(32),AGY_HOSTED_SCHEMA:schema}),/UNTRACKED_SCHEMA_RECONCILIATION_REQUIRED/);
  assert.deepEqual((await admin.query(`SELECT * FROM ${schema}.untouched`)).rows,[{value:'preserve'}]);
  assert.equal((await admin.query('SELECT count(*)::int n FROM pg_tables WHERE schemaname=$1',[schema])).rows[0].n,1);
 }finally{await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
