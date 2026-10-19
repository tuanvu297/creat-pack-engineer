import {Pool} from 'pg';
import {Client,Connection} from '@temporalio/client';
import {identitiesFromEnv} from '../platform/auth.js';
import {temporalConfig} from './config.js';
import {TemporalBridge} from './bridge.js';
import {TemporalGateway} from './gateway.js';
import {createGatewayHttpServer} from './http-server.js';
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
  const server=createGatewayHttpServer({identities,execute:(...args)=>gateway.execute(...args),
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
  await new Promise<void>(resolve=>{
   const shutdown=()=>{server.close(()=>resolve());server.closeIdleConnections();};
   process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  });
 }finally{await connection?.close();await pool.end();}
}
main().catch(()=>{console.error(JSON.stringify({event:'GATEWAY_BLOCKED',code:'DEPENDENCY_OR_CONFIG_FAILED',production:false}));process.exitCode=1;});
