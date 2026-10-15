import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {externalPaths} from '../src/private_paths.mjs';
import {Journal} from '../src/journal.mjs';
import {checkPolicy,allowed} from '../src/policy.mjs';
import {GeminiSteel} from '../src/runtime.mjs';
const policy=()=>({schema_version:1,worker_id:'GEMINI-STEEL',task_id:'AGY-GEMINI-STEEL-PEER-A1',owner_request_ref:'HUMAN_DIRECT_CURRENT_CHAT',callback_target:'ENGINEER_CHAT',expires_at:1000,max_sessions:1,max_submissions:1,timeout_ms:900000,persist_profile:false,project_id:'00000000-0000-0000-0000-000000000000',resource:{eligibility:'VERIFIED_EXISTING_CREDIT',checked_at:0}});
async function temporary(fn){const root=mkdtempSync(join(tmpdir(),'agy-steel-peer-'));try{return await fn(root);}finally{assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));rmSync(root,{recursive:true,force:true});}}
test('private paths reject package descendants including nonexistent children and case aliases',()=>temporary(async root=>{
 const pkg=join(root,'Package');mkdirSync(pkg);const config=join(root,'external.json');writeFileSync(config,'{}');
 assert.throws(()=>externalPaths(pkg,join(pkg,'private','future'),config),/PRIVATE_STATE_MUST_BE_EXTERNAL/);
 assert.throws(()=>externalPaths(pkg,join(root,'outside'),join(pkg,'config.json')),/PRIVATE_STATE_MUST_BE_EXTERNAL/);
 if(process.platform==='win32')assert.throws(()=>externalPaths(pkg,join(pkg.toUpperCase(),'private'),config),/PRIVATE_STATE_MUST_BE_EXTERNAL/);
 assert.equal(externalPaths(pkg,join(root,'PackageSibling'),config).state,join(root,'PackageSibling'));
}));
test('private paths resolve junctions before containment checks',()=>temporary(async root=>{
 const pkg=join(root,'Package');mkdirSync(pkg);const alias=join(root,'alias');symlinkSync(pkg,alias,'junction');const config=join(root,'external.json');writeFileSync(config,'{}');
 assert.throws(()=>externalPaths(pkg,join(alias,'future'),config),/PRIVATE_STATE_MUST_BE_EXTERNAL/);
}));
test('expired authority permits only cleanup policy and release lease',()=>temporary(async root=>{
 const p=policy();assert.throws(()=>checkPolicy(p,2000),/EXPIRED/);assert.equal(checkPolicy(p,2000,{cleanup:true}),p);
 const j=new Journal(root);try{j.bind(p.task_id);assert.throws(()=>j.sid('OTHER'),/BINDING/);assert.throws(()=>j.lease(p,'probe'),/LEASE_EXPIRED/);const l=j.lease(p,'release');assert.equal(l.scope,'RELEASE_OWNED_SESSION_ONLY');assert.ok(l.expires_at>Date.now());}finally{j.close();}
}));
test('collect requires matching send identity and permits uncertain same-send reconciliation',()=>temporary(async root=>{
 const j=new Journal(root);try{assert.throws(()=>j.requireIntent('SEND',{nonce:'NONCE-001'}),/SEND_INTENT_REQUIRED/);await assert.rejects(j.once('SEND',{nonce:'NONCE-001'},async()=>{throw Error('timeout');}));assert.equal(j.requireIntent('SEND',{nonce:'NONCE-001'}).state,'PENDING');assert.throws(()=>j.requireIntent('SEND',{nonce:'NONCE-002'}),/IDEMPOTENCY_CONFLICT/);}finally{j.close();}
}));
test('accounts auth page is classified without form access or automation',async()=>{
 const r=new GeminiSteel({},null,null,policy());r.page={url:()=> 'https://accounts.google.com/signin',getByRole:()=>{throw Error('form access forbidden');}};
 assert.equal((await r.status()).status,'HUMAN_LOGIN_REQUIRED');await assert.rejects(r.type('fixture'),/AUTH_UI/);await assert.rejects(r.send(),/AUTH_UI/);await assert.rejects(r.collect('NONCE-001'),/AUTH_UI/);
});
test('HTTP Gemini pages cannot be sent or collected',async()=>{
 const r=new GeminiSteel({},null,null,policy());r.page={url:()=> 'http://gemini.google.com/app'};await assert.rejects(r.send(),/URL_DENIED/);await assert.rejects(r.collect('NONCE-001'),/URL_DENIED/);
});
test('composer presence is never reported as authenticated',async()=>{
 const r=new GeminiSteel({},null,null,policy());r.page={url:()=> 'https://gemini.google.com/app',getByRole:role=>({count:async()=>role==='textbox'?1:0}),title:async()=> 'fixture'};assert.equal((await r.status()).status,'COMPOSER_PRESENT_AUTH_UNVERIFIED');
});
test('main navigation cannot reuse a static resource allowlist',async()=>{
 let routeHandler;const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},on(){}};const context={route:async(_,handler)=>{routeHandler=handler;},pages:()=>[page]};
 const r=new GeminiSteel({sessions:{retrieve:async()=>({status:'live'})}},{connectOverCDP:async()=>({contexts:()=>[context]})},'LOCAL-NONCREDENTIAL-FIXTURE',policy());await r.connect('fixture-session');
 const run=async(url,navigation)=>{let outcome;await routeHandler({request:()=>({url:()=>url,isNavigationRequest:()=>navigation}),continue:()=>{outcome='continue';},abort:()=>{outcome='abort';}});return outcome;};
 assert.equal(await run('https://www.gstatic.com/file.js',false),'continue');assert.equal(await run('https://www.google.com/search',true),'abort');assert.equal(await run('https://accounts.google.com/signin',true),'continue');
});
test('observed Gemini static host is resource-only; trackers remain denied',()=>{assert.equal(allowed('https://gemini.gstatic.com/app.js',{resource:true}),'https://gemini.gstatic.com/app.js');assert.throws(()=>allowed('https://gemini.gstatic.com/app.js'),/URL_DENIED/);assert.throws(()=>allowed('https://www.google-analytics.com/collect',{resource:true}),/URL_DENIED/);});
test('refresh is once-only and blocked by pending or completed prompt intents',()=>temporary(async root=>{
 const j=new Journal(root);try{let calls=0;await j.once('REFRESH',{sid:'S1'},async()=>({n:++calls}));await j.once('REFRESH',{sid:'S1'},async()=>({n:++calls}));assert.equal(calls,1);await j.once('FILL',{nonce:'N1'},async()=>({filled:true}));await assert.rejects(j.once('REFRESH',{sid:'S1'},async()=>({})),/REFRESH_DENIED/);}finally{j.close();}
}));
test('uncertain refresh blocks send without replaying navigation',()=>temporary(async root=>{
 const j=new Journal(root);try{await assert.rejects(j.once('REFRESH',{sid:'S1'},async()=>{throw Error('timeout');}));await assert.rejects(j.once('REFRESH',{sid:'S1'},async()=>({})),/UNCERTAIN/);await assert.rejects(j.once('SEND',{nonce:'N1'},async()=>({submitted:true})),/REFRESH_UNCERTAIN/);assert.equal(j.db.prepare("SELECT count(*) AS n FROM intents WHERE k='SEND'").get().n,0);}finally{j.close();}
}));
test('refresh refuses account pages, conversations and query redirects',async()=>{
 const r=new GeminiSteel({},null,null,policy());for(const url of ['https://accounts.google.com/signin','https://gemini.google.com/app/conversation','https://gemini.google.com/app?redirect=elsewhere']){r.page={url:()=>url};await assert.rejects(r.refresh(),/REFRESH_EXACT/);}
 let got;r.page={url:()=> 'https://gemini.google.com/app',goto:async url=>{got=url;}};await r.refresh();assert.equal(got,'https://gemini.google.com/app');
});
function guestPage({url='https://gemini.google.com/app',editable=1}={}){let fills=0,clicks=0;const page={url:()=>url,title:async()=> 'public fixture',getByRole:role=>({count:async()=>role==='textbox'?0:1,click:async()=>{clicks++;}}),locator:selector=>{assert.equal(selector,'[contenteditable="true"]:visible');return{count:async()=>editable,fill:async()=>{fills++;}};}};return{page,counts:()=>({fills,clicks})};}
test('guest fallback defaults denied and policy opt-in is strict boolean',async()=>{const x=guestPage(),r=new GeminiSteel({},null,null,policy());r.page=x.page;await assert.rejects(r.type('fixture'),/AUTH_OR_COMPOSER/);await assert.rejects(r.send(),/AUTH_OR_COMPOSER/);assert.deepEqual(x.counts(),{fills:0,clicks:0});assert.throws(()=>checkPolicy({...policy(),allow_guest_probe:'true'},500),/GUEST_POLICY_BOOLEAN/);});
test('explicit guest permits only one visible public editor and remains AUTH_UNVERIFIED',async()=>{const x=guestPage(),r=new GeminiSteel({},null,null,{...policy(),allow_guest_probe:true});r.page=x.page;assert.equal((await r.type('fixture')).mode,'GUEST_WEB_AUTH_UNVERIFIED');await r.send();assert.deepEqual(x.counts(),{fills:1,clicks:1});for(const editable of [0,2]){r.page=guestPage({editable}).page;await assert.rejects(r.type('fixture'),/EDITOR_AMBIGUOUS/);}});
test('guest permission never allows auth-page typing or non-app editors',async()=>{const r=new GeminiSteel({},null,null,{...policy(),allow_guest_probe:true});r.page={url:()=> 'https://accounts.google.com/signin',getByRole:()=>{throw Error('auth form forbidden');}};await assert.rejects(r.type('fixture'),/AUTH_UI/);await assert.rejects(r.send(),/AUTH_UI/);for(const url of ['https://gemini.google.com/app/conversation','https://gemini.google.com/app?redirect=login']){r.page=guestPage({url}).page;await assert.rejects(r.type('fixture'),/GUEST_EXACT/);}});
test('guest-app navigation happens at most once and cannot follow a send intent',()=>temporary(async root=>{const j=new Journal(root);try{let gets=0;await j.once('GUEST_APP',{sid:'S1'},async()=>({get:++gets}));await j.once('GUEST_APP',{sid:'S1'},async()=>({get:++gets}));assert.equal(gets,1);await j.once('SEND',{nonce:'N1'},async()=>({submitted:true}));await assert.rejects(j.once('GUEST_APP',{sid:'S1'},async()=>({})),/REFRESH_DENIED/);}finally{j.close();}}));
