import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {GatewayJournal,digest} from '../src/gateway-shadow/journal.js';
import {FakeShadowGateway} from './fake-shadow-gateway.js';

const context={gateway:'http://127.0.0.1:1234',worker:'R11-LOCAL',endpoint:'http://127.0.0.1:1235',capabilities:['text']};
async function directory(t: any) {
  const dir=await mkdtemp(join(tmpdir(),'agy-journal-recovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));return dir;
}

test('empty or missing journal directory cannot silently initialize on acquire',async t=>{
  const dir=await directory(t);
  await assert.rejects(()=>GatewayJournal.acquire(dir,context),/JOURNAL_MISSING/);
  assert.deepEqual(await readdir(dir),[]);
  await assert.rejects(()=>GatewayJournal.acquire(join(dir,'absent'),context),/JOURNAL_MISSING/);
  assert.deepEqual(await readdir(dir),[]);
});

test('explicit offline initialization never overwrites receipts or other directory contents',async t=>{
  const dir=await directory(t);await GatewayJournal.initialize(dir,context);
  const journal=await GatewayJournal.acquire(dir,context);
  await journal.once('external-submit',{payload:'controlled'},async()=>({externalId:'OP-CONTROLLED'}));
  await journal.close();const before=await readFile(join(dir,'current.json'));
  await assert.rejects(()=>GatewayJournal.initialize(dir,context),/JOURNAL_NOT_EMPTY/);
  assert.deepEqual(await readFile(join(dir,'current.json')),before);
  const other=join(dir,'other');await writeFile(other,'retained');
  await assert.rejects(()=>GatewayJournal.initialize(dir,context),/JOURNAL_NOT_EMPTY/);
  assert.equal(await readFile(other,'utf8'),'retained');
});

const valid={context:digest(context),cycle:1,done:false,ops:{}};
for(const [name,patch] of [
  ['null root',null],['array root',[]],['array operations',{...valid,ops:[]}],
  ['zero cycle',{...valid,cycle:0}],['fractional cycle',{...valid,cycle:1.5}],
  ['null operation',{...valid,ops:{ack:null}}],
  ['invalid request hash',{...valid,ops:{ack:{hash:'wrong',confirmed:false}}}],
  ['nonboolean confirmation',{...valid,ops:{ack:{hash:digest({}),confirmed:'true',response:{}}}}],
  ['confirmed receipt missing response',{...valid,ops:{ack:{hash:digest({}),confirmed:true}}}]
] as const) {
  test('structural corruption is retained and rejected: '+name,async t=>{
    const dir=await directory(t);const bytes=JSON.stringify(patch);
    await writeFile(join(dir,'current.json'),bytes);
    await assert.rejects(()=>GatewayJournal.acquire(dir,context),/JOURNAL_INVALID/);
    assert.equal(await readFile(join(dir,'current.json'),'utf8'),bytes);
    assert.equal((await readdir(dir)).includes('worker.lock'),false);
  });
}

test('existing valid pre-hardening journal is read without rewriting its bytes',async t=>{
  const dir=await directory(t);
  const state={...valid,ops:{'external-submit':{hash:digest({payload:'controlled'}),confirmed:true,response:{externalId:'OP-EXISTING'}}}};
  const bytes=JSON.stringify(state,null,2)+'\n';await writeFile(join(dir,'current.json'),bytes);
  const journal=await GatewayJournal.acquire(dir,context);
  try {
    assert.deepEqual(journal.receipt('external-submit',{payload:'controlled'}),{externalId:'OP-EXISTING'});
    assert.equal(await readFile(join(dir,'current.json'),'utf8'),bytes);
  }finally{await journal.close();}
});

test('missing current journal with retained archive cannot be reinitialized',async t=>{
  const dir=await directory(t);const bytes=JSON.stringify(valid);
  await writeFile(join(dir,'cycle-1.json'),bytes);
  await assert.rejects(()=>GatewayJournal.acquire(dir,context),/JOURNAL_MISSING/);
  await assert.rejects(()=>GatewayJournal.initialize(dir,context),/JOURNAL_NOT_EMPTY/);
  assert.deepEqual(await readdir(dir),['cycle-1.json']);
  assert.equal(await readFile(join(dir,'cycle-1.json'),'utf8'),bytes);
});

test('real worker fails closed before HTTP; initializer is offline and refuses reinitialization',async t=>{
  const gateway=await new FakeShadowGateway().start();t.after(()=>gateway.close());
  const dir=await directory(t);
  const base=Object.fromEntries(Object.entries(process.env).filter(([k])=>['SYSTEMROOT','WINDIR','PATH','PATHEXT','TEMP','TMP','COMSPEC'].includes(k.toUpperCase())));
  const env={...base,AGY_WORKER_TRANSPORT:'GATEWAY_SHADOW',AGY_STAGE_ONLY:'true',AGY_STATE_MODE:'SHADOW_STAGING',
    AGY_CANONICAL_AUTHORITY:'EXISTING_POSTGRES_D049',AGY_ORCHESTRATION_MODE:'LEGACY',AGY_WORKER_ID:'R11-LOCAL',
    AGY_GATEWAY_URL:gateway.url,AGY_R11_CONNECTOR_URL:gateway.url,AGY_R11_CAPABILITIES_JSON:'["text"]',AGY_GATEWAY_STATE_DIR:dir};
  const run=async(file:string)=>{
    const child=spawn(process.execPath,['--import','tsx',file],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    const code=await new Promise<number|null>((r,j)=>{child.once('error',j);child.once('close',r);});return {code,output};
  };
  const blocked=await run('src/platform/worker.ts');assert.equal(blocked.code,1);
  assert.match(blocked.output,/"code":"JOURNAL_MISSING"/);assert.doesNotMatch(blocked.output,/"outcome":"IDLE"/);
  assert.equal(gateway.calls.length,0);
  const initialized=await run('src/gateway-shadow/init-journal.ts');assert.equal(initialized.code,0,initialized.output);
  assert.match(initialized.output,/JOURNAL_INITIALIZED/);assert.equal(gateway.calls.length,0);
  const before=await readFile(join(dir,'current.json'));
  const refused=await run('src/gateway-shadow/init-journal.ts');assert.equal(refused.code,1);
  assert.match(refused.output,/JOURNAL_NOT_EMPTY/);assert.deepEqual(await readFile(join(dir,'current.json')),before);
  assert.equal(gateway.calls.length,0);
});
