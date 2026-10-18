import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {R11GatewayConnector} from '../src/gateway-shadow/runtime.js';
import {workerTransport,gatewayConfig,privateUrl} from '../src/gateway-shadow/config.js';
import {GatewayJournal} from '../src/gateway-shadow/journal.js';
import {GatewayTransport,identity} from '../src/gateway-shadow/transport.js';
import {GatewayShadowWorker} from '../src/gateway-shadow/worker.js';
import type {WorkerAdapter,ClaimedTask} from '../src/types.js';
import {FakeShadowGateway,spec} from './fake-shadow-gateway.js';

const env = {AGY_WORKER_TRANSPORT:'GATEWAY_SHADOW',AGY_STAGE_ONLY:'true',AGY_STATE_MODE:'SHADOW_STAGING',
  AGY_CANONICAL_AUTHORITY:'EXISTING_POSTGRES_D049',AGY_WORKER_ID:'R11-CONTROLLED',AGY_GATEWAY_STATE_DIR:'/data/r11',
  AGY_GATEWAY_URL:'http://agy-gateway.railway.internal:8080'};

async function fixture(t: any, options: Partial<WorkerAdapter> = {}) {
  const gateway = await new FakeShadowGateway().start();
  const dir = await mkdtemp(join(tmpdir(),'agy-gateway-test-'));
  const config = {...gatewayConfig(env),url:gateway.url,stateDir:dir,heartbeatMs:20};
  let submissions = 0;
  const adapter: WorkerAdapter = {name:'r11',capabilities:['text'],health:async () => ({ready:true}),
    execute:async (task: ClaimedTask) => {submissions++;assert.equal(task.idempotencyKey,'IDEM-1');
      assert.equal((task as any).attemptId,'ATT-CONTROLLED');assert.equal((task as any).traceId,'TRACE-1');return {externalId:'OP-1'};},
    check_status:async () => ({state:'SUCCEEDED'}),collect_result:async () => ({state:'SUCCEEDED',output:{controlled:true}}),
    cancel:async () => {throw new Error('MUST_NOT_CANCEL');},...options};
  const transport = new GatewayTransport(gateway.url,config.workerId,500);
  let journal = await GatewayJournal.acquire(dir,{gateway:gateway.url,worker:config.workerId});
  let worker = new GatewayShadowWorker(transport,journal,adapter,config);
  t.after(async () => {await journal.close();await gateway.close();await rm(dir,{recursive:true,force:true});});
  return {gateway,transport,adapter,config,dir,get journal(){return journal;},get worker(){return worker;},
    get submissions(){return submissions;},
    create:async (payload:any=spec) => transport.createTask({mission_id:'MISSION-1',task_id:'TASK-1',trace_id:'TRACE-1',
      idempotency_key:'IDEM-1',objective:'controlled fixture',payload}),
    restart:async () => {await journal.close();journal = await GatewayJournal.acquire(dir,{gateway:gateway.url,worker:config.workerId});
      worker = new GatewayShadowWorker(transport,journal,adapter,config);}};
}

test('worker routing stays LEGACY by default; gateway requires explicit staging authority and no DB secrets', () => {
  assert.equal(workerTransport({}),'LEGACY'); assert.equal(gatewayConfig(env).leaseSeconds,120);
  for (const patch of [{AGY_WORKER_TRANSPORT:'TYPO'},{AGY_STAGE_ONLY:'false'},{AGY_STATE_MODE:'PRODUCTION'},
    {AGY_CANONICAL_AUTHORITY:'SUPABASE'},{DATABASE_URL:'controlled'},{SUPABASE_SERVICE_ROLE_KEY:'controlled'},
    {AGY_ORCHESTRATION_MODE:'TEMPORAL_SHADOW'},{AGY_RUNTIME_HEARTBEAT_MS:'NaN'},{AGY_GATEWAY_TIMEOUT_MS:'Infinity'},
    {AGY_GATEWAY_LEASE_SECONDS:'29'},{AGY_WORKER_ID:''},{AGY_GATEWAY_STATE_DIR:''}])
    assert.throws(() => gatewayConfig({...env,...patch}));
});

test('gateway URL accepts private networking and loopback, rejects public/Supabase/credentials/paths', () => {
  for (const url of ['http://agy-gateway.railway.internal:8080','http://127.0.0.1:4444','http://[::1]:4444']) assert.ok(privateUrl(url));
  for (const url of ['https://project.supabase.co','https://example.com','http://u:p@agy-gateway.railway.internal',
    'http://agy-gateway.railway.internal/path','http://agy-gateway.railway.internal?key=x','file:///data']) assert.throws(() => privateUrl(url));
});

test('controlled deployed router: register/create/claim/ACK/heartbeat/checkpoint/result/pending callback preserve full identity', async t => {
  const f = await fixture(t);assert.equal((await f.create()).status,'CREATED');
  assert.equal((await f.create()).status,'IDEMPOTENT_REPLAY');
  await assert.rejects(() => f.transport.createTask({mission_id:'MISSION-1',task_id:'TASK-1',trace_id:'TRACE-1',
    idempotency_key:'CHANGED',objective:'controlled fixture',payload:spec}),/GATEWAY_REJECTED/);
  assert.equal(await f.worker.tick(),'RESULT_SUBMITTED');
  assert.equal(f.submissions,1);assert.equal(f.gateway.registered,true);assert.equal(f.gateway.queueArchived,true);
  assert.equal(f.gateway.checkpoints.get(1)?.submissionState,'INTENT');
  assert.equal(f.gateway.checkpoints.get(2)?.externalId,'OP-1');
  assert.equal(f.gateway.result?.result_status,'RESULT_READY');assert.equal(f.gateway.result?.evidence.qa_state,'PENDING');
  assert.equal(f.gateway.callback?.callback_status,'PENDING');assert.equal(f.gateway.callback?.callback_payload.qa_state,'PENDING');
  for (const call of f.gateway.calls.filter(c => ['/ack','/heartbeat','/checkpoint','/result','/callback'].includes(c.path)))
    assert.deepEqual(Object.fromEntries(Object.entries(call.headers).filter(([k]) => k.startsWith('x-agy-'))),identity(f.gateway.lease!));
  assert.ok(f.gateway.rpcCalls.some(c => c.name === 'agy_gateway_claim_rpc'));
  assert.ok(f.gateway.rpcCalls.some(c => c.name === 'agy_gateway_callback_rpc'));
  assert.equal(f.gateway.calls.some(c => c.headers.apikey || c.headers.authorization),false);
  assert.equal(await f.worker.tick(),'IDLE');assert.equal(f.submissions,1);
});

test('EMPTY is genuine idle; failed registration and generic PASS cannot fabricate ACK or health', async t => {
  const f = await fixture(t);assert.equal(await f.worker.tick(),'IDLE');
  f.gateway.invalid = '/workers/register';
  await assert.rejects(() => f.worker.tick(),/REGISTER_UNCONFIRMED/);assert.equal(f.gateway.count('/ack'),0);
});

test('gateway health must confirm the D049 staging authority before any mutation', async t => {
  const f = await fixture(t);f.gateway.invalid = '/health';
  await assert.rejects(() => f.worker.tick(),/GATEWAY_AUTHORITY_MISMATCH/);
  assert.equal(f.gateway.count('/workers/register'),0);
});

test('unknown queue maintenance status is blocked, not a claim or fake idle', async t => {
  const f = await fixture(t);await f.create();f.gateway.invalid = '/tasks/claim';
  await assert.rejects(() => f.worker.tick(),/CLAIM_NOT_LEASED/);assert.equal(f.submissions,0);
});

for (const badClaim of [{lease_token:null},{fence:null},{fence:0},{worker_id:'OTHER'},{trace_id:''},{attempt_id:''},{expires_at:'invalid'}])
  test('claim rejects invalid lease field ' + Object.keys(badClaim)[0], async t => {
    const f = await fixture(t);await f.create();await f.transport.register(['text']);f.gateway.badClaim = badClaim;
    await assert.rejects(() => f.transport.claim(120),/LEASE_CONTRACT_INVALID/);assert.equal(f.gateway.count('/ack'),0);
  });

test('stale token and fence cannot mutate a successor lease', async t => {
  const f = await fixture(t);await f.create();await f.transport.register(['text']);const lease = (await f.transport.claim(120))!;
  await assert.rejects(() => f.transport.action('/ack',{...lease,fence:lease.fence-1}),/GATEWAY_REJECTED/);
  await assert.rejects(() => f.transport.action('/ack',{...lease,lease_token:'stale'}),/GATEWAY_REJECTED/);
  assert.equal(f.gateway.state,'LEASED');await f.transport.action('/ack',lease);
  await assert.rejects(() => f.transport.action('/ack',lease),/GATEWAY_REJECTED/);
});

test('unsafe/paid task envelope is denied before ACK or external execute', async t => {
  const f = await fixture(t);await f.create({...spec,estimatedCost:1});
  await assert.rejects(() => f.worker.tick(),/UNATTENDED_APPROVAL_BOUNDARY/);
  assert.equal(f.gateway.count('/ack'),0);assert.equal(f.submissions,0);
});

test('new attempt without prior-effect evidence requires reconciliation', async t => {
  const f = await fixture(t);await f.create();f.gateway.badClaim = {attempt_no:2};
  await assert.rejects(() => f.worker.tick(),/RECONCILIATION_REQUIRED/);assert.equal(f.submissions,0);
});

test('lease heartbeat is actually renewed during a pending external execute', {timeout:5000}, async t => {
  const f = await fixture(t);await f.create();let finish!: () => void;
  const held = new Promise<void>(r => {finish = r;});
  f.adapter.execute = async () => {await held;return {externalId:'OP-1'};};
  f.gateway.onHeartbeat = () => {if (f.gateway.count('/heartbeat') >= 2) finish();};
  assert.equal(await f.worker.tick(),'RESULT_SUBMITTED');assert.ok(f.gateway.count('/heartbeat') >= 2);
});

test('many short status polls cannot postpone the heartbeat deadline indefinitely', {timeout:5000}, async t => {
  const f = await fixture(t);await f.create();f.config.heartbeatMs = 300;let polls = 0;
  f.adapter.check_status = async () => ({state:++polls <= 3 ? 'RUNNING' : 'SUCCEEDED'});
  assert.equal(await f.worker.tick(),'RESULT_SUBMITTED');assert.ok(f.gateway.count('/heartbeat') >= 2);
});

test('lease loss aborts connector; no result/callback, cancellation or blind replay', {timeout:5000}, async t => {
  const f = await fixture(t);await f.create();let aborted = false;
  f.adapter.execute = async (_task,signal) => {
    f.gateway.reject = '/heartbeat';
    await new Promise<void>(resolve => signal.addEventListener('abort',() => {aborted=true;resolve();},{once:true}));
    return {externalId:'TOO-LATE'};
  };
  await assert.rejects(() => f.worker.tick(),/GATEWAY_REJECTED/);
  assert.equal(aborted,true);assert.equal(f.gateway.count('/result'),0);assert.equal(f.gateway.count('/callback'),0);
  await f.restart();await assert.rejects(() => f.worker.tick(),/RECONCILIATION_REQUIRED/);
});

for (const path of ['/tasks/claim','/ack','/checkpoint','/result','/callback']) {
  test(`lost response after accepted ${path} is retained uncertain across restart without any replay`,async t => {
    const f = await fixture(t);await f.create();f.gateway.dropAfter = path;
    await assert.rejects(() => f.worker.tick(),/GATEWAY_OUTCOME_UNCERTAIN/);
    const count = f.gateway.calls.length;
    await f.restart();f.gateway.dropAfter = undefined;
    await assert.rejects(() => f.worker.tick(),/RECONCILIATION_REQUIRED/);
    assert.equal(f.gateway.calls.length,count);assert.equal(f.gateway.count(path),1);
    if (path === '/result') assert.equal(f.gateway.state,'RESULT_SUBMITTED');
  });
}

test('uncertain connector submission is not resubmitted after worker restart', async t => {
  const f = await fixture(t);await f.create();let effects = 0;
  f.adapter.execute = async () => {effects++;throw new Error('accepted remotely, response lost');};
  await assert.rejects(() => f.worker.tick(),/CONNECTOR_OUTCOME_UNCERTAIN/);
  await f.restart();await assert.rejects(() => f.worker.tick(),/RECONCILIATION_REQUIRED/);
  assert.equal(effects,1);assert.equal(f.gateway.count('/result'),0);
});

test('confirmed operation resumes status/collect after restart, without re-ACK or execute', async t => {
  const f = await fixture(t);await f.create();let unavailable = true;
  f.adapter.check_status = async () => {if (unavailable) throw new Error('temporary status outage');return {state:'SUCCEEDED'};};
  await assert.rejects(() => f.worker.tick(),/CONNECTOR_OUTCOME_UNCERTAIN/);
  assert.equal(f.gateway.checkpoints.get(2)?.externalId,'OP-1');
  const before = f.gateway.checkpointDigest();await f.restart();unavailable = false;
  assert.equal(await f.worker.tick(),'RESULT_SUBMITTED');
  assert.equal(f.submissions,1);assert.equal(f.gateway.count('/ack'),1);
  assert.equal(f.gateway.checkpointDigest(),before);assert.equal(f.gateway.count('/checkpoint'),2);
});

test('restart after confirmed result resumes only pending callback against released lease', async t => {
  const f = await fixture(t);await f.create();const once = f.journal.once.bind(f.journal);
  f.journal.once = async (key,request,operation) => {if (key === 'callback') throw new Error('CONTROLLED_CRASH_BEFORE_CALLBACK_INTENT');
    return once(key,request,operation);};
  await assert.rejects(() => f.worker.tick(),/CONTROLLED_CRASH/);assert.equal(f.gateway.state,'RESULT_SUBMITTED');
  const heartbeats = f.gateway.count('/heartbeat');await f.restart();
  assert.equal(await f.worker.tick(),'RESULT_SUBMITTED');assert.equal(f.submissions,1);
  assert.equal(f.gateway.count('/result'),1);assert.equal(f.gateway.count('/heartbeat'),heartbeats);
  assert.equal(f.gateway.callback?.callback_status,'PENDING');
});

test('single writer lock, context binding and payload conflict protect the durable journal', async t => {
  const f = await fixture(t);
  await assert.rejects(() => GatewayJournal.acquire(f.dir,{}),/JOURNAL_LOCKED/);
  await f.journal.once('controlled',{payload:1},async () => ({receipt:true}));
  await assert.rejects(() => f.journal.once('controlled',{payload:2},async () => ({})),/IDEMPOTENCY_CONFLICT/);
  await f.journal.close();
  await assert.rejects(() => GatewayJournal.acquire(f.dir,{}),/JOURNAL_CONTEXT_MISMATCH/);
  // Recreate a controlled lock for the existing fixture's cleanup handle.
  await writeFile(join(f.dir,'worker.lock'),'controlled cleanup');
});

test('connector not ready sends no register/claim, and stopped worker does no work', async t => {
  const f = await fixture(t,{health:async () => ({ready:false})});
  await assert.rejects(() => f.worker.tick(),/CONNECTOR_UNVERIFIED/);assert.equal(f.gateway.calls.length,0);
  const stop = new AbortController();stop.abort();await assert.rejects(() => f.worker.tick(stop.signal),/WORKER_STOPPED/);
});

test('terminal connector failure is preserved without PASS, retry or cancellation', async t => {
  const f = await fixture(t,{check_status:async () => ({state:'FAILED'}),
    collect_result:async () => ({state:'FAILED',output:{controlled_failure:true}})});
  await f.create();assert.equal(await f.worker.tick(),'RESULT_SUBMITTED');
  assert.equal(f.submissions,1);assert.equal(f.gateway.result?.result_status,'FAILED');
  assert.equal(f.gateway.callback?.callback_payload.result_state,'FAILED');
  assert.equal(f.gateway.callback?.callback_status,'PENDING');
});

test('R11 HTTP execute makes exactly one request on 429/503/redirect and exposes no raw errors', async t => {
  let count = 0, status = 429;
  const server = createServer((_req,res) => {count++;res.writeHead(status,{location:'http://public.invalid/execute'});res.end('sensitive upstream body');});
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => {server.closeAllConnections();await new Promise<void>(r => server.close(() => r()));});
  const connector = new R11GatewayConnector('http://127.0.0.1:' + (server.address() as any).port,['text']);
  for (status of [429,503,307]) {
    const before = count;
    await assert.rejects(() => connector.execute({taskId:'controlled',payload:{},idempotencyKey:'controlled'} as ClaimedTask,
      new AbortController().signal),{message:'SUBMISSION_UNCERTAIN'});
    assert.equal(count,before+1);
  }
});

test('real worker entrypoint completes controlled HTTP flow with DATABASE_URL absent', {timeout:15000}, async t => {
  const f = await fixture(t);await f.create();let executions = 0;
  const connector = createServer(async (req,res) => {
    let data = '';for await (const part of req) data += part;
    res.setHeader('content-type','application/json');
    if (req.url === '/health') res.end('{"ready":true}');
    else if (req.url === '/execute') {executions++;const body = JSON.parse(data);
      assert.equal(body.task.traceId,'TRACE-1');assert.equal(body.idempotency_key,'IDEM-1');res.end('{"externalId":"OP-ENTRYPOINT"}');}
    else res.end('{"state":"SUCCEEDED","output":{"controlled":true}}');
  });
  await new Promise<void>(r => connector.listen(0,'127.0.0.1',r));
  t.after(async () => {connector.closeAllConnections();await new Promise<void>(r => connector.close(() => r()));});
  const childDir = await mkdtemp(join(tmpdir(),'agy-gateway-child-'));
  t.after(() => rm(childDir,{recursive:true,force:true}));
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'DATABASE_URL' && !k.startsWith('SUPABASE_')));
  const child = spawn(process.execPath,['--import','tsx','src/platform/worker.ts'],{cwd:process.cwd(),
    env:{...childEnv,...env,AGY_GATEWAY_URL:f.gateway.url,AGY_GATEWAY_STATE_DIR:childDir,
      AGY_R11_CONNECTOR_URL:'http://127.0.0.1:' + (connector.address() as any).port,AGY_R11_CAPABILITIES_JSON:'["text"]'},
    stdio:['ignore','pipe','pipe']});
  let output = '';child.stdout.on('data',d => output += d);child.stderr.on('data',d => output += d);
  t.after(() => {if (child.exitCode === null) child.kill();});
  const [code] = await once(child,'exit');
  assert.equal(code,0,output);assert.match(output,/"outcome":"RESULT_SUBMITTED"/);
  assert.equal(executions,1);assert.equal(f.gateway.callback?.callback_status,'PENDING');
  assert.doesNotMatch(output,/lease_token|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL_REQUIRED/);
});
