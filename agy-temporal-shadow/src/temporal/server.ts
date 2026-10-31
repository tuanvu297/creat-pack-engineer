import {Pool} from 'pg';
import {Client,Connection} from '@temporalio/client';
import {identitiesFromEnv,authorize} from '../platform/auth.js';
import {createWorkerCallbackDriver,parseCallbackDriverConfig,findCallbackOperator} from '../platform/worker-callback-driver.js';
import {createQualificationController,parseQualificationConfig,QUALIFICATION_SCOPE} from '../platform/qualification-controller.js';
import {hostedR11Control} from '../hosted/r11-host.js';
import {validateMission} from './bridge.js';
import {temporalConfig} from './config.js';
import {TemporalBridge} from './bridge.js';
import {TemporalGateway} from './gateway.js';
import {createGatewayHttpServer} from './http-server.js';
import {createWorkerSurface} from '../platform/worker-surface.js';
import {createWorkerUi} from '../platform/worker-ui.js';
import {createCallbackReceiver} from '../platform/worker-callback-receiver.js';
import {gatewayListenConfig} from './hosting.js';
async function main(){
 const config=temporalConfig(),listen=gatewayListenConfig();
 if(config.mode!=='TEMPORAL_SHADOW'||!process.env.DATABASE_URL)throw new Error('SHADOW_DATABASE_CONFIG_REQUIRED');
 const identities=identitiesFromEnv();
 const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:5000});
 let connection:Connection|undefined;
 try{
  const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  if(!role||role.rolsuper||role.rolbypassrls)throw new Error('RLS_BYPASS_DENIED');
  connection=await Connection.connect({address:config.address,connectTimeout:'5 seconds'});
  const temporal=connection;
  const gateway=new TemporalGateway(new TemporalBridge(pool),new Client({connection,namespace:config.namespace}),config.taskQueue,'TEMPORAL_SHADOW');
  let workerReady=false;
  process.on('message',(message:any)=>{if(message?.type==='worker-ready')workerReady=message.ready===true;});
  // Request the current state after installing the listener; an earlier ready event
  // may have arrived while dependency connections were still being established.
  process.send?.({type:'gateway-listening'});
  // Qualification controller config is parsed BEFORE the worker
  // surface so the surface can cap qualification claim/heartbeat
  // leases at the owner's absolute deadline (no lease outlives the
  // window, even across a service outage at the deadline).
  const qualCfg=parseQualificationConfig(process.env);
  const workerSurface=createWorkerSurface(pool,{leaseDeadlineMs:(s)=>qualCfg.config.enabled&&s.tenantId===QUALIFICATION_SCOPE.tenantId&&s.workspaceId===QUALIFICATION_SCOPE.workspaceId&&s.projectId===QUALIFICATION_SCOPE.projectId?qualCfg.config.expiresAtMs:undefined});
  const server=createGatewayHttpServer({identities,worker:workerSurface,callbacks:createCallbackReceiver(pool),ui:process.env.AGY_WORKER_UI_SESSION_SECRET?createWorkerUi({identities,surface:workerSurface,secret:process.env.AGY_WORKER_UI_SESSION_SECRET}):undefined,execute:async(m,p,action,body)=>{
   if(action==='r11_control'){authorize(p,m,'write');validateMission(m);return hostedR11Control(body?.command);}
   return gateway.execute(m,p,action,body);
  },
   health:async()=>{
    const results=await Promise.allSettled([
     pool.query('SELECT 1'),
     temporal.withDeadline(Date.now()+5000,()=>temporal.workflowService.describeNamespace({namespace:config.namespace}))
    ]);
    return {postgres:results[0].status==='fulfilled',temporal:results[1].status==='fulfilled',worker:workerReady};
   }});
  server.requestTimeout=15000;server.headersTimeout=10000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(listen.port,listen.host,resolve);});
  console.log(JSON.stringify({event:'GATEWAY_LISTENING',host:listen.host,port:listen.port,mode:config.mode,production:false}));
  // Callback driver (candidate): DEFAULT DISABLED. Starts only with
  // AGY_CALLBACK_DRIVER_ENABLED=true + an explicit scope + a mission
  // allowlist; acts as the existing scoped operator, in-process.
  const driverCfg=parseCallbackDriverConfig(process.env);
  if(driverCfg.config.enabled&&driverCfg.config.scope){
   const driver=createWorkerCallbackDriver(pool,{config:driverCfg.config,operator:findCallbackOperator(identities,driverCfg.config.scope)});
   console.log(JSON.stringify({event:'CALLBACK_DRIVER_STATE',state:driver.start()}));
  }
  // Qualification provisioning controller (candidate): DEFAULT
  // DISABLED — starts only with AGY_QUALIFICATION_ENABLED=true +
  // AGY_STAGE_ONLY=true + an owner run id + an absolute deadline +
  // the cap-only approval flag. Fixed qualification scope only;
  // rolls the window back automatically after the deadline.
  // (qualCfg was parsed above, before the worker surface, so the
  // same deadline also caps qualification leases.)
  if(qualCfg.config.enabled){
   const qual=createQualificationController(pool,{config:qualCfg.config});
   console.log(JSON.stringify({event:'QUALIFICATION_CONTROLLER_STATE',state:qual.start()}));
  }
  await new Promise<void>(resolve=>{
   const shutdown=()=>{server.close(()=>resolve());server.closeIdleConnections();};
   process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  });
 }finally{await connection?.close();await pool.end();}
}
main().catch(()=>{console.error(JSON.stringify({event:'GATEWAY_BLOCKED',code:'DEPENDENCY_OR_CONFIG_FAILED',production:false}));process.exitCode=1;});
