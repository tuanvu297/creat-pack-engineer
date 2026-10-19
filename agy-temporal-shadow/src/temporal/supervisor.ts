import {fileURLToPath} from 'node:url';
import {temporalConfig} from './config.js';
import {gatewayListenConfig} from './hosting.js';
import {startSupervised} from './supervision.js';
try{
 const config=temporalConfig();gatewayListenConfig();
 if(config.mode!=='TEMPORAL_SHADOW'||process.env.AGY_STAGE_ONLY!=='true')throw new Error('STAGING_ONLY');
 const runtime=startSupervised([
  {name:'worker',file:fileURLToPath(new URL('./worker.js',import.meta.url))},
  {name:'gateway',file:fileURLToPath(new URL('./server.js',import.meta.url))}
 ]);
 const stop=()=>runtime.stop(0);
 process.once('SIGTERM',stop);process.once('SIGINT',stop);
 process.exitCode=await runtime.done;
 process.off('SIGTERM',stop);process.off('SIGINT',stop);
}catch{console.error(JSON.stringify({event:'SUPERVISOR_BLOCKED',production:false}));process.exitCode=1;}
