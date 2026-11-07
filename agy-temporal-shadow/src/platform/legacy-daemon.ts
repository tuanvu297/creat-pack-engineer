import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {authenticate,authorize,identitiesFromEnv} from './auth.js';
import {ProjectService} from './service.js';
import {validateScope,type ProjectScope} from './scope.js';
import {DurableDispatcher,type RuntimeLane} from './dispatcher.js';
import {withHelperDelegation} from './helper-lane.js';
import {ConnectorError} from '../adapters.js';

if(process.env.AGY_STAGE_ONLY!=='true')throw new Error('STAGING_ONLY');
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL_REQUIRED');
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:10000});
const identities=identitiesFromEnv(),instance=randomUUID();
try {
 const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(!role||role.rolsuper||role.rolbypassrls)throw new Error('RLS_BYPASS_DENIED');
 // Only preconfigured identities/scopes/connectors; never invent credentials or provision projects.
 const bindings=JSON.parse(process.env.AGY_RUNTIME_LANES_JSON??'[]') as {scope:ProjectScope;workerTokenRef:string;connectorId:string}[];
 const lanes:RuntimeLane[]=[];
 const heartbeatMs=Number(process.env.AGY_RUNTIME_HEARTBEAT_MS??5000);
 for(const b of bindings) {
  if(!/^AGY_[A-Z0-9_]+$/.test(b.workerTokenRef))throw new Error('INVALID_TOKEN_REF');
  const scope=validateScope(b.scope),principal=authenticate('Bearer '+(process.env[b.workerTokenRef]??''),identities);
  authorize(principal,scope,'execute');if(principal.role!=='worker'||!principal.workerId)throw new Error('BOUND_WORKER_REQUIRED');
  const service=new ProjectService(pool,scope,principal),adapter=await service.adapter(b.connectorId);
  // Financial policy and Expert approval remain task gates; this runtime never enables paid adapters.
  if(adapter.name==='openai-responses'||/expert/i.test(adapter.name))throw new Error('AUTOMATIC_PAID_OR_EXPERT_ROUTE_DENIED');
  const resource=(await pool.query('SELECT adapter,capabilities,resource_profile FROM agy_workers WHERE worker_id=$1',[principal.workerId])).rows[0];
  if(!resource||resource.adapter!==adapter.name||adapter.capabilities.some(c=>!resource.capabilities.includes(c)))throw new Error('WORKER_CONNECTOR_MISMATCH');
  if(adapter.runtimeProfile&&JSON.stringify(adapter.runtimeProfile)!==JSON.stringify(resource.resource_profile?.runtimeProfile))throw new Error('WORKER_RUNTIME_PROFILE_MISMATCH');
  const workerId=principal.workerId;
  const liveAdapter=Object.create(adapter) as typeof adapter;
  liveAdapter.execute=async(task,signal)=>{
   if(task.estimatedCost!==0||!task.permissionGranted||!task.safetyApproved||task.risk==='HIGH'||
    (task.requiredPermissions??[]).some(p=>!['read','analyze','planning','qa'].includes(p))||
    /expert/i.test(String(task.payload?.role??'')))throw new ConnectorError('UNATTENDED_APPROVAL_BOUNDARY',false);
   return adapter.execute(task,signal);
  };
  liveAdapter.health=async()=>{const h=await adapter.health();if(h.ready){
   await pool.query(`UPDATE agy_workers SET status='READY',heartbeat_at=now(),
    resource_profile=jsonb_set(jsonb_set(resource_profile,'{lastHealthAt}',to_jsonb($2::bigint)),
    '{runtimeProfile,health_freshness,observed_at}',to_jsonb($2::bigint)),updated_at=now() WHERE worker_id=$1`,[workerId,Date.now()]);
   if(adapter.runtimeProfile)adapter.runtimeProfile.health_freshness.observed_at=Date.now();
  }return h;};
  // Helper delegation (D-057): helper_delegation children claimed by this
  // lane execute through the delegation host loop, never the connector.
  // The wrapper passes every other task through untouched.
  const laneAdapter=withHelperDelegation(liveAdapter,{pool,scope,parent:principal});
  lanes.push({key:JSON.stringify([scope,workerId,b.connectorId]),workerId,store:service.store,adapter:laneAdapter,
   report:async(state,outcome,error)=>{await service.pool.query(`INSERT INTO agy_runtime_workers(instance_id,worker_id,connector_id,state,expires_at,last_outcome,error_code)
    VALUES($1,$2,$3,$4,now()+($5::double precision*interval '1 millisecond'),$6,$7)
    ON CONFLICT(tenant_id,workspace_id,project_id,instance_id,worker_id,connector_id) DO UPDATE
    SET state=EXCLUDED.state,heartbeat_at=now(),expires_at=EXCLUDED.expires_at,last_outcome=EXCLUDED.last_outcome,error_code=EXCLUDED.error_code`,
    [instance,workerId,b.connectorId,state,heartbeatMs*3,outcome??null,error??null]);}});
 }
 const dispatcher=new DurableDispatcher(lanes,{pollMs:Number(process.env.AGY_RUNTIME_POLL_MS??1000),heartbeatMs,
  leaseSeconds:Number(process.env.AGY_RUNTIME_LEASE_SECONDS??30),concurrency:Number(process.env.AGY_RUNTIME_CONCURRENCY??4)});
 const stop=new AbortController();process.on('SIGTERM',()=>stop.abort());process.on('SIGINT',()=>stop.abort());
 await dispatcher.run(stop.signal);
}finally{await pool.end();}
