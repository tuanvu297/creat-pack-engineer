import {createServer} from 'node:http';
import {Pool} from 'pg';
import {Client,Connection} from '@temporalio/client';
import {authenticate,identitiesFromEnv} from '../platform/auth.js';
import {temporalConfig} from './config.js';
import {TemporalBridge} from './bridge.js';
import {TemporalGateway} from './gateway.js';
const config=temporalConfig();if(config.mode!=='TEMPORAL_SHADOW'||!process.env.DATABASE_URL)throw new Error('SHADOW_DATABASE_CONFIG_REQUIRED');
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000,query_timeout:10000});
const role=(await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
if(!role||role.rolsuper||role.rolbypassrls)throw new Error('RLS_BYPASS_DENIED');
const connection=await Connection.connect({address:config.address});
const gateway=new TemporalGateway(new TemporalBridge(pool),new Client({connection,namespace:config.namespace}),config.taskQueue,'TEMPORAL_SHADOW');
const identities=identitiesFromEnv();
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 try{
  if(req.method!=='POST')throw new Error('POST_REQUIRED');
  const action=/^\/v1\/agy\/(bootstrap|current_state|dispatch|task_status|get_run|active_missions|reconcile|submit_qa|callback_status|stop)$/.exec(req.url??'')?.[1];
  if(!action)throw new Error('UNKNOWN_GATEWAY_ACTION');
  const p=authenticate(req.headers.authorization,identities),chunks:Buffer[]=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>65536)throw new Error('REQUEST_TOO_LARGE');chunks.push(chunk);}
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  res.end(JSON.stringify(await gateway.execute(body.mission,p,action,body.verdict)));
 }catch(e){const message=e instanceof Error?e.message:'REQUEST_FAILED';res.statusCode=message==='UNAUTHORIZED'?401:/DENIED/.test(message)?403:400;
  res.end(JSON.stringify({error:/^[A-Z_]+$/.test(message)?message:'REQUEST_FAILED'}));}
});
server.listen(Number(process.env.AGY_TEMPORAL_GATEWAY_PORT??8798),'127.0.0.1');
const shutdown=()=>{server.close(()=>{void connection.close().finally(()=>pool.end());});};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
