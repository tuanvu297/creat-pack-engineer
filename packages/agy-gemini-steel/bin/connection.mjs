import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{resolve,join}from'node:path';import{pathToFileURL}from'node:url';import{createRequire}from'node:module';import{Journal}from'../src/journal.mjs';import{checkPolicy,publicPage,validateText,fail}from'../src/policy.mjs';import{GeminiSteel}from'../src/runtime.mjs';import{externalPaths}from'../src/private_paths.mjs';
const argv=process.argv.slice(2);if(argv.includes('--help')){console.log('connection.mjs <connect|status|refresh|guest-app|probe|collect|release> --state PRIVATE --config PRIVATE --dependencies NODE_MODULE_ROOT [--nonce TOKEN]');process.exit(0);}
const op=argv[0],get=k=>argv[argv.indexOf('--'+k)+1];let j,r;
try{
 if(!['connect','status','refresh','guest-app','probe','collect','release'].includes(op)||!['state','config','dependencies'].every(k=>argv.includes('--'+k)))fail('ARGUMENTS_REQUIRED');
 const pkg=resolve(import.meta.dirname,'..'),{state,config}=externalPaths(pkg,get('state'),get('config'));
 const p=checkPolicy(JSON.parse(readFileSync(config,'utf8')),Date.now(),{cleanup:op==='release'});if(!process.env.STEEL_API_KEY)fail('STEEL_KEY_ENV_REQUIRED');
 const require=createRequire(join(resolve(get('dependencies')),'package.json'));const sm=require.resolve('steel-sdk'),pm=require.resolve('playwright');const steelModule=await import(pathToFileURL(sm).href),playwrightModule=await import(pathToFileURL(pm).href);const Steel=steelModule.default??steelModule.Steel,chromium=playwrightModule.chromium??playwrightModule.default?.chromium;if(typeof Steel!=='function'||typeof chromium?.connectOverCDP!=='function')fail('DEPENDENCY_EXPORTS_UNVERIFIED');const client=new Steel({steelAPIKey:process.env.STEEL_API_KEY,maxRetries:0,timeout:30000});
 j=new Journal(state);const lease=j.lease(p,op);r=new GeminiSteel(client,chromium,process.env.STEEL_API_KEY,p);const ensure=()=>{if(Date.now()>=lease.expires_at)fail('LEASE_EXPIRED_RECONCILE');};
 let result;
 if(op==='connect'){const sid=j.bind(p.task_id);ensure();await j.once('CREATE',{sid,policy:p},()=>r.create(sid));const remote=await r.connect(sid);ensure();await j.once('NAVIGATE',{sid,url:'https://gemini.google.com/app'},()=>r.navigate());result={session_id:sid,...await r.status()};
  // Viewer is a temporary access capability: private local state only, never stdout/export.
  writeFileSync(join(state,'viewer.private.json'),JSON.stringify({session_id:sid,viewer_url:remote.sessionViewerUrl,debug_url:remote.debugUrl,expires_in_ms:p.timeout_ms}));
 }else{const sid=j.sid(p.task_id);if(op==='release'){const remote=await client.sessions.retrieve(sid);if(remote.status!=='live')result={session_id:sid,released:true,reconciled:true};else result=await j.once('RELEASE',{sid},async()=>{await client.sessions.release(sid);return{session_id:sid,released:true};});}
 else{await r.connect(sid);ensure();if(op==='status')result={session_id:sid,...await r.status()};
  else if(op==='refresh'){result={session_id:sid,...await j.once('REFRESH',{sid,url:'https://gemini.google.com/app'},()=>r.refresh()),...await r.status()};}
  else if(op==='guest-app'){if(p.allow_guest_probe!==true)fail('GUEST_MODE_NOT_BOUND');result={session_id:sid,...await j.once('GUEST_APP',{sid,url:'https://gemini.google.com/app'},()=>r.navigate()),...await r.status(),mode:'GUEST_WEB_AUTH_UNVERIFIED'};}
  else{const nonce=get('nonce');if(!/^[A-Z0-9-]{8,60}$/.test(nonce??''))fail('NONCE_REQUIRED');if(op==='probe'){const text=validateText('AGY bounded connection test. No tools or external actions. Return exactly two lines: ACK:'+nonce+' and SUM:42 (19+23).');await j.once('FILL',{nonce,text},()=>r.type(text));ensure();result=await j.once('SEND',{nonce},()=>r.send());}else{j.requireIntent('SEND',{nonce});result=await r.collect(nonce);}}}
 }
 ensure();j.event('CHECKPOINT_RESULT',{operation:op,result});console.log(JSON.stringify({ok:true,operation:op,task_id:p.task_id,worker_id:p.worker_id,result}));
}catch(e){console.log(JSON.stringify({ok:false,error:e.code??'PROVIDER_OR_BROWSER_ERROR',http_status:e.status??null,uncertain:'Reconcile existing session/journal before any repeat mutation'}));process.exitCode=1;}finally{await r?.detach();j?.close();}
