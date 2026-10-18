import { Pool } from 'pg';
import { authenticate,authorize,identitiesFromEnv } from './auth.js';
import { validateScope } from './scope.js';
import { ProjectService } from './service.js';
import { WorkerEngine } from '../engine.js';
// One tick only. No automatic background service, deployment or connector discovery.
if(process.env.AGY_STAGE_ONLY!=='true')throw new Error('STAGING_ONLY');
const scope=validateScope(JSON.parse(process.env.AGY_WORKER_SCOPE??'null'));
const principal=authenticate('Bearer '+(process.env.AGY_WORKER_TOKEN??''),identitiesFromEnv());
authorize(principal,scope,'execute');if(principal.role!=='worker'||!principal.workerId)throw new Error('BOUND_WORKER_IDENTITY_REQUIRED');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL_REQUIRED');
const pool=new Pool({connectionString:process.env.DATABASE_URL});
try {
 const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];if(role.rolsuper||role.rolbypassrls)throw new Error('RLS_BYPASS_DENIED');
 const service=new ProjectService(pool,scope,principal),adapter=await service.adapter(process.env.AGY_CONNECTOR_ID??'');
 const resource=(await pool.query('SELECT adapter,capabilities,resource_profile FROM agy_workers WHERE worker_id=$1',[principal.workerId])).rows[0];
 if(!resource||resource.adapter!==adapter.name||adapter.capabilities.some(c=>!resource.capabilities.includes(c)))throw new Error('WORKER_CONNECTOR_MISMATCH');
 if(adapter.runtimeProfile&&JSON.stringify(adapter.runtimeProfile)!==JSON.stringify(resource.resource_profile?.runtimeProfile))throw new Error('WORKER_RUNTIME_PROFILE_MISMATCH');
 if(!(await adapter.health()).ready)throw new Error('CONNECTOR_UNVERIFIED');
 console.log(JSON.stringify({scope,outcome:await new WorkerEngine(service.store,adapter,principal.workerId).tick()}));
}finally{await pool.end();}
