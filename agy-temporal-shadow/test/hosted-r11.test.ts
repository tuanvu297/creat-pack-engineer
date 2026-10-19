import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {GatewayTransport} from '../src/gateway-shadow/transport.js';
import {executorEnv,hostedR11Control} from '../src/hosted/r11-host.js';
import {validateMission} from '../src/temporal/bridge.js';

test('R11 authenticated transport sends bearer on health and register; missing/wrong credential fails closed',async t=>{
 const seen:string[]=[];
 const server=createServer((req,res)=>{
  seen.push(req.headers.authorization??'');res.setHeader('content-type','application/json');
  if(req.headers.authorization!=='Bearer test-only-credential'){res.writeHead(401);res.end('{}');return;}
  if(req.url==='/health')res.end(JSON.stringify({gateway:'PASS',canonical_authority:'EXISTING_POSTGRES_D049',state_plane:{status:'PASS',mode:'SHADOW_STAGING',canonical_authority:'EXISTING_POSTGRES_D049'}}));
  else res.end('{"status":"PASS","worker_id":"R11-test","health":"ONLINE"}');
 });
 await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));t.after(()=>{server.closeAllConnections();server.close();});
 const url='http://127.0.0.1:'+(server.address() as any).port;
 await assert.rejects(new GatewayTransport(url,'R11-test',1000).health(),/GATEWAY_HEALTH_UNVERIFIED/);
 await assert.rejects(new GatewayTransport(url,'R11-test',1000,'wrong').register(['code']),/GATEWAY_REJECTED/);
 const valid=new GatewayTransport(url,'R11-test',1000,'test-only-credential');await valid.health();await valid.register(['code']);
 assert.deepEqual(seen,['','Bearer wrong','Bearer test-only-credential','Bearer test-only-credential']);
});
test('R11 child receives only fixed staging configuration and process allowlist',()=>{
 const before={DATABASE_URL:process.env.DATABASE_URL,SUPABASE_SERVICE_ROLE_KEY:process.env.SUPABASE_SERVICE_ROLE_KEY,AGY_IDENTITIES_JSON:process.env.AGY_IDENTITIES_JSON};
 Object.assign(process.env,{DATABASE_URL:'must-not-reach-child',SUPABASE_SERVICE_ROLE_KEY:'must-not-reach-child',AGY_IDENTITIES_JSON:'must-not-reach-child'});
 try{const env=executorEnv();assert.equal(env.AGY_GATEWAY_STATE_DIR,'/data/r11-hosted');assert.ok(Object.keys(env).every(k=>!/^DATABASE_URL$|^SUPABASE_|BOOTSTRAP|IDENTITIES/i.test(k)));assert.equal(env.AGY_ORCHESTRATION_MODE,'LEGACY');}
 finally{for(const [k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('hosted controls cannot initialize a journal without explicit hosted R11 gate',async()=>{
 const old=process.env.AGY_HOSTED_R11;delete process.env.AGY_HOSTED_R11;
 try{await assert.rejects(hostedR11Control('init'),/R11_CONTROL_DENIED/);}finally{if(old!==undefined)process.env.AGY_HOSTED_R11=old;}
});
test('R11 mission accepts only exact fixed command and no correction/retry expansion',()=>{
 const m:any={tenantId:'gl',workspaceId:'legacy-workspace',projectId:'GL_AUTOMATION',mission_id:'AGY-TEMPORAL-20261018',task_id:'fresh-test',attempt:1,idempotency_key:'fresh-test',objective:'bounded source check',executor_worker_id:'R11_HOSTED_ENGINEERING',source_ref:'source',qa_contract_version:'1.1',mode:'TEMPORAL_SHADOW',payload:{command:'verify_gateway_contract'},ack_timeout_ms:120000,result_timeout_ms:120000,qa_timeout_ms:120000,max_corrections:0};
 assert.doesNotThrow(()=>validateMission(m));assert.throws(()=>validateMission({...m,payload:{command:'arbitrary'}}));assert.throws(()=>validateMission({...m,max_corrections:1}));assert.throws(()=>validateMission({...m,payload:{command:'verify_gateway_contract',argv:['unsafe']}}));
});
