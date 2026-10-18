import {Pool} from 'pg';
import {fileURLToPath} from 'node:url';
import {NativeConnection,Worker} from '@temporalio/worker';
import {TemporalBridge} from './bridge.js';
import {temporalConfig} from './config.js';
const config=temporalConfig();
if(config.mode!=='TEMPORAL_SHADOW'||!process.env.DATABASE_URL)throw new Error('SHADOW_DATABASE_CONFIG_REQUIRED');
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:10000});
let connection:NativeConnection|undefined;
try{
 const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(!role||role.rolsuper||role.rolbypassrls)throw new Error('RLS_BYPASS_DENIED');
 connection=await NativeConnection.connect({address:config.address});
 const worker=await Worker.create({connection,namespace:config.namespace,taskQueue:config.taskQueue,
  workflowsPath:fileURLToPath(new URL('./workflow.js',import.meta.url)),activities:new TemporalBridge(pool).activities(),
  shutdownGraceTime:'5 seconds',maxConcurrentActivityTaskExecutions:4,maxConcurrentWorkflowTaskExecutions:4});
 await worker.run();
}finally{await connection?.close();await pool.end();}
