import {Pool,type PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function provisionStaging(env=process.env){
 if(env.AGY_STAGE_ONLY!=='true'||env.AGY_HOSTED_STAGING!=='true'||env.AGY_PROVISION_STAGING!=='true')throw new Error('EXPLICIT_STAGING_PROVISION_REQUIRED');
 if(!env.AGY_BOOTSTRAP_DATABASE_URL)throw new Error('AGY_BOOTSTRAP_DATABASE_URL_REQUIRED');
 if(!env.AGY_DB_RUNTIME_PASSWORD||env.AGY_DB_RUNTIME_PASSWORD.length<32)throw new Error('AGY_DB_RUNTIME_PASSWORD_REQUIRED');
 const schema=env.AGY_HOSTED_SCHEMA??'agy_hosted_staging';
 if(!/^agy_hosted_staging(?:_[a-z0-9]+)?$/.test(schema))throw new Error('STAGING_SCHEMA_REQUIRED');
 const role=env.AGY_HOSTED_RUNTIME_ROLE??'agy_staging_runtime';
 if(!/^agy_staging_runtime(?:_[a-z0-9]+)?$/.test(role))throw new Error('STAGING_RUNTIME_ROLE_REQUIRED');
 const quoted='"'+schema+'"',quotedRole='"'+role+'"';
 const db=new Pool({connectionString:env.AGY_BOOTSTRAP_DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:15000,max:1});
 let c:PoolClient|undefined;
 try{
  c=await db.connect();
  await c.query("SELECT pg_advisory_lock(hashtext($1))",['agy:provision:'+schema]);
  const exists=(await c.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount;
  if(exists){
   const marker=(await c.query("SELECT 1 FROM pg_tables WHERE schemaname=$1 AND tablename='agy_hosted_migrations'",[schema])).rowCount;
   const count=(await c.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','v','m','S')",[schema])).rows[0].n;
   if(count&&!marker)throw new Error('UNTRACKED_SCHEMA_RECONCILIATION_REQUIRED');
  }else await c.query('CREATE SCHEMA '+quoted);
  await c.query('SET search_path TO '+quoted+', public');
  await c.query('CREATE TABLE IF NOT EXISTS agy_hosted_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
  const names=(await readdir(resolve('migrations'))).filter(n=>/^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  if(!names.length)throw new Error('MIGRATION_SOURCE_MISSING');
  for(const name of names){
   const bytes=await readFile(resolve('migrations',name));
   const sql=bytes.toString('utf8').replaceAll('\r\n','\n');
   const hash=createHash('sha256').update(sql).digest('hex');
   const prior=(await c.query('SELECT sha256 FROM agy_hosted_migrations WHERE name=$1',[name])).rows[0];
   if(prior){if(prior.sha256!==hash)throw new Error('MIGRATION_HASH_CONFLICT');continue;}
   const body=sql.replace(/^\s*(BEGIN|COMMIT);\s*$/gm,'');
   await c.query('BEGIN');
   try{await c.query(body);await c.query('INSERT INTO agy_hosted_migrations(name,sha256) VALUES($1,$2)',[name,hash]);await c.query('COMMIT');}
   catch(e){await c.query('ROLLBACK');throw e;}
  }
  const oldRole=(await c.query('SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  if(oldRole){if(oldRole.rolsuper||oldRole.rolbypassrls||!oldRole.rolcanlogin)throw new Error('UNSAFE_RUNTIME_ROLE');}
  else{
   // Parameter-bound format; password values are never logged or returned.
   const statement=(await c.query("SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) sql",[role,env.AGY_DB_RUNTIME_PASSWORD])).rows[0].sql;
   await c.query(statement);
  }
  await c.query('GRANT USAGE ON SCHEMA '+quoted+' TO '+quotedRole);
  await c.query('GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA '+quoted+' TO '+quotedRole);
  await c.query('REVOKE ALL ON agy_hosted_migrations FROM '+quotedRole);
  await c.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA '+quoted+' TO '+quotedRole);
  await c.query('GRANT DELETE ON agy_dispatch_tasks TO '+quotedRole);
  const initialized=(await c.query("SELECT 1 FROM agy_hosted_migrations WHERE name='hosted-project-v1'")).rowCount;
  if(!initialized){
   await c.query('BEGIN');
   try{
    await c.query("SELECT set_config('agy.tenant_id','gl',true),set_config('agy.workspace_id','legacy-workspace',true),set_config('agy.project_id','GL_AUTOMATION',true)");
    await c.query("UPDATE agy_projects SET status='ACTIVE',source_of_truth_ref=$1,policy_ref='D-049',policies=policies||'{\"temporalShadowOnly\":true}',resource_policy='{\"maxConcurrentTasks\":4,\"quotaCap\":0,\"spendCap\":0,\"reservation\":0}' WHERE tenant_id='gl' AND workspace_id='legacy-workspace' AND project_id='GL_AUTOMATION'",['https://docs.google.com/document/d/10Ph_XvsgytAHsdECGDNkPY94l4EIuTat-4VWtbXrTsY/edit']);
    await c.query("INSERT INTO agy_hosted_migrations(name,sha256) VALUES('hosted-project-v1',$1)",[createHash('sha256').update('D-049 isolated staging bootstrap v1').digest('hex')]);await c.query('COMMIT');
   }catch(e){await c.query('ROLLBACK');throw e;}
  }
  // Runtime never receives the bootstrap connection or migration password.
  return {schema,role,migrations:names.length,production:false};
 }finally{if(c){await c.query("SELECT pg_advisory_unlock(hashtext($1))",['agy:provision:'+schema]).catch(()=>{});c.release();}await db.end();}
}
